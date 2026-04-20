const { EmbedBuilder, SlashCommandBuilder } = require("discord.js");
const { JSDOM } = require("jsdom");
const User = require("./schema/user");
const { getClassName } = require("./models/Class");
const {
  RAID_REQUIREMENTS,
  getRaidRequirementChoices,
  getRaidRequirementList,
  getRaidRequirementMap,
} = require("./models/Raid");

const MAX_CHARACTERS_PER_ACCOUNT = 6;
const RAID_LEADER_ROLE_NAME = "raid leader";
const RAID_CHOICES = getRaidRequirementChoices();
const RAID_REQUIREMENT_MAP = getRaidRequirementMap();
const RAID_GROUP_KEYS = Object.keys(RAID_REQUIREMENTS);

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

function toModeLabel(modeKey) {
  const lower = normalizeName(modeKey);
  if (lower === "hard") return "Hard";
  if (lower === "nightmare") return "Nightmare";
  return "Normal";
}

function toModeKey(modeLabel) {
  const lower = normalizeName(modeLabel);
  if (lower === "hard") return "hard";
  if (lower === "nightmare") return "nightmare";
  return "normal";
}

function getCharacterName(character) {
  return character?.name || character?.charName || "";
}

function getCharacterClass(character) {
  return character?.class || character?.className || "Unknown";
}

function getRequirementFor(raidKey, modeKey) {
  const value = `${raidKey}_${modeKey}`;
  return RAID_REQUIREMENT_MAP[value] || null;
}

function getBestEligibleModeKey(raidKey, itemLevel) {
  const modes = Object.entries(RAID_REQUIREMENTS[raidKey]?.modes || {})
    .map(([modeKey, mode]) => ({ modeKey, minItemLevel: Number(mode.minItemLevel) || 0 }))
    .filter((item) => Number(itemLevel) >= item.minItemLevel)
    .sort((a, b) => b.minItemLevel - a.minItemLevel);

  return modes[0]?.modeKey || null;
}

function sanitizeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter((task) => task && task.id)
    .map((task) => ({
      id: String(task.id),
      completions: Number(task.completions) || 0,
      completionDate: Number(task.completionDate) || undefined,
    }));
}

function getGateKeys(assignedRaid) {
  return Object.keys(assignedRaid || {})
    .filter((key) => /^G\d+$/i.test(key))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function normalizeAssignedRaid(assignedRaid, fallbackDifficulty) {
  const gateKeys = getGateKeys(assignedRaid);
  const keys = gateKeys.length > 0 ? gateKeys : ["G1", "G2"];

  const normalized = {};
  for (const gate of keys) {
    const source = assignedRaid?.[gate] || {};
    normalized[gate] = {
      difficulty: source.difficulty || assignedRaid?.G1?.difficulty || fallbackDifficulty,
      completedDate: Number(source.completedDate) || undefined,
    };
  }

  return normalized;
}

function getCompletedGateKeys(assignedRaid) {
  return getGateKeys(assignedRaid).filter((gate) => Number(assignedRaid?.[gate]?.completedDate) > 0);
}

function buildAssignedRaidFromLegacy(legacyRaid) {
  const requirement = getRaidRequirementList().find(
    (raid) => normalizeName(raid.label) === normalizeName(legacyRaid?.raidName)
  );
  if (!requirement) return null;

  const modeLabel = toModeLabel(requirement.modeKey);
  const completedDate = legacyRaid?.isCompleted ? Date.now() : undefined;
  return {
    raidKey: requirement.raidKey,
    data: {
      G1: { difficulty: modeLabel, completedDate },
      G2: { difficulty: modeLabel, completedDate },
    },
  };
}

function ensureAssignedRaids(character) {
  const itemLevel = Number(character?.itemLevel) || 0;
  const existing = character?.assignedRaids || {};
  const legacyRaids = Array.isArray(character?.raids) ? character.raids : [];
  const assigned = {};

  for (const raidKey of RAID_GROUP_KEYS) {
    const bestModeKey = getBestEligibleModeKey(raidKey, itemLevel) || "normal";
    const fallbackDifficulty = toModeLabel(bestModeKey);
    const sourceRaid = existing[raidKey] || {};

    assigned[raidKey] = normalizeAssignedRaid(sourceRaid, fallbackDifficulty);
  }

  for (const legacyRaid of legacyRaids) {
    const converted = buildAssignedRaidFromLegacy(legacyRaid);
    if (!converted) continue;
    assigned[converted.raidKey] = converted.data;
  }

  return assigned;
}

function isAssignedRaidCompleted(assignedRaid) {
  const gates = getGateKeys(assignedRaid);
  if (gates.length === 0) return false;
  return gates.every((gate) => Number(assignedRaid?.[gate]?.completedDate) > 0);
}

function buildCharacterRecord(source, fallbackId) {
  return {
    id: String(source?.id || fallbackId),
    name: getCharacterName(source),
    class: getCharacterClass(source),
    itemLevel: Number(source?.itemLevel) || 0,
    isGoldEarner: Boolean(source?.isGoldEarner),
    combatScore: String(source?.combatScore || ""),
    assignedRaids: ensureAssignedRaids(source),
    tasks: sanitizeTasks(source?.tasks),
  };
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
  const assignedRaids = ensureAssignedRaids(character);
  const raids = [];

  for (const raidKey of RAID_GROUP_KEYS) {
    const assignedRaid = assignedRaids[raidKey];
    const difficulty = assignedRaid?.G1?.difficulty || assignedRaid?.G2?.difficulty || "Normal";
    const modeKey = toModeKey(difficulty);
    const requirement = getRequirementFor(raidKey, modeKey) || getRequirementFor(raidKey, "normal");
    if (!requirement) continue;

    raids.push({
      raidName: requirement.label,
      raidKey,
      modeKey,
      minItemLevel: requirement.minItemLevel,
      completedGateKeys: getCompletedGateKeys(assignedRaid),
      isCompleted: isAssignedRaidCompleted(assignedRaid),
    });
  }

  return raids;
}

function getStatusRaidsForCharacter(character) {
  const itemLevel = Number(character?.itemLevel) || 0;
  const assignedRaids = ensureAssignedRaids(character);
  const selected = [];

  for (const raidKey of RAID_GROUP_KEYS) {
    const assignedRaid = assignedRaids[raidKey];
    const selectedDifficulty = assignedRaid?.G1?.difficulty || assignedRaid?.G2?.difficulty || "Normal";
    const modeKey = toModeKey(selectedDifficulty);
    const requirement = getRequirementFor(raidKey, modeKey);
    if (!requirement || itemLevel < requirement.minItemLevel) continue;

    selected.push({
      raidName: requirement.label,
      raidKey,
      modeKey,
      minItemLevel: requirement.minItemLevel,
      completedGateKeys: getCompletedGateKeys(assignedRaid),
      isCompleted: isAssignedRaidCompleted(assignedRaid),
    });
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
  .setDescription("Set complete status for a character raid (full raid or specific gate)")
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
      .setDescription("Which action to update")
      .setRequired(true)
      .addChoices(
        { name: "Complete", value: "complete" },
        { name: "Reset", value: "reset" }
      )
  )
  .addStringOption((option) =>
    option
      .setName("gate")
      .setDescription("Optional: update only one gate")
      .setRequired(false)
      .addChoices(
        { name: "G1", value: "G1" },
        { name: "G2", value: "G2" },
        { name: "G3", value: "G3" }
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
        account.characters.some((character) => normalizeName(getCharacterName(character)) === normalizedSeed)
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
    item.characters.some((character) => rosterNameSet.has(normalizeName(getCharacterName(character))))
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
    account.characters.map((character) => [normalizeName(getCharacterName(character)), character])
  );

  account.characters = topCharacters.map((character) => {
    const existing = existingMap.get(normalizeName(character.charName));
    return buildCharacterRecord(
      {
        ...existing,
        name: character.charName,
        class: character.className,
        itemLevel: character.itemLevel,
        combatScore: character.combatScore,
      },
      existing?.id || String(account.characters.length + 1)
    );
  });

  await userDoc.save();

  const summaryLines = account.characters.map(
    (character, index) => {
      return `${index + 1}. ${getCharacterName(character)} · ${getCharacterClass(character)} · \`${character.itemLevel}\` · \`${character.combatScore || "?"}\``;
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

        const assignedRaids = ensureAssignedRaids(character);
        const assigned = assignedRaids[raidMeta.raidKey];
        const selectedDifficulty = toModeLabel(raidMeta.modeKey);
        const gateKeys = getGateKeys(assigned);
        const sameDifficulty = gateKeys.every(
          (gate) => normalizeName(assigned?.[gate]?.difficulty) === normalizeName(selectedDifficulty)
        );
        const completed = sameDifficulty && isAssignedRaidCompleted(assigned);

        if (!completed) {
          matchedCharacters.push({
            discordId: userDoc.discordId,
            charName: getCharacterName(character),
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
        "Status: ✅ Done all gates | G1/G2(/G3) = partial progress | ❓ Pending",
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
        return `• ${getCharacterName(character)}: No eligible raids for current iLvl`;
      }

      const raidSummary = raids
        .map((raid) => {
          if (raid.isCompleted) return `${raid.raidName} ✅`;
          if (Array.isArray(raid.completedGateKeys) && raid.completedGateKeys.length > 0) {
            return `${raid.raidName} ${raid.completedGateKeys.join("/")}`;
          }
          return `${raid.raidName} ❓`;
        })
        .join(", ");
      return `• ${getCharacterName(character)} (${getCharacterClass(character)}): ${raidSummary}`;
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
  const targetGate = interaction.options.getString("gate") || "";
  const raidMeta = RAID_REQUIREMENT_MAP[raidKey];

  if (!raidMeta) {
    await interaction.reply({
      content: "Raid option is invalid. Please try again.",
      ephemeral: true,
    });
    return;
  }

  if (!["complete", "reset"].includes(statusType)) {
    await interaction.reply({
      content: "Status type is invalid. Use complete or reset.",
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
  const now = Date.now();
  const selectedDifficulty = toModeLabel(raidMeta.modeKey);
  let updatedCount = 0;
  for (const account of userDoc.accounts) {
    const characters = Array.isArray(account.characters) ? account.characters : [];
    for (const character of characters) {
      if (normalizeName(getCharacterName(character)) !== targetName) continue;

      const assignedRaids = ensureAssignedRaids(character);
      const raidData = normalizeAssignedRaid(assignedRaids[raidMeta.raidKey] || {
        G1: { difficulty: selectedDifficulty },
        G2: { difficulty: selectedDifficulty },
      }, selectedDifficulty);

      const gateKeys = targetGate ? [targetGate] : getGateKeys(raidData);
      for (const gate of gateKeys) {
        raidData[gate] = {
          difficulty: selectedDifficulty,
          completedDate: statusType === "complete" ? now : null,
        };
      }

      assignedRaids[raidMeta.raidKey] = raidData;
      character.assignedRaids = assignedRaids;

      // Keep basic shape updated when old documents are edited.
      if (!character.name) character.name = getCharacterName(character);
      if (!character.class) character.class = getCharacterClass(character);
      if (!character.id) character.id = String(updatedCount + 1);

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
      `Updated **${raidMeta.label}** for **${characterName}**. ` +
      `${statusType === "complete" ? "Completed" : "Reset"}` +
      `${targetGate ? ` ${targetGate}` : " all gates"}.`,
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
