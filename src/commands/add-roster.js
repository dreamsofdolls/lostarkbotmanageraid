"use strict";

const crypto = require("crypto");
const { buildNoticeEmbed } = require("../raid/shared");

// Two-step flow window: from /add-roster invocation to Confirm click. After
// 5 minutes the in-memory session is dropped and the embed is updated to
// "expired"; user must re-run the command to retry. Matches the budget
// Traine specified.
const SESSION_TTL_MS = 5 * 60 * 1000;

// Discord caps a message at 5 ActionRow components. The picker layout
// reserves 1 row for Confirm + Cancel buttons, leaving 4 rows for
// per-char toggle buttons at 5 buttons per row = 20 max chars in the
// picker. Real Lost Ark rosters max ~18 chars per account in-game so
// 20 still has headroom. Any chars beyond the cap get dropped from the
// picker (CP-sorted prefix wins) and surfaced as an embed warning.
const PICKER_MAX_OPTIONS = 20;
const BUTTONS_PER_ROW = 5;

const CHECK_ICON = "✅";
const UNCHECK_ICON = "⬜";
const PRESERVED_CHARACTER_FIELDS = [
  "bibleSerial",
  "bibleCid",
  "bibleRid",
  "publicLogDisabled",
];

function preserveExistingCharacterState(record, existing) {
  if (!existing) return record;
  const source = existing.toObject?.() ?? existing;
  for (const field of PRESERVED_CHARACTER_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(source, field) &&
      source[field] !== undefined
    ) {
      record[field] = source[field];
    }
  }
  return record;
}

function createAddRosterCommand({
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  MAX_CHARACTERS_PER_ACCOUNT,
  fetchRosterCharacters,
  parseCombatScore,
  normalizeName,
  getCharacterName,
  getCharacterClass,
  buildCharacterRecord,
  createCharacterId,
  isManagerId,
  getPrimaryManagerId,
}) {
  // Resolved once at factory boot. Used in error embeds to ping the
  // primary admin (first entry of RAID_MANAGER_ID env) by mention so
  // users see a clickable @<id> instead of a generic "ping admin"
  // string. Falls back to plain text when no manager is configured.
  const adminMention = (() => {
    const id = typeof getPrimaryManagerId === "function" ? getPrimaryManagerId() : null;
    return id ? `<@${id}>` : "admin";
  })();
  // Module-level cache: sessionId -> session state. Lives in process
  // memory only; bot restart drops every in-flight session, which is
  // acceptable since the user is sitting in front of the embed and can
  // simply re-run /add-roster. Keying by random sessionId (not by user)
  // means a user who runs /add-roster twice gets two independent
  // pickers — the older one still works until its 5-minute timer fires.
  const sessions = new Map();

  function newSessionId() {
    return crypto.randomBytes(8).toString("hex");
  }

  function buildSeedRosterLink(seedCharName) {
    return `https://lostark.bible/character/NA/${encodeURIComponent(seedCharName)}/roster`;
  }

  function buildSelectionEmbed(session) {
    // Char list shows stats only — selection state lives on the toggle
    // buttons below (✅/⬜ in the button label) so the embed and the
    // controls don't duplicate the same information visually.
    const lines = session.chars.map((c, i) => {
      const cp = c.combatScore || "?";
      return `**${i + 1}.** ${c.charName} · ${c.className} · iLvl \`${c.itemLevel}\` · CP \`${cp}\``;
    });

    const desc = [
      `Roster: [**${session.seedCharName}**](${buildSeedRosterLink(session.seedCharName)})`,
      `Tìm thấy **${session.chars.length}** characters - bấm nút bên dưới để toggle ✅/⬜:`,
      "",
      ...lines,
      "",
      `Đang chọn: **${session.selectedIndices.size}** / ${session.chars.length}`,
      `${UI.icons.info} Phiên 5 phút - hết giờ sẽ tự huỷ. Bấm **Confirm** để lưu, **Cancel** để bỏ.`,
    ];

    if (session.actingForOther) {
      desc.push("");
      desc.push(
        `${UI.icons.info} Raid Manager <@${session.callerId}> đang add giúp <@${session.targetId}>.`
      );
    }

    return new EmbedBuilder()
      .setTitle(`${UI.icons.roster} Chọn characters để add`)
      .setDescription(desc.join("\n").slice(0, 4000))
      .setColor(UI.colors.neutral)
      .setFooter({ text: "Source: lostark.bible · Confirm trong 5 phút" });
  }

  function buildSelectionComponents(session) {
    // Per-char toggle buttons replace the previous StringSelectMenu.
    // Rationale: a multi-select dropdown duplicated state with the
    // embed (both showed ✅/⬜ for each char) and got visually messy
    // when expanded with default-selected pills wrapping across lines.
    // Toggle buttons keep state visible permanently in one place
    // (button label + green/gray style) and collapse the workflow to
    // a single click per char to flip.
    //
    // Layout: 4 rows of up to 5 char buttons (PICKER_MAX_OPTIONS=20)
    // + 1 row of Confirm/Cancel. Discord's hard cap is 5 ActionRows
    // per message, so this is the maximum picker size.
    const charRows = [];
    for (let rowStart = 0; rowStart < session.chars.length; rowStart += BUTTONS_PER_ROW) {
      const row = new ActionRowBuilder();
      const rowEnd = Math.min(rowStart + BUTTONS_PER_ROW, session.chars.length);
      for (let i = rowStart; i < rowEnd; i += 1) {
        const c = session.chars[i];
        const isSelected = session.selectedIndices.has(i);
        const marker = isSelected ? CHECK_ICON : UNCHECK_ICON;
        // Button label cap is 80 chars. Keep the index + name + class
        // visible; truncate the char name first if needed.
        const baseLabel = `${marker} ${i + 1}. ${c.charName} (${c.className})`;
        const label = baseLabel.length > 80 ? `${baseLabel.slice(0, 77)}...` : baseLabel;
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`add-roster:toggle:${session.sessionId}:${i}`)
            .setLabel(label)
            .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary)
        );
      }
      charRows.push(row);
    }

    // Color scheme keeps action buttons visually distinct from toggle
    // state buttons: Success (green) / Secondary (gray) belong to the
    // per-char toggles, so Confirm uses Primary (blue) and Cancel uses
    // Danger (red). Without this split the channel screenshot showed
    // Confirm visually identical to a selected char and Cancel
    // identical to an unselected one — hard to scan the action row.
    const confirmBtn = new ButtonBuilder()
      .setCustomId(`add-roster:confirm:${session.sessionId}`)
      .setLabel(`Confirm (${session.selectedIndices.size})`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(session.selectedIndices.size === 0);

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`add-roster:cancel:${session.sessionId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger);

    return [
      ...charRows,
      new ActionRowBuilder().addComponents(confirmBtn, cancelBtn),
    ];
  }

  function buildExpiredEmbed(session) {
    return new EmbedBuilder()
      .setTitle(`${UI.icons.warn} Phiên đã hết hạn`)
      .setDescription(
        [
          `Roster: [**${session.seedCharName}**](${buildSeedRosterLink(session.seedCharName)})`,
          "",
          `Phiên 5 phút đã hết và không có gì được lưu. Chạy lại \`/add-roster\` để thử lại nhé~`,
        ].join("\n")
      )
      .setColor(UI.colors.muted)
      .setFooter({ text: "Source: lostark.bible" });
  }

  function buildCancelledEmbed(session) {
    return new EmbedBuilder()
      .setTitle(`${UI.icons.info} Đã huỷ`)
      .setDescription(
        [
          `Roster: [**${session.seedCharName}**](${buildSeedRosterLink(session.seedCharName)})`,
          "",
          `Không có gì được lưu. Chạy lại \`/add-roster\` khi cậu sẵn sàng.`,
        ].join("\n")
      )
      .setColor(UI.colors.muted)
      .setFooter({ text: "Source: lostark.bible" });
  }

  function buildSavedEmbed(session, savedAccount, dmDelivery = null) {
    const summaryLines = savedAccount.characters.map(
      (character, index) =>
        `${index + 1}. ${character.name} · ${character.class} · \`${character.itemLevel}\` · \`${character.combatScore || "?"}\``
    );
    const descriptionLines = [
      `Roster: [**${savedAccount.accountName}**](${buildSeedRosterLink(session.seedCharName)})`,
      `Saved: **${savedAccount.characters.length}** characters (cậu chọn)`,
    ];
    if (session.actingForOther) {
      descriptionLines.push(
        `\n${UI.icons.info} Roster này được Raid Manager <@${session.callerId}> add giúp <@${session.targetId}> nha~`
      );
      // Surface DM-delivery status so the Manager knows whether the
      // target got a private notice or only the channel ping.
      if (dmDelivery?.delivered) {
        descriptionLines.push(
          `📩 Artist đã DM riêng cho <@${session.targetId}> kèm full chars list.`
        );
      } else if (dmDelivery?.reason === "dms-disabled") {
        descriptionLines.push(
          `${UI.icons.warn} Không DM được cho <@${session.targetId}> (target tắt DM từ server members). Channel ping ở trên là backup nha.`
        );
      } else if (dmDelivery?.reason === "error") {
        descriptionLines.push(
          `${UI.icons.warn} DM cho <@${session.targetId}> fail (lỗi khác). Channel ping vẫn ok.`
        );
      }
    }
    return new EmbedBuilder()
      .setTitle(`${UI.icons.roster} Roster Synced`)
      .setDescription(descriptionLines.join("\n"))
      .addFields({
        name: `Characters (${savedAccount.characters.length})`,
        value: summaryLines.join("\n").slice(0, 1024),
        inline: false,
      })
      .setColor(UI.colors.success)
      .setFooter({ text: "Source: lostark.bible" })
      .setTimestamp();
  }

  // Personal DM embed for the Manager-target onboarding flow. Mirrors
  // buildSavedEmbed's content but with a Manager-friendly intro line +
  // hints at the next-step commands (/raid-status, /edit-roster) so
  // the target knows what to do without scrolling channel chrome.
  function buildTargetDMEmbed(session, savedAccount, guildName) {
    const summaryLines = savedAccount.characters.map(
      (character, index) =>
        `${index + 1}. ${character.name} · ${character.class} · \`${character.itemLevel}\` · \`${character.combatScore || "?"}\``
    );
    const guildLine = guildName ? ` trong server **${guildName}**` : "";
    return new EmbedBuilder()
      .setTitle(`${UI.icons.roster} Roster mới do Manager add giúp cậu`)
      .setDescription(
        [
          `Heya~ Raid Manager <@${session.callerId}> vừa add giúp cậu một roster mới${guildLine}. Artist DM riêng cho cậu xem cho tiện nha.`,
          "",
          `Roster: [**${savedAccount.accountName}**](${buildSeedRosterLink(session.seedCharName)})`,
          `Đã save **${savedAccount.characters.length}** characters.`,
          "",
          "Vài lệnh tiếp theo:",
          "• `/raid-status` → xem tiến độ raid mọi lúc",
          "• `/edit-roster` → chỉnh sửa nếu có chars sai (thêm/bỏ)",
          "• `/raid-help` → tài liệu đầy đủ mọi lệnh",
        ].join("\n")
      )
      .addFields({
        name: `Characters (${savedAccount.characters.length})`,
        value: summaryLines.join("\n").slice(0, 1024),
        inline: false,
      })
      .setColor(UI.colors.success)
      .setFooter({ text: "Source: lostark.bible · Artist Bot" })
      .setTimestamp();
  }

  // Best-effort DM to the target user when Manager added on their
  // behalf. Returns a delivery report so the channel embed can surface
  // success / failure ("📩 Đã DM" vs "⚠️ Không DM được"). Discord
  // API code 50007 = "Cannot send messages to this user" — fires when
  // target has DMs from server members disabled, has blocked the bot,
  // or shares no mutual servers (latter shouldn't happen here since
  // they're in the slash command's guild). Treated as expected, not
  // an error.
  async function tryDeliverTargetDM(client, session, savedAccount, guildName) {
    if (!session.actingForOther || !session.targetId) {
      return { delivered: false, reason: "not-acting-for-other" };
    }
    try {
      const targetUser = await client.users.fetch(session.targetId);
      await targetUser.send({
        embeds: [buildTargetDMEmbed(session, savedAccount, guildName)],
      });
      return { delivered: true };
    } catch (err) {
      const dmsDisabled =
        err?.code === 50007 || err?.rawError?.code === 50007;
      console.warn(
        `[add-roster] DM to target ${session.targetId} failed${dmsDisabled ? " (DMs disabled)" : ""}: ${err?.message || err}`
      );
      return {
        delivered: false,
        reason: dmsDisabled ? "dms-disabled" : "error",
      };
    }
  }

  // The save path used to live inline in handleAddRosterCommand; pulled
  // out so Confirm can reuse the same logic without round-tripping the
  // whole command. Returns a plain account snapshot for embed rendering.
  //
  // Throws an Error with code "RACE_DUP_ROSTER" + collidingAccountName
  // when the freshly-loaded userDoc already contains an account whose
  // chars overlap the bible roster we fetched. The Confirm handler
  // catches this and renders a user-friendly hint pointing to /edit-roster.
  async function persistSelectedRoster(session, selectedChars) {
    const rosterNameSet = new Set(selectedChars.map((c) => normalizeName(c.charName)));
    // Full bible char names from the fetch that opened this picker.
    // Used inside the saveWithRetry body to detect a concurrent
    // /add-roster session that committed first against the same bible
    // roster (race the command-time guard can't catch). Empty Set is
    // a no-op skip — preserves behavior if a future caller forgets
    // to populate session.bibleNames.
    const bibleNameSet = session.bibleNames instanceof Set
      ? session.bibleNames
      : new Set();
    let savedAccount;
    await saveWithRetry(async () => {
      let userDoc = await User.findOne({ discordId: session.discordId });
      if (!userDoc) {
        userDoc = new User({ discordId: session.discordId, accounts: [] });
      }
      ensureFreshWeek(userDoc);
      const normalizedSeed = normalizeName(session.seedCharName);
      let account = userDoc.accounts.find((item) => {
        if (normalizeName(item.accountName) === normalizedSeed) return true;
        const chars = Array.isArray(item.characters) ? item.characters : [];
        if (chars.some((character) => normalizeName(getCharacterName(character)) === normalizedSeed)) return true;
        return chars.some((character) => rosterNameSet.has(normalizeName(getCharacterName(character))));
      });

      // Race-safe overlap guard: re-check, with the freshest userDoc, that
      // no OTHER account already covers the bible roster we're about to
      // create/merge into. Skip the account we identified above as our
      // target — that's where merging is supposed to happen and any
      // overlap there is by design. Catches the case where two
      // /add-roster sessions opened pickers concurrently (both passed
      // the command-time guard against an empty user doc), then the
      // first session committed an account that the second session can
      // no longer ignore.
      if (bibleNameSet.size > 0) {
        const collidingAccount = userDoc.accounts.find((item) => {
          if (account && item === account) return false;
          const chars = Array.isArray(item.characters) ? item.characters : [];
          return chars.some((character) =>
            bibleNameSet.has(normalizeName(getCharacterName(character)))
          );
        });
        if (collidingAccount) {
          const err = new Error(
            `Roster đã được saved ở account '${collidingAccount.accountName}' (concurrent /add-roster session committed first).`
          );
          err.code = "RACE_DUP_ROSTER";
          err.collidingAccountName = collidingAccount.accountName;
          throw err;
        }
      }

      if (!account) {
        userDoc.accounts.push({ accountName: session.seedCharName, characters: [] });
        account = userDoc.accounts[userDoc.accounts.length - 1];
      }
      const existingMap = new Map(
        account.characters.map((character) => [normalizeName(getCharacterName(character)), character])
      );
      account.characters = selectedChars.map((character) => {
        const existing = existingMap.get(normalizeName(character.charName));
        const record = buildCharacterRecord(
          {
            ...(existing ? existing.toObject?.() ?? existing : {}),
            name: character.charName,
            class: character.className,
            itemLevel: character.itemLevel,
            combatScore: character.combatScore,
          },
          existing?.id || createCharacterId()
        );
        return preserveExistingCharacterState(record, existing);
      });
      // Stamp the refresh timestamp so /raid-status lazy-refresh treats this
      // account as fresh for the cooldown window and skips a redundant fetch.
      account.lastRefreshedAt = Date.now();
      await userDoc.save();
      savedAccount = {
        accountName: account.accountName,
        characters: account.characters.map((character) => ({
          name: getCharacterName(character),
          class: getCharacterClass(character),
          itemLevel: Number(character.itemLevel) || 0,
          combatScore: character.combatScore || "",
        })),
      };
    });
    return savedAccount;
  }

  function clearSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    if (session.expireTimer) {
      clearTimeout(session.expireTimer);
      session.expireTimer = null;
    }
    sessions.delete(sessionId);
    return session;
  }

  async function handleSessionTimeout(sessionId, interaction) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    session.expireTimer = null;
    try {
      await interaction.editReply({
        embeds: [buildExpiredEmbed(session)],
        components: [],
      });
    } catch (err) {
      // Original message could be deleted, channel gone, etc. Nothing
      // to do — the in-memory session is already cleaned up.
      console.warn(
        `[add-roster] timeout edit failed for session ${sessionId}: ${err?.message || err}`
      );
    }
  }

  async function handleAddRosterCommand(interaction) {
    const callerId = interaction.user.id;
    const seedCharName = interaction.options.getString("name", true).trim();

    // Target option: Raid Manager onboarding for lazy members. When the
    // caller specifies `target`, we save the roster under THAT user's
    // discordId instead of the caller's. Manager-gated because letting
    // any user write to any other user's roster doc would let members
    // grief each other (overwrite progress, add fake chars).
    const targetUser = interaction.options.getUser("target");
    let discordId = callerId;
    let actingForOther = false;
    if (targetUser && targetUser.id !== callerId) {
      if (typeof isManagerId !== "function" || !isManagerId(callerId)) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "lock",
              title: "Chỉ Raid Manager dùng được option `target`",
              description: "Add roster cho người khác là privilege của Raid Manager nha~ Cậu muốn add cho mình thì bỏ option `target` đi rồi chạy lại là Artist sẽ làm ngay.",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (targetUser.bot) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Bot không có roster đâu nha~",
              description: "Bot không chơi Lost Ark được, Artist không add roster cho bot được. Cậu chọn user người chơi thay nhé.",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      discordId = targetUser.id;
      actingForOther = true;
    }

    // Reject if this roster is already saved under this Discord user.
    // Seed name matches either an existing account name or any stored
    // character name → block the add. Users who want to refresh a saved
    // roster should remove it first, per Traine's explicit preference.
    const existingUser = await User.findOne({ discordId }).lean();
    if (existingUser && Array.isArray(existingUser.accounts)) {
      const normalizedSeed = normalizeName(seedCharName);
      const matched = existingUser.accounts.find((account) => {
        if (normalizeName(account.accountName) === normalizedSeed) return true;
        const chars = Array.isArray(account.characters) ? account.characters : [];
        return chars.some((c) => normalizeName(getCharacterName(c)) === normalizedSeed);
      });
      if (matched) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Roster này đã có sẵn rồi~",
              description: [
                `Artist thấy roster cậu đang muốn add đã được saved trong account **${matched.accountName}** từ trước. Không tạo trùng được nha.`,
                "",
                `Muốn cập nhật chars trong roster đó: \`/edit-roster roster:${matched.accountName}\``,
                `Muốn xoá hẳn rồi add lại từ đầu: \`/remove-roster\` rồi \`/add-roster\``,
              ].join("\n"),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    await interaction.deferReply();
    let rosterCharacters;
    try {
      rosterCharacters = await fetchRosterCharacters(seedCharName);
    } catch (error) {
      await interaction.editReply(
        `${UI.icons.warn} Không fetch được roster từ lostark.bible: ${error.message}`
      );
      return;
    }
    if (rosterCharacters.length === 0) {
      await interaction.editReply(
        `${UI.icons.warn} Không tìm thấy roster hợp lệ. Kiểm tra lại tên character nhé.`
      );
      return;
    }

    // Robust duplicate-roster guard (post-fetch). The pre-fetch guard above
    // only catches seedCharName collisions with accountName / saved char
    // names - it misses the case where the user seeds with a real bible
    // char they haven't saved yet but whose roster already lives under a
    // different accountName. Without this check, persistSelectedRoster
    // would create a SECOND account pointing to the same bible roster
    // (because the account-match logic only inspects the user's selection,
    // not the full bible char list), splitting one bible roster across
    // two accounts and breaking the "1 bible roster = 1 account/user"
    // invariant that /remove-roster + /raid-set rely on. Direct users to
    // /edit-roster instead since that's exactly the right tool here.
    // Build the bible name set once: used both for the command-time
    // overlap guard below AND stashed into session.bibleNames so
    // persistSelectedRoster can re-run the same overlap check inside
    // saveWithRetry against the FRESH userDoc (catches the race where
    // a concurrent /add-roster session committed first between command
    // time and Confirm).
    const bibleNameSet = new Set(
      rosterCharacters.map((c) => normalizeName(c.charName))
    );

    if (existingUser && Array.isArray(existingUser.accounts)) {
      const collidingAccount = existingUser.accounts.find((account) => {
        const chars = Array.isArray(account.characters) ? account.characters : [];
        return chars.some((c) =>
          bibleNameSet.has(normalizeName(getCharacterName(c)))
        );
      });
      if (collidingAccount) {
        await interaction.editReply({
          content: null,
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Roster này đã saved ở account khác rồi",
              description: [
                `Artist fetch bible xong thấy có chars trùng với account **${collidingAccount.accountName}** đã saved của cậu - tránh tạo split nên Artist từ chối nha.`,
                "",
                `Muốn add chars mới: \`/edit-roster roster:${collidingAccount.accountName}\``,
                `Muốn làm lại từ đầu: \`/remove-roster\` rồi \`/add-roster\``,
              ].join("\n"),
            }),
          ],
        });
        return;
      }
    }

    // CP-sorted (highest first) so the picker shows the most-played
    // chars at the top by default. We only cap at PICKER_MAX_OPTIONS
    // (Discord 5-row limit minus the Confirm/Cancel row) which is
    // well above any real roster size.
    const sortedChars = [...rosterCharacters].sort((a, b) => {
      const aCombat = parseCombatScore(a.combatScore);
      const bCombat = parseCombatScore(b.combatScore);
      const combatDiff = bCombat - aCombat;
      if (combatDiff !== 0) return combatDiff;
      return b.itemLevel - a.itemLevel;
    });
    const displayChars = sortedChars.slice(0, PICKER_MAX_OPTIONS);
    const truncated = sortedChars.length > PICKER_MAX_OPTIONS;

    const sessionId = newSessionId();
    // Default selection: every char shown. Matches Traine's intent
    // ("user này chơi toàn bộ"). Users with alts they don't play
    // toggle them off via the per-char buttons before confirming.
    const selectedIndices = new Set(displayChars.map((_, i) => i));

    const session = {
      sessionId,
      callerId,
      targetId: targetUser?.id || null,
      discordId,
      actingForOther,
      seedCharName,
      // Snapshot of the FULL bible roster's normalized char names from
      // this fetch — feeds the race-safe overlap guard inside
      // persistSelectedRoster. NOT just the displayed (capped) chars
      // because two sessions on the same bible roster could each truncate
      // to different windows yet still represent the same roster.
      bibleNames: bibleNameSet,
      chars: displayChars.map((c) => ({
        charName: c.charName,
        className: c.className,
        itemLevel: c.itemLevel,
        combatScore: c.combatScore,
      })),
      selectedIndices,
      expireTimer: null,
    };
    sessions.set(sessionId, session);

    if (truncated) {
      console.warn(
        `[add-roster] roster ${seedCharName} has ${sortedChars.length} chars; truncated to ${PICKER_MAX_OPTIONS} for picker.`
      );
    }

    await interaction.editReply({
      embeds: [buildSelectionEmbed(session)],
      components: buildSelectionComponents(session),
    });

    session.expireTimer = setTimeout(
      () => handleSessionTimeout(sessionId, interaction),
      SESSION_TTL_MS
    );
  }

  // Auth gate shared by select + button paths: only the original
  // command caller can manipulate or confirm their own session. Manager
  // who used `target:` is still the caller; the target user can't click
  // anything on the picker.
  function authorizeSession(interaction, session) {
    if (interaction.user.id !== session.callerId) {
      return interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "lock",
            title: "Picker này không phải của cậu",
            description: "Chỉ người gõ lệnh `/add-roster` mới điều khiển được picker đó nha. Cậu muốn add roster của mình thì gõ `/add-roster` riêng.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
    return null;
  }

  async function handleAddRosterButton(interaction) {
    // CustomId shape: `add-roster:<action>:<sessionId>` for confirm/cancel,
    // `add-roster:toggle:<sessionId>:<charIndex>` for per-char toggle.
    const parts = interaction.customId.split(":");
    const action = parts[1];
    const sessionId = parts[2];
    const session = sessions.get(sessionId);
    if (!session) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "muted",
            title: "Phiên đã hết hạn",
            description: "Phiên 5 phút đã trôi qua mất rồi. Chạy lại `/add-roster` để Artist mở picker mới cho cậu nha~",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const denied = await authorizeSession(interaction, session);
    if (denied) return;

    if (action === "toggle") {
      const charIndex = Number(parts[3]);
      if (!Number.isInteger(charIndex) || charIndex < 0 || charIndex >= session.chars.length) {
        // Stale customId from a prior session shape; ignore silently
        // by acking the interaction. Avoids "interaction failed".
        await interaction.deferUpdate().catch(() => {});
        return;
      }
      if (session.selectedIndices.has(charIndex)) {
        session.selectedIndices.delete(charIndex);
      } else {
        session.selectedIndices.add(charIndex);
      }
      await interaction.update({
        embeds: [buildSelectionEmbed(session)],
        components: buildSelectionComponents(session),
      });
      return;
    }

    if (action === "cancel") {
      clearSession(sessionId);
      await interaction.update({
        embeds: [buildCancelledEmbed(session)],
        components: [],
      });
      return;
    }

    if (action === "confirm") {
      if (session.selectedIndices.size === 0) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Cần chọn ít nhất 1 char",
              description: "Cậu chưa toggle char nào - Artist không có gì để save cả. Bấm ít nhất 1 button char (chuyển từ ⬜ sang ✅) rồi Confirm lại nhé.",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // Pull selected chars in display order (sorted ascending by
      // index = CP-rank order) so the saved-embed list reads naturally.
      const selectedChars = Array.from(session.selectedIndices)
        .sort((a, b) => a - b)
        .map((i) => session.chars[i]);

      // Cap at MAX_CHARACTERS_PER_ACCOUNT defensively. The picker is
      // already capped at PICKER_MAX_OPTIONS but a future change could
      // raise that without reviewing the storage cap, so guard here too.
      if (selectedChars.length > MAX_CHARACTERS_PER_ACCOUNT) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Vượt cap roster",
              description: `Mỗi roster Artist save được tối đa **${MAX_CHARACTERS_PER_ACCOUNT}** chars (Discord component limit). Cậu đang chọn **${selectedChars.length}** - toggle off bớt vài char rồi Confirm lại nhé.`,
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Defer the component update before the DB write — saveWithRetry
      // can take longer than the 3s ack window if Mongo is slow. Using
      // deferUpdate keeps the picker on screen while we work, then
      // editReply swaps it for the final saved embed.
      await interaction.deferUpdate();
      clearSession(sessionId);

      let savedAccount;
      try {
        savedAccount = await persistSelectedRoster(session, selectedChars);
      } catch (err) {
        // Race-detected duplicate (a concurrent /add-roster session
        // committed first against the same bible roster). Friendly
        // hint + steer to /edit-roster instead of a generic error.
        if (err?.code === "RACE_DUP_ROSTER") {
          console.warn(
            `[add-roster] race-detected duplicate roster: ${err.collidingAccountName}`
          );
          await interaction.editReply({
            content: null,
            components: [],
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "warn",
                title: "Có phiên khác vừa save trước",
                description: [
                  `Trong lúc cậu đang chọn chars, một phiên \`/add-roster\` khác của cậu vừa save xong roster này ở account **${err.collidingAccountName}**.`,
                  "",
                  `Dùng \`/edit-roster roster:${err.collidingAccountName}\` để add tiếp chars cậu vừa chọn vào account đó nhé~`,
                ].join("\n"),
              }),
            ],
          });
          return;
        }
        console.error(`[add-roster] persist failed:`, err);
        await interaction.editReply({
          content: null,
          components: [],
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "error",
              title: "Lưu roster fail",
              description: `Artist lưu roster không xong: ${err?.message || err}\n\nThử lại sau vài giây nhé. Nếu lặp lại nhiều lần ping ${adminMention} giúp Artist debug~`,
            }),
          ],
        });
        return;
      }

      // Manager target onboarding: best-effort DM to the target user
      // BEFORE the channel embed lands, so the embed can surface DM
      // delivery status ("📩 Đã DM" / "⚠️ Không DM được"). DM is the
      // primary notification (cleaner, persistent in target's inbox);
      // channel ping below stays as both audit proof + fallback when
      // DMs are blocked.
      let dmDelivery = null;
      if (session.actingForOther) {
        const guildName = interaction.guild?.name || null;
        dmDelivery = await tryDeliverTargetDM(
          interaction.client,
          session,
          savedAccount,
          guildName
        );
      }

      // Ping the target user when Manager added on their behalf. Discord
      // ONLY fires notifications for mentions in the message `content`
      // field — mentions inside an embed description don't ping anyone,
      // even with allowedMentions set. Without an explicit content
      // mention here the target wouldn't get any notification despite
      // the embed text saying "đã được Manager add giúp <@target>".
      await interaction.editReply({
        content: session.actingForOther
          ? `<@${session.targetId}> Heya~ Manager <@${session.callerId}> vừa add giúp roster này cho cậu rồi nhé. Check thử xem chars có đúng không, sai thì \`/edit-roster\` sửa được.`
          : null,
        embeds: [buildSavedEmbed(session, savedAccount, dmDelivery)],
        components: [],
        allowedMentions: session.actingForOther
          ? { users: [session.targetId] }
          : { parse: [] },
      });
    }
  }

  return {
    handleAddRosterCommand,
    handleAddRosterButton,
    // Internals exposed for unit tests in test/add-roster.test.js. Not
    // part of the public contract — runtime callers go through the
    // handlers above. The session map is exposed read-only-by-convention
    // for tests that need to inject a session before exercising Confirm.
    __test: {
      persistSelectedRoster,
      sessions,
    },
  };
}

module.exports = {
  createAddRosterCommand,
};
