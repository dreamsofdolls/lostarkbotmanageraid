const {
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
} = require("discord.js");
const { randomUUID } = require("node:crypto");
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

const UI = {
  colors: {
    success: 0x57f287,
    progress: 0xfee75c,
    neutral: 0x5865f2,
    danger: 0xed4245,
    muted: 0x99aab5,
  },
  icons: {
    done: "✅",
    partial: "🟡",
    pending: "⚪",
    reset: "🔄",
    lock: "🔒",
    warn: "⚠️",
  },
};

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function createCharacterId() {
  try {
    return randomUUID();
  } catch {
    return `char_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
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
    id: String(source?.id || fallbackId || createCharacterId()),
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
    const completedGateKeys = getCompletedGateKeys(assignedRaid);

    // At 1740+, surface both Serca Hard and Nightmare as selectable options
    // (Hard alone still eligible from 1730 via the generic branch below).
    const allGateKeys = getGateKeys(assignedRaid);

    if (raidKey === "serca" && itemLevel >= 1740) {
      for (const sercaModeKey of ["hard", "nightmare"]) {
        const sercaRequirement = getRequirementFor(raidKey, sercaModeKey);
        if (!sercaRequirement || itemLevel < sercaRequirement.minItemLevel) continue;

        const isSameMode = modeKey === sercaModeKey;
        selected.push({
          raidName: sercaRequirement.label,
          raidKey,
          modeKey: sercaModeKey,
          minItemLevel: sercaRequirement.minItemLevel,
          allGateKeys,
          completedGateKeys: isSameMode ? completedGateKeys : [],
          isCompleted: isSameMode && isAssignedRaidCompleted(assignedRaid),
        });
      }
      continue;
    }

    const requirement = getRequirementFor(raidKey, modeKey);
    if (!requirement || itemLevel < requirement.minItemLevel) continue;

    selected.push({
      raidName: requirement.label,
      raidKey,
      modeKey,
      minItemLevel: requirement.minItemLevel,
      allGateKeys,
      completedGateKeys,
      isCompleted: isAssignedRaidCompleted(assignedRaid),
    });
  }

  return selected.sort((a, b) => {
    const minDiff = (Number(b.minItemLevel) || 0) - (Number(a.minItemLevel) || 0);
    if (minDiff !== 0) return minDiff;
    return a.raidName.localeCompare(b.raidName);
  });
}

function formatRaidStatusLine(raid) {
  const gates = Array.isArray(raid.allGateKeys) && raid.allGateKeys.length > 0
    ? raid.allGateKeys
    : ["G1", "G2"];
  const done = new Set(raid.completedGateKeys || []).size;
  const total = gates.length;

  if (raid.isCompleted) return `${UI.icons.done} ${raid.raidName} · ${done}/${total}`;
  if (done > 0) return `${UI.icons.partial} ${raid.raidName} · ${done}/${total}`;
  return `${UI.icons.pending} ${raid.raidName} · ${done}/${total}`;
}

function summarizeRaidProgress(allRaids) {
  const total = allRaids.length;
  if (total === 0) return { color: UI.colors.muted, completed: 0, partial: 0, total: 0 };

  let completed = 0;
  let partial = 0;
  for (const raid of allRaids) {
    if (raid.isCompleted) completed += 1;
    else if ((raid.completedGateKeys || []).length > 0) partial += 1;
  }

  let color = UI.colors.neutral;
  if (completed === total) color = UI.colors.success;
  else if (completed > 0 || partial > 0) color = UI.colors.progress;

  return { color, completed, partial, total };
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

const laraidHelpCommand = new SlashCommandBuilder()
  .setName("laraidhelp")
  .setDescription("Show help for the raid management bot (bilingual EN + VN)");

const commands = [addRosterCommand, raidCheckCommand, raidSetCommand, statusCommand, laraidHelpCommand];

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
      existing?.id || createCharacterId()
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
        if (!character) continue;
        const characterItemLevel = Number(character.itemLevel) || 0;
        if (characterItemLevel < raidMeta.minItemLevel) continue;

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

  const allRaidEntries = [];
  for (const account of userDoc.accounts) {
    const characters = Array.isArray(account.characters) ? account.characters : [];
    for (const character of characters) {
      for (const raid of getStatusRaidsForCharacter(character)) {
        allRaidEntries.push(raid);
      }
    }
  }

  const progress = summarizeRaidProgress(allRaidEntries);
  const titleIcon = progress.total === 0
    ? UI.icons.lock
    : progress.completed === progress.total
      ? UI.icons.done
      : progress.completed + progress.partial > 0
        ? UI.icons.partial
        : UI.icons.pending;

  const embed = new EmbedBuilder()
    .setTitle(`${titleIcon} Raid Status`)
    .setDescription(
      progress.total === 0
        ? `**${totalCharacters}** characters · no eligible raids yet`
        : `**${totalCharacters}** characters · **${progress.completed}/${progress.total}** raids done · ${progress.partial} in progress`
    )
    .setColor(progress.color)
    .setFooter({ text: `${UI.icons.done} done · ${UI.icons.partial} partial · ${UI.icons.pending} pending` })
    .setTimestamp();

  for (const account of userDoc.accounts.slice(0, 25)) {
    const characters = Array.isArray(account.characters) ? account.characters : [];
    if (characters.length === 0) {
      embed.addFields({
        name: `📁 ${account.accountName}`,
        value: "_No characters saved._",
        inline: false,
      });
      continue;
    }

    const lines = characters.map((character) => {
      const raids = getStatusRaidsForCharacter(character);
      const header = `**${getCharacterName(character)}** · ${getCharacterClass(character)} · \`${Number(character.itemLevel) || 0}\``;
      if (raids.length === 0) {
        return `${header}\n  ${UI.icons.lock} _Not eligible for any raid yet_`;
      }
      const raidLines = raids.map((raid) => `  ${formatRaidStatusLine(raid)}`).join("\n");
      return `${header}\n${raidLines}`;
    });

    const value = lines.join("\n\n");
    embed.addFields({
      name: `📁 ${account.accountName}`,
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
      if (!character.id) character.id = createCharacterId();

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

  const isComplete = statusType === "complete";
  const resultEmbed = new EmbedBuilder()
    .setTitle(`${isComplete ? UI.icons.done : UI.icons.reset} Raid ${isComplete ? "Completed" : "Reset"}`)
    .setColor(isComplete ? UI.colors.success : UI.colors.muted)
    .addFields(
      { name: "Character", value: `**${characterName}**`, inline: true },
      { name: "Raid", value: `**${raidMeta.label}**`, inline: true },
      { name: "Gates", value: targetGate || "All gates", inline: true },
    )
    .setTimestamp();

  await interaction.reply({ embeds: [resultEmbed], ephemeral: true });
}

const HELP_SECTIONS = [
  {
    key: "add-roster",
    label: "/add-roster",
    icon: "📥",
    short: "Sync roster from lostark.bible",
    shortVn: "Đồng bộ roster từ lostark.bible",
    options: [
      { name: "name", required: true, desc: "Tên 1 character trong roster / Name of a character in the roster" },
      { name: "total", required: false, desc: "Số characters muốn lưu (1-6, default 6) / Number of characters to save" },
    ],
    example: "/add-roster name:Clauseduk total:6",
    notes: [
      "EN: Saves top-N characters ranked by combat score; falls back to item level for ties.",
      "VN: Lưu top-N nhân vật theo combat score; nếu bằng điểm thì xếp theo item level.",
      "• Nếu roster/character đã tồn tại trong account khác của cùng Discord user, bot sẽ từ chối.",
    ],
  },
  {
    key: "raid-status",
    label: "/raid-status",
    icon: "📊",
    short: "View your raid completion status",
    shortVn: "Xem tiến độ raid của mình",
    options: [],
    example: "/raid-status",
    notes: [
      `EN: ${UI.icons.done} done all gates · ${UI.icons.partial} partial · ${UI.icons.pending} pending · ${UI.icons.lock} not eligible.`,
      "VN: Hiển thị per-account per-character, mỗi raid có count `done/total`.",
      "• Embed color động: xanh lá = xong hết, vàng = đang tiến triển, xanh dương = chưa bắt đầu.",
      "• Ở iLvl 1740+: Serca Hard VÀ Nightmare hiển thị riêng biệt để cậu chọn mode.",
    ],
  },
  {
    key: "raid-set",
    label: "/raid-set",
    icon: "✏️",
    short: "Update raid completion per character",
    shortVn: "Cập nhật tiến độ raid cho character",
    options: [
      { name: "character", required: true, desc: "Tên character / Character name" },
      { name: "raid", required: true, desc: "Raid + difficulty (ví dụ: kazeros_hard, serca_nightmare)" },
      { name: "status", required: true, desc: "complete | reset" },
      { name: "gate", required: false, desc: "G1 | G2 | G3 — bỏ trống để update tất cả / blank = all gates" },
    ],
    example: "/raid-set character:Clauseduk raid:kazeros_hard status:complete gate:G1",
    notes: [
      "EN: Update a single gate, or omit `gate` to update every discovered gate.",
      "VN: Bỏ trống `gate` để update mọi gate của raid; chọn G1/G2/G3 để chỉ update gate đó.",
      "• Nếu 2 account cùng user có character trùng tên, cả 2 đều bị update.",
    ],
  },
  {
    key: "raid-check",
    label: "/raid-check",
    icon: "🔍",
    short: "[Raid Leader] Scan uncompleted characters",
    shortVn: "[Raid Leader] Scan nhân vật chưa hoàn thành",
    options: [
      { name: "raid", required: true, desc: "Raid + difficulty to scan / Raid + difficulty cần scan" },
    ],
    example: "/raid-check raid:kazeros_hard",
    notes: [
      "EN: Requires role named exactly `raid leader` (case-insensitive).",
      "VN: Role name phải là `raid leader` (không phân biệt hoa thường).",
      "• Output auto-paginate thành chunks ≤ 1900 chars — follow-up messages ephemeral.",
    ],
  },
];

function buildHelpOverviewEmbed() {
  const embed = new EmbedBuilder()
    .setTitle("🎯 Raid Management Bot — Help")
    .setDescription(
      [
        "**EN:** Lost Ark raid progress tracker for Discord. Pick a command below for details.",
        "**VN:** Bot quản lý tiến độ raid Lost Ark. Chọn command ở dropdown để xem chi tiết.",
      ].join("\n")
    )
    .setColor(UI.colors.neutral)
    .setFooter({ text: "Type /laraidhelp anytime · Soạn /laraidhelp bất cứ lúc nào" })
    .setTimestamp();

  for (const section of HELP_SECTIONS) {
    embed.addFields({
      name: `${section.icon} ${section.label}`,
      value: `${section.short}\n_${section.shortVn}_`,
      inline: false,
    });
  }

  return embed;
}

function buildHelpDetailEmbed(sectionKey) {
  const section = HELP_SECTIONS.find((item) => item.key === sectionKey);
  if (!section) return buildHelpOverviewEmbed();

  const embed = new EmbedBuilder()
    .setTitle(`${section.icon} ${section.label}`)
    .setDescription(`**EN:** ${section.short}\n**VN:** ${section.shortVn}`)
    .setColor(UI.colors.neutral);

  if (section.options.length > 0) {
    const optionLines = section.options.map((opt) => {
      const req = opt.required ? "✅" : "⚪";
      return `${req} \`${opt.name}\` — ${opt.desc}`;
    });
    embed.addFields({ name: "Options", value: optionLines.join("\n"), inline: false });
  } else {
    embed.addFields({ name: "Options", value: "_No options_", inline: false });
  }

  embed.addFields({ name: "Example", value: `\`${section.example}\``, inline: false });
  embed.addFields({ name: "Notes", value: section.notes.join("\n"), inline: false });

  return embed;
}

function buildHelpDropdown() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("laraidhelp:select")
    .setPlaceholder("📖 Pick a command for details... / Chọn command để xem chi tiết...")
    .addOptions(
      HELP_SECTIONS.map((section) => ({
        label: section.label,
        value: section.key,
        description: section.short.slice(0, 100),
        emoji: section.icon,
      }))
    );
  return new ActionRowBuilder().addComponents(menu);
}

async function handleLaraidHelpCommand(interaction) {
  await interaction.reply({
    embeds: [buildHelpOverviewEmbed()],
    components: [buildHelpDropdown()],
    ephemeral: true,
  });
}

async function handleLaraidHelpSelect(interaction) {
  const sectionKey = interaction.values?.[0];
  await interaction.update({
    embeds: [buildHelpDetailEmbed(sectionKey)],
    components: [buildHelpDropdown()],
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
    return;
  }

  if (interaction.commandName === "laraidhelp") {
    await handleLaraidHelpCommand(interaction);
  }
}

module.exports = {
  commands,
  handleRaidManagementCommand,
  handleLaraidHelpSelect,
};
