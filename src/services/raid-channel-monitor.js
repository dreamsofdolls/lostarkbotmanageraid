"use strict";

const { getArtistEmoji } = require("../data/ArtistEmoji");

function createRaidChannelMonitorService({
  PermissionFlagsBits,
  EmbedBuilder,
  UI,
  GuildConfig,
  RAID_REQUIREMENT_MAP,
  getGatesForRaid,
  applyRaidSetForDiscordId,
  getAnnouncementsConfig,
  // Injected so checkUserMonitorCooldown / clearUserMonitorCooldown can fold
  // message.content into a stable dedup key. Missing this dep in the compose
  // site caused every MessageCreate to throw ReferenceError and the silent
  // try/catch in bot.js swallowed the error, making the whole channel appear
  // unresponsive even though the listener was bound.
  normalizeName,
}) {
  // Raid channel monitor (text-driven raid-set)
  // ---------------------------------------------------------------------------
  // In-memory per-guild cache of the monitor channel ID. The MessageCreate
  // handler fires for every message the bot can see - hitting Mongo on each
  // one would turn normal chat traffic into a DB read. The cache is loaded
  // once at boot (loadMonitorChannelCache) and updated in-place by
  // /raid-channel config action:set|clear, so the hot path can filter with
  // a Map lookup. Single-process bot → no multi-instance invalidation needed.
  const monitorChannelCache = new Map(); // guildId -> channelId | null
  // `false` until `loadMonitorChannelCache` completes successfully at least
  // once. Callers (/raid-channel config action:show) can surface this so
  // admins know a silent monitor failure is a cache-load issue, not just
  // missing config.
  let monitorCacheHealthy = false;
  let monitorCacheLoadError = null;
  async function loadMonitorChannelCache() {
    try {
      const configs = await GuildConfig.find({}).lean();
      monitorChannelCache.clear();
      for (const c of configs) {
        monitorChannelCache.set(c.guildId, c.raidChannelId || null);
      }
      monitorCacheHealthy = true;
      monitorCacheLoadError = null;
      console.log(`[raid-channel] loaded ${configs.length} guild config(s) into cache.`);
    } catch (err) {
      monitorCacheHealthy = false;
      monitorCacheLoadError = err?.message || String(err);
      // Elevate to error (not warn): this silently disables the monitor until
      // the next successful load, so operators need it to be noisy in logs.
      console.error("[raid-channel] cache load FAILED - monitor inactive until reload:", monitorCacheLoadError);
    }
  }
  function getMonitorCacheHealth() {
    return { healthy: monitorCacheHealthy, error: monitorCacheLoadError };
  }
  function getCachedMonitorChannelId(guildId) {
    return monitorChannelCache.get(guildId) ?? null;
  }
  function setCachedMonitorChannelId(guildId, channelId) {
    monitorChannelCache.set(guildId, channelId);
  }
  // Mirror of bot.js's TEXT_MONITOR_ENABLED gate so `/raid-channel` can refuse
  // to save / surface a warning in `show` when the feature is disabled at the
  // deploy layer. raid-command.js reads process.env directly to keep bot.js as
  // the single registration surface without having to plumb a shared config.
  function isTextMonitorEnabled() {
    return process.env.TEXT_MONITOR_ENABLED !== "false";
  }
  const BOT_CHANNEL_PERMS = [
    { flag: PermissionFlagsBits.ViewChannel, label: "View Channel" },
    { flag: PermissionFlagsBits.SendMessages, label: "Send Messages" },
    { flag: PermissionFlagsBits.ManageMessages, label: "Manage Messages" },
    // ReadMessageHistory is required by clearPendingHint's `channel.messages.fetch(id)`
    // - without it, the fetch throws and persistent hints never auto-clean.
    { flag: PermissionFlagsBits.ReadMessageHistory, label: "Read Message History" },
    // EmbedLinks is required for welcome + success embeds to render. Discord
    // silently strips embeds from bots that lack this permission, leaving
    // users with an empty or text-only message.
    { flag: PermissionFlagsBits.EmbedLinks, label: "Embed Links" },
  ];
  const ANNOUNCEMENT_CHANNEL_PERMS = [
    { flag: PermissionFlagsBits.ViewChannel, label: "View Channel" },
    { flag: PermissionFlagsBits.SendMessages, label: "Send Messages" },
  ];
  function getMissingChannelPermissions(channel, botMember, requiredPerms) {
    if (!channel || !botMember) return requiredPerms.map((p) => p.label);
    const perms = channel.permissionsFor(botMember);
    if (!perms) return requiredPerms.map((p) => p.label);
    return requiredPerms.filter((p) => !perms.has(p.flag)).map((p) => p.label);
  }
  function getMissingBotChannelPermissions(channel, botMember) {
    return getMissingChannelPermissions(channel, botMember, BOT_CHANNEL_PERMS);
  }
  function getMissingAnnouncementChannelPermissions(channel, botMember) {
    return getMissingChannelPermissions(channel, botMember, ANNOUNCEMENT_CHANNEL_PERMS);
  }
  const RAID_ALIASES = new Map([
    ["armoche", "armoche"],
    ["act4",    "armoche"],
    ["kazeros", "kazeros"],
    ["kaz",     "kazeros"],
    ["serca",   "serca"],
    // Common letter-swap typo of "Serca" - Lost Ark SEA/VN players hit this
    // frequently. Accept as an alias so /raid-channel monitor doesn't silent-
    // ignore the whole message.
    ["secra",   "serca"],
  ]);
  const DIFFICULTY_ALIASES = new Map([
    ["nightmare", "nightmare"],
    ["9m",        "nightmare"],
    ["hard",      "hard"],
    ["hm",        "hard"],
    ["normal",    "normal"],
    ["nor",       "normal"],
    // `nm` now maps to normal (not nightmare) per Traine's VN-community
    // preference where "nm" reads as nor-mal more naturally. Nightmare
    // shorthand is `9m` only. Breaking for anyone who was typing `nm` for
    // nightmare, but the 2-operator deployment makes the blast radius small.
    ["nm",        "normal"],
  ]);
  const GATE_TOKEN_RE = /^g([1-9])$/;
  /**
   * Parse a short message posted in the guild's configured raid channel into a
   * raid-set intent. Format is liberal: whitespace, `+`, or `,` as separators;
   * case-insensitive; tokens can appear in any order.
   *
   * Accepted patterns:
   *   "{raid} {difficulty} {character}"            → complete (all gates)
   *   "{raid} {difficulty} {character} G_N"        → process, handler
   *                                                  cumulatively expands to
   *                                                  gates G1..G_N so one
   *                                                  post captures the full
   *                                                  progression
   *
   * Raid aliases: act 4 / act4 / armoche · kazeros / kaz · serca
   * Difficulty aliases: normal / nor / nm · hard / hm · nightmare / 9m
   * Gate pattern: G1..G9 (validated downstream against raid's gate list)
   *
   * Returns:
   *   - null if the message is not a raid update at all (silent ignore)
   *   - { error: "multi-gate", gates: [...] } if raid+diff+char parse but
   *     multiple distinct gates appear (ambiguous intent - should reply)
   *   - { raidKey, modeKey, charName, gate } on success
   *
   * The parser tokenizes by separators and matches each token against an exact
   * alias map. That avoids the non-ASCII word-boundary traps of `\b` regexes
   * and makes character names safe even if they contain substring of an alias
   * (e.g. "Normalize", "Hardman", "Kazan" all remain intact as char names).
   */
  function parseRaidMessage(content) {
    const raw = String(content || "").trim();
    if (!raw) return null;
    // Collapse "act 4" / "act  4" into a single "act4" token so it survives
    // whitespace-based tokenization. Done before separator normalization.
    const normalized = raw
      .replace(/act\s+4/gi, "act4")
      .replace(/[+,]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) return null;
    const tokens = normalized.toLowerCase().split(" ").filter(Boolean);
    if (tokens.length < 3) return null; // need at least raid + diff + char
    const raidSet = new Set();
    const diffSet = new Set();
    const gateSet = new Set();
    const leftover = [];
    for (const tok of tokens) {
      if (RAID_ALIASES.has(tok)) {
        raidSet.add(RAID_ALIASES.get(tok));
        continue;
      }
      if (DIFFICULTY_ALIASES.has(tok)) {
        diffSet.add(DIFFICULTY_ALIASES.get(tok));
        continue;
      }
      const gateMatch = tok.match(GATE_TOKEN_RE);
      if (gateMatch) {
        gateSet.add(`G${gateMatch[1]}`);
        continue;
      }
      leftover.push(tok);
    }
    // Need raid + diff + char tokens for this to look like a raid-update intent.
    if (raidSet.size === 0 || diffSet.size === 0) return null;
    if (leftover.length === 0) return null;
    // Ambiguous intent - user named two different raids or difficulties in the
    // same message. Surface as an explicit parse error so the handler can tell
    // them, instead of letting the second alias fall through to `charName` and
    // produce a misleading "character not found" reply.
    if (raidSet.size > 1) {
      return { error: "multi-raid", raids: [...raidSet] };
    }
    if (diffSet.size > 1) {
      return { error: "multi-difficulty", difficulties: [...diffSet] };
    }
    if (gateSet.size > 1) {
      return { error: "multi-gate", gates: [...gateSet] };
    }
    // Multi-character support: each leftover token is treated as its own
    // character name. Lost Ark NA/SEA names are always single-word so
    // token boundaries map cleanly to character boundaries. Dedup via Set
    // so "Priscilladuk, Priscilladuk, Nailaduk" collapses to 2 unique
    // targets and the write is idempotent.
    const charNames = [...new Set(leftover.filter(Boolean))];
    return {
      raidKey: [...raidSet][0],
      modeKey: [...diffSet][0],
      charNames,
      gate: [...gateSet][0] || null,
    };
  }
  /**
   * Build a single aggregated embed summarizing the outcome of applying one
   * raid update across multiple characters in one channel message. Buckets
   * results by status (done / already complete / not found / ineligible /
   * errored) so the user reads one tidy card instead of N separate DMs -
   * works equally well when N === 1 (single-char) since buckets collapse.
   */
  function buildRaidChannelMultiResultEmbed({
    results,
    raidMeta,
    gates,
    statusType,
    guildName,
  }) {
    const gatesText = Array.isArray(gates) && gates.length > 0 ? gates.join(", ") : "All gates";
    const scopeLabel =
      statusType === "process" && Array.isArray(gates) && gates.length > 0
        ? `${raidMeta.label} · ${gatesText}`
        : raidMeta.label;
    const done = [];
    const already = [];
    const notFound = [];
    const ineligible = [];
    const errored = [];
    for (const r of results) {
      const display = r.displayName || r.charName;
      if (r.error) errored.push(r.charName);
      else if (r.updated) done.push(display);
      else if (r.alreadyComplete) already.push(display);
      else if (!r.matched) notFound.push(r.charName);
      else ineligible.push(`${display} (iLvl ${r.ineligibleItemLevel})`);
    }
    const hasProgress = done.length > 0 || already.length > 0;
    const anyError = notFound.length > 0 || ineligible.length > 0 || errored.length > 0;
    const color = hasProgress && !anyError ? UI.colors.success : UI.colors.progress;
    const titleIcon = hasProgress ? UI.icons.done : UI.icons.info;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${titleIcon} Raid Update · ${scopeLabel}`)
      .setDescription(`Tớ đã xử lý raid cho ${results.length} character~`)
      .setTimestamp();
    if (done.length > 0) {
      embed.addFields({
        name: `${UI.icons.done} Updated (${done.length})`,
        value: done.map((n) => `**${n}**`).join(", "),
      });
    }
    if (already.length > 0) {
      embed.addFields({
        name: `${UI.icons.info} Đã DONE từ trước (${already.length})`,
        value: already.map((n) => `**${n}**`).join(", "),
      });
    }
    if (notFound.length > 0) {
      embed.addFields({
        name: `${UI.icons.warn} Không tìm thấy trong roster (${notFound.length})`,
        value: notFound.map((n) => `\`${n}\``).join(", "),
      });
    }
    if (ineligible.length > 0) {
      embed.addFields({
        name: `${UI.icons.warn} Chưa đủ iLvl cho ${raidMeta.label} (cần ${raidMeta.minItemLevel}+)`,
        value: ineligible.join("\n"),
      });
    }
    if (errored.length > 0) {
      embed.addFields({
        name: `${UI.icons.warn} Lỗi hệ thống`,
        value: errored.map((n) => `\`${n}\``).join(", "),
      });
    }
    if (guildName) embed.setFooter({ text: `Server: ${guildName}` });
    return embed;
  }
  function buildRaidChannelAlreadyCompleteEmbed({
    charName,
    raidMeta,
    gates,
    statusType,
    guildName,
  }) {
    const gatesText = Array.isArray(gates) && gates.length > 0 ? gates.join(", ") : "All gates";
    const isSingleOrPartial = statusType === "process" && Array.isArray(gates) && gates.length > 0;
    const scopeLabel = isSingleOrPartial ? `${raidMeta.label} · ${gatesText}` : raidMeta.label;
    const embed = new EmbedBuilder()
      .setColor(UI.colors.progress)
      .setTitle(`${UI.icons.info} Raid đã DONE từ trước rồi~`)
      .setDescription(
        `**${charName}** đã clear **${scopeLabel}** tuần này rồi nhé. Tớ không update lại đâu - để tránh overwriting progress cậu đã có.`
      )
      .addFields(
        { name: "Character", value: `**${charName}**`, inline: true },
        { name: "Raid", value: `**${raidMeta.label}**`, inline: true },
        { name: "Gates", value: gatesText, inline: true },
        {
          name: "Muốn reset?",
          value: "Dùng `/raid-set character:<name> raid:<raid> status:reset` nếu cậu thật sự muốn mark-chưa-done cái này (ví dụ bị write nhầm).",
        }
      )
      .setTimestamp();
    if (guildName) embed.setFooter({ text: `Server: ${guildName}` });
    return embed;
  }
  function buildRaidChannelSuccessEmbed({
    charName,
    raidMeta,
    gates,
    statusType,
    selectedDifficulty,
    modeResetCount,
    guildName,
  }) {
    const isProcess = statusType === "process";
    const title = isProcess
      ? `${UI.icons.done} Gate${Array.isArray(gates) && gates.length > 1 ? "s" : ""} Completed`
      : `${UI.icons.done} Raid Completed`;
    const gatesText = Array.isArray(gates) && gates.length > 0 ? gates.join(", ") : "All gates";
    const embed = new EmbedBuilder()
      .setColor(UI.colors.success)
      .setTitle(title)
      .setDescription(`Tớ đã update progress cho **${charName}** rồi nha~`)
      .addFields(
        { name: "Character", value: `**${charName}**`, inline: true },
        { name: "Raid", value: `**${raidMeta.label}**`, inline: true },
        { name: "Gates", value: gatesText, inline: true }
      )
      .setTimestamp();
    if (guildName) embed.setFooter({ text: `Server: ${guildName}` });
    if (modeResetCount > 0) {
      embed.addFields({
        name: `${UI.icons.reset} Note`,
        value: `Đã chuyển mode sang **${selectedDifficulty}** - progress mode cũ được clear cho state consistent.`,
      });
    }
    return embed;
  }
  function buildRaidChannelWelcomeEmbed() {
    return new EmbedBuilder()
      .setColor(UI.colors.neutral)
      // Artist persona emoji (chibi "shy" face) replaces the legacy
      // generic 🦊 fox. Resolved at render-time from the ARTIST_EMOJI_MAP
      // that the artist-emoji bootstrap populates on ClientReady - so
      // the actual emoji ID is bot-application-owned (works in every
      // guild the bot joins) and refreshes automatically when the
      // source PNG content changes.
      //
      // Empty-string fallback when the bootstrap hasn't completed yet
      // means the title degrades to "Chào các bạn~..." without an
      // icon prefix - cleaner than rendering literal `<:shy:0>` text.
      .setTitle(`${getArtistEmoji("shy")} Chào các bạn~ Artist ngồi trông channel này nhé`.trim())
      .setDescription(
        [
          "Mỗi lần clear raid xong, cứ post 1 tin nhắn ngắn dạng `<raid> <difficulty> <character[, character2, ...]> [gate]` vào đây là Artist sẽ tự đánh dấu progress giúp cậu, xong tớ dọn luôn tin nhắn cho channel khỏi rối nha~",
          "",
          "**Artist chỉ update được character trong roster của chính bạn thôi đấy.** Chưa có roster thì xem field bên dưới để biết bắt đầu từ đâu nha.",
        ].join("\n")
      )
      .addFields(
        {
          // Onboarding workflow lives in the first field so một newcomer
          // scan pin top-down sẽ gặp 3 bước trước docs format post.
          // Word choice: ưu tiên VN cho động từ thường (lấy/chọn/theo dõi/
          // thêm/bỏ/xem) — giữ lại các từ technical / nhãn nút thật
          // (`picker`, `Confirm`, `command`, `language`) để khớp UI thật.
          name: "🚀 Mới vào server? Bắt đầu ở đây",
          value: [
            "1. `/add-roster name:<tên-char-bất-kỳ>` → Artist lấy roster từ lostark.bible, mở picker để cậu chọn ✅ chars muốn theo dõi rồi bấm **Confirm**.",
            "2. `/edit-roster roster:<tên>` → sau này muốn thêm chars mới vào roster đã có hoặc bỏ chars không còn chơi.",
            "3. `/raid-status` → xem tiến độ raid mọi lúc · `/raid-help` → tài liệu đầy đủ mọi lệnh (có tuỳ chọn `language: English`).",
          ].join("\n"),
        },
        {
          name: "📌 Ví dụ cho dễ hình dung",
          value: [
            "`Serca Nightmare Clauseduk` → mark cả Serca Nightmare là DONE (tất cả gate)",
            "`Kazeros Hard Soulrano G1` → mark G1 của Kazeros Hard (chưa clear tới G2)",
            "`Serca Nor Soulrano G2` → mark **G1 + G2** của Serca Normal (cumulative - đi tới G2 nghĩa là G1 cũng đã qua)",
            "`Act4 Hard Priscilladuk, Nailaduk` → mark Act 4 Hard done cho **cả 2 character** trong 1 post (multi-char; dedup tự động)",
          ].join("\n"),
        },
        {
          name: "🏷️ Alias Artist nhận (không phân biệt hoa thường)",
          value: [
            "**Raid**: `act 4` / `act4` / `armoche` · `kazeros` / `kaz` · `serca`",
            "**Difficulty**: `normal` / `nor` / `nm` · `hard` / `hm` · `nightmare` / `9m`",
            "**Gate**: `G1`, `G2` - chỉ dùng khi muốn đánh dấu đúng 1 gate",
            "**Separator**: space, `+`, hay `,` đều xài được hết",
          ].join("\n"),
        },
        {
          name: "⚠️ Vài chuyện Artist muốn nhắc nhỏ",
          value: [
            "• Character phải đủ iLvl cho raid đó, không tớ sẽ nhắc khẽ~",
            "• Gõ tin nhắn không giống format → tớ im lặng, không spam channel đâu.",
            "• Gõ đúng nhưng có lỗi (không tìm thấy char, iLvl thiếu, nhiều raid/difficulty/gate lẫn lộn) → Artist ping nhẹ nhàng; tin nhắn đó sẽ tự dọn khi bạn post lại, hoặc sau 5 phút nếu quên.",
            "• Post đúng → Artist tag bạn ngay trong channel báo nhận được rồi, kèm DM embed confirm riêng; 5 giây sau tớ dọn cả tin gốc lẫn biển tag. Nếu DM bị tắt, tớ sẽ ping public ngắn rồi tự xóa sau 15 giây.",
            "• Post 1 raid đã clear từ trước → tớ DM notice riêng báo đã DONE rồi, không update lại. Tránh overwrite progress tuần này. Muốn reset thật sự thì dùng `/raid-set` với `status:reset`.",
            "• Post cách nhau ít nhất **2 giây** nha~ Spam nhanh quá tớ sẽ im lặng bỏ qua và nhắc khéo 1 lần.",
          ].join("\n"),
        },
        {
          name: "📣 Artist sẽ tự nói trong channel này khi nào",
          value: [
            "• **Mỗi 30 phút (giờ VN, từ 8h sáng đến 3h đêm)**: Artist tự dọn rác channel, post 1 biển báo tone đổi theo lượng rác (sạch sẵn / nhẹ / bình thường / nhiều), biển tự biến sau 5 phút.",
            "• **3h đêm (giờ VN)**: Artist đi ngủ, post 1 biển báo gn rồi tạm nghỉ đến 8h sáng - trong khoảng này không dọn rác cũng không ồn ào, nhưng raid clear các cậu post vẫn được ghi nhận bình thường.",
            "• **8h sáng (giờ VN)**: Artist dậy, sweep 1 lần catch-up đống tin tích đêm qua + post 1 biển báo chào ngày mới, biển tự biến sau 10 phút.",
            "• **Thứ 4 17:00 VN (mỗi tuần)**: Artist thông báo progress raid vừa được reset tuần mới, biển tự biến sau 30 phút.",
            "• **Khi có người vừa set channel này**: Artist post 1 dòng chào hỏi, tự biến sau 2 phút (welcome pin thì ở lại).",
            "• **Khi có member bật `/raid-auto-manage` mà toàn char private log**: Artist sẽ tag khẽ nhắc bật Public Log ở lostark.bible, tối đa 1 lần mỗi 7 ngày.",
          ].join("\n"),
        },
        {
          name: "🤖 Lười post? Bật `/raid-auto-manage` nhé",
          value: [
            "Gõ `/raid-auto-manage action:on` để tớ tự update raid progress cho cậu, không cần post thủ công nha~",
            "Nhớ bật **Public Log** cho từng char muốn sync tại <https://lostark.bible/me/logs> trước nha.",
          ].join("\n"),
        },
        {
          name: "👑 Ghi chú bé xíu",
          value: "Thi thoảng cậu sẽ bắt gặp vài roster đội `👑` thay cho `📁`. Artist quen vài người thôi mà~",
        },
        {
          name: "🛡️ ⚔️ Icon trong dropdown nghĩa là gì?",
          value: [
            "Khi cậu xem `/raid-status` hay `/raid-check`, dropdown filter sẽ kèm 2 icon nho nhỏ phân loại pending count:",
            "• `🛡️` = **Support** (Bard / Paladin / Artist / Valkyrie)",
            "• `⚔️` = **DPS** (mọi class còn lại)",
            "Ví dụ `Du (8 pending · 2🛡️ 6⚔️)` = Du còn 8 char chưa clear raid, trong đó 2 sup + 6 DPS. Để Raid Manager nhìn 1 phát biết comp còn thiếu role nào.",
          ].join("\n"),
        }
      )
      .setFooter({ text: "Muốn xem hướng dẫn đầy đủ tất cả lệnh? Gõ /raid-help nhé~" });
  }
  async function postTransientReply(message, content) {
    try {
      const reply = await message.reply({ content, allowedMentions: { repliedUser: false } });
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 10_000);
    } catch (err) {
      console.warn("[raid-channel] reply failed:", err?.message || err);
    }
  }
  const emptyContentWarningAt = new Map(); // guildId:channelId -> unix ms
  const EMPTY_CONTENT_WARNING_COOLDOWN_MS = 5 * 60 * 1000;
  async function postEmptyContentWarning(message) {
    const key = `${message.guildId}:${message.channelId}`;
    const now = Date.now();
    const last = emptyContentWarningAt.get(key) || 0;
    if (now - last < EMPTY_CONTENT_WARNING_COOLDOWN_MS) return;
    emptyContentWarningAt.set(key, now);
    await postTransientReply(
      message,
      `${UI.icons.warn} Ớ kìa, tin của cậu bay qua rồi nhưng Artist không đọc được chữ nào hết... Không phải lỗi của cậu đâu nha, chắc tớ đang rối mấy cài đặt bên trong. Phiền cậu nhờ chủ bot xem hộ giúp Artist xíu, sửa xong cậu gõ lại là tớ bắt được ngay~`
    );
  }
  // Persistent per-user hint tracker: when a user posts a recoverable-error
  // message, the bot pings them (reply with default repliedUser mention) and
  // keeps the hint visible until they retype. On the next message from the
  // same user in the same channel - success or a fresh error - the previous
  // hint is cleaned up. TTL auto-cleanup runs 5 minutes after post in case
  // the user never retries.
  const pendingChannelHints = new Map(); // "guildId:channelId:userId" -> { hintId, timerId }
  const HINT_TTL_MS = 5 * 60 * 1000;
  function hintKey(guildId, channelId, userId) {
    return `${guildId}:${channelId}:${userId}`;
  }
  async function clearPendingHint(channel, key) {
    const entry = pendingChannelHints.get(key);
    if (!entry) return;
    pendingChannelHints.delete(key);
    if (entry.timerId) clearTimeout(entry.timerId);
    // Delete BOTH the bot's hint reply and the user's original failed message
    // so the channel looks clean after retry. Best-effort: either may already
    // be gone (user deleted manually, hint TTL expired, etc.), swallow errors.
    const ids = [entry.hintId];
    if (entry.originalId) ids.push(entry.originalId);
    await Promise.allSettled(
      ids.map(async (id) => {
        try {
          const msg = await channel.messages.fetch(id);
          await msg.delete();
        } catch {
          // Already deleted or not fetchable - skip.
        }
      })
    );
  }
  // Per-user spam guard for the monitor channel. Silent-ignore on parse-null
  // already handles chat noise - this layer only fires on parse-success
  // messages that would actually cause bot work (hint posting, DM sending,
  // message deletion, or DB writes). Three sliding-window counters prevent
  // both accidental double-taps and deliberate spam, and the warning is
  // deduped so a sustained spammer only gets "quạo'd at" once per minute.
  const userMonitorCooldowns = new Map(); // key -> { lastProcessedAt, spamHits, spamWindowStart, warnedAt }
  const MONITOR_COOLDOWN_MS = 2000;     // min 2s between processed messages per user
  const MONITOR_SPAM_WINDOW_MS = 10000; // sliding window for counting spam hits
  const MONITOR_SPAM_THRESHOLD = 3;     // cooldown-hits within window → trigger warning
  const MONITOR_SPAM_WARN_CD_MS = 60000;// dedup: one warning per user per minute
  /**
   * Check whether a user's message should be accepted under the per-user
   * cooldown. Content-aware with a pending-hint exception that is LIMITED
   * to one quick retry per cooldown window (otherwise the exception would
   * let a user vary content indefinitely while cooldown still theoretically
   * applies, since each failed attempt replaces the pending hint and looks
   * like a "fresh" correction flow):
   *
   *   - within cooldown + same content → DROP (duplicate spam)
   *   - within cooldown + different content + pending hint + no recent
   *     exception yet → ACCEPT via one-shot exception (round 14 typo-fix)
   *   - within cooldown + different content + exception already consumed
   *     in this window → DROP (caught by round 16 Codex as a bypass)
   *   - within cooldown + different content + no pending hint → DROP (fresh
   *     post right after a successful write; hard throttle)
   *   - outside cooldown → ACCEPT
   *
   * Returns { accepted, warn, viaException }. commitUserMonitorActivity
   * must be called right after an accept, passing `viaException` so
   * `lastExceptionAt` is bumped (or reset to 0 on a normal fresh accept).
   */
  function checkUserMonitorCooldown(message) {
    const key = hintKey(message.guildId, message.channelId, message.author.id);
    const now = Date.now();
    const contentKey = normalizeName(message.content);
    const entry = userMonitorCooldowns.get(key) || {
      lastProcessedAt: 0,
      lastContent: "",
      lastExceptionAt: 0,
      spamHits: 0,
      spamWindowStart: 0,
      warnedAt: 0,
    };
    const withinCooldown = now - entry.lastProcessedAt < MONITOR_COOLDOWN_MS;
    if (withinCooldown) {
      const sameContent = contentKey && contentKey === entry.lastContent;
      const hasPendingHint = pendingChannelHints.has(key);
      const recentException = now - (entry.lastExceptionAt || 0) < MONITOR_COOLDOWN_MS;
      // Correction-flow exception - ONE retry per cooldown window, not
      // per hint (hint churn from repeated failures kept resetting the
      // per-hint flag, letting a user vary content forever).
      if (hasPendingHint && !sameContent && !recentException) {
        return { accepted: true, warn: false, viaException: true };
      }
      // Otherwise drop. Bump spam tracking and maybe emit a warning.
      if (now - entry.spamWindowStart > MONITOR_SPAM_WINDOW_MS) {
        entry.spamHits = 1;
        entry.spamWindowStart = now;
      } else {
        entry.spamHits += 1;
      }
      const shouldWarn =
        entry.spamHits >= MONITOR_SPAM_THRESHOLD &&
        now - entry.warnedAt > MONITOR_SPAM_WARN_CD_MS;
      if (shouldWarn) entry.warnedAt = now;
      userMonitorCooldowns.set(key, entry);
      return { accepted: false, warn: shouldWarn, viaException: false };
    }
    return { accepted: true, warn: false, viaException: false };
  }
  function commitUserMonitorActivity(message, viaException = false) {
    const key = hintKey(message.guildId, message.channelId, message.author.id);
    const now = Date.now();
    const contentKey = normalizeName(message.content);
    const entry = userMonitorCooldowns.get(key) || {
      lastProcessedAt: 0,
      lastContent: "",
      lastExceptionAt: 0,
      spamHits: 0,
      spamWindowStart: 0,
      warnedAt: 0,
    };
    entry.lastProcessedAt = now;
    entry.lastContent = contentKey;
    // Track exception use. Fresh cooldown passes (non-exception) reset the
    // exception slot to 0 so the next hint-triggered retry gets its one shot.
    entry.lastExceptionAt = viaException ? now : 0;
    entry.spamHits = 0;
    entry.spamWindowStart = 0;
    userMonitorCooldowns.set(key, entry);
  }
  async function postSpamWarning(message) {
    try {
      const reply = await message.reply({
        content: `💢 Này ơi, tớ theo không kịp đâu~ Mỗi tin cách nhau ít nhất 2 giây thôi nhé, không Artist im lặng ignore đấy!`,
      });
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 15_000);
    } catch (err) {
      console.warn("[raid-channel] spam warning post failed:", err?.message || err);
    }
  }
  async function postPersistentHint(message, content) {
    const key = hintKey(message.guildId, message.channelId, message.author.id);
    await clearPendingHint(message.channel, key);
    try {
      const hint = await message.reply({ content });
      const timerId = setTimeout(() => {
        clearPendingHint(message.channel, key).catch(() => {});
      }, HINT_TTL_MS);
      // Track the user's original failed message too so the next clear (retry
      // success or replacement hint) wipes the whole failed exchange, not just
      // the bot's reply.
      pendingChannelHints.set(key, {
        hintId: hint.id,
        originalId: message.id,
        timerId,
      });
    } catch (err) {
      console.warn("[raid-channel] persistent hint failed:", err?.message || err);
    }
  }
  async function handleRaidChannelMessage(message) {
    // Cheap filters BEFORE touching the cache: skip DMs, system messages,
    // webhooks, bot authors, and empty content. MessageCreate fires for all
    // of these and most of them will never map to a raid intent anyway.
    if (!message) return;
    if (!message.guildId) return;
    if (message.author?.bot) return;
    if (message.system) return;
    if (message.webhookId) return;
    // Cache lookup - no Mongo hit on the hot path. Miss means no config or
    // this channel isn't the configured monitor.
    const cachedChannelId = getCachedMonitorChannelId(message.guildId);
    if (!cachedChannelId || cachedChannelId !== message.channelId) return;
    if (!message.content || !message.content.trim()) {
      await postEmptyContentWarning(message);
      return;
    }
    const userHintKey = hintKey(message.guildId, message.channelId, message.author.id);
    const parsed = parseRaidMessage(message.content);
    if (!parsed) return; // Silent ignore: not a raid-update message.
    // Per-user cooldown gate: stops a spammer from triggering bursts of
    // postPersistentHint / DM / delete cycles. Chat noise (parse-null) is
    // already silent so unaffected. Sustained spam above threshold trips a
    // one-shot annoyed-kitsune warning, deduped per minute per user.
    //
    // The check is content-aware with a pending-hint exception, so:
    //   - Spam of duplicate content within 2s is dropped.
    //   - Typo → hint → correct-with-new-content within 2s passes through
    //     because the user has a pending hint (active correction flow).
    //   - Fresh writes back-to-back within 2s of a successful write are
    //     dropped as hard throttling.
    //
    // Commit happens immediately after a check-pass so the NEXT message
    // sees the right lastContent / timestamp, regardless of whether this
    // message ends up on the success path or an error path. Content-aware
    // logic handles the round-14 goal (retries after hints work) without
    // needing to defer the commit.
    const cooldown = checkUserMonitorCooldown(message);
    if (!cooldown.accepted) {
      if (cooldown.warn) await postSpamWarning(message);
      // Delete the throttled message so the channel doesn't accumulate
      // ignored attempts as visible text. Best-effort; swallow errors.
      message.delete().catch(() => {});
      return;
    }
    commitUserMonitorActivity(message, cooldown.viaException);
    if (parsed.error === "multi-gate") {
      await postPersistentHint(
        message,
        `${UI.icons.warn} Có nhiều gate (${parsed.gates.join(", ")}) trong message. Mỗi lần chỉ update 1 gate - post lại với 1 gate hoặc bỏ gate để đánh DONE cả raid nha.`
      );
      return;
    }
    if (parsed.error === "multi-raid") {
      await postPersistentHint(
        message,
        `${UI.icons.warn} Message chứa nhiều raid khác nhau (${parsed.raids.join(", ")}). Chọn đúng 1 raid rồi post lại nha.`
      );
      return;
    }
    if (parsed.error === "multi-difficulty") {
      await postPersistentHint(
        message,
        `${UI.icons.warn} Message chứa nhiều difficulty khác nhau (${parsed.difficulties.join(", ")}). Chọn đúng 1 difficulty rồi post lại nha.`
      );
      return;
    }
    const { raidKey, modeKey, charNames, gate } = parsed;
    const raidValue = `${raidKey}_${modeKey}`;
    const raidMeta = RAID_REQUIREMENT_MAP[raidValue];
    if (!raidMeta) {
      await postPersistentHint(message, `${UI.icons.warn} Combo \`${raidKey} ${modeKey}\` không tồn tại. Check lại raid + difficulty rồi post lại nha.`);
      return;
    }
    if (gate) {
      const validGates = getGatesForRaid(raidMeta.raidKey);
      if (!validGates.includes(gate)) {
        await postPersistentHint(
          message,
          `${UI.icons.warn} Gate **${gate}** không có cho **${raidMeta.label}**. Gates hợp lệ: ${validGates.map((g) => `\`${g}\``).join(", ")}. Post lại với gate đúng nha.`
        );
        return;
      }
    }
    if (!Array.isArray(charNames) || charNames.length === 0) {
      // Defensive - parser should have returned null in this case.
      return;
    }
    const statusType = gate ? "process" : "complete";
    // Cumulative gate expansion: posting `G2` means "cleared up to G2" in
    // Lost Ark sequential progression (G1 is a prereq for G2 in-game, so
    // you can't reach G2 without G1). Expand the single parsed gate into
    // the full prefix [G1..G_N] so one post captures the whole progress.
    let effectiveGates = [];
    if (gate) {
      const allGates = getGatesForRaid(raidMeta.raidKey);
      const gateIndex = allGates.indexOf(gate);
      effectiveGates = gateIndex >= 0 ? allGates.slice(0, gateIndex + 1) : [gate];
    }
    // Process each character in the message. One message → one cooldown
    // slot regardless of how many chars the user lists; write path runs
    // per character with shared raid+gate target.
    const results = [];
    let hadNoRoster = false;
    for (const charName of charNames) {
      try {
        const r = await applyRaidSetForDiscordId({
          discordId: message.author.id,
          characterName: charName,
          raidMeta,
          statusType,
          effectiveGates,
        });
        results.push({ charName, ...r });
        if (r.noRoster) {
          hadNoRoster = true;
          break; // no point checking more chars when the user has no roster at all
        }
      } catch (err) {
        console.error(`[raid-channel] write for "${charName}" failed:`, err?.message || err);
        results.push({
          charName,
          error: err?.message || String(err),
          matched: false,
          updated: false,
          alreadyComplete: false,
        });
      }
    }
    if (hadNoRoster) {
      await postPersistentHint(
        message,
        `${UI.icons.info} Cậu chưa có roster. Dùng \`/add-roster\` trước rồi quay lại post clear nha.`
      );
      return;
    }
    const successCount = results.filter((r) => r.updated).length;
    const alreadyCount = results.filter((r) => r.alreadyComplete).length;
    const notFoundResults = results.filter((r) => !r.matched && !r.error);
    const ineligibleResults = results.filter((r) => r.matched && !r.updated && !r.alreadyComplete);
    const errorResults = results.filter((r) => r.error);
    const hasProgress = successCount > 0 || alreadyCount > 0;
    const hasErrors =
      notFoundResults.length > 0 || ineligibleResults.length > 0 || errorResults.length > 0;
    // Build an aggregated embed for DM - covers both single-char and multi-char
    // cases, and groups results by status so the user sees one tidy card.
    const aggregateEmbed = buildRaidChannelMultiResultEmbed({
      results,
      raidMeta,
      gates: effectiveGates,
      statusType,
      guildName: message.guild?.name,
    });
    // DM the aggregate for a private record. Public fallback when DM is
    // disabled. Only attempted if we actually processed something useful
    // (some progress OR enough info to be worth surfacing).
    let dmSucceeded = false;
    if (hasProgress || hasErrors) {
      try {
        await message.author.send({ embeds: [aggregateEmbed] });
        dmSucceeded = true;
      } catch (err) {
        console.warn(
          `[raid-channel] DM to ${message.author.tag || message.author.id} failed (DMs disabled?):`,
          err?.message || err
        );
      }
    }
    const ops = [];
    // When ANY error is present, post a persistent hint in the channel so
    // the user visibly gets pinged about the specific bad names - even if
    // some other names succeeded. Traine: "gõ đầu user nếu gõ sai".
    if (hasErrors) {
      const hintLines = [];
      if (notFoundResults.length > 0) {
        hintLines.push(
          `${UI.icons.warn} Không tìm thấy trong roster: ${notFoundResults
            .map((r) => `\`${r.charName}\``)
            .join(", ")}`
        );
      }
      if (ineligibleResults.length > 0) {
        hintLines.push(
          `${UI.icons.warn} Chưa đủ iLvl cho **${raidMeta.label}** (cần **${raidMeta.minItemLevel}+**): ${ineligibleResults
            .map((r) => `**${r.displayName || r.charName}** (iLvl ${r.ineligibleItemLevel})`)
            .join(", ")}`
        );
      }
      if (errorResults.length > 0) {
        hintLines.push(
          `${UI.icons.warn} Lỗi hệ thống khi update: ${errorResults
            .map((r) => `\`${r.charName}\``)
            .join(", ")}`
        );
      }
      if (hasProgress) {
        hintLines.push(
          `_(Các character hợp lệ khác trong post của bạn đã được update rồi - check DM cho chi tiết.)_`
        );
      } else {
        hintLines.push(`_(Sửa lại rồi post lại nhé, tớ sẽ tự dọn hint cũ.)_`);
      }
      ops.push(postPersistentHint(message, hintLines.join("\n")));
    }
    // Delete the source message only when there's actual progress to record.
    // If everything failed, keep the message so the user can see what they
    // posted + the hint next to it, easier to retype correctly.
    if (hasProgress) {
      // When DM was the delivery path, post a whisper acknowledgement that
      // tags the user so they realise the post was accepted (otherwise the
      // message just silently vanishes and feels like a rejection). Dusk's
      // whisper voice, but still signed as Artist per bot persona.
      // Whisper ack can be disabled per-guild via /raid-announce. Load the
      // flag BEFORE attempting send so a disabled guild skips entirely
      // (no transient message flicker while it's auto-deleted).
      let whisperAckEnabled = true;
      try {
        const cfg = await GuildConfig.findOne({ guildId: message.guildId })
          .select("announcements.whisperAck")
          .lean();
        whisperAckEnabled = getAnnouncementsConfig(cfg).whisperAck.enabled;
      } catch {
        // Read fail → default to enabled (conservative: announce rather
        // than silently drop - Traine's intent with this flow was visibility).
      }
      let whisperMsg = null;
      if (dmSucceeded && whisperAckEnabled) {
        try {
          whisperMsg = await message.channel.send({
            content: `<@${message.author.id}> ...Artist nhận được rồi nha~ Chờ Artist 5 giây gửi kết quả qua DM cho cậu nhé...`,
            allowedMentions: { users: [message.author.id] },
          });
        } catch (err) {
          console.warn("[raid-channel] whisper confirm failed:", err?.message || err);
        }
      }
      // Delay deletion so the user has time to notice the whisper before
      // both messages disappear. Fire-and-forget - no reason to make the
      // handler sit around for 5s just to await a delete.
      setTimeout(() => {
        message.delete().catch((err) => {
          console.warn("[raid-channel] delete failed (missing Manage Messages?):", err?.message || err);
        });
        if (whisperMsg) {
          whisperMsg.delete().catch(() => {});
        }
      }, 5_000);
      // Also clear any stale pending hint from a previous bad post, now that
      // a real write landed.
      if (!hasErrors) {
        ops.push(clearPendingHint(message.channel, userHintKey));
      }
    }
    // Public fallback when DM failed AND there's progress to announce. Uses
    // channel.send with @mention so user still sees the update status when
    // their DMs are disabled. Only needed for success-path; errors already
    // post a public persistent hint above.
    if (hasProgress && !dmSucceeded) {
      const scope = effectiveGates.length > 0
        ? `${raidMeta.label} · ${effectiveGates.join(", ")}`
        : raidMeta.label;
      const doneNames = results
        .filter((r) => r.updated)
        .map((r) => `**${r.displayName || r.charName}**`)
        .join(", ");
      const alreadyNames = results
        .filter((r) => r.alreadyComplete)
        .map((r) => `**${r.displayName || r.charName}**`)
        .join(", ");
      const parts = [];
      if (doneNames) parts.push(`mark **${scope}** done cho ${doneNames}`);
      if (alreadyNames) parts.push(`${alreadyNames} đã clear **${scope}** từ trước`);
      const fallbackText = `${UI.icons.done} <@${message.author.id}> ${parts.join("; ")}. _(DM bị tắt - enable "Allow DMs from server members" để nhận confirm private.)_`;
      ops.push(
        (async () => {
          try {
            const fallback = await message.channel.send({
              content: fallbackText,
              allowedMentions: { users: [message.author.id] },
            });
            setTimeout(() => fallback.delete().catch(() => {}), 15_000);
          } catch (err) {
            console.warn("[raid-channel] DM fallback post failed:", err?.message || err);
          }
        })()
      );
    }
    await Promise.allSettled(ops);
  }
  /**
   * Delete every non-pinned message in the raid monitor channel. Paginates
   * through channel history via the `before` cursor in 100-message batches
   * (Discord's per-fetch cap) so busy channels with more than 100 messages
   * get cleaned all the way back. Uses `bulkDelete(messages, true)` so
   * messages older than 14 days are silently filtered out and counted as
   * `skippedOld` instead of failing the batch.
   *
   * Caller must verify the bot has Manage Messages + Read Message History
   * in the channel. Safety cap of 20 iterations (max 2000 messages per run)
   * prevents a runaway if history is unexpectedly huge - for a raid-clear
   * channel that's well above any realistic size.
   */
  async function cleanupRaidChannelMessages(channel) {
    const MAX_ITERATIONS = 20;
    let totalDeleted = 0;
    let totalSkippedOld = 0;
    let before;
    for (let iter = 0; iter < MAX_ITERATIONS; iter += 1) {
      const fetchOpts = { limit: 100 };
      if (before) fetchOpts.before = before;
      const fetched = await channel.messages.fetch(fetchOpts);
      if (fetched.size === 0) break;
      // Advance the pagination cursor to the oldest message in this batch,
      // regardless of whether we can delete any of it - this prevents an
      // infinite loop when a batch is all pinned.
      before = fetched.last()?.id;
      const toDelete = fetched.filter((m) => !m.pinned);
      if (toDelete.size > 0) {
        const deleted = await channel.bulkDelete(toDelete, true);
        totalDeleted += deleted.size;
        totalSkippedOld += toDelete.size - deleted.size;
      }
      // Less than a full batch means we reached the end of channel history.
      if (fetched.size < 100) break;
    }
    return { deleted: totalDeleted, skippedOld: totalSkippedOld };
  }
  /**
   * Unpin the stored welcome message (if any), then post + pin a fresh
   * welcome embed. Used by both `/raid-channel config action:set` (initial
   * welcome) and `/raid-channel config action:repin` (manual refresh). The
   * new welcome's message ID is persisted to `GuildConfig.welcomeMessageId`
   * so the next invocation can identify the exact pin to remove instead of
   * scanning every bot-authored pin (which would also tear down unrelated
   * bot pins).
   *
   * Returns an object reporting which steps succeeded so the caller can
   * decide whether to surface a warning to the admin.
   */
  async function postRaidChannelWelcome(channel, botUserId, guildId) {
    const outcome = { posted: false, pinned: false, persisted: false, removedOldCount: 0 };
    // Collect every STALE welcome we should delete when the fresh welcome
    // is safely in place. Two sources combined into a Set to dedupe:
    //   1. The DB-tracked `welcomeMessageId` - primary, explicit reference.
    //   2. Signature-match scan of currently-pinned bot messages whose
    //      embed title matches the welcome signature - catches orphans
    //      from earlier versions that pinned without DB tracking (exactly
    //      the case where real-user saw 2 pinned welcomes after round 17
    //      fix didn't clean up the pre-fix orphan).
    // Both collected BEFORE post/pin/persist of the new one, so the
    // fresh welcome's id (generated after this block) is guaranteed NOT
    // in the stale set.
    const staleIds = new Set();
    if (guildId) {
      try {
        const cfg = await GuildConfig.findOne({ guildId }).lean();
        if (cfg?.welcomeMessageId) staleIds.add(cfg.welcomeMessageId);
      } catch (err) {
        console.warn("[raid-channel] GuildConfig read for welcomeMessageId failed:", err?.message || err);
      }
    }
    try {
      // discord.js v14.18+ replaced the deprecated `fetchPinned()`
      // (which returned a Collection<id, Message>) with `fetchPins()`,
      // whose response shape is `{ items: MessagePin[], hasMore }` —
      // `items` is a plain array (NOT a Collection), and each entry is
      // a MessagePin wrapping the actual Message under `.message`.
      // Iterating the response object directly throws "pinned is not
      // iterable"; destructuring `[, msg]` from a MessagePin would also
      // give garbage. Discord caps pinned messages at 50 per channel
      // and one fetch returns up to 50, so `hasMore` is safely ignored
      // for the welcome-scan use case.
      const { items: pins = [] } = await channel.messages.fetchPins();
      for (const pin of pins) {
        const msg = pin?.message;
        if (!msg || msg.author?.id !== botUserId) continue;
        const title = msg.embeds?.[0]?.title || "";
        // Welcome title signature is stable across versions (kitsune +
        // "Artist ngồi trông channel này"). Match loose enough to survive
        // minor wording tweaks but specific enough to miss other bot pins.
        if (title.includes("Artist ngồi trông channel này")) {
          staleIds.add(msg.id);
        }
      }
    } catch (err) {
      console.warn("[raid-channel] fetchPins for stale-welcome scan failed:", err?.message || err);
    }
    const embed = buildRaidChannelWelcomeEmbed();
    try {
      const sent = await channel.send({ embeds: [embed] });
      outcome.posted = true;
      try {
        await sent.pin();
        outcome.pinned = true;
        // Only persist the new welcome ID after BOTH post AND pin succeed.
        // Persist failure rolls back the fresh pin (best-effort unpin) so
        // the DB and channel state stay coherent - otherwise we'd end up
        // with a pinned-in-channel-but-not-tracked-in-DB welcome that the
        // next repin can't find, letting stale pins accumulate over time.
        if (guildId) {
          try {
            await GuildConfig.findOneAndUpdate(
              { guildId },
              { $set: { welcomeMessageId: sent.id } },
              { upsert: true, setDefaultsOnInsert: true }
            );
            outcome.persisted = true;
          } catch (err) {
            console.warn("[raid-channel] persist welcomeMessageId failed:", err?.message || err);
            try {
              await sent.unpin();
            } catch (unpinErr) {
              console.warn("[raid-channel] rollback-unpin after persist fail also failed:", unpinErr?.message || unpinErr);
            }
            outcome.pinned = false;
          }
        } else {
          // No guildId was passed - we can't persist, so treat as
          // persist-succeeded for unpin purposes (caller opted out of
          // tracking).
          outcome.persisted = true;
        }
      } catch (err) {
        console.warn("[raid-channel] pin fresh welcome failed:", err?.message || err);
      }
    } catch (err) {
      console.warn("[raid-channel] post welcome failed:", err?.message || err);
    }
    // Remove every stale welcome only after the new one is post + pin +
    // persist confirmed. Any partial failure on the fresh-welcome side
    // leaves the stale set alone so the channel still has guidance AND
    // the next repin can retry cleanup.
    //
    // `message.delete()` is used instead of just `unpin()` because each
    // stale welcome is a bot-authored onboarding embed - leaving them as
    // regular (unpinned) messages would clutter the channel with multiple
    // welcomes, which is exactly what repin is supposed to prevent. Delete
    // also automatically removes from the pin list.
    if (outcome.posted && outcome.pinned && outcome.persisted && staleIds.size > 0) {
      for (const id of staleIds) {
        try {
          const oldMsg = await channel.messages.fetch(id);
          await oldMsg.delete();
          outcome.removedOldCount += 1;
        } catch {
          // Stale welcome is already gone (deleted manually, channel
          // cleanup, etc.) - skip.
        }
      }
    }
    return outcome;
  }
  async function resolveRaidMonitorChannel(interaction, channelId) {
    let channel = interaction.guild?.channels?.cache?.get(channelId) || null;
    if (!channel && interaction.guild?.channels?.fetch) {
      try {
        channel = await interaction.guild.channels.fetch(channelId);
      } catch {
        channel = null;
      }
    }
    return channel;
  }

  return {
    loadMonitorChannelCache,
    getMonitorCacheHealth,
    getCachedMonitorChannelId,
    setCachedMonitorChannelId,
    isTextMonitorEnabled,
    getMissingBotChannelPermissions,
    getMissingAnnouncementChannelPermissions,
    parseRaidMessage,
    handleRaidChannelMessage,
    cleanupRaidChannelMessages,
    postRaidChannelWelcome,
    resolveRaidMonitorChannel,
  };
}

module.exports = {
  createRaidChannelMonitorService,
};
