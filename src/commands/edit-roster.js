"use strict";

const crypto = require("crypto");

// Same 5-min window as /add-roster picker. Long enough to read + decide,
// short enough that abandoned sessions don't pile up in memory.
const SESSION_TTL_MS = 5 * 60 * 1000;

// Discord StringSelectMenu cap. Real Lost Ark rosters max out at ~18
// characters per account, so 25 covers everyone with headroom. Matches
// the cap used by /add-roster's picker.
const SELECT_MAX_OPTIONS = 25;

const CHECK_ICON = "✅";
const UNCHECK_ICON = "⬜";
const NEW_TAG = "🆕";
const STALE_TAG = "📦"; // saved locally but not in current bible roster

function createEditRosterCommand({
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
  loadUserForAutocomplete,
}) {
  // sessionId -> session state. Same shape/semantics as the /add-roster
  // sessions map: in-process only, dropped on bot restart, keyed by a
  // random 16-hex token so concurrent /edit-roster invocations don't
  // step on each other.
  const sessions = new Map();

  function newSessionId() {
    return crypto.randomBytes(8).toString("hex");
  }

  // Mirror /remove-roster's roster autocomplete: list the caller's saved
  // accounts with a char-count hint, fuzzy-filtered by what they've typed.
  async function handleEditRosterAutocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "roster") {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const needle = normalizeName(focused.value || "");
    const discordId = interaction.user.id;
    const userDoc = await loadUserForAutocomplete(discordId);
    if (!userDoc || !Array.isArray(userDoc.accounts)) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const choices = userDoc.accounts
      .filter((a) => !needle || normalizeName(a.accountName).includes(needle))
      .slice(0, 25)
      .map((a) => {
        const chars = Array.isArray(a.characters) ? a.characters : [];
        const label = `${UI.icons.folder} ${a.accountName} · ${chars.length} char${chars.length === 1 ? "" : "s"}`;
        return {
          name: label.length > 100 ? `${label.slice(0, 97)}...` : label,
          value: a.accountName.length > 100 ? a.accountName.slice(0, 100) : a.accountName,
        };
      });
    await interaction.respond(choices).catch(() => {});
  }

  function tagFor(c) {
    if (c.savedKey && !c.inBible) return STALE_TAG;
    if (!c.savedKey && c.inBible) return NEW_TAG;
    return "";
  }

  function buildSelectionEmbed(session) {
    const lines = session.chars.map((c, i) => {
      const checked = session.selectedIndices.has(i) ? CHECK_ICON : UNCHECK_ICON;
      const cp = c.combatScore || "?";
      const tag = tagFor(c);
      const tagSuffix = tag ? ` · ${tag}` : "";
      return `${checked} **${i + 1}.** ${c.charName} · ${c.className} · iLvl \`${c.itemLevel}\` · CP \`${cp}\`${tagSuffix}`;
    });

    const desc = [
      `Roster: **${session.accountName}**`,
      `Đang edit - tick những char muốn **giữ/add**, bỏ tick những char muốn **xoá**:`,
      "",
      ...lines,
      "",
      `Đang chọn: **${session.selectedIndices.size}** / ${session.chars.length}`,
    ];

    if (session.bibleError) {
      desc.push("");
      desc.push(
        `${UI.icons.warn} Bible offline (${session.bibleError}) - chỉ thấy char đã saved, không add char mới được. Thử lại sau khi bible up.`
      );
    } else {
      desc.push(
        `${UI.icons.info} ${NEW_TAG} = char mới có ở bible chưa được add · ${STALE_TAG} = char đã saved nhưng không còn ở bible (rename/private log?).`
      );
    }
    desc.push(
      `${UI.icons.info} Phiên 5 phút - hết giờ sẽ tự huỷ. Bấm **Confirm** để apply, **Cancel** để bỏ.`
    );

    return new EmbedBuilder()
      .setTitle(`${UI.icons.folder} Edit roster: ${session.accountName}`)
      .setDescription(desc.join("\n").slice(0, 4000))
      .setColor(UI.colors.neutral)
      .setFooter({ text: "Source: lostark.bible · Confirm trong 5 phút" });
  }

  function buildSelectionComponents(session) {
    const options = session.chars.map((c, i) => {
      const cpLabel = c.combatScore || "?";
      const tag = tagFor(c);
      const tagSuffix = tag ? ` · ${tag}` : "";
      return {
        label: `${i + 1}. ${c.charName} (${c.className})`.slice(0, 100),
        description: `iLvl ${c.itemLevel} · CP ${cpLabel}${tagSuffix}`.slice(0, 100),
        value: String(i),
        default: session.selectedIndices.has(i),
      };
    });

    const select = new StringSelectMenuBuilder()
      .setCustomId(`edit-roster:select:${session.sessionId}`)
      .setPlaceholder(`Tick chars muốn giữ/add (${session.chars.length} có sẵn)`)
      .setMinValues(0)
      .setMaxValues(session.chars.length)
      .addOptions(options);

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`edit-roster:confirm:${session.sessionId}`)
      .setLabel(`Confirm (${session.selectedIndices.size})`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(session.selectedIndices.size === 0);

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`edit-roster:cancel:${session.sessionId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary);

    return [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(confirmBtn, cancelBtn),
    ];
  }

  function buildExpiredEmbed(session) {
    return new EmbedBuilder()
      .setTitle(`${UI.icons.warn} Phiên đã hết hạn`)
      .setDescription(
        [
          `Roster: **${session.accountName}**`,
          "",
          `Phiên 5 phút đã hết và không có thay đổi nào được lưu. Chạy lại \`/edit-roster\` để thử lại nhé~`,
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
          `Roster: **${session.accountName}**`,
          "",
          `Không có thay đổi nào được lưu. Chạy lại \`/edit-roster\` khi cậu sẵn sàng.`,
        ].join("\n")
      )
      .setColor(UI.colors.muted)
      .setFooter({ text: "Source: lostark.bible" });
  }

  function buildSavedEmbed(session, summary) {
    const { added, removed, kept, finalChars } = summary;
    const lines = finalChars.map(
      (c, i) =>
        `${i + 1}. ${c.name} · ${c.class} · \`${c.itemLevel}\` · \`${c.combatScore || "?"}\``
    );
    const diffParts = [];
    if (added.length) diffParts.push(`${added.length} added (${added.join(", ")})`);
    if (removed.length) diffParts.push(`${removed.length} removed (${removed.join(", ")})`);
    if (kept.length && !added.length && !removed.length) {
      diffParts.push(`${kept.length} unchanged (refreshed bible-side fields)`);
    }
    const diffLine = diffParts.length ? diffParts.join(" · ") : "Không có thay đổi";

    return new EmbedBuilder()
      .setTitle(`${UI.icons.folder} Roster Updated`)
      .setDescription(
        [
          `Roster: **${session.accountName}**`,
          `Diff: ${diffLine}`,
        ].join("\n")
      )
      .addFields({
        name: `Characters (${finalChars.length})`,
        value: lines.join("\n").slice(0, 1024) || "_(empty)_",
        inline: false,
      })
      .setColor(UI.colors.success)
      .setFooter({ text: "Source: lostark.bible" })
      .setTimestamp();
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
      console.warn(
        `[edit-roster] timeout edit failed for session ${sessionId}: ${err?.message || err}`
      );
    }
  }

  // The diff-apply save: fully replace account.characters[] based on the
  // user's selection, but preserve per-char state (raid completion,
  // bibleSerial/cid/rid, publicLogDisabled, tasks) on chars that survive
  // the edit by name match. New chars get a fresh id + record. Removed
  // chars are dropped entirely.
  //
  // Returns a summary: which char names were added/removed/kept, plus
  // the final chars array for the embed.
  async function persistEditedRoster(session, selectedChars) {
    const summary = { added: [], removed: [], kept: [], finalChars: [] };

    await saveWithRetry(async () => {
      const userDoc = await User.findOne({ discordId: session.discordId });
      if (!userDoc) throw new Error("User document disappeared between command and confirm.");
      ensureFreshWeek(userDoc);

      const account = userDoc.accounts.find(
        (a) => normalizeName(a.accountName) === normalizeName(session.accountName)
      );
      if (!account) {
        throw new Error(`Roster '${session.accountName}' không còn tồn tại.`);
      }

      const existingMap = new Map(
        (account.characters || []).map((c) => [normalizeName(getCharacterName(c)), c])
      );

      const selectedNameSet = new Set(selectedChars.map((c) => normalizeName(c.charName)));

      // Reset diff (saveWithRetry can re-fire body — keep summary in sync
      // with the latest pass).
      summary.added = [];
      summary.removed = [];
      summary.kept = [];

      // Tally removals: chars previously in account but absent from the
      // user's selection.
      for (const [key, oldChar] of existingMap.entries()) {
        if (!selectedNameSet.has(key)) {
          summary.removed.push(getCharacterName(oldChar));
        }
      }

      account.characters = selectedChars.map((character) => {
        const key = normalizeName(character.charName);
        const existing = existingMap.get(key);
        if (existing) {
          summary.kept.push(getCharacterName(existing));
        } else {
          summary.added.push(character.charName);
        }
        return buildCharacterRecord(
          {
            ...(existing ? existing.toObject?.() ?? existing : {}),
            name: character.charName,
            class: character.className,
            itemLevel: character.itemLevel,
            combatScore: character.combatScore,
          },
          existing?.id || createCharacterId()
        );
      });

      // Stamp lastRefreshedAt: the bible fetch we just did to build the
      // picker is fresher than whatever was on the account, so /raid-status
      // lazy-refresh can skip a re-fetch for the cooldown window.
      account.lastRefreshedAt = Date.now();
      await userDoc.save();

      summary.finalChars = account.characters.map((character) => ({
        name: getCharacterName(character),
        class: getCharacterClass(character),
        itemLevel: Number(character.itemLevel) || 0,
        combatScore: character.combatScore || "",
      }));
    });

    return summary;
  }

  async function handleEditRosterCommand(interaction) {
    const callerId = interaction.user.id;
    const rosterArg = interaction.options.getString("roster", true).trim();

    const userDoc = await User.findOne({ discordId: callerId }).lean();
    if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
      await interaction.reply({
        content: `${UI.icons.warn} Cậu chưa có roster nào để edit nha~ Dùng \`/add-roster\` để tạo mới trước.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const targetAccount = userDoc.accounts.find(
      (a) => normalizeName(a.accountName) === normalizeName(rosterArg)
    );
    if (!targetAccount) {
      await interaction.reply({
        content: `${UI.icons.warn} Không tìm thấy roster **${rosterArg}** trong account của cậu. Dùng autocomplete để chọn cho chuẩn nhé.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();

    const savedChars = (targetAccount.characters || []).map((c) => ({
      name: getCharacterName(c),
      class: getCharacterClass(c),
      itemLevel: Number(c.itemLevel) || 0,
      combatScore: c.combatScore || "",
    }));

    // Pick highest-CP saved char as bible seed - most likely to still
    // exist + be findable. Fall back to accountName if the account is
    // empty (shouldn't happen via normal flow, but /remove-roster can
    // leave an empty account behind).
    const seedFromSaved = [...savedChars].sort(
      (a, b) => parseCombatScore(b.combatScore) - parseCombatScore(a.combatScore)
    )[0];
    const seedName = seedFromSaved?.name || targetAccount.accountName;

    let bibleChars = [];
    let bibleError = null;
    try {
      bibleChars = await fetchRosterCharacters(seedName);
    } catch (err) {
      bibleError = err?.message || String(err);
      console.warn(
        `[edit-roster] bible fetch failed for seed '${seedName}': ${bibleError}`
      );
    }

    // Merge saved + bible into a deduped list keyed by normalized name.
    // Bible-side fields (iLvl/CP/class) win when both sources have the
    // char — they're fresher. Saved-only entries keep their stored values.
    const savedMap = new Map(savedChars.map((c) => [normalizeName(c.name), c]));
    const bibleMap = new Map(bibleChars.map((c) => [normalizeName(c.charName), c]));
    const allKeys = new Set([...savedMap.keys(), ...bibleMap.keys()]);

    const merged = [];
    for (const key of allKeys) {
      const saved = savedMap.get(key);
      const bible = bibleMap.get(key);
      merged.push({
        charName: bible?.charName || saved.name,
        className: bible?.className || saved.class,
        itemLevel: bible?.itemLevel ?? saved.itemLevel,
        combatScore: bible?.combatScore || saved.combatScore,
        savedKey: saved ? key : null,
        inBible: !!bible,
      });
    }

    if (merged.length === 0) {
      await interaction.editReply({
        content: `${UI.icons.warn} Roster **${targetAccount.accountName}** không có char nào ở DB và bible cũng không trả về gì. Dùng \`/remove-roster\` nếu muốn xoá hẳn account này, hoặc \`/add-roster\` để tạo lại.`,
      });
      return;
    }

    merged.sort((a, b) => {
      const cpDiff = parseCombatScore(b.combatScore) - parseCombatScore(a.combatScore);
      if (cpDiff !== 0) return cpDiff;
      return (b.itemLevel || 0) - (a.itemLevel || 0);
    });

    const displayChars = merged.slice(0, SELECT_MAX_OPTIONS);
    const truncated = merged.length > SELECT_MAX_OPTIONS;
    if (truncated) {
      console.warn(
        `[edit-roster] roster ${targetAccount.accountName} merged ${merged.length} chars; truncated to ${SELECT_MAX_OPTIONS} for picker.`
      );
    }

    // Default selection = chars currently in saved roster. New bible
    // chars start unticked - user has to opt them in. Saved-not-in-bible
    // chars stay ticked so the default action is "preserve current state".
    const selectedIndices = new Set();
    displayChars.forEach((c, i) => {
      if (c.savedKey) selectedIndices.add(i);
    });

    const sessionId = newSessionId();
    const session = {
      sessionId,
      callerId,
      discordId: callerId,
      accountName: targetAccount.accountName,
      bibleError,
      chars: displayChars.map((c) => ({
        charName: c.charName,
        className: c.className,
        itemLevel: c.itemLevel,
        combatScore: c.combatScore,
        savedKey: c.savedKey,
        inBible: c.inBible,
      })),
      selectedIndices,
      expireTimer: null,
    };
    sessions.set(sessionId, session);

    await interaction.editReply({
      embeds: [buildSelectionEmbed(session)],
      components: buildSelectionComponents(session),
    });

    session.expireTimer = setTimeout(
      () => handleSessionTimeout(sessionId, interaction),
      SESSION_TTL_MS
    );
  }

  function authorizeSession(interaction, session) {
    if (interaction.user.id !== session.callerId) {
      return interaction.reply({
        content: `${UI?.icons?.lock || "🔒"} Chỉ người gọi lệnh mới chọn được nhé.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return null;
  }

  async function handleEditRosterSelect(interaction) {
    const sessionId = interaction.customId.split(":")[2];
    const session = sessions.get(sessionId);
    if (!session) {
      await interaction.reply({
        content: `${UI.icons.warn} Phiên đã hết hạn. Chạy lại \`/edit-roster\` nhé~`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const denied = await authorizeSession(interaction, session);
    if (denied) return;

    session.selectedIndices = new Set(interaction.values.map((v) => Number(v)));
    await interaction.update({
      embeds: [buildSelectionEmbed(session)],
      components: buildSelectionComponents(session),
    });
  }

  async function handleEditRosterButton(interaction) {
    const [, action, sessionId] = interaction.customId.split(":");
    const session = sessions.get(sessionId);
    if (!session) {
      await interaction.reply({
        content: `${UI.icons.warn} Phiên đã hết hạn. Chạy lại \`/edit-roster\` nhé~`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const denied = await authorizeSession(interaction, session);
    if (denied) return;

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
        // Reject 0-select with a hint sang /remove-roster - empty roster
        // is a different operation (cleanup the whole account) and has its
        // own dedicated command.
        await interaction.reply({
          content: `${UI.icons.warn} Phải giữ ít nhất 1 char. Nếu cậu muốn xoá hẳn roster **${session.accountName}**, dùng \`/remove-roster\` nhé.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const selectedChars = Array.from(session.selectedIndices)
        .sort((a, b) => a - b)
        .map((i) => session.chars[i]);

      if (selectedChars.length > MAX_CHARACTERS_PER_ACCOUNT) {
        await interaction.reply({
          content: `${UI.icons.warn} Tối đa **${MAX_CHARACTERS_PER_ACCOUNT}** characters mỗi roster. Cậu đang chọn ${selectedChars.length} - bỏ bớt rồi confirm lại nhé.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferUpdate();
      clearSession(sessionId);

      let summary;
      try {
        summary = await persistEditedRoster(session, selectedChars);
      } catch (err) {
        console.error(`[edit-roster] persist failed:`, err);
        await interaction.editReply({
          embeds: [],
          components: [],
          content: `${UI.icons.warn} Lưu roster thất bại: ${err?.message || err}. Thử lại nhé.`,
        });
        return;
      }

      await interaction.editReply({
        embeds: [buildSavedEmbed(session, summary)],
        components: [],
        allowedMentions: { parse: [] },
      });
    }
  }

  return {
    handleEditRosterAutocomplete,
    handleEditRosterCommand,
    handleEditRosterSelect,
    handleEditRosterButton,
  };
}

module.exports = {
  createEditRosterCommand,
};
