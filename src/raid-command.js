const { EmbedBuilder, SlashCommandBuilder } = require("discord.js");
const { JSDOM } = require("jsdom");
const User = require("./schema/user");
const { getClassName } = require("./models/Class");
const {
  getRaidRequirementChoices,
  getRaidRequirementList,
  getRaidRequirementMap,
} = require("./models/Raid");

const MAX_CHARACTERS_PER_ACCOUNT = 6;
const RAID_LEADER_ROLE_NAME = "raid leader";
const RAID_CHOICES = getRaidRequirementChoices();
const RAID_REQUIREMENT_MAP = getRaidRequirementMap();

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function parseItemLevel(rawValue) {
  const sanitized = String(rawValue || "0")
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");
  const parsed = parseFloat(sanitized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCombatScore(rawValue) {
  const sanitized = String(rawValue || "0")
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");
  const parsed = parseFloat(sanitized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractRosterClassMapFromHtml(html) {
  const rosterClassMap = new Map();
  const regex = /name:\"([^\"]+)\",class:\"([^\"]+)\"/g;

  let match;
  while ((match = regex.exec(html)) !== null) {
    const [, charName, className] = match;
    if (!charName || !className) continue;
    rosterClassMap.set(charName, className);
  }

  return rosterClassMap;
}

async function fetchRosterCharacters(seedCharacterName) {
  const targetUrl = `https://lostark.bible/character/NA/${encodeURIComponent(seedCharacterName)}/roster`;
  const response = await fetch(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`LostArk Bible HTTP ${response.status}`);
  }

  const html = await response.text();
  const { document } = new JSDOM(html).window;
  const rosterClassMap = extractRosterClassMapFromHtml(html);
  const links = document.querySelectorAll('a[href^="/character/NA/"]');

  const characters = [];
  for (const link of links) {
    const headerDiv = link.querySelector(".text-lg.font-semibold");
    if (!headerDiv) continue;

    const charName = [...headerDiv.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent.trim())
      .find((text) => text.length > 0);

    if (!charName) continue;

    const spans = headerDiv.querySelectorAll("span");
    const itemLevelRaw = spans[0]?.textContent.trim() ?? "0";
    const combatScore = spans[1]?.textContent.trim() ?? "?";
    const itemLevel = parseItemLevel(itemLevelRaw);
    if (!Number.isFinite(itemLevel) || itemLevel <= 0) continue;

    characters.push({
      charName,
      className: getClassName(rosterClassMap.get(charName) ?? ""),
      itemLevel,
      combatScore,
    });
  }

  return characters;
}

function ensureRaidEntries(character) {
  const existingRaids = Array.isArray(character.raids) ? character.raids : [];
  const requirementList = getRaidRequirementList();
  const requirementMetaByName = new Map(
    requirementList.map((raid) => [normalizeName(raid.label), raid])
  );
  const raidMap = new Map();
  for (const raid of existingRaids) {
    if (!raid || !raid.raidName) continue;
    raidMap.set(normalizeName(raid.raidName), {
      isJail: Boolean(raid.isJail),
      isCompleted: Boolean(raid.isCompleted ?? raid.isComplete),
    });
  }

  return requirementList.map((raid) => ({
    raidName: raid.label,
    raidKey: requirementMetaByName.get(normalizeName(raid.label))?.raidKey || "",
    modeKey: requirementMetaByName.get(normalizeName(raid.label))?.modeKey || "",
    minItemLevel: requirementMetaByName.get(normalizeName(raid.label))?.minItemLevel || 0,
    isJail: raidMap.get(normalizeName(raid.label))?.isJail ?? false,
    isCompleted: raidMap.get(normalizeName(raid.label))?.isCompleted ?? false,
  }));
}

function getStatusRaidsForCharacter(character) {
  const itemLevel = Number(character?.itemLevel) || 0;
  const eligibleRaids = ensureRaidEntries(character)
    .filter((raid) => itemLevel >= (Number(raid.minItemLevel) || 0));

  if (eligibleRaids.length === 0) return [];

  const groupedByRaidKey = new Map();
  for (const raid of eligibleRaids) {
    if (!groupedByRaidKey.has(raid.raidKey)) groupedByRaidKey.set(raid.raidKey, []);
    groupedByRaidKey.get(raid.raidKey).push(raid);
  }

  const selected = [];
  for (const [raidKey, raids] of groupedByRaidKey.entries()) {
    const sortedRaids = [...raids].sort((a, b) => {
      const minDiff = (Number(b.minItemLevel) || 0) - (Number(a.minItemLevel) || 0);
      if (minDiff !== 0) return minDiff;
      return a.raidName.localeCompare(b.raidName);
    });

    if (raidKey === "serca") {
      const nightmare = sortedRaids.find((raid) => raid.modeKey === "nightmare");
      const hard = sortedRaids.find((raid) => raid.modeKey === "hard");
      if (nightmare && hard) {
        selected.push(nightmare, hard);
        continue;
      }
    }

    if (sortedRaids[0]) {
      selected.push(sortedRaids[0]);
    }
  }

  return selected.sort((a, b) => {
    const minDiff = (Number(b.minItemLevel) || 0) - (Number(a.minItemLevel) || 0);
    if (minDiff !== 0) return minDiff;
    return a.raidName.localeCompare(b.raidName);
  });
}

function isRaidLeader(interaction) {
  const roles = interaction.member?.roles?.cache;
  if (!roles) return false;
  return roles.some((role) => normalizeName(role.name) === RAID_LEADER_ROLE_NAME);
}

const addRosterCommand = new SlashCommandBuilder()
  .setName("add-roster")
  .setDescription("Sync a roster from one character and save the top item levels")
  .addStringOption((option) =>
    option
      .setName("name")
      .setDescription("A character name that belongs to the target roster")
      .setRequired(true)
  )
  .addIntegerOption((option) =>
    option
      .setName("total")
      .setDescription("How many characters to save (1-6, default: 6)")
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(6)
  );

const raidCheckCommand = new SlashCommandBuilder()
  .setName("raid-check")
  .setDescription("(Raid Leader) Scan all uncompleted eligible characters for a raid")
  .addStringOption((option) => {
    option
      .setName("raid")
      .setDescription("Raid to scan")
      .setRequired(true);

    for (const choice of RAID_CHOICES) {
      option.addChoices(choice);
    }
    return option;
  });

const raidSetCommand = new SlashCommandBuilder()
  .setName("raid-set")
  .setDescription("Set complete or jail status for a character raid")
  .addStringOption((option) =>
    option
      .setName("character")
      .setDescription("Character name to update")
      .setRequired(true)
  )
  .addStringOption((option) => {
    option
      .setName("raid")
      .setDescription("Raid to update")
      .setRequired(true);

    for (const choice of RAID_CHOICES) {
      option.addChoices(choice);
    }
    return option;
  })
  .addStringOption((option) =>
    option
      .setName("status")
      .setDescription("Which status to update")
      .setRequired(true)
      .addChoices(
        { name: "Complete", value: "complete" },
        { name: "Jail", value: "jail" }
      )
  );

const statusCommand = new SlashCommandBuilder()
  .setName("raid-status")
  .setDescription("View your raid completion status by account and character");

const commands = [addRosterCommand, raidCheckCommand, raidSetCommand, statusCommand];

async function handleAddRosterCommand(interaction) {
  const discordId = interaction.user.id;
  const seedCharName = interaction.options.getString("name", true).trim();
  const topCount = interaction.options.getInteger("total") ?? MAX_CHARACTERS_PER_ACCOUNT;

  let userDoc = await User.findOne({ discordId });
  if (userDoc) {
    const normalizedSeed = normalizeName(seedCharName);
    const matchedAccount = userDoc.accounts.find(
      (account) =>
        normalizeName(account.accountName) === normalizedSeed ||
        account.characters.some((character) => normalizeName(character.charName) === normalizedSeed)
    );

    if (matchedAccount) {
      await interaction.reply({
        content: `Roster already exists in account **${matchedAccount.accountName}**.`,
        ephemeral: true,
      });
      return;
    }
  }

  await interaction.deferReply();

  let rosterCharacters;
  try {
    rosterCharacters = await fetchRosterCharacters(seedCharName);
  } catch (error) {
    await interaction.editReply(`Failed to fetch roster from LostArk Bible: ${error.message}`);
    return;
  }

  if (rosterCharacters.length === 0) {
    await interaction.editReply("No valid roster was found. Please verify the character name.");
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

  if (!userDoc) {
    userDoc = new User({
      discordId,
      accounts: [],
    });
  }

  const rosterNameSet = new Set(topCharacters.map((character) => normalizeName(character.charName)));

  let account = userDoc.accounts.find((item) =>
    item.characters.some((character) => rosterNameSet.has(normalizeName(character.charName)))
  );

  if (!account) {
    account = {
      accountName: seedCharName,
      characters: [],
    };
    userDoc.accounts.push(account);
    account = userDoc.accounts[userDoc.accounts.length - 1];
  }

  const existingMap = new Map(
    account.characters.map((character) => [normalizeName(character.charName), character])
  );

  account.characters = topCharacters.map((character) => {
    const existing = existingMap.get(normalizeName(character.charName));
    return {
      charName: character.charName,
      className: character.className,
      itemLevel: character.itemLevel,
      combatScore: character.combatScore,
      isGoldEarner: existing?.isGoldEarner ?? false,
      raids: ensureRaidEntries(existing || { raids: [] }),
    };
  });

  await userDoc.save();

  const summaryLines = account.characters.map(
    (character, index) => {
      return `${index + 1}. ${character.charName} · ${character.className || "Unknown"} · \`${character.itemLevel}\` · \`${character.combatScore || "?"}\``;
    }
  );

  const seedRosterLink = `https://lostark.bible/character/NA/${encodeURIComponent(seedCharName)}/roster`;

  const embed = new EmbedBuilder()
    .setTitle("Roster Sync Completed")
    .setDescription(
      [
        `Roster name: [**${account.accountName}**](${seedRosterLink})`,
        `Saved characters: **Top ${topCount}** by combat power`,
      ].join("\n")
    )
    .addFields({
      name: `Top ${account.characters.length} Characters`,
      value: summaryLines.join("\n").slice(0, 1024),
      inline: false,
    })
    .setColor(0x57f287)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function resolveDiscordDisplay(client, discordId) {
  try {
    const user = await client.users.fetch(discordId);
    return user?.username || discordId;
  } catch {
    return discordId;
  }
}

async function handleRaidCheckCommand(interaction) {
  if (!isRaidLeader(interaction)) {
    await interaction.reply({
      content: "Chi Raid Leader moi duoc dung /raid-check.",
      ephemeral: true,
    });
    return;
  }

  const raidKey = interaction.options.getString("raid", true);
  const raidMeta = RAID_REQUIREMENT_MAP[raidKey];
  if (!raidMeta) {
    await interaction.reply({
      content: "Raid option is invalid. Please try again.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const users = await User.find({}).lean();
  const matchedCharacters = [];

  for (const userDoc of users) {
    const accounts = Array.isArray(userDoc.accounts) ? userDoc.accounts : [];
    for (const account of accounts) {
      const characters = Array.isArray(account.characters) ? account.characters : [];
      for (const character of characters) {
        if (!character || Number(character.itemLevel) < raidMeta.minItemLevel) continue;

        const raids = ensureRaidEntries(character);
        const targetRaid = raids.find(
          (raid) => normalizeName(raid.raidName) === normalizeName(raidMeta.label)
        );

        if (targetRaid && targetRaid.isCompleted === false) {
          matchedCharacters.push({
            discordId: userDoc.discordId,
            charName: character.charName,
            itemLevel: character.itemLevel,
          });
        }
      }
    }
  }

  if (matchedCharacters.length === 0) {
    await interaction.editReply(
      `Khong co nhan vat nao dat iLvl >= ${raidMeta.minItemLevel} ma chua hoan thanh **${raidMeta.label}**.`
    );
    return;
  }

  const uniqueDiscordIds = [...new Set(matchedCharacters.map((item) => item.discordId))];
  const displayMap = new Map();
  await Promise.all(
    uniqueDiscordIds.map(async (discordId) => {
      const displayName = await resolveDiscordDisplay(interaction.client, discordId);
      displayMap.set(discordId, displayName);
    })
  );

  const lines = matchedCharacters
    .sort((a, b) => b.itemLevel - a.itemLevel)
    .map((item) => `${displayMap.get(item.discordId)} - ${item.charName} (${item.itemLevel})`);

  const chunks = [];
  let currentChunk = `Raid: **${raidMeta.label}** (>= ${raidMeta.minItemLevel})\n\n`;
  for (const line of lines) {
    if (currentChunk.length + line.length + 1 > 1900) {
      chunks.push(currentChunk);
      currentChunk = "";
    }
    currentChunk += `${line}\n`;
  }
  if (currentChunk.trim()) chunks.push(currentChunk);

  await interaction.editReply(chunks[0]);
  for (let index = 1; index < chunks.length; index += 1) {
    await interaction.followUp({ content: chunks[index], ephemeral: true });
  }
}

async function handleStatusCommand(interaction) {
  const discordId = interaction.user.id;
  const userDoc = await User.findOne({ discordId }).lean();

  if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
    await interaction.reply({
      content: "You do not have any saved roster yet. Use /add-roster first.",
      ephemeral: true,
    });
    return;
  }

  const totalCharacters = userDoc.accounts.reduce(
    (sum, account) => sum + (Array.isArray(account.characters) ? account.characters.length : 0),
    0
  );

  const totalPendingCharacters = userDoc.accounts.reduce((sum, account) => {
    const characters = Array.isArray(account.characters) ? account.characters : [];
    const pending = characters.filter((character) => {
      const raids = ensureRaidEntries(character);
      return raids.some((raid) => !raid.isCompleted);
    }).length;
    return sum + pending;
  }, 0);

  const embed = new EmbedBuilder()
    .setTitle("Raid Status")
    .setDescription(
      [
        `Characters: **${totalCharacters}**`,
        "Status: ❌ Jail | ✅ Done | ❓ Pending",
      ].join("\n")
    )
    .setColor(0x5865f2)
    .setTimestamp();

  for (const account of userDoc.accounts.slice(0, 25)) {
    const characters = Array.isArray(account.characters) ? account.characters : [];
    if (characters.length === 0) {
      embed.addFields({
        name: `Account: ${account.accountName}`,
        value: "No characters saved.",
        inline: false,
      });
      continue;
    }

    const lines = characters.map((character) => {
      const raids = getStatusRaidsForCharacter(character);
      if (raids.length === 0) {
        return `• ${character.charName}: No eligible raids for current iLvl`;
      }

      const raidSummary = raids
        .map((raid) => {
          if (raid.isJail) return `${raid.raidName} ❌`;
          return `${raid.raidName} ${raid.isCompleted ? "✅" : "❓"}`;
        })
        .join(", ");
      return `• ${character.charName} (${character.className || "Unknown"}): ${raidSummary}`;
    });

    const value = lines.join("\n");
    embed.addFields({
      name: `Account: ${account.accountName}`,
      value: value.length > 1024 ? `${value.slice(0, 1020)}...` : value,
      inline: false,
    });
  }

  await interaction.reply({ embeds: [embed] });
}

async function handleRaidSetCommand(interaction) {
  const discordId = interaction.user.id;
  const characterName = interaction.options.getString("character", true).trim();
  const raidKey = interaction.options.getString("raid", true);
  const statusType = interaction.options.getString("status", true);
  const raidMeta = RAID_REQUIREMENT_MAP[raidKey];

  if (!raidMeta) {
    await interaction.reply({
      content: "Raid option is invalid. Please try again.",
      ephemeral: true,
    });
    return;
  }

  if (!["complete", "jail"].includes(statusType)) {
    await interaction.reply({
      content: "Status type is invalid. Use complete or jail.",
      ephemeral: true,
    });
    return;
  }

  const userDoc = await User.findOne({ discordId });
  if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
    await interaction.reply({
      content: "You do not have any saved roster yet. Use /add-roster first.",
      ephemeral: true,
    });
    return;
  }

  const targetName = normalizeName(characterName);
  let updatedCount = 0;
  for (const account of userDoc.accounts) {
    const characters = Array.isArray(account.characters) ? account.characters : [];
    for (const character of characters) {
      if (normalizeName(character.charName) !== targetName) continue;

      const normalizedRaids = ensureRaidEntries(character).map((raid) => {
        if (normalizeName(raid.raidName) !== normalizeName(raidMeta.label)) {
          return {
            raidName: raid.raidName,
            isCompleted: raid.isCompleted,
            isJail: raid.isJail,
          };
        }

        return {
          raidName: raid.raidName,
          isCompleted: statusType === "complete" ? true : raid.isCompleted,
          isJail: statusType === "complete" ? false : true,
        };
      });

      character.raids = normalizedRaids;
      updatedCount += 1;
    }
  }

  if (updatedCount === 0) {
    await interaction.reply({
      content: `Character **${characterName}** was not found in your roster.`,
      ephemeral: true,
    });
    return;
  }

  await userDoc.save();

  await interaction.reply({
    content:
      `Updated **${raidMeta.label}** for **${characterName}**. `,
    ephemeral: true,
  });
}

async function handleRaidManagementCommand(interaction) {
  if (interaction.commandName === "add-roster") {
    await handleAddRosterCommand(interaction);
    return;
  }

  if (interaction.commandName === "raid-check") {
    await handleRaidCheckCommand(interaction);
    return;
  }

  if (interaction.commandName === "raid-set") {
    await handleRaidSetCommand(interaction);
    return;
  }

  if (interaction.commandName === "raid-status") {
    await handleStatusCommand(interaction);
  }
}

module.exports = {
  commands,
  handleRaidManagementCommand,
};
