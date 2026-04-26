"use strict";

const crypto = require("crypto");

// Two-step flow window: from /add-roster invocation to Confirm click. After
// 5 minutes the in-memory session is dropped and the embed is updated to
// "expired"; user must re-run the command to retry. Matches the budget
// Traine specified.
const SESSION_TTL_MS = 5 * 60 * 1000;

// Discord StringSelectMenu cap. Real Lost Ark rosters max out at ~18
// characters per account, so 25 covers everyone with headroom. If a
// roster ever exceeds this, the extras are dropped from the picker (the
// CP-sorted prefix wins, matching the old top-N behavior for that edge).
const SELECT_MAX_OPTIONS = 25;

const CHECK_ICON = "✅";
const UNCHECK_ICON = "⬜";

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
}) {
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
    const lines = session.chars.map((c, i) => {
      const checked = session.selectedIndices.has(i) ? CHECK_ICON : UNCHECK_ICON;
      const cp = c.combatScore || "?";
      return `${checked} **${i + 1}.** ${c.charName} · ${c.className} · iLvl \`${c.itemLevel}\` · CP \`${cp}\``;
    });

    const desc = [
      `Roster: [**${session.seedCharName}**](${buildSeedRosterLink(session.seedCharName)})`,
      `Tìm thấy **${session.chars.length}** characters - chọn những char muốn track:`,
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
    // Plain objects (APIStringSelectOption shape) instead of
    // StringSelectMenuOptionBuilder so the factory doesn't have to take
    // an extra discord.js dep — addOptions accepts both shapes.
    const options = session.chars.map((c, i) => {
      const cpLabel = c.combatScore || "?";
      return {
        label: `${i + 1}. ${c.charName} (${c.className})`.slice(0, 100),
        description: `iLvl ${c.itemLevel} · CP ${cpLabel}`.slice(0, 100),
        value: String(i),
        default: session.selectedIndices.has(i),
      };
    });

    // min=0 lets the user deselect everything via the dropdown; the
    // Confirm button below is disabled in that state so an empty save
    // is impossible. max=chars.length so multi-select up to all is
    // allowed (Discord caps at 25 anyway, which we already enforced).
    const select = new StringSelectMenuBuilder()
      .setCustomId(`add-roster:select:${session.sessionId}`)
      .setPlaceholder(`Chọn chars (${session.chars.length} có sẵn)`)
      .setMinValues(0)
      .setMaxValues(session.chars.length)
      .addOptions(options);

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`add-roster:confirm:${session.sessionId}`)
      .setLabel(`Confirm (${session.selectedIndices.size})`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(session.selectedIndices.size === 0);

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`add-roster:cancel:${session.sessionId}`)
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

  function buildSavedEmbed(session, savedAccount) {
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

  // The save path used to live inline in handleAddRosterCommand; pulled
  // out so Confirm can reuse the same logic without round-tripping the
  // whole command. Returns a plain account snapshot for embed rendering.
  async function persistSelectedRoster(session, selectedChars) {
    const rosterNameSet = new Set(selectedChars.map((c) => normalizeName(c.charName)));
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
      if (!account) {
        userDoc.accounts.push({ accountName: session.seedCharName, characters: [] });
        account = userDoc.accounts[userDoc.accounts.length - 1];
      }
      const existingMap = new Map(
        account.characters.map((character) => [normalizeName(getCharacterName(character)), character])
      );
      account.characters = selectedChars.map((character) => {
        const existing = existingMap.get(normalizeName(character.charName));
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
          content: `${UI.icons.lock} Chỉ Raid Manager mới được add roster cho người khác (option \`target\`). Tự add cho mình thì bỏ option \`target\` đi nhé.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (targetUser.bot) {
        await interaction.reply({
          content: `${UI.icons.warn} Không add roster cho bot được nha~`,
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
          content: `${UI.icons.warn} Roster đã tồn tại ở account **${matched.accountName}**. Không thể add trùng.`,
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
    if (existingUser && Array.isArray(existingUser.accounts)) {
      const bibleNameSet = new Set(
        rosterCharacters.map((c) => normalizeName(c.charName))
      );
      const collidingAccount = existingUser.accounts.find((account) => {
        const chars = Array.isArray(account.characters) ? account.characters : [];
        return chars.some((c) =>
          bibleNameSet.has(normalizeName(getCharacterName(c)))
        );
      });
      if (collidingAccount) {
        await interaction.editReply({
          content: `${UI.icons.warn} Roster này đã được saved ở account **${collidingAccount.accountName}** (chars overlap với bible roster). Dùng \`/edit-roster roster:${collidingAccount.accountName}\` để sửa, hoặc \`/remove-roster\` để xoá rồi add lại.`,
        });
        return;
      }
    }

    // CP-sorted (highest first) so the picker shows the most-played
    // chars at the top by default. We do NOT slice to the old top-N
    // here — that was the whole point of this rewrite. We only cap at
    // SELECT_MAX_OPTIONS (Discord limit) which is well above any real
    // roster size.
    const sortedChars = [...rosterCharacters].sort((a, b) => {
      const aCombat = parseCombatScore(a.combatScore);
      const bCombat = parseCombatScore(b.combatScore);
      const combatDiff = bCombat - aCombat;
      if (combatDiff !== 0) return combatDiff;
      return b.itemLevel - a.itemLevel;
    });
    const displayChars = sortedChars.slice(0, SELECT_MAX_OPTIONS);
    const truncated = sortedChars.length > SELECT_MAX_OPTIONS;

    const sessionId = newSessionId();
    // Default selection: every char shown. Matches Traine's intent
    // ("user này chơi toàn bộ"). Users with alts they don't play can
    // deselect via the dropdown before confirming.
    const selectedIndices = new Set(displayChars.map((_, i) => i));

    const session = {
      sessionId,
      callerId,
      targetId: targetUser?.id || null,
      discordId,
      actingForOther,
      seedCharName,
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
        `[add-roster] roster ${seedCharName} has ${sortedChars.length} chars; truncated to ${SELECT_MAX_OPTIONS} for picker.`
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
        content: `${UI?.icons?.lock || "🔒"} Chỉ người gọi lệnh mới chọn được nhé.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return null;
  }

  async function handleAddRosterSelect(interaction) {
    const parts = interaction.customId.split(":");
    const sessionId = parts[2];
    const session = sessions.get(sessionId);
    if (!session) {
      await interaction.reply({
        content: `${UI.icons.warn} Phiên đã hết hạn. Chạy lại \`/add-roster\` nhé~`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const denied = await authorizeSession(interaction, session);
    if (denied) return;

    // Replace selection wholesale — values is the full new selection
    // set (not a delta), so a Set rebuild is correct.
    session.selectedIndices = new Set(interaction.values.map((v) => Number(v)));

    await interaction.update({
      embeds: [buildSelectionEmbed(session)],
      components: buildSelectionComponents(session),
    });
  }

  async function handleAddRosterButton(interaction) {
    const [, action, sessionId] = interaction.customId.split(":");
    const session = sessions.get(sessionId);
    if (!session) {
      await interaction.reply({
        content: `${UI.icons.warn} Phiên đã hết hạn. Chạy lại \`/add-roster\` nhé~`,
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
        await interaction.reply({
          content: `${UI.icons.warn} Phải chọn ít nhất 1 character mới confirm được nhé.`,
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
      // already capped at SELECT_MAX_OPTIONS but a future change could
      // raise that without reviewing the storage cap, so guard here too.
      if (selectedChars.length > MAX_CHARACTERS_PER_ACCOUNT) {
        await interaction.reply({
          content: `${UI.icons.warn} Tối đa **${MAX_CHARACTERS_PER_ACCOUNT}** characters mỗi roster. Cậu đang chọn ${selectedChars.length} - bỏ bớt rồi confirm lại nhé.`,
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
        console.error(`[add-roster] persist failed:`, err);
        await interaction.editReply({
          embeds: [],
          components: [],
          content: `${UI.icons.warn} Lưu roster thất bại: ${err?.message || err}. Thử lại nhé.`,
        });
        return;
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
        embeds: [buildSavedEmbed(session, savedAccount)],
        components: [],
        allowedMentions: session.actingForOther
          ? { users: [session.targetId] }
          : { parse: [] },
      });
    }
  }

  return {
    handleAddRosterCommand,
    handleAddRosterSelect,
    handleAddRosterButton,
  };
}

module.exports = {
  createAddRosterCommand,
};
