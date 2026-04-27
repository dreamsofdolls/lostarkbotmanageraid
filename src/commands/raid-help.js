function createRaidHelpCommand(deps) {
  const {
    EmbedBuilder,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    MessageFlags,
    UI,
  } = deps;

const HELP_SECTIONS = [
    {
      key: "getting-started",
      label: "🚀 Mới vào - Bắt đầu ở đây",
      icon: "🚀",
      short: "Quick onboarding flow for new users",
      shortVn: "3 bước để track raid lần đầu",
      options: [],
      example: "/add-roster name:<tên-char-bất-kỳ>",
      notes: [
        "VN: Mới gặp Artist lần đầu? Đây là 3 bước để bắt đầu nha~",
        "EN: First time meeting Artist? Here's the 3-step starter flow.",
        "",
        "**1️⃣ Đăng ký roster**: gõ `/add-roster name:<bất-kỳ-char-trong-roster>`. Artist fetch toàn bộ char từ lostark.bible, hiện picker để cậu tick chọn char muốn track rồi bấm **Confirm**.",
        "**2️⃣ Xem progress**: gõ `/raid-status` bất cứ lúc nào để xem char nào đã clear raid gì tuần này.",
        "**3️⃣ Update tiến độ**: 2 cách - (a) gõ `/raid-set` chỉnh tay, hoặc (b) gõ `/raid-auto-manage action:on` để Artist tự sync từ lostark.bible mỗi 24h.",
        "",
        "**Bonus**: post text dạng `<raid> <difficulty> <character>` vào channel raid (admin set qua `/raid-channel`) - Artist tự đọc + update + DM xác nhận. Ví dụ: `Serca Hard Clauseduk`.",
        "",
        "Lệnh nâng cao: `/raid-task` (track chore daily/weekly), `/edit-roster` (sửa roster đã có), `/remove-roster` (xoá). Mỗi lệnh có section riêng ở dropdown phía dưới~",
      ],
    },
    {
      key: "add-roster",
      label: "/add-roster",
      icon: "📥",
      short: "Sync roster from lostark.bible",
      shortVn: "Đăng ký roster từ lostark.bible",
      options: [
        { name: "name", required: true, desc: "Tên 1 character bất kỳ trong roster muốn add" },
        { name: "target", required: false, desc: "(Raid Manager) Add roster giúp 1 user khác" },
      ],
      example: "/add-roster name:Clauseduk",
      notes: [
        "VN: Gõ tên 1 char, Artist fetch toàn bộ roster từ lostark.bible rồi mở picker để cậu tick chọn char muốn track.",
        "EN: Type any character name from your roster - Artist fetches the full account from lostark.bible and opens a picker so you choose which chars to keep.",
        "",
        "**Khi nào dùng**: lần đầu vào server, hoặc khi cậu thêm account mới (alt account).",
        "**Cách Artist xử lý**: bấm **Confirm** sau khi tick → Artist lưu roster vào DB. Bấm **Cancel** hoặc đợi 5 phút → bỏ qua.",
        "**Cap 20 char/roster** (đủ cho mọi player). Nếu char trong roster đã saved sẵn ở account khác → Artist từ chối, dùng `/edit-roster` để sửa thay.",
        "**Mẹo Manager**: option `target:` cho Manager add giúp member lười tự gõ. Reply embed sẽ ping user kia.",
      ],
    },
    {
      key: "edit-roster",
      label: "/edit-roster",
      icon: "📁",
      short: "Add new chars or remove saved chars from a roster",
      shortVn: "Thêm char mới / bỏ char trong roster đã có",
      options: [
        { name: "roster", required: true, desc: "Roster cần edit (autocomplete từ list đã saved)" },
      ],
      example: "/edit-roster roster:Clauseduk",
      notes: [
        "VN: Artist mở picker merged - tick char `🆕` để add char mới, bỏ tick char đã saved để xoá. Tiến độ raid của char survive được giữ nguyên.",
        "EN: Opens a merged picker - tick `🆕` to add new chars, untick to remove saved ones. Raid progress on surviving chars is preserved.",
        "",
        "**Khi nào dùng**: cậu vừa tạo char mới chưa được track, hoặc muốn bỏ alt không chơi nữa.",
        "**Icon**: `🆕` = char mới có ở bible · `📦` = char đã saved nhưng không còn ở bible (rename / private log).",
        "**Mẹo**: nếu bible offline tạm, vẫn vào được nhưng chỉ remove được. Đợi bible up rồi add char mới sau.",
        "**Khác `/add-roster`**: edit-roster sửa roster đã có. Muốn add roster mới hoàn toàn (account khác) → dùng `/add-roster`.",
      ],
    },
    {
      key: "raid-status",
      label: "/raid-status",
      icon: "📊",
      short: "View your raid progress",
      shortVn: "Xem tiến độ raid + chore phụ của cậu",
      options: [],
      example: "/raid-status",
      notes: [
        "VN: Hiển thị mỗi character + raid nào đã clear tuần này. Có 2 view: 📋 Tiến độ raid + 📝 Side tasks.",
        "EN: Per-account per-character view of this week's raid clears. Two views: 📋 Raid + 📝 Side tasks.",
        "",
        `**Icons**: ${UI.icons.done} done all gates · ${UI.icons.partial} partial · ${UI.icons.pending} pending · ${UI.icons.lock} not eligible (iLvl thiếu).`,
        "**Khi nào dùng**: thường xuyên - kiểm tra char nào còn pending tuần này.",
        "**Auto-refresh**: roster (iLvl/class) tự update mỗi 2h. Nếu cậu opt-in `/raid-auto-manage` thì progress raid cũng auto-sync luôn từ bible.",
        "**🔄 Sync ngay button**: chỉ hiện khi đã `/raid-auto-manage action:on`. Bấm để pull bible logs ngay (cooldown 15s cho Raid Manager, 10 phút cho user thường).",
        "**Filter**: dropdown raid filter để zoom 1 raid cụ thể. Toggle `📝 Side tasks` để xem checklist chore daily/weekly đã đăng ký qua `/raid-task`.",
        "**Real-time countdown**: dòng `Last updated`, `Last synced`, `Sync ready` đếm ngược tự động (Discord native timestamp), không cần refresh embed.",
      ],
    },
    {
      key: "raid-task",
      label: "/raid-task",
      icon: "📝",
      short: "Track daily/weekly side tasks per character",
      shortVn: "Tracker chore phụ (Una/Chaos/Guardian...) per character",
      options: [
        { name: "subcommand", required: true, desc: "`add` · `remove` · `clear`" },
        { name: "action", required: false, desc: "(add) `single` 1 char hoặc `all` cả roster" },
        { name: "roster", required: true, desc: "Roster chứa character" },
        { name: "character", required: false, desc: "(add single / remove / clear) char muốn gắn task" },
        { name: "name", required: false, desc: "(add) tên task, autocomplete gợi ý từ task cũ của cậu" },
        { name: "reset", required: false, desc: "(add) `daily` hoặc `weekly`" },
        { name: "task", required: false, desc: "(remove) task cần xoá - autocomplete theo char" },
      ],
      example: "/raid-task add action:single roster:Clauseduk character:Frostmourne name:Una Dailies reset:daily",
      notes: [
        "VN: Đăng ký chore phụ ngoài raid (Una dailies, Chaos, Guardian...) gắn từng char. Toggle complete ở `/raid-status` view 📝 Side tasks.",
        "EN: Track per-character side chores. Toggle complete in /raid-status's 📝 Side tasks view.",
        "",
        "**Cap**: 3 daily + 5 weekly mỗi character.",
        "**Auto-reset**: daily 17:00 VN mỗi ngày · weekly 17:00 VN thứ 4. Tự động, không cần làm gì.",
        "**Action `all`**: thêm cùng task cho mọi char trong roster (đỡ gõ 6 lần). Char đã có task / đầy cap được skip kèm tên trong reply.",
        "**Toggle**: vào `/raid-status` → dropdown `📝 Side tasks` → chọn char (hoặc `🌐 Tất cả character` để bulk) → bấm task để flip 🟢/⚪.",
        "**Subcommand `clear`**: xoá toàn bộ task của 1 char (ephemeral confirm trước khi xoá).",
        "**Mỗi người có list riêng**: side tasks gắn với character của bản thân. Mọi user đều có cùng feature.",
      ],
    },
    {
      key: "raid-set",
      label: "/raid-set",
      icon: "✏️",
      short: "Manually update one character's raid progress",
      shortVn: "Update tay tiến độ raid cho 1 character",
      options: [
        { name: "roster", required: true, desc: "Roster chứa character (autocomplete)" },
        { name: "character", required: true, desc: "Character cần update (autocomplete theo roster)" },
        { name: "raid", required: true, desc: "Raid + difficulty (autocomplete kèm icon tiến độ)" },
        { name: "status", required: true, desc: "`complete` / `process` / `reset`" },
        { name: "gate", required: false, desc: "Gate cụ thể - chỉ active khi status = process (G1/G2)" },
      ],
      example: "/raid-set roster:Clauseduk character:Nailaduk raid:kazeros_hard status:process gate:G1",
      notes: [
        "VN: Update progress tay khi không dùng auto-sync. `complete`/`reset` tác động cả raid; `process gate:G1` chỉ mark 1 gate.",
        "EN: Manual progress update. `complete`/`reset` act on every gate; `process gate:G1` marks one specific gate.",
        "",
        "**Khi nào dùng**: post text trong channel sai format, hoặc cậu không bật auto-sync nhưng cần update nhanh.",
        "**Mẹo**: pick `roster:` trước - autocomplete `character:` chỉ list char trong roster đó (đỡ chọn nhầm khi 2 roster cùng tên char).",
        "**Đổi mode**: ví dụ Serca Nightmare → Hard sẽ wipe progress cũ vì raid weekly entry là mode-scoped.",
        "**Alternative nhanh hơn**: post text `Kazeros Hard Nailaduk G1` vào channel raid - tự update không cần gõ slash command.",
      ],
    },
    {
      key: "raid-check",
      label: "/raid-check",
      icon: "🔍",
      short: "[Raid Manager] Scan who hasn't cleared a raid yet",
      shortVn: "[Raid Manager] Quét xem ai chưa clear raid",
      options: [
        { name: "raid", required: true, desc: "Raid + difficulty cần scan (hoặc `all` xem tổng)" },
      ],
      example: "/raid-check raid:kazeros_hard",
      notes: [
        "VN: Scan tất cả char trong server còn pending raid được chọn. Chỉ Raid Manager (env `RAID_MANAGER_ID`) mới gọi được.",
        "EN: Scan every character pending the selected raid. Restricted to Raid Managers (env `RAID_MANAGER_ID`).",
        "",
        "**Khi nào dùng**: trước khi roll raid, Manager check ai cần đi cùng nhóm.",
        "**Filter**: dropdown user hoặc raid để zoom. Pick 1 user → button `Edit progress` / `Bật/Tắt auto-sync hộ` xuất hiện. Trong `raid:all` còn có thêm `📝 Xem tasks` để monitor chore.",
        "**🔄 Sync button**: force-sync bible logs CHỈ cho user đã opt-in auto-sync trong list pending. Non-opted-in user không bị động đến (privacy-respecting).",
        "**✏️ Edit button**: cascading select để fix progress của member khác. Char đã opt-in auto-sync + bible visible bị ẩn (sync sẽ ghi đè manual edit). Char private log → vẫn edit được.",
        "**`raid:all` (cross-raid overview)**: pagination per user/account. Toggle `📝 Xem tasks` để xem chore của member (read-only).",
        "**Session timeout 5 phút** - hết hạn disable mọi component, gõ lại `/raid-check` để mở lại.",
      ],
    },
    {
      key: "remove-roster",
      label: "/remove-roster",
      icon: "🗑️",
      short: "Remove a roster or one character from it",
      shortVn: "Xoá roster hoặc 1 character",
      options: [
        { name: "roster", required: true, desc: "Roster name (autocomplete)" },
        { name: "action", required: true, desc: "`Remove entire roster` hoặc `Remove a single character`" },
        { name: "character", required: false, desc: "Char cần xoá - required khi action = Remove a single character" },
      ],
      example: "/remove-roster roster:Qiylyn action:Remove a single character character:Zywang",
      notes: [
        "VN: Xoá toàn bộ account roster, hoặc chỉ 1 char trong đó.",
        "EN: Delete an entire roster, or just one character.",
        "",
        "**Khi nào dùng**: account/char cũ không chơi nữa.",
        "**Mẹo**: muốn refresh 1 roster → `/remove-roster` rồi `/add-roster` lại để pull data mới từ bible.",
        "**Khác `/edit-roster`**: edit-roster sửa picker tick/untick. Remove-roster xoá hẳn.",
      ],
    },
    {
      key: "raid-channel",
      label: "/raid-channel",
      icon: "📢",
      short: "[Admin] Configure the raid-clear monitor channel",
      shortVn: "[Admin] Set channel để bot tự đọc message clear raid",
      options: [
        { name: "config action:<x>", required: true, desc: "Action: `show` / `set` / `clear` / `cleanup` / `repin` / `schedule-on` / `schedule-off`" },
        { name: "channel", required: false, desc: "Text channel - cần khi action:set" },
      ],
      example: "/raid-channel config action:set channel:#raid-clears",
      notes: [
        "VN: Set 1 channel làm nơi member post text dạng `<raid> <difficulty> <character>`. Artist tự parse, update DB, xoá tin nhắn, DM xác nhận.",
        "EN: Pick a channel where members post raid clears as text. Artist parses, updates, deletes the source, DMs a private confirmation.",
        "",
        "**Format text**:",
        "• `Serca Hard Clauseduk` (mark whole raid done)",
        "• `Kazeros Hard Soulrano G1` (mark G1 only - cumulative đến G_N)",
        "• Multi-char: `Act4 Hard A, B, C`",
        "**Aliases**: act4/armoche · kazeros/kaz · serca · normal/nor/nm · hard/hm · nightmare/9m. Lưu ý `nm` = Normal (không phải Nightmare).",
        "**Auto-cleanup mỗi 30 phút** (giờ VN, từ 8h-3h sáng): bot xoá non-pinned + post biển báo tone đổi theo lượng rác. Quiet hours 3h-8h sáng VN: không dọn, không ồn.",
        "**Permissions cần**: View Channel, Send Messages, Manage Messages, Read Message History, Embed Links. Thiếu 1 trong 5 → action:set reject.",
        "**Admin-only**: cần permission `Manage Server`.",
      ],
    },
    {
      key: "raid-auto-manage",
      label: "/raid-auto-manage",
      icon: "🤖",
      short: "Auto-sync raid progress from lostark.bible",
      shortVn: "Tự động sync tiến độ raid từ bible (opt-in)",
      options: [
        { name: "action:on", required: false, desc: "Bật + probe roster (warn nếu char chưa Public Log) + sync ngay" },
        { name: "action:off", required: false, desc: "Tắt auto-sync" },
        { name: "action:sync", required: false, desc: "Manual sync ngay" },
        { name: "action:status", required: false, desc: "Xem state on/off + last sync time" },
      ],
      example: "/raid-auto-manage action:on",
      notes: [
        "VN: Khi bật, Artist tự pull clear logs từ lostark.bible mỗi ngày + mỗi lần cậu gõ /raid-status (cooldown protect bible).",
        "EN: When enabled, Artist pulls clear logs from lostark.bible daily + on each /raid-status open (cooldown-protected).",
        "",
        "**Khi nào dùng**: lười post text + lười gõ `/raid-set`. Bật 1 lần, bot tự lo.",
        "**Yêu cầu**: bật **Show on Profile** ở https://lostark.bible/me/logs cho mỗi char muốn sync (để bible cho phép Artist đọc). Char Private log → Artist không reach được.",
        "**Cooldown**: 15s cho Raid Manager, 10 phút cho user thường - protect bible khỏi spam.",
        "**`action:on` flow**: probe roster trước, nếu có char private log → warn embed kèm nút `Vẫn bật` / `Huỷ`. Confirm thì kickstart 1 lần sync ngay.",
        "**Auto-tick background**: opted-in user nào chưa sync 24h → background scheduler tự pull mỗi 30 phút (batch 3 user/tick fair rotation).",
        "**`action:status`**: show last success vs last attempt - dễ thấy khi sync đang fail liên tục (Cloudflare/private log).",
        "**Mode-switch**: nếu bible log báo clear Serca NM nhưng DB đang track Serca Hard cho char đó, bible-wins - Artist wipe progress cũ rồi ghi theo mode mới.",
      ],
    },
    {
      key: "raid-announce",
      label: "/raid-announce",
      icon: "📣",
      short: "[Admin] Configure Artist's channel announcements",
      shortVn: "[Admin] Tắt/bật + redirect channel cho từng loại thông báo",
      options: [
        { name: "type", required: true, desc: "Loại thông báo (dropdown 9 loại - xem ghi chú dưới)" },
        { name: "action", required: true, desc: "`show` / `on` / `off` / `set-channel` / `clear-channel`" },
        { name: "channel", required: false, desc: "Channel đích - cần khi action:set-channel" },
      ],
      example: "/raid-announce type:maintenance-early action:set-channel channel:#announcements",
      notes: [
        "VN: 9 loại thông báo Artist post vào channel, mỗi loại tắt/bật được. 4 loại còn redirect được sang channel khác (#announcements / #maintenance riêng).",
        "EN: 9 announcement types, each with on/off toggle. 4 types support channel override.",
        "",
        "**9 loại**:",
        "• `weekly-reset` - Wed 17 VN reset tuần",
        "• `stuck-nudge` - tag user có toàn char private log",
        "• `set-greeting` - chào sau /raid-channel set",
        "• `hourly-cleanup` - notice sau cleanup",
        "• `artist-bedtime` - 3h sáng VN Artist đi ngủ",
        "• `artist-wakeup` - 8h sáng VN Artist dậy",
        "• `whisper-ack` - whisper khi parse clear thành công",
        "• `maintenance-early` - T-3h/2h/1h trước bảo trì",
        "• `maintenance-countdown` - T-15m/10m/5m/1m",
        "**Channel-overridable** (4 loại): `weekly-reset`, `stuck-nudge`, `maintenance-early`, `maintenance-countdown`. Còn lại bound với monitor channel vì content refer cụ thể.",
        "**Khi nào dùng**: pin /raid-channel hơi nhiều noise → tắt `hourly-cleanup` / `artist-bedtime`. Hoặc redirect maintenance reminder sang #announcements riêng.",
        "**Admin-only**: cần `Manage Server`.",
      ],
    },
  ];
  // Language toggle: pick "en" or "vi" (default). Each render builder
  // takes the resolved lang and emits monolingual content. Notes
  // pre-tagged with "EN: " / "VN: " filter accordingly; un-tagged lines
  // (technical bullets, code refs) render in both languages.
  const LANG_DEFAULT = "vi";
  function pickLang(value) {
    return value === "en" ? "en" : "vi";
  }
  function pickShortText(section, lang) {
    return lang === "en" ? section.short : section.shortVn;
  }
  function filterNotesByLang(notes, lang) {
    const PREFIX_EN = /^EN:\s*/;
    const PREFIX_VN = /^VN:\s*/;
    return notes
      .filter((line) => {
        if (PREFIX_EN.test(line)) return lang === "en";
        if (PREFIX_VN.test(line)) return lang === "vi";
        return true; // shared technical notes
      })
      .map((line) => line.replace(PREFIX_EN, "").replace(PREFIX_VN, ""));
  }

  function buildHelpOverviewEmbed(lang = LANG_DEFAULT) {
    const titleSuffix = lang === "en" ? "EN" : "VI";
    const desc = lang === "en"
      ? "Lost Ark raid progress tracker for Discord. Pick a command below for details."
      : "Bot quản lý tiến độ raid Lost Ark. Chọn command ở dropdown để xem chi tiết.";
    const footer = lang === "en"
      ? "Switch language: /raid-help language:vi"
      : "Đổi ngôn ngữ: /raid-help language:en";
    const embed = new EmbedBuilder()
      .setTitle(`🎯 Raid Management Bot - Help (${titleSuffix})`)
      .setDescription(desc)
      .setColor(UI.colors.neutral)
      .setFooter({ text: footer })
      .setTimestamp();
    for (const section of HELP_SECTIONS) {
      embed.addFields({
        name: `${section.icon} ${section.label}`,
        value: pickShortText(section, lang),
        inline: false,
      });
    }
    return embed;
  }
  const HELP_FIELD_VALUE_LIMIT = 1024; // Discord rejects embed field values above this.
  function splitHelpFieldValue(value, limit = HELP_FIELD_VALUE_LIMIT) {
    const chunks = [];
    let current = "";
    for (const rawLine of String(value || "").split("\n")) {
      const lineParts = [];
      let remaining = rawLine;
      while (remaining.length > limit) {
        let cutAt = remaining.lastIndexOf(" ", limit);
        if (cutAt < Math.floor(limit * 0.6)) cutAt = limit;
        lineParts.push(remaining.slice(0, cutAt).trimEnd());
        remaining = remaining.slice(cutAt).trimStart();
      }
      lineParts.push(remaining);
      for (const part of lineParts) {
        const next = current ? `${current}\n${part}` : part;
        if (next.length > limit && current) {
          chunks.push(current);
          current = part;
        } else {
          current = next;
        }
      }
    }
    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : ["_No details_"];
  }
  function addChunkedHelpField(embed, name, value) {
    const chunks = splitHelpFieldValue(value);
    chunks.forEach((chunk, index) => {
      embed.addFields({
        name: index === 0 ? name : `${name} (${index + 1})`,
        value: chunk,
        inline: false,
      });
    });
  }
  function buildHelpDetailEmbed(sectionKey, lang = LANG_DEFAULT) {
    const section = HELP_SECTIONS.find((item) => item.key === sectionKey);
    if (!section) return buildHelpOverviewEmbed(lang);
    const noOptionsLabel = lang === "en" ? "_No options_" : "_Không có options_";
    const embed = new EmbedBuilder()
      .setTitle(`${section.icon} ${section.label}`)
      .setDescription(pickShortText(section, lang))
      .setColor(UI.colors.neutral);
    if (section.options.length > 0) {
      const optionLines = section.options.map((opt) => {
        const req = opt.required ? "✅" : "⚪";
        return `${req} \`${opt.name}\` - ${opt.desc}`;
      });
      addChunkedHelpField(embed, "Options", optionLines.join("\n"));
    } else {
      embed.addFields({ name: "Options", value: noOptionsLabel, inline: false });
    }
    embed.addFields({ name: "Example", value: `\`${section.example}\``, inline: false });
    const filteredNotes = filterNotesByLang(section.notes, lang);
    addChunkedHelpField(embed, "Notes", filteredNotes.join("\n"));
    return embed;
  }
  function buildHelpDropdown(lang = LANG_DEFAULT) {
    const placeholder = lang === "en"
      ? "📖 Pick a command for details..."
      : "📖 Chọn command để xem chi tiết...";
    // Lang baked into the customId so dropdown selections after a
    // language switch render the detail in the user's chosen language
    // without re-running the slash command. selectRoutes prefix-match
    // in bot.js dispatches `raid-help:select:<lang>` to the same
    // handler.
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`raid-help:select:${lang}`)
      .setPlaceholder(placeholder)
      .addOptions(
        HELP_SECTIONS.map((section) => ({
          label: section.label,
          value: section.key,
          description: pickShortText(section, lang).slice(0, 100),
          emoji: section.icon,
        }))
      );
    return new ActionRowBuilder().addComponents(menu);
  }
  async function handleRaidHelpCommand(interaction) {
    const lang = pickLang(interaction.options.getString("language"));
    await interaction.reply({
      embeds: [buildHelpOverviewEmbed(lang)],
      components: [buildHelpDropdown(lang)],
      flags: MessageFlags.Ephemeral,
    });
  }
  async function handleRaidHelpSelect(interaction) {
    // CustomId shape: `raid-help:select:<lang>` - lang baked in by the
    // dropdown builder so the detail embed stays monolingual.
    const lang = pickLang(interaction.customId.split(":")[2]);
    const sectionKey = interaction.values?.[0];
    await interaction.update({
      embeds: [buildHelpDetailEmbed(sectionKey, lang)],
      components: [buildHelpDropdown(lang)],
    });
  }
  return {
    handleRaidHelpCommand,
    handleRaidHelpSelect,
  };
}

module.exports = {
  createRaidHelpCommand,
};
