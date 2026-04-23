"use strict";

function createAddRosterCommand({
  EmbedBuilder,
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
}) {
  async function handleAddRosterCommand(interaction) {
    const discordId = interaction.user.id;
    const seedCharName = interaction.options.getString("name", true).trim();
    const topCount = interaction.options.getInteger("total") ?? MAX_CHARACTERS_PER_ACCOUNT;
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
      await interaction.editReply(`${UI.icons.warn} Không fetch được roster từ lostark.bible: ${error.message}`);
      return;
    }
    if (rosterCharacters.length === 0) {
      await interaction.editReply(`${UI.icons.warn} Không tìm thấy roster hợp lệ. Kiểm tra lại tên character nhé.`);
      return;
    }
    const topCharacters = rosterCharacters
      .sort((a, b) => {
        const aCombat = parseCombatScore(a.combatScore);
        const bCombat = parseCombatScore(b.combatScore);
        const combatDiff = bCombat - aCombat;
        if (combatDiff !== 0) return combatDiff;
        return b.itemLevel - a.itemLevel;
      })
      .slice(0, topCount);
    const rosterNameSet = new Set(topCharacters.map((character) => normalizeName(character.charName)));
    let savedAccount;
    await saveWithRetry(async () => {
      let userDoc = await User.findOne({ discordId });
      if (!userDoc) {
        userDoc = new User({ discordId, accounts: [] });
      }
      ensureFreshWeek(userDoc);
      const normalizedSeed = normalizeName(seedCharName);
      let account = userDoc.accounts.find((item) => {
        if (normalizeName(item.accountName) === normalizedSeed) return true;
        const chars = Array.isArray(item.characters) ? item.characters : [];
        if (chars.some((character) => normalizeName(getCharacterName(character)) === normalizedSeed)) return true;
        return chars.some((character) => rosterNameSet.has(normalizeName(getCharacterName(character))));
      });
      if (!account) {
        userDoc.accounts.push({ accountName: seedCharName, characters: [] });
        account = userDoc.accounts[userDoc.accounts.length - 1];
      }
      const existingMap = new Map(
        account.characters.map((character) => [normalizeName(getCharacterName(character)), character])
      );
      account.characters = topCharacters.map((character) => {
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
    const summaryLines = savedAccount.characters.map(
      (character, index) => {
        return `${index + 1}. ${character.name} · ${character.class} · \`${character.itemLevel}\` · \`${character.combatScore || "?"}\``;
      }
    );
    const seedRosterLink = `https://lostark.bible/character/NA/${encodeURIComponent(seedCharName)}/roster`;
    const embed = new EmbedBuilder()
      .setTitle(`${UI.icons.roster} Roster Synced`)
      .setDescription(
        [
          `Roster: [**${savedAccount.accountName}**](${seedRosterLink})`,
          `Saved: **Top ${savedAccount.characters.length}** characters by combat power`,
        ].join("\n")
      )
      .addFields({
        name: `Characters (${savedAccount.characters.length})`,
        value: summaryLines.join("\n").slice(0, 1024),
        inline: false,
      })
      .setColor(UI.colors.success)
      .setFooter({ text: "Source: lostark.bible" })
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  }

  return {
    handleAddRosterCommand,
  };
}

module.exports = {
  createAddRosterCommand,
};
