const {
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
} = require("discord.js");
const { randomUUID } = require("node:crypto");
const { JSDOM, VirtualConsole } = require("jsdom");

const jsdomVirtualConsole = new VirtualConsole();
jsdomVirtualConsole.on("jsdomError", (err) => {
  if (err?.message?.includes("Could not parse CSS stylesheet")) return;
  console.error("[jsdom]", err);
});
const User = require("./schema/user");
const { saveWithRetry } = require("./schema/user");
const { ensureFreshWeek } = require("./weekly-reset");

/**
 * Minimal concurrency limiter: tasks queue up and run at most `max` in
 * parallel. Used to keep lostark.bible fetches from fanning out into an
 * unthrottled burst when several users hit /add-roster or /raid-status
 * close together, which would be the most likely way to get throttled or
 * temporarily blocked upstream.
 */
class ConcurrencyLimiter {
  constructor(max) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.queue = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._dispatch();
    });
  }

  _dispatch() {
    while (this.active < this.max && this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          this.active -= 1;
          this._dispatch();
        });
    }
  }
}

const bibleLimiter = new ConcurrencyLimiter(2);

/**
 * In-flight dedup loader for autocomplete paths. Rapid keystrokes for the
 * same discordId collapse into a single Mongo read — all concurrent handlers
 * await the same promise and the map entry clears once it settles.
 */
const autocompleteUserInFlight = new Map();
function loadUserForAutocomplete(discordId) {
  if (!autocompleteUserInFlight.has(discordId)) {
    const promise = User.findOne({ discordId })
      .lean()
      .finally(() => autocompleteUserInFlight.delete(discordId));
    autocompleteUserInFlight.set(discordId, promise);
  }
  return autocompleteUserInFlight.get(discordId);
}
const { getClassName } = require("./models/Class");
const {
  RAID_REQUIREMENTS,
  getRaidRequirementChoices,
  getRaidRequirementList,
  getRaidRequirementMap,
  getGatesForRaid,
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
    done: "🟢",
    partial: "🟡",
    pending: "⚪",
    reset: "🔄",
    lock: "🔒",
    warn: "⚠️",
    info: "ℹ️",
    roster: "📥",
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

function normalizeAssignedRaid(assignedRaid, fallbackDifficulty, raidKey) {
  // Drop any gate keys that are not part of the raid's current official
  // gate list (e.g. legacy Serca G3 stored before the metadata correction).
  // This ensures status counts match reality and lets DB self-heal on next
  // save, since callers reassign `character.assignedRaids = <normalized>`.
  const officialGates = getGatesForRaid(raidKey);
  const rawGateKeys = getGateKeys(assignedRaid).filter((k) => officialGates.includes(k));
  const keys = rawGateKeys.length > 0 ? rawGateKeys : officialGates;

  // Self-heal legacy mixed-mode records (e.g. G1=Nightmare + G2=Hard created
  // before the write-path mode-coherence fix). Pick one canonical difficulty
  // so downstream reads — /raid-status, /raid-set autocomplete — all agree
  // on the raid's mode and count completions correctly.
  //
  // Rule: prefer the difficulty that carries the most `completedDate > 0`
  // gates (conservation of progress), then G1's stored difficulty, then the
  // caller's fallback. Non-canonical completions are dropped because Lost
  // Ark weekly entries are mode-scoped — progress on a "minority" mode is
  // a corrupted claim from the old process bug.
  const diffTally = new Map();
  for (const gate of keys) {
    const source = assignedRaid?.[gate];
    if (!source?.difficulty) continue;
    if (!(Number(source.completedDate) > 0)) continue;
    const key = normalizeName(source.difficulty);
    const entry = diffTally.get(key) || { count: 0, raw: source.difficulty };
    entry.count += 1;
    diffTally.set(key, entry);
  }

  let canonicalDifficulty;
  if (diffTally.size === 0) {
    canonicalDifficulty =
      assignedRaid?.G1?.difficulty || assignedRaid?.G2?.difficulty || fallbackDifficulty;
  } else {
    let best = null;
    for (const entry of diffTally.values()) {
      if (!best || entry.count > best.count) best = entry;
    }
    canonicalDifficulty = best.raw;
  }
  const canonicalNorm = normalizeName(canonicalDifficulty);

  const normalized = {};
  for (const gate of keys) {
    const source = assignedRaid?.[gate] || {};
    const sourceDiff = source.difficulty;
    const sourceMatchesCanonical =
      !sourceDiff || normalizeName(sourceDiff) === canonicalNorm;
    normalized[gate] = {
      difficulty: canonicalDifficulty,
      completedDate: sourceMatchesCanonical ? (Number(source.completedDate) || undefined) : undefined,
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
  const data = {};
  for (const gate of getGatesForRaid(requirement.raidKey)) {
    data[gate] = { difficulty: modeLabel, completedDate };
  }
  return { raidKey: requirement.raidKey, data };
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

    assigned[raidKey] = normalizeAssignedRaid(sourceRaid, fallbackDifficulty, raidKey);
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

function unescapeJsonLike(value) {
  return String(value || "").replace(/\\(["\\/bfnrt])/g, (_, ch) => {
    switch (ch) {
      case "b": return "\b";
      case "f": return "\f";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      default: return ch;
    }
  });
}

function extractRosterClassMapFromHtml(html) {
  const rosterClassMap = new Map();
  const regex = /name:\s*"((?:[^"\\]|\\.)*)"\s*,\s*class:\s*"((?:[^"\\]|\\.)*)"/g;

  let match;
  while ((match = regex.exec(html)) !== null) {
    const charName = unescapeJsonLike(match[1]);
    const className = unescapeJsonLike(match[2]);
    if (!charName || !className) continue;
    rosterClassMap.set(charName, className);
  }

  return rosterClassMap;
}

async function fetchRosterCharacters(seedCharacterName) {
  return bibleLimiter.run(() => fetchRosterCharactersRaw(seedCharacterName));
}

async function fetchRosterCharactersRaw(seedCharacterName) {
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
  const { document } = new JSDOM(html, { virtualConsole: jsdomVirtualConsole }).window;
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
    const rawGateKeys = getGateKeys(assignedRaid);
    const allGateKeys = rawGateKeys.length > 0 ? rawGateKeys : getGatesForRaid(raidKey);

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

  // Display order: Act 4 → Kazeros (Final) → Serca, top-to-bottom per
  // character card. Within the same raid (Serca Hard vs Nightmare at 1740+),
  // the lower difficulty tier comes first because it is the lower iLvl gate —
  // e.g. Serca Hard (1730) appears above Serca Nightmare (1740).
  const raidDisplayOrder = { armoche: 0, kazeros: 1, serca: 2 };
  return selected.sort((a, b) => {
    const orderDiff = (raidDisplayOrder[a.raidKey] ?? 99) - (raidDisplayOrder[b.raidKey] ?? 99);
    if (orderDiff !== 0) return orderDiff;
    return (Number(a.minItemLevel) || 0) - (Number(b.minItemLevel) || 0);
  });
}

function formatRaidStatusLine(raid) {
  const gates = Array.isArray(raid.allGateKeys) && raid.allGateKeys.length > 0
    ? raid.allGateKeys
    : getGatesForRaid(raid.raidKey);
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
      .setDescription("Character name (autocomplete from your saved roster)")
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption((option) =>
    option
      .setName("raid")
      .setDescription("Raid to update (auto-filtered by selected character's eligibility + progress)")
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption((option) =>
    option
      .setName("status")
      .setDescription("complete | reset — auto-filtered by raid progress")
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption((option) =>
    option
      .setName("gate")
      .setDescription("Specific gate — only active when status = Process")
      .setRequired(false)
      .setAutocomplete(true)
  );

const statusCommand = new SlashCommandBuilder()
  .setName("raid-status")
  .setDescription("View your raid completion status by account and character");

const raidHelpCommand = new SlashCommandBuilder()
  .setName("raid-help")
  .setDescription("Show help for the raid management bot (bilingual EN + VN)");

const removeRosterCommand = new SlashCommandBuilder()
  .setName("remove-roster")
  .setDescription("Remove a saved roster or a specific character from your data")
  .addStringOption((option) =>
    option
      .setName("roster")
      .setDescription("Roster (account) to target — autocomplete from your saved data")
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption((option) =>
    option
      .setName("action")
      .setDescription("What to remove")
      .setRequired(true)
      .addChoices(
        { name: "Remove entire roster", value: "remove_roster" },
        { name: "Remove a single character", value: "remove_char" }
      )
  )
  .addStringOption((option) =>
    option
      .setName("character")
      .setDescription("Character to remove (required if action = Remove a single character)")
      .setRequired(false)
      .setAutocomplete(true)
  );

const commands = [
  addRosterCommand,
  raidCheckCommand,
  raidSetCommand,
  statusCommand,
  raidHelpCommand,
  removeRosterCommand,
];

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
      content: `${UI.icons.lock} Chỉ Raid Leader mới được dùng \`/raid-check\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const raidKey = interaction.options.getString("raid", true);
  const raidMeta = RAID_REQUIREMENT_MAP[raidKey];
  if (!raidMeta) {
    await interaction.reply({
      content: `${UI.icons.warn} Raid option không hợp lệ. Vui lòng thử lại.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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

  const modeKey = normalizeName(raidMeta.modeKey);
  const difficultyColor =
    modeKey === "nightmare" ? UI.colors.danger
      : modeKey === "hard" ? UI.colors.progress
      : UI.colors.neutral;

  if (matchedCharacters.length === 0) {
    const emptyEmbed = new EmbedBuilder()
      .setTitle(`${UI.icons.done} Raid Check · ${raidMeta.label}`)
      .setColor(UI.colors.success)
      .setDescription(
        `Không có nhân vật nào đạt iLvl ≥ **${raidMeta.minItemLevel}** mà chưa hoàn thành **${raidMeta.label}**.\nAll eligible characters have completed this raid.`
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [emptyEmbed] });
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

  const byUser = new Map();
  for (const item of matchedCharacters) {
    if (!byUser.has(item.discordId)) byUser.set(item.discordId, []);
    byUser.get(item.discordId).push(item);
  }
  for (const chars of byUser.values()) {
    chars.sort((a, b) => (Number(b.itemLevel) || 0) - (Number(a.itemLevel) || 0));
  }

  const userGroups = [...byUser.entries()]
    .map(([discordId, chars]) => ({
      discordId,
      displayName: displayMap.get(discordId) || discordId,
      chars,
    }))
    .sort((a, b) => {
      const countDiff = b.chars.length - a.chars.length;
      if (countDiff !== 0) return countDiff;
      return a.displayName.localeCompare(b.displayName);
    });

  const headerTitle = `${UI.icons.warn} Raid Check · ${raidMeta.label}`;
  const headerDescription =
    `**${matchedCharacters.length}** characters · **${userGroups.length}** rosters · iLvl ≥ **${raidMeta.minItemLevel}**`;
  const footerText = `Pending raid: ${raidMeta.label} · Raid Leader scan`;

  const makeCheckEmbed = (isFirst) => {
    const e = new EmbedBuilder().setColor(difficultyColor).setFooter({ text: footerText });
    if (isFirst) {
      e.setTitle(headerTitle).setDescription(headerDescription).setTimestamp();
    } else {
      e.setTitle(`${headerTitle} (continued)`);
    }
    return e;
  };

  const embeds = [makeCheckEmbed(true)];
  const baseSize = headerTitle.length + headerDescription.length + footerText.length + 50;
  let currentSize = baseSize;

  for (const group of userGroups) {
    const rawLines = group.chars.map(
      (item) => `• **${item.charName}** · \`${Number(item.itemLevel) || 0}\``
    );
    let fieldValue = rawLines.join("\n");
    if (fieldValue.length > 1024) fieldValue = `${fieldValue.slice(0, 1020)}...`;

    const fieldName = `👤 ${group.displayName} · ${group.chars.length}`;
    const fieldSize = fieldName.length + fieldValue.length;
    const current = embeds[embeds.length - 1];
    const fieldCount = current.data.fields?.length ?? 0;

    if (fieldCount >= 25 || currentSize + fieldSize > 5500) {
      embeds.push(makeCheckEmbed(false));
      currentSize = 50;
    }

    embeds[embeds.length - 1].addFields({
      name: fieldName,
      value: fieldValue,
      inline: false,
    });
    currentSize += fieldSize;
  }

  await interaction.editReply({ embeds: [embeds[0]] });
  for (let i = 1; i < embeds.length; i += 1) {
    await interaction.followUp({ embeds: [embeds[i]], flags: MessageFlags.Ephemeral });
  }
}

const STATUS_SESSION_MS = 2 * 60 * 1000;
const STATUS_FOOTER_LEGEND = `${UI.icons.done} done · ${UI.icons.partial} partial · ${UI.icons.pending} pending`;

// Lostark.bible updates each character roughly every 2 hours. We match that
// cadence to avoid wasted fetches: any account refreshed within this window
// is treated as fresh enough.
const ROSTER_REFRESH_COOLDOWN_MS = 2 * 60 * 60 * 1000;

/**
 * Lazy-refresh every stale account inside a hydrated User doc in place,
 * updating only the roster-shape fields (item level, combat score, class)
 * and stamping `lastRefreshedAt`. Raid progress (`assignedRaids`) and
 * tasks are deliberately preserved.
 *
 * Returns true if at least one account was refreshed so the caller knows
 * it needs to save. Individual account fetch failures are logged and
 * skipped; one failure does not block the others.
 */
async function refreshStaleAccounts(userDoc) {
  if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
    return false;
  }

  const now = Date.now();
  const staleAccounts = userDoc.accounts.filter((account) => {
    const last = Number(account?.lastRefreshedAt) || 0;
    return (now - last) > ROSTER_REFRESH_COOLDOWN_MS;
  });
  if (staleAccounts.length === 0) return false;

  const results = await Promise.allSettled(
    staleAccounts.map(async (account) => {
      const seeds = [];
      if (account.accountName) seeds.push(account.accountName);
      for (const c of (account.characters || [])) {
        const n = getCharacterName(c);
        if (n && !seeds.includes(n)) seeds.push(n);
      }
      if (seeds.length === 0) return { account, fetched: null };

      for (const seed of seeds) {
        try {
          const fetched = await fetchRosterCharacters(seed);
          if (Array.isArray(fetched) && fetched.length > 0) {
            if (account.accountName !== seed) account.accountName = seed;
            return { account, fetched };
          }
        } catch (err) {
          console.warn(`[refresh] seed "${seed}" failed: ${err?.message || err}`);
        }
      }
      return { account, fetched: null };
    })
  );

  let didUpdate = false;
  for (const r of results) {
    if (r.status === "rejected") {
      console.warn(`[refresh] account fetch failed: ${r.reason?.message || r.reason}`);
      continue;
    }
    const { account, fetched } = r.value || {};
    if (!account || !Array.isArray(fetched) || fetched.length === 0) continue;

    const fetchedByName = new Map(
      fetched.map((c) => [normalizeName(c.charName), c])
    );
    for (const character of (account.characters || [])) {
      const match = fetchedByName.get(normalizeName(getCharacterName(character)));
      if (!match) continue;
      character.itemLevel = Number(match.itemLevel) || character.itemLevel;
      character.combatScore = String(match.combatScore || character.combatScore || "");
      if (match.className) character.class = match.className;
    }
    account.lastRefreshedAt = Date.now();
    didUpdate = true;
  }

  return didUpdate;
}

function truncateText(s, max) {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function buildCharacterField(character, getRaidsFor) {
  const name = getCharacterName(character);
  const iLvl = Number(character.itemLevel) || 0;
  const fieldName = truncateText(`${name} · ${iLvl}`, 256);

  const raids = getRaidsFor(character);
  const fieldValue = raids.length === 0
    ? `${UI.icons.lock} _Not eligible yet_`
    : raids.map((raid) => formatRaidStatusLine(raid)).join("\n");

  return {
    name: fieldName,
    value: truncateText(fieldValue, 1024),
    inline: true,
  };
}

function buildAccountPageEmbed(account, pageIndex, totalPages, globalTotals, getRaidsFor) {
  const characters = Array.isArray(account.characters) ? account.characters : [];

  const accountRaids = [];
  for (const character of characters) {
    accountRaids.push(...getRaidsFor(character));
  }
  const accountProgress = summarizeRaidProgress(accountRaids);

  const titleIcon = accountProgress.total === 0
    ? UI.icons.lock
    : accountProgress.completed === accountProgress.total
      ? UI.icons.done
      : accountProgress.completed + accountProgress.partial > 0
        ? UI.icons.partial
        : UI.icons.pending;

  const pageSuffix = totalPages > 1 ? ` · Page ${pageIndex + 1}/${totalPages}` : "";
  const title = `${titleIcon} 📁 ${account.accountName}${pageSuffix}`;

  const description = accountProgress.total === 0
    ? `**${characters.length}** character${characters.length === 1 ? "" : "s"} · no eligible raids yet`
    : `**${characters.length}** character${characters.length === 1 ? "" : "s"} · **${accountProgress.completed}/${accountProgress.total}** raids done · ${accountProgress.partial} in progress`;

  const globalSummary = totalPages > 1
    ? `\n🌐 All accounts: **${globalTotals.characters}** chars · **${globalTotals.progress.completed}/${globalTotals.progress.total}** raids done`
    : "";

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description + globalSummary)
    .setColor(accountProgress.color)
    .setFooter({ text: STATUS_FOOTER_LEGEND })
    .setTimestamp();

  if (characters.length === 0) {
    embed.addFields({ name: "\u200B", value: "_No characters saved._", inline: false });
    return embed;
  }

  // Two characters per row with a horizontal gap between them.
  // Layout per row: [char-left] [ZWS spacer = gap] [char-right].
  // Discord inline fields split row width evenly into thirds, so putting
  // the spacer in the MIDDLE column (not the right) gives visible horizontal
  // breathing room between the two character cards.
  const inlineSpacer = { name: "\u200B", value: "\u200B", inline: true };
  for (let i = 0; i < characters.length; i += 2) {
    embed.addFields(buildCharacterField(characters[i], getRaidsFor));
    embed.addFields(inlineSpacer);
    embed.addFields(characters[i + 1] ? buildCharacterField(characters[i + 1], getRaidsFor) : inlineSpacer);
  }

  return embed;
}

function buildStatusPaginationRow(currentPage, totalPages, disabled) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("status:prev")
      .setLabel("◀ Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || currentPage === 0),
    new ButtonBuilder()
      .setCustomId("status:next")
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || currentPage === totalPages - 1),
  );
}

async function handleStatusCommand(interaction) {
  const discordId = interaction.user.id;

  // Fast path: no roster at all → ephemeral reply, skip defer entirely.
  const preCheck = await User.findOne({ discordId }).lean();
  if (!preCheck || !Array.isArray(preCheck.accounts) || preCheck.accounts.length === 0) {
    await interaction.reply({
      content: `${UI.icons.info} Cậu chưa có roster nào. Dùng \`/add-roster\` để thêm trước nhé.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Defer because the lazy refresh may fetch lostark.bible (up to ~15s per
  // account). If no refresh is needed the overhead is just the defer round-trip.
  await interaction.deferReply();

  // Lazy refresh stale accounts inside saveWithRetry for concurrency safety,
  // and return the hydrated-to-plain snapshot so we do not have to re-read
  // the document a third time on the fast path.
  let userDoc = null;
  try {
    userDoc = await saveWithRetry(async () => {
      const doc = await User.findOne({ discordId });
      if (!doc) return null;
      const didRefresh = await refreshStaleAccounts(doc);
      if (didRefresh) await doc.save();
      return doc.toObject();
    });
  } catch (err) {
    console.error("[raid-status] lazy refresh failed:", err?.message || err);
    userDoc = await User.findOne({ discordId }).lean();
  }

  if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
    await interaction.editReply({
      content: `${UI.icons.info} Cậu chưa có roster nào. Dùng \`/add-roster\` để thêm trước nhé.`,
    });
    return;
  }

  // Memoize per-character raid status for the lifetime of this one render.
  // getStatusRaidsForCharacter is pure for a given character snapshot, so
  // a simple Map keyed by character id (or normalized name fallback) lets
  // global totals, per-account totals, and per-card rendering share one
  // computation instead of repeating it three times per character.
  const raidsCache = new Map();
  const getRaidsFor = (character) => {
    const key = character.id || normalizeName(getCharacterName(character));
    let result = raidsCache.get(key);
    if (!result) {
      result = getStatusRaidsForCharacter(character);
      raidsCache.set(key, result);
    }
    return result;
  };

  const accounts = userDoc.accounts;
  const totalCharacters = accounts.reduce(
    (sum, account) => sum + (Array.isArray(account.characters) ? account.characters.length : 0),
    0
  );
  const allRaidEntries = [];
  for (const account of accounts) {
    for (const character of (account.characters || [])) {
      allRaidEntries.push(...getRaidsFor(character));
    }
  }
  const globalProgress = summarizeRaidProgress(allRaidEntries);
  const globalTotals = { characters: totalCharacters, progress: globalProgress };

  const pages = accounts.map((account, idx) =>
    buildAccountPageEmbed(account, idx, accounts.length, globalTotals, getRaidsFor)
  );

  if (pages.length === 1) {
    await interaction.editReply({ embeds: [pages[0]] });
    return;
  }

  let currentPage = 0;
  await interaction.editReply({
    embeds: [pages[currentPage]],
    components: [buildStatusPaginationRow(currentPage, pages.length, false)],
  });
  const message = await interaction.fetchReply();

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: STATUS_SESSION_MS,
  });

  collector.on("collect", async (btn) => {
    if (btn.user.id !== interaction.user.id) {
      await btn.reply({
        content: `${UI.icons.lock} Chỉ người chạy \`/raid-status\` mới điều khiển được pagination.`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }
    if (btn.customId === "status:prev") currentPage = Math.max(0, currentPage - 1);
    else if (btn.customId === "status:next") currentPage = Math.min(pages.length - 1, currentPage + 1);
    else return;

    await btn.update({
      embeds: [pages[currentPage]],
      components: [buildStatusPaginationRow(currentPage, pages.length, false)],
    }).catch(() => {});
  });

  collector.on("end", async () => {
    try {
      const expiredFooter = `⏱️ Session đã hết hạn (${STATUS_SESSION_MS / 1000}s) · Dùng /raid-status để xem lại`;
      const expiredEmbed = EmbedBuilder.from(pages[currentPage]).setFooter({ text: expiredFooter });
      await interaction.editReply({
        embeds: [expiredEmbed],
        components: [buildStatusPaginationRow(currentPage, pages.length, true)],
      });
    } catch {
      // Interaction token may have expired — ignore.
    }
  });
}

function findCharacterInUser(userDoc, characterName) {
  if (!userDoc || !Array.isArray(userDoc.accounts)) return null;
  const target = normalizeName(characterName);
  for (const account of userDoc.accounts) {
    const chars = Array.isArray(account.characters) ? account.characters : [];
    for (const character of chars) {
      if (normalizeName(getCharacterName(character)) === target) return character;
    }
  }
  return null;
}

async function autocompleteRaidSetCharacter(interaction, focused) {
  const needle = normalizeName(focused.value || "");
  const discordId = interaction.user.id;
  const userDoc = await loadUserForAutocomplete(discordId);
  if (!userDoc || !Array.isArray(userDoc.accounts)) {
    await interaction.respond([]).catch(() => {});
    return;
  }

  const entries = [];
  const seen = new Set();
  for (const account of userDoc.accounts) {
    const chars = Array.isArray(account.characters) ? account.characters : [];
    for (const character of chars) {
      const name = getCharacterName(character);
      const normalized = normalizeName(name);
      if (!name || seen.has(normalized)) continue;
      if (needle && !normalized.includes(needle)) continue;
      seen.add(normalized);
      entries.push({
        name,
        className: getCharacterClass(character),
        itemLevel: Number(character.itemLevel) || 0,
      });
    }
  }

  entries.sort((a, b) => b.itemLevel - a.itemLevel || a.name.localeCompare(b.name));

  const choices = entries.slice(0, 25).map((entry) => {
    const label = `${entry.name} · ${entry.className} · ${entry.itemLevel}`;
    return {
      name: label.length > 100 ? `${label.slice(0, 97)}...` : label,
      value: entry.name.length > 100 ? entry.name.slice(0, 100) : entry.name,
    };
  });

  await interaction.respond(choices).catch(() => {});
}

function computeRaidProgress(character, req) {
  const assignedRaids = ensureAssignedRaids(character);
  const assigned = assignedRaids[req.raidKey] || {};
  const rawGates = getGateKeys(assigned);
  const allGates = rawGates.length > 0 ? rawGates : getGatesForRaid(req.raidKey);
  const total = allGates.length;

  const storedDifficulty = assigned?.G1?.difficulty || assigned?.G2?.difficulty || "Normal";
  const sameDifficulty = normalizeName(storedDifficulty) === normalizeName(toModeLabel(req.modeKey));
  const done = sameDifficulty
    ? allGates.filter((g) => Number(assigned?.[g]?.completedDate) > 0).length
    : 0;

  const isComplete = total > 0 && done === total;
  let icon;
  if (isComplete) icon = UI.icons.done;
  else if (done > 0) icon = UI.icons.partial;
  else icon = UI.icons.pending;

  return { done, total, isComplete, icon };
}

async function autocompleteRaidSetRaid(interaction, focused) {
  const characterInput = interaction.options.getString("character") || "";
  const needle = normalizeName(focused.value || "");
  const discordId = interaction.user.id;

  const allRaids = getRaidRequirementList();

  const renderPlain = () =>
    allRaids
      .filter((req) => !needle || normalizeName(req.label).includes(needle))
      .slice(0, 25)
      .map((req) => ({
        name: `${req.label} · ${req.minItemLevel}+`,
        value: `${req.raidKey}_${req.modeKey}`,
      }));

  if (!characterInput) {
    await interaction.respond(renderPlain()).catch(() => {});
    return;
  }

  const userDoc = await loadUserForAutocomplete(discordId);
  const character = findCharacterInUser(userDoc, characterInput);
  if (!character) {
    await interaction.respond(renderPlain()).catch(() => {});
    return;
  }

  const itemLevel = Number(character.itemLevel) || 0;

  const choices = [];
  for (const req of allRaids) {
    if (itemLevel < req.minItemLevel) continue;
    if (needle && !normalizeName(req.label).includes(needle)) continue;

    const { done, total, isComplete, icon } = computeRaidProgress(character, req);
    const base = `${icon} ${req.label} · ${done}/${total}`;
    choices.push({
      name: isComplete ? `${base} · DONE` : base,
      value: `${req.raidKey}_${req.modeKey}`,
    });

    if (choices.length >= 25) break;
  }

  await interaction.respond(choices).catch(() => {});
}

async function autocompleteRaidSetStatus(interaction, focused) {
  const characterInput = interaction.options.getString("character") || "";
  const raidValue = interaction.options.getString("raid") || "";
  const needle = normalizeName(focused.value || "");
  const discordId = interaction.user.id;

  const baseChoices = [
    { name: "Complete — mark the whole raid as done", value: "complete" },
    { name: "Process — mark one specific gate as done (requires gate)", value: "process" },
    { name: "Reset — clear all gates back to 0", value: "reset" },
  ];

  const applyFilter = (list) =>
    list.filter((c) => !needle || normalizeName(c.name).includes(needle));

  const raidMeta = RAID_REQUIREMENT_MAP[raidValue];
  if (!characterInput || !raidMeta) {
    await interaction.respond(applyFilter(baseChoices)).catch(() => {});
    return;
  }

  const userDoc = await loadUserForAutocomplete(discordId);
  const character = findCharacterInUser(userDoc, characterInput);
  if (!character) {
    await interaction.respond(applyFilter(baseChoices)).catch(() => {});
    return;
  }

  const { isComplete } = computeRaidProgress(character, raidMeta);
  const choices = isComplete
    ? [{ name: "Reset (raid đã hoàn thành — chỉ có thể reset)", value: "reset" }]
    : baseChoices;

  await interaction.respond(applyFilter(choices)).catch(() => {});
}

async function autocompleteRaidSetGate(interaction, focused) {
  const raidValue = interaction.options.getString("raid") || "";
  const statusValue = interaction.options.getString("status") || "";
  const needle = normalizeName(focused.value || "");

  if (statusValue !== "process") {
    await interaction.respond([]).catch(() => {});
    return;
  }

  const raidMeta = RAID_REQUIREMENT_MAP[raidValue];
  if (!raidMeta) {
    await interaction.respond([]).catch(() => {});
    return;
  }

  const gates = getGatesForRaid(raidMeta.raidKey);
  const choices = gates
    .filter((g) => !needle || normalizeName(g).includes(needle))
    .map((g) => ({ name: g, value: g }));

  await interaction.respond(choices).catch(() => {});
}

async function handleRaidSetAutocomplete(interaction) {
  try {
    const focused = interaction.options.getFocused(true);
    if (focused?.name === "character") {
      await autocompleteRaidSetCharacter(interaction, focused);
      return;
    }
    if (focused?.name === "raid") {
      await autocompleteRaidSetRaid(interaction, focused);
      return;
    }
    if (focused?.name === "status") {
      await autocompleteRaidSetStatus(interaction, focused);
      return;
    }
    if (focused?.name === "gate") {
      await autocompleteRaidSetGate(interaction, focused);
      return;
    }
    await interaction.respond([]).catch(() => {});
  } catch (error) {
    console.error("[autocomplete] raid-set error:", error?.message || error);
    await interaction.respond([]).catch(() => {});
  }
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
      content: `${UI.icons.warn} Raid option không hợp lệ. Vui lòng thử lại.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!["complete", "reset", "process"].includes(statusType)) {
    await interaction.reply({
      content: `${UI.icons.warn} Status không hợp lệ. Dùng \`complete\`, \`process\`, hoặc \`reset\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const effectiveGate = statusType === "process" ? targetGate : "";

  if (statusType === "process") {
    if (!targetGate) {
      await interaction.reply({
        content: `${UI.icons.warn} Status \`process\` yêu cầu chọn \`gate\` cụ thể (ví dụ G1 hoặc G2). Nếu muốn đánh dấu cả raid, dùng \`complete\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const validGates = getGatesForRaid(raidMeta.raidKey);
    if (!validGates.includes(targetGate)) {
      await interaction.reply({
        content: `${UI.icons.warn} Gate **${targetGate}** không tồn tại cho **${raidMeta.label}**. Gates hợp lệ: ${validGates.map((g) => `\`${g}\``).join(", ")}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  const selectedDifficulty = toModeLabel(raidMeta.modeKey);

  const existing = await User.findOne({ discordId });
  if (!existing || !Array.isArray(existing.accounts) || existing.accounts.length === 0) {
    await interaction.reply({
      content: `${UI.icons.info} Cậu chưa có roster nào. Dùng \`/add-roster\` để thêm trước nhé.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let updatedCount = 0;
  let matchedCount = 0;
  let ineligibleItemLevel = 0;
  let modeResetCount = 0;
  await saveWithRetry(async () => {
    const userDoc = await User.findOne({ discordId });
    if (!userDoc) throw new Error("User document disappeared during /raid-set");

    ensureFreshWeek(userDoc);

    updatedCount = 0;
    matchedCount = 0;
    ineligibleItemLevel = 0;
    modeResetCount = 0;

    // Resolve exactly ONE character — the same first-by-iteration record
    // that autocompleteRaidSetCharacter de-duplicates to. If a user happens
    // to have two characters sharing a name across rosters, /raid-set
    // operates on the one the autocomplete displayed (the copy whose data
    // drove eligibility + progress icons), not on all copies. Duplicate
    // names across rosters are rare and not a first-class feature; pinning
    // the write to a single target keeps view and write consistent.
    const character = findCharacterInUser(userDoc, characterName);
    if (!character) return;

    matchedCount = 1;
    const charItemLevel = Number(character.itemLevel) || 0;
    if (charItemLevel < raidMeta.minItemLevel) {
      ineligibleItemLevel = charItemLevel;
      return;
    }

    const now = Date.now();
    const normalizedSelectedDiff = normalizeName(selectedDifficulty);
    const officialGateList = getGatesForRaid(raidMeta.raidKey);

    const assignedRaids = ensureAssignedRaids(character);
    const raidData = normalizeAssignedRaid(
      assignedRaids[raidMeta.raidKey] || {},
      selectedDifficulty,
      raidMeta.raidKey
    );

    let modeChangeDetected = false;
    for (const g of officialGateList) {
      const existingDiff = raidData[g]?.difficulty;
      if (existingDiff && normalizeName(existingDiff) !== normalizedSelectedDiff) {
        modeChangeDetected = true;
        break;
      }
    }
    if (modeChangeDetected) {
      for (const g of officialGateList) {
        raidData[g] = { difficulty: selectedDifficulty, completedDate: undefined };
      }
      modeResetCount = 1;
    }

    const gateKeys = effectiveGate ? [effectiveGate] : getGateKeys(raidData);
    const shouldMarkDone = statusType === "complete" || statusType === "process";
    for (const gate of gateKeys) {
      raidData[gate] = {
        difficulty: selectedDifficulty,
        completedDate: shouldMarkDone ? now : null,
      };
    }

    assignedRaids[raidMeta.raidKey] = raidData;
    character.assignedRaids = assignedRaids;

    if (!character.name) character.name = getCharacterName(character);
    if (!character.class) character.class = getCharacterClass(character);
    if (!character.id) character.id = createCharacterId();

    updatedCount = 1;
    await userDoc.save();
  });

  if (matchedCount === 0) {
    await interaction.reply({
      content: `${UI.icons.warn} Không tìm thấy character **${characterName}** trong roster.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (updatedCount === 0) {
    await interaction.reply({
      content: `${UI.icons.warn} Character **${characterName}** đang ở iLvl **${ineligibleItemLevel}**, chưa đủ **${raidMeta.minItemLevel}+** để thao tác **${raidMeta.label}**.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const markedDone = statusType === "complete" || statusType === "process";
  const titleText =
    statusType === "process" ? "Gate Completed" :
    statusType === "complete" ? "Raid Completed" :
    "Raid Reset";
  const resultEmbed = new EmbedBuilder()
    .setTitle(`${markedDone ? UI.icons.done : UI.icons.reset} ${titleText}`)
    .setColor(markedDone ? UI.colors.success : UI.colors.muted)
    .addFields(
      { name: "Character", value: `**${characterName}**`, inline: true },
      { name: "Raid", value: `**${raidMeta.label}**`, inline: true },
      { name: "Gates", value: effectiveGate || "All gates", inline: true },
    )
    .setTimestamp();
  if (modeResetCount > 0) {
    resultEmbed.setFooter({
      text: `Switched difficulty to ${selectedDifficulty} — previous mode progress cleared for a consistent state.`,
    });
  }

  await interaction.reply({ embeds: [resultEmbed], flags: MessageFlags.Ephemeral });
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
      { name: "character", required: true, desc: "Tên character — có autocomplete từ roster đã lưu / autocomplete from saved roster" },
      { name: "raid", required: true, desc: "Raid + difficulty — autocomplete filter theo character đã chọn, kèm icon tiến độ (🟢/🟡/⚪). Raid đã hoàn thành hiển thị suffix DONE." },
      { name: "status", required: true, desc: "complete | process | reset — autocomplete. `process` đánh dấu 1 gate cụ thể; khi raid đã DONE thì dropdown tự thu còn `reset` thôi." },
      { name: "gate", required: false, desc: "Gate cụ thể — autocomplete **chỉ active khi status = Process**, dropdown đọc số gate thực tế của raid (G1/G2 cho Act 4/Kazeros/Serca hiện tại)" },
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
  {
    key: "remove-roster",
    label: "/remove-roster",
    icon: "🗑️",
    short: "Remove a roster or a single character from it",
    shortVn: "Xóa roster hoặc 1 character trong roster",
    options: [
      { name: "roster", required: true, desc: "Roster name — autocomplete từ roster đã lưu" },
      { name: "action", required: true, desc: "`Remove entire roster` hoặc `Remove a single character`" },
      { name: "character", required: false, desc: "Character cần xóa — autocomplete theo roster đã chọn (required nếu action = Remove a single character)" },
    ],
    example: "/remove-roster roster:Qiylyn action:Remove a single character character:Zywang",
    notes: [
      "EN: Delete an entire account, or just one character from it. The account stays even if all characters are removed.",
      "VN: Xóa cả account roster, hoặc chỉ 1 character trong đó. Account vẫn giữ lại dù không còn character nào.",
      "• Dùng kết hợp với `/add-roster`: muốn refresh 1 roster → `/remove-roster` rồi `/add-roster` lại.",
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
    .setFooter({ text: "Type /raid-help anytime · Soạn /raid-help bất cứ lúc nào" })
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
    .setCustomId("raid-help:select")
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

async function handleRaidHelpCommand(interaction) {
  await interaction.reply({
    embeds: [buildHelpOverviewEmbed()],
    components: [buildHelpDropdown()],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleRaidHelpSelect(interaction) {
  const sectionKey = interaction.values?.[0];
  await interaction.update({
    embeds: [buildHelpDetailEmbed(sectionKey)],
    components: [buildHelpDropdown()],
  });
}

async function autocompleteRemoveRosterRoster(interaction, focused) {
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
      const label = `📁 ${a.accountName} · ${chars.length} char${chars.length === 1 ? "" : "s"}`;
      return {
        name: label.length > 100 ? `${label.slice(0, 97)}...` : label,
        value: a.accountName.length > 100 ? a.accountName.slice(0, 100) : a.accountName,
      };
    });

  await interaction.respond(choices).catch(() => {});
}

async function autocompleteRemoveRosterCharacter(interaction, focused) {
  const rosterInput = interaction.options.getString("roster") || "";
  if (!rosterInput) {
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

  const normalizedRoster = normalizeName(rosterInput);
  const account = userDoc.accounts.find(
    (a) => normalizeName(a.accountName) === normalizedRoster
  );
  if (!account || !Array.isArray(account.characters)) {
    await interaction.respond([]).catch(() => {});
    return;
  }

  const choices = account.characters
    .filter((c) => {
      const name = normalizeName(getCharacterName(c));
      return name && (!needle || name.includes(needle));
    })
    .slice(0, 25)
    .map((c) => {
      const name = getCharacterName(c);
      const cls = getCharacterClass(c);
      const iLvl = Number(c.itemLevel) || 0;
      const label = `${name} · ${cls} · ${iLvl}`;
      return {
        name: label.length > 100 ? `${label.slice(0, 97)}...` : label,
        value: name.length > 100 ? name.slice(0, 100) : name,
      };
    });

  await interaction.respond(choices).catch(() => {});
}

async function handleRemoveRosterAutocomplete(interaction) {
  try {
    const focused = interaction.options.getFocused(true);
    if (focused?.name === "roster") {
      await autocompleteRemoveRosterRoster(interaction, focused);
      return;
    }
    if (focused?.name === "character") {
      await autocompleteRemoveRosterCharacter(interaction, focused);
      return;
    }
    await interaction.respond([]).catch(() => {});
  } catch (error) {
    console.error("[autocomplete] remove-roster error:", error?.message || error);
    await interaction.respond([]).catch(() => {});
  }
}

async function handleRemoveRosterCommand(interaction) {
  const discordId = interaction.user.id;
  const rosterName = interaction.options.getString("roster", true).trim();
  const action = interaction.options.getString("action", true);
  const characterName = (interaction.options.getString("character") || "").trim();

  if (action !== "remove_roster" && action !== "remove_char") {
    await interaction.reply({
      content: `${UI.icons.warn} Action không hợp lệ.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "remove_char" && !characterName) {
    await interaction.reply({
      content: `${UI.icons.warn} Cần chọn \`character\` khi action là **Remove a single character**.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let replyEmbed = null;

  await saveWithRetry(async () => {
    const userDoc = await User.findOne({ discordId });
    if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
      replyEmbed = new EmbedBuilder()
        .setColor(UI.colors.muted)
        .setTitle(`${UI.icons.info} No Roster`)
        .setDescription(`Cậu chưa có roster nào để xóa. Dùng \`/add-roster\` trước nhé.`);
      return;
    }

    const normalizedRoster = normalizeName(rosterName);
    const accountIndex = userDoc.accounts.findIndex(
      (a) => normalizeName(a.accountName) === normalizedRoster
    );
    if (accountIndex === -1) {
      replyEmbed = new EmbedBuilder()
        .setColor(UI.colors.danger)
        .setTitle(`${UI.icons.warn} Roster Not Found`)
        .setDescription(`Không tìm thấy roster **${rosterName}** trong data của cậu.`);
      return;
    }

    const account = userDoc.accounts[accountIndex];

    if (action === "remove_roster") {
      const removedCount = Array.isArray(account.characters) ? account.characters.length : 0;
      userDoc.accounts.splice(accountIndex, 1);
      await userDoc.save();
      replyEmbed = new EmbedBuilder()
        .setColor(UI.colors.danger)
        .setTitle(`🗑️ Roster Removed`)
        .addFields(
          { name: "Roster", value: `**${account.accountName}**`, inline: true },
          { name: "Characters removed", value: `${removedCount}`, inline: true },
        )
        .setTimestamp();
      return;
    }

    // action === "remove_char"
    const normalizedChar = normalizeName(characterName);
    const charIndex = (account.characters || []).findIndex(
      (c) => normalizeName(getCharacterName(c)) === normalizedChar
    );
    if (charIndex === -1) {
      replyEmbed = new EmbedBuilder()
        .setColor(UI.colors.progress)
        .setTitle(`${UI.icons.warn} Character Not Found`)
        .setDescription(`Không tìm thấy character **${characterName}** trong roster **${account.accountName}**.`);
      return;
    }
    const wasSeed = normalizeName(account.accountName) === normalizedChar;
    account.characters.splice(charIndex, 1);

    let reseededTo = null;
    if (wasSeed && account.characters.length > 0) {
      const fallbackName = getCharacterName(account.characters[0]);
      if (fallbackName) {
        account.accountName = fallbackName;
        reseededTo = fallbackName;
      }
    }

    await userDoc.save();
    const embed = new EmbedBuilder()
      .setColor(UI.colors.muted)
      .setTitle(`🗑️ Character Removed`)
      .addFields(
        { name: "Character", value: `**${characterName}**`, inline: true },
        { name: "Roster", value: `**${account.accountName}**`, inline: true },
        { name: "Remaining", value: `${account.characters.length} character${account.characters.length === 1 ? "" : "s"}`, inline: true },
      )
      .setTimestamp();
    if (reseededTo) {
      embed.setFooter({
        text: `Roster seed re-pointed to "${reseededTo}" so /raid-status refresh keeps working.`,
      });
    }
    replyEmbed = embed;
  });

  if (replyEmbed) {
    await interaction.reply({ embeds: [replyEmbed], flags: MessageFlags.Ephemeral });
  }
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

  if (interaction.commandName === "raid-help") {
    await handleRaidHelpCommand(interaction);
    return;
  }

  if (interaction.commandName === "remove-roster") {
    await handleRemoveRosterCommand(interaction);
  }
}

module.exports = {
  commands,
  handleRaidManagementCommand,
  handleRaidHelpSelect,
  handleRaidSetAutocomplete,
  handleRemoveRosterAutocomplete,
};
