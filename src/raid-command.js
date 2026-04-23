const {
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");
const GuildConfig = require("./schema/guildConfig");
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
// Discord REST fan-out limiter: caps parallel `client.users.fetch` bursts in
// /raid-check (which resolves display names for every unique discordId with
// matching chars). discord.js serializes per-bucket internally, but a large
// raiding server could queue up dozens of fetches at once and trip the
// global 50-req/s ceiling - 5 in flight is a safe middle ground.
const discordUserLimiter = new ConcurrencyLimiter(5);

/**
 * In-flight dedup loader for autocomplete paths. Rapid keystrokes for the
 * same discordId collapse into a single Mongo read - all concurrent handlers
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
  getRaidGateForBoss,
} = require("./models/Raid");

const MAX_CHARACTERS_PER_ACCOUNT = 6;
// Raid leader gating: switched from Discord role-name match to an explicit
// env-configured user ID allowlist. Operator sets RAID_MANAGER_ID as
// comma-separated Discord user IDs (e.g. "123456789012345678,987654321098765432").
// Whitespace and empty entries are stripped. Empty/missing env = no raid
// leaders configured = /raid-check effectively disabled (boot warns).
//
// Why env-over-role: deterministic (no Discord role rename surprises),
// decoupled from server admin chain, multi-guild consistent, and rotation
// happens via redeploy rather than touching Discord role assignments.
const RAID_MANAGER_ID = new Set(
  (process.env.RAID_MANAGER_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
if (RAID_MANAGER_ID.size === 0) {
  console.warn(
    "[raid-check] RAID_MANAGER_ID env not set or empty - /raid-check will reject every invocation. Set the env var to a comma-separated list of Discord user IDs to enable."
  );
}
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
  // so downstream reads - /raid-status, /raid-set autocomplete - all agree
  // on the raid's mode and count completions correctly.
  //
  // Rule: prefer the difficulty that carries the most `completedDate > 0`
  // gates (conservation of progress), then G1's stored difficulty, then the
  // caller's fallback. Non-canonical completions are dropped because Lost
  // Ark weekly entries are mode-scoped - progress on a "minority" mode is
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
  // the lower difficulty tier comes first because it is the lower iLvl gate -
  // e.g. Serca Hard (1730) appears above Serca Nightmare (1740).
  const raidDisplayOrder = { armoche: 0, kazeros: 1, serca: 2 };
  return selected.sort((a, b) => {
    const orderDiff = (raidDisplayOrder[a.raidKey] ?? 99) - (raidDisplayOrder[b.raidKey] ?? 99);
    if (orderDiff !== 0) return orderDiff;
    return (Number(a.minItemLevel) || 0) - (Number(b.minItemLevel) || 0);
  });
}

// 3-state aggregate icon for a (done, total) pair. Shared by /raid-status's
// per-raid line AND /raid-check's per-char card so both commands surface the
// same visual vocabulary: 🟢 = all done, 🟡 = at least 1 done but not all,
// ⚪ = none done. `total=0` guards divide-by-zero for chars with no eligible
// gates (lock icon handled upstream).
function pickProgressIcon(done, total) {
  if (total > 0 && done === total) return UI.icons.done;
  if (done > 0) return UI.icons.partial;
  return UI.icons.pending;
}

function formatRaidStatusLine(raid) {
  const gates = Array.isArray(raid.allGateKeys) && raid.allGateKeys.length > 0
    ? raid.allGateKeys
    : getGatesForRaid(raid.raidKey);
  const done = new Set(raid.completedGateKeys || []).size;
  const total = gates.length;
  const icon = raid.isCompleted ? UI.icons.done : pickProgressIcon(done, total);
  return `${icon} ${raid.raidName} · ${done}/${total}`;
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
  // Env-allowlist check against the invoker's Discord user ID. Set is
  // built once at module load (see RAID_MANAGER_ID) so this is O(1)
  // per call. interaction.user.id is always present on slash commands -
  // no need to defensive-check member or guild context.
  const userId = interaction.user?.id;
  if (!userId) return false;
  return RAID_MANAGER_ID.has(userId);
}

const addRosterCommand = new SlashCommandBuilder()
  .setName("add-roster")
  .setDescription("Sync a roster from lostark.bible")
  .addStringOption((option) =>
    option
      .setName("name")
      .setDescription("Any character name in the roster")
      .setRequired(true)
  )
  .addIntegerOption((option) =>
    option
      .setName("total")
      .setDescription("How many characters to save (1-6)")
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
  .setDescription("Mark raid progress for a character")
  .addStringOption((option) =>
    option
      .setName("roster")
      .setDescription("Roster (account) chứa character - autocomplete")
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption((option) =>
    option
      .setName("character")
      .setDescription("Character to update")
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption((option) =>
    option
      .setName("raid")
      .setDescription("Raid to update for this character")
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption((option) =>
    option
      .setName("status")
      .setDescription("complete | process | reset (process marks one gate)")
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption((option) =>
    option
      .setName("gate")
      .setDescription("Specific gate (required when status=process)")
      .setRequired(false)
      .setAutocomplete(true)
  );

const statusCommand = new SlashCommandBuilder()
  .setName("raid-status")
  .setDescription("View your raid progress");

const raidHelpCommand = new SlashCommandBuilder()
  .setName("raid-help")
  .setDescription("Show help for all raid commands");

const removeRosterCommand = new SlashCommandBuilder()
  .setName("remove-roster")
  .setDescription("Remove a roster or a character")
  .addStringOption((option) =>
    option
      .setName("roster")
      .setDescription("Roster to target")
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
      .setDescription("Character to remove (if removing one char)")
      .setRequired(false)
      .setAutocomplete(true)
  );

// Full action catalog for /raid-channel config. Autocomplete handler
// filters out whichever of schedule-on/schedule-off is redundant given
// the guild's current autoCleanupEnabled state - admin sees only the
// toggle that actually changes something.
const RAID_CHANNEL_ACTION_CHOICES = [
  { name: "show - view current config + health check", value: "show" },
  { name: "set - register the monitor channel (needs `channel` option)", value: "set" },
  { name: "clear - disable monitor + reset schedule", value: "clear" },
  { name: "cleanup - delete all non-pinned messages now", value: "cleanup" },
  { name: "repin - refresh the pinned welcome embed", value: "repin" },
  { name: "schedule-on - enable daily 00:00 VN auto-cleanup", value: "schedule-on" },
  { name: "schedule-off - disable daily auto-cleanup", value: "schedule-off" },
];

const raidChannelCommand = new SlashCommandBuilder()
  .setName("raid-channel")
  .setDescription("Configure the raid monitor channel")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName("config")
      .setDescription("Config action to run")
      .addStringOption((opt) =>
        opt
          .setName("action")
          .setDescription("Which action to run")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Target text channel (for action=set)")
          .setRequired(false)
          .addChannelTypes(ChannelType.GuildText)
      )
  );

const raidAutoManageCommand = new SlashCommandBuilder()
  .setName("raid-auto-manage")
  .setDescription("Auto-sync raid progress from lostark.bible")
  .setDMPermission(false)
  .addStringOption((opt) =>
    opt
      .setName("action")
      .setDescription("on · off · sync · status")
      .setRequired(true)
      // Autocomplete (not static choices) so we can hide `on` while already
      // enabled and hide `off` while already disabled - the redundant action
      // in each state shouldn't even appear in the dropdown.
      .setAutocomplete(true)
  );

const commands = [
  addRosterCommand,
  raidCheckCommand,
  raidSetCommand,
  statusCommand,
  raidHelpCommand,
  removeRosterCommand,
  raidChannelCommand,
  raidAutoManageCommand,
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
  // Cache-first: discord.js populates users cache during normal gateway
  // events so most IDs are resolvable without a REST round-trip. Only miss
  // paths go through the limiter - keeps /raid-check fast on warm caches.
  const cached = client.users.cache.get(discordId);
  if (cached) return cached.username || discordId;
  try {
    const user = await discordUserLimiter.run(() => client.users.fetch(discordId));
    return user?.username || discordId;
  } catch {
    return discordId;
  }
}

// Per-gate display icon for Phase 1 progress-aware /raid-check rendering.
// 'done'    = gate completed AT this raid's selected difficulty
// 'partial' = unused right now (kept for future per-gate "started" semantics)
// 'pending' = gate not done OR done at a different difficulty (mode-switch
//             would wipe it anyway, so it's not real progress for this scan)
function raidCheckGateIcon(status) {
  if (status === "done") return "🟢";
  if (status === "partial") return "🟡";
  return "⚪";
}

// Compact relative time (e.g. "5m", "2h", "3d") for /raid-check field names.
// Embed field names don't render Discord's <t:X:R> timestamp markdown, so
// we pre-compute a short label. English units keep the segment narrow
// enough to fit next to pending count + roster + user without wrapping.
function formatShortRelative(timestamp) {
  const diffMs = Date.now() - Number(timestamp);
  if (!Number.isFinite(diffMs) || diffMs < 60_000) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// Per-roster state breakdown formatter. Emits `N ⚪ · M 🟡 · K 🟢` with
// zero-count segments filtered out. Used by /raid-check's section header
// rich value line so a roster showing just 6 pending renders as plain
// `6 ⚪` instead of the noisier `6 ⚪ · 0 🟡 · 0 🟢`.
function formatRosterStats(stats) {
  const parts = [];
  if (stats.none > 0) parts.push(`${stats.none} ${UI.icons.pending}`);
  if (stats.partial > 0) parts.push(`${stats.partial} ${UI.icons.partial}`);
  if (stats.done > 0) parts.push(`${stats.done} ${UI.icons.done}`);
  return parts.join(" · ");
}

// Mode hierarchy for /raid-check scan: Normal (1) < Hard (2) < Nightmare (3).
// Clearing a HIGHER mode satisfies LOWER-mode weekly requirement. Char who
// did Kazeros Hard doesn't need to appear pending when scanning Kazeros
// Normal - Hard (2) >= Normal (1), so Hard progress counts as done for the
// Normal scan. Reverse is NOT true: doing Normal doesn't satisfy Hard scan
// (lower mode has no effect on higher-mode requirement).
const MODE_RANK = { normal: 1, hard: 2, nightmare: 3 };
const modeRank = (modeStr) => MODE_RANK[normalizeName(modeStr || "")] || 0;

// Shared scan+classify pass for /raid-check. Returns the raw eligible list
// + per-user metadata so both the initial command AND the button handlers
// (Remind / Sync) can operate on a fresh Mongo snapshot every time - no
// stale state map, no cache staleness bug.
// Composite key separator (Unit Separator \x1f) for maps keyed by
// discordId + accountName. Shared between rosterBuckets, rosterStats,
// and rosterRefreshMap so lookups line up across the three structures.
const ROSTER_KEY_SEP = "\x1f";

async function computeRaidCheckSnapshot(raidMeta) {
  const users = await User.find({}).lean();
  const userMeta = new Map();
  // rosterRefreshMap: composite key → account.lastRefreshedAt (ms timestamp
  // of last /raid-status lazy refresh that pulled iLvl/class from bible).
  // Covers ALL users (not just opted-in auto-manage) - any account that's
  // been refreshed has a positive value. Used by /raid-check section header
  // to surface roster data freshness via `📥<relative>` badge.
  const rosterRefreshMap = new Map();
  const allEligible = [];
  const selectedDifficulty = toModeLabel(raidMeta.modeKey);
  const selectedDiffNorm = normalizeName(selectedDifficulty);
  const scanRank = modeRank(selectedDiffNorm);

  for (const userDoc of users) {
    ensureFreshWeek(userDoc);
    if (!userMeta.has(userDoc.discordId)) {
      userMeta.set(userDoc.discordId, {
        autoManageEnabled: !!userDoc.autoManageEnabled,
        lastAutoManageSyncAt: Number(userDoc.lastAutoManageSyncAt) || 0,
      });
    }
    const accounts = Array.isArray(userDoc.accounts) ? userDoc.accounts : [];
    for (const account of accounts) {
      const rosterKey = userDoc.discordId + ROSTER_KEY_SEP + (account.accountName || "(no name)");
      rosterRefreshMap.set(rosterKey, Number(account.lastRefreshedAt) || 0);
      const characters = Array.isArray(account.characters) ? account.characters : [];
      for (const character of characters) {
        if (!character) continue;
        const characterItemLevel = Number(character.itemLevel) || 0;
        if (characterItemLevel < raidMeta.minItemLevel) continue;

        const assignedRaids = ensureAssignedRaids(character);
        const assigned = assignedRaids[raidMeta.raidKey] || {};
        const storedGateKeys = getGateKeys(assigned);
        const officialGates =
          storedGateKeys.length > 0 ? storedGateKeys : getGatesForRaid(raidMeta.raidKey);
        const gateStatus = officialGates.map((gate) => {
          const g = assigned[gate];
          if (!g) return "pending";
          // Gate counts as done only when the stored mode rank is >= the
          // scan mode rank. Higher modes satisfy lower-mode scans (Hard
          // clear counts for Normal scan). Lower stored modes don't count
          // for higher-mode scans (Normal clear doesn't satisfy Hard scan).
          const storedRank = modeRank(g.difficulty);
          if (storedRank < scanRank) return "pending";
          return Number(g.completedDate) > 0 ? "done" : "pending";
        });
        const doneCount = gateStatus.filter((s) => s === "done").length;
        let overallStatus;
        if (doneCount === officialGates.length) overallStatus = "complete";
        else if (doneCount > 0) overallStatus = "partial";
        else overallStatus = "none";

        allEligible.push({
          discordId: userDoc.discordId,
          // accountName lets /raid-check group by user+roster instead of
          // just user, mirroring /raid-status's per-roster page semantics.
          // A user with 2 rosters (main + alt) now shows 2 sections instead
          // of a single mashed-together list.
          accountName: account.accountName || "(no name)",
          charName: getCharacterName(character),
          itemLevel: characterItemLevel,
          gateStatus,
          overallStatus,
        });
      }
    }
  }

  const completeChars = allEligible.filter((c) => c.overallStatus === "complete");
  const partialChars = allEligible.filter((c) => c.overallStatus === "partial");
  const noneChars = allEligible.filter((c) => c.overallStatus === "none");
  const pendingChars = [...partialChars, ...noneChars];

  return { allEligible, completeChars, partialChars, noneChars, pendingChars, userMeta, rosterRefreshMap };
}

async function handleRaidCheckCommand(interaction) {
  if (!isRaidLeader(interaction)) {
    await interaction.reply({
      content: `${UI.icons.lock} Chỉ Raid Manager mới được dùng \`/raid-check\` (config qua env \`RAID_MANAGER_ID\`).`,
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

  // Shared scan + classification (reused by Remind/Sync button handlers).
  const { allEligible, completeChars, partialChars, noneChars, pendingChars, userMeta, rosterRefreshMap } =
    await computeRaidCheckSnapshot(raidMeta);

  const modeKey = normalizeName(raidMeta.modeKey);
  const difficultyColor =
    modeKey === "nightmare" ? UI.colors.danger
      : modeKey === "hard" ? UI.colors.progress
      : UI.colors.neutral;

  // Empty state: every eligible char already cleared.
  if (pendingChars.length === 0) {
    const emptyEmbed = new EmbedBuilder()
      .setTitle(`${UI.icons.done} Raid Check · ${raidMeta.label}`)
      .setColor(UI.colors.success)
      .setDescription(
        `Toàn bộ **${allEligible.length}** character iLvl ≥ **${raidMeta.minItemLevel}** đã hoàn thành **${raidMeta.label}**.\nAll eligible characters have completed this raid.`
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [emptyEmbed] });
    return;
  }

  // Resolve display names for the pending users only - cache-first via
  // resolveDiscordDisplay (Phase 23 limiter applies on misses).
  const pendingDiscordIds = [...new Set(pendingChars.map((c) => c.discordId))];
  const displayMap = new Map();
  await Promise.all(
    pendingDiscordIds.map(async (discordId) => {
      const displayName = await resolveDiscordDisplay(interaction.client, discordId);
      displayMap.set(discordId, displayName);
    })
  );

  // Group pending chars by user+roster composite so a user with 2 rosters
  // (main + alt) gets 2 separate sections. Uses module-level
  // `ROSTER_KEY_SEP` (\x1f Unit Separator) shared with rosterRefreshMap
  // from the snapshot - same key shape across all per-roster maps.
  const rosterBuckets = new Map();
  for (const item of pendingChars) {
    const key = item.discordId + ROSTER_KEY_SEP + item.accountName;
    if (!rosterBuckets.has(key)) rosterBuckets.set(key, []);
    rosterBuckets.get(key).push(item);
  }
  for (const chars of rosterBuckets.values()) {
    chars.sort((a, b) => b.itemLevel - a.itemLevel);
  }
  // Per-user aggregate pending total - used as the PRIMARY sort key so
  // all rosters of the same user stay grouped consecutively, with the
  // user who has the most pending across all rosters at the top.
  const userTotalPending = new Map();
  for (const item of pendingChars) {
    userTotalPending.set(item.discordId, (userTotalPending.get(item.discordId) || 0) + 1);
  }
  // Per-roster 3-state count breakdown used by section header's rich
  // value line. Covers ALL eligible chars (incl. `complete` ones) so
  // rosters with mixed state render accurate counts like `4 ⚪ · 1 🟡 ·
  // 1 🟢`. Same composite key as rosterBuckets so we can look up per
  // group inside the map step.
  const rosterStats = new Map();
  for (const item of allEligible) {
    const key = item.discordId + ROSTER_KEY_SEP + item.accountName;
    if (!rosterStats.has(key)) rosterStats.set(key, { none: 0, partial: 0, done: 0 });
    const s = rosterStats.get(key);
    if (item.overallStatus === "complete") s.done += 1;
    else if (item.overallStatus === "partial") s.partial += 1;
    else s.none += 1;
  }

  const rosterGroups = [...rosterBuckets.entries()]
    .map(([key, chars]) => {
      const [discordId, accountName] = key.split(ROSTER_KEY_SEP);
      const meta = userMeta.get(discordId) || {};
      const stats = rosterStats.get(key) || { none: 0, partial: 0, done: 0 };
      const lastRefreshedAt = rosterRefreshMap.get(key) || 0;
      return {
        discordId,
        accountName,
        displayName: displayMap.get(discordId) || discordId,
        chars,
        stats,
        lastRefreshedAt,
        partialCount: chars.filter((c) => c.overallStatus === "partial").length,
        autoManageEnabled: meta.autoManageEnabled || false,
        lastAutoManageSyncAt: meta.lastAutoManageSyncAt || 0,
      };
    })
    .sort((a, b) => {
      // 1) User with most TOTAL pending across all rosters first
      const totalDiff = (userTotalPending.get(b.discordId) || 0) - (userTotalPending.get(a.discordId) || 0);
      if (totalDiff !== 0) return totalDiff;
      // 2) Same user - group rosters by pending count in this roster desc
      const countDiff = b.chars.length - a.chars.length;
      if (countDiff !== 0) return countDiff;
      // 3) Stable tie-break by display name then account name
      const nameDiff = a.displayName.localeCompare(b.displayName);
      if (nameDiff !== 0) return nameDiff;
      return a.accountName.localeCompare(b.accountName);
    });

  // Summary header: title carries raid label + iLvl threshold inline
  // (`Act 4 Normal (1700)`). No description needed - footer legend covers
  // state breakdown, and per-roster header carries the sync badge.
  const headerTitle = `${UI.icons.warn} Raid Check · ${raidMeta.label} (${raidMeta.minItemLevel})`;
  // Dynamic footer merges count + icon + English label per-state. Unlike
  // /raid-status's static `STATUS_FOOTER_LEGEND`, /raid-check counts vary
  // per scan so the footer is computed inline. `0 done · 0 partial · N
  // pending` reads naturally for Raid Manager scanning progress.
  const footerText =
    `${UI.icons.done} ${completeChars.length} done · ` +
    `${UI.icons.partial} ${partialChars.length} partial · ` +
    `${UI.icons.pending} ${noneChars.length} pending`;

  // One embed per roster - mirrors /raid-status's 1-account-per-page model.
  // Roster header lives in setDescription right under the global summary so
  // the inline char fields below sit tight against the header without a
  // wasted spacer row. Pagination via Prev/Next buttons surfaces the other
  // rosters one at a time.

  // Per-char inline field mirroring /raid-status's 2-column card layout.
  // Name carries `charName · iLvl`, value carries the aggregate icon +
  // done/total ratio on a SEPARATE line below. This matches /raid-status's
  // pattern where value always holds content (raid-status packs 3+ raid
  // lines, /raid-check packs 1 summary line) so the value line isn't
  // wasted height. Earlier attempt to pack everything into name + ZWS value
  // produced visible blank space below each card ("cách nhau quá") - this
  // format fills both lines with info instead.
  const buildCharField = (c) => {
    const doneCount = c.gateStatus.filter((s) => s === "done").length;
    const total = c.gateStatus.length;
    const icon = pickProgressIcon(doneCount, total);
    return {
      name: truncateText(`${c.charName} · ${Math.round(c.itemLevel)}`, 256),
      value: truncateText(`${icon} ${doneCount}/${total}`, 1024),
      inline: true,
    };
  };

  // Spacer mirrors /raid-status's approach: Discord inline fields default
  // to 3-per-row, so we inject a zero-width spacer as the middle column to
  // force the char cards to pair up visibly as 2-per-row with a gap.
  const inlineSpacer = { name: "​", value: "​", inline: true };

  const ROSTERS_PER_PAGE = 2;
  const FILTER_ALL = "__all__";

  // Per-user pending total for dropdown options (sort desc, take top 24
  // to leave 1 slot for the "All users" entry within Discord's 25-option
  // cap for StringSelectMenu).
  const userPendingTotals = new Map();
  for (const item of pendingChars) {
    userPendingTotals.set(item.discordId, (userPendingTotals.get(item.discordId) || 0) + 1);
  }
  const userDropdownEntries = [...userPendingTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24);

  // Filter helper: null/FILTER_ALL shows everyone, specific discordId
  // narrows to that user's rosters only.
  const filterByUser = (userId) => {
    if (!userId || userId === FILTER_ALL) return rosterGroups;
    return rosterGroups.filter((g) => g.discordId === userId);
  };

  // Chunk rosters into pages of N (default 2). Each chunk renders as one
  // embed page with its roster sections stacked.
  const chunkRosters = (groups) => {
    const chunks = [];
    for (let i = 0; i < groups.length; i += ROSTERS_PER_PAGE) {
      chunks.push(groups.slice(i, i + ROSTERS_PER_PAGE));
    }
    return chunks;
  };

  // Add one roster section to an embed. Section header = non-inline field
  // with name = clean roster label, value = RICH stats line (state
  // breakdown + avg iLvl + sync badge). Rich value fills the field's
  // value-line height with meaningful content instead of ZWS - inter-row
  // padding below then looks proportional to content, not wasted. Lets
  // us use non-inline's full-width without the "thừa khoảng cách" feel.
  const addRosterSection = (embed, group) => {
    // Freshness badges:
    // 📥 = roster data refresh (iLvl/class pulled từ bible qua /raid-status
    //      lazy refresh). Stamped on every user, không cần opt-in.
    // 🔄 = auto-manage bible log sync (raid progress pull). Chỉ opted-in
    //      user qua /raid-auto-manage action:on.
    // Show both nếu đủ data - 2 timestamp semantically khác nhau.
    const badges = [];
    if (group.lastRefreshedAt > 0) {
      badges.push(`📥${formatShortRelative(group.lastRefreshedAt)}`);
    }
    if (group.autoManageEnabled) {
      badges.push(
        group.lastAutoManageSyncAt > 0
          ? `🔄${formatShortRelative(group.lastAutoManageSyncAt)}`
          : "🔄never"
      );
    }
    const syncBadge = badges.length > 0 ? " · " + badges.join(" · ") : "";
    // Per-roster state breakdown (filter zero counts)
    const statsText = formatRosterStats(group.stats || { none: 0, partial: 0, done: 0 });
    // Average iLvl of pending chars in this roster (integer round)
    const avgILvlText = group.chars.length > 0
      ? `avg iLvl ${Math.round(
          group.chars.reduce((sum, c) => sum + (Number(c.itemLevel) || 0), 0) / group.chars.length
        )}`
      : "";
    const valueParts = [statsText, avgILvlText].filter(Boolean);
    const headerValue = valueParts.join(" · ") + syncBadge;

    embed.addFields({
      name: truncateText(`📁 ${group.accountName} (${group.displayName})`, 256),
      value: truncateText(headerValue || "​", 1024),
      inline: false,
    });
    for (let i = 0; i < group.chars.length; i += 2) {
      embed.addFields(buildCharField(group.chars[i]));
      embed.addFields(inlineSpacer);
      if (group.chars[i + 1]) {
        embed.addFields(buildCharField(group.chars[i + 1]));
      } else {
        embed.addFields(inlineSpacer);
      }
    }
  };

  // Build one embed page rendering a chunk (up to ROSTERS_PER_PAGE) of
  // roster sections. Title stable across pages; footer appends page
  // indicator when there's more than 1 page.
  const buildRaidCheckPage = (rosterChunk, pageIndex, totalPages) => {
    const pageFooter = totalPages > 1
      ? `${footerText} · Page ${pageIndex + 1}/${totalPages}`
      : footerText;
    const embed = new EmbedBuilder()
      .setTitle(headerTitle)
      .setColor(difficultyColor)
      .setFooter({ text: pageFooter })
      .setTimestamp();
    // When user filter is active, show that user's display name + avatar
    // in embed author slot as visual confirmation of who's being filtered.
    // Discord StringSelectMenu options can't carry per-option avatars, so
    // the embed author is the compromise - 1 avatar (the selected user's)
    // at the top of each filtered page.
    if (selectedUserId) {
      const displayName = displayMap.get(selectedUserId) || selectedUserId;
      const authorPayload = { name: displayName };
      if (selectedUserAvatar) authorPayload.iconURL = selectedUserAvatar;
      embed.setAuthor(authorPayload);
    }
    for (const group of rosterChunk) {
      addRosterSection(embed, group);
    }
    return embed;
  };

  // Empty-filter state (user picked a dropdown option whose data got
  // cleared mid-session, e.g. they /raid-set'd their last pending char).
  const buildEmptyFilterEmbed = (userId) => {
    const username = (userId && displayMap.get(userId)) || "this user";
    return new EmbedBuilder()
      .setTitle(headerTitle)
      .setDescription(`${UI.icons.done} **${username}** không có char nào pending trong ${raidMeta.label}.`)
      .setColor(UI.colors.success)
      .setFooter({ text: footerText })
      .setTimestamp();
  };

  // Sync button enabled only when at least one pending user has opted-in
  // to /raid-auto-manage. Count UNIQUE users - a user with 2 rosters
  // shouldn't inflate the opt-in count.
  const optedInPendingCount = new Set(
    rosterGroups.filter((g) => g.autoManageEnabled).map((g) => g.discordId)
  ).size;

  // Button row: Prev + Next (from generic helper) + Sync. Prev/Next
  // customId prefix `raid-check-page:` deliberately NOT `raid-check:` so
  // bot.js's global handleRaidCheckButton dispatcher ignores them.
  const buildButtonRow = (currentPage, totalPages, disabled) => {
    const row = buildPaginationRow(currentPage, totalPages, disabled, {
      prevId: "raid-check-page:prev",
      nextId: "raid-check-page:next",
    });
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`raid-check:sync:${raidKey}`)
        .setLabel(
          optedInPendingCount > 0
            ? `Sync ${optedInPendingCount} opted-in user(s)`
            : "Sync (no opted-in users)"
        )
        .setEmoji("🔄")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || optedInPendingCount === 0),
    );
    return row;
  };

  // User filter dropdown. First option is always "All users" sentinel
  // that resets the filter. Subsequent options list top-24 users by
  // pending total desc with their display name + pending count.
  const buildFilterDropdown = (selectedUserId, disabled) => {
    const allDefault = !selectedUserId || selectedUserId === FILTER_ALL;
    const options = [
      {
        label: truncateText(`All users (${pendingChars.length} pending)`, 100),
        value: FILTER_ALL,
        emoji: "🌐",
        default: allDefault,
      },
      ...userDropdownEntries.map(([discordId, total]) => ({
        label: truncateText(`${displayMap.get(discordId) || discordId} (${total} pending)`, 100),
        value: discordId,
        emoji: "👤",
        default: selectedUserId === discordId,
      })),
    ];
    const menu = new StringSelectMenuBuilder()
      .setCustomId("raid-check-filter:user")
      .setPlaceholder("Filter by user / Lọc theo user...")
      .setDisabled(disabled)
      .addOptions(options);
    return new ActionRowBuilder().addComponents(menu);
  };

  const buildComponents = (currentPage, totalPages, selectedUserId, disabled) => {
    return [
      buildButtonRow(currentPage, totalPages, disabled),
      buildFilterDropdown(selectedUserId, disabled),
    ];
  };

  // Initial state: no filter, page 0. `selectedUserAvatar` captures the
  // filtered user's Discord avatar URL (resolved lazily on filter-change)
  // - buildRaidCheckPage reads it via closure to set embed.author iconURL.
  let selectedUserId = null;
  let selectedUserAvatar = null;
  let pages = chunkRosters(filterByUser(selectedUserId)).map((chunk, idx, arr) =>
    buildRaidCheckPage(chunk, idx, arr.length)
  );
  let currentPage = 0;

  await interaction.editReply({
    embeds: [pages[currentPage]],
    components: buildComponents(currentPage, pages.length, selectedUserId, false),
  });

  // Always attach collector - dropdown needs a handler regardless of
  // page count. Mirrors /raid-status pattern (user-lock + on-end disable)
  // but tracks filter state across interactions too.
  const message = await interaction.fetchReply();
  const collector = message.createMessageComponentCollector({
    time: PAGINATION_SESSION_MS,
  });

  collector.on("collect", async (i) => {
    // User lock: reject unauthorized clicks on OUR components; let
    // others fall through to bot.js global router (e.g. Sync button).
    if (i.user.id !== interaction.user.id) {
      const ours =
        (i.customId || "").startsWith("raid-check-page:") ||
        i.customId === "raid-check-filter:user";
      if (ours) {
        await i.reply({
          content: `${UI.icons.lock} Chỉ người chạy \`/raid-check\` mới điều khiển được pagination.`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
      return;
    }

    if (i.customId === "raid-check-page:prev") {
      currentPage = Math.max(0, currentPage - 1);
    } else if (i.customId === "raid-check-page:next") {
      currentPage = Math.min(pages.length - 1, currentPage + 1);
    } else if (i.customId === "raid-check-filter:user") {
      const value = Array.isArray(i.values) && i.values.length > 0 ? i.values[0] : FILTER_ALL;
      selectedUserId = value === FILTER_ALL ? null : value;
      // Resolve avatar for the filtered user (cache-first). Skip entirely
      // when clearing filter. discordUserLimiter caps concurrent fetches
      // even though this is only 1 user at a time - defense against
      // Discord's global REST rate limit.
      if (selectedUserId) {
        try {
          let userObj = interaction.client.users.cache.get(selectedUserId);
          if (!userObj) {
            userObj = await discordUserLimiter.run(() =>
              interaction.client.users.fetch(selectedUserId)
            );
          }
          selectedUserAvatar = userObj ? userObj.displayAvatarURL({ size: 64 }) : null;
        } catch {
          selectedUserAvatar = null;
        }
      } else {
        selectedUserAvatar = null;
      }
      const filtered = filterByUser(selectedUserId);
      pages = chunkRosters(filtered).map((chunk, idx, arr) =>
        buildRaidCheckPage(chunk, idx, arr.length)
      );
      currentPage = 0;
      if (pages.length === 0) {
        // Filter landed on a user with no pending rosters (edge case).
        await i.update({
          embeds: [buildEmptyFilterEmbed(selectedUserId)],
          components: [buildFilterDropdown(selectedUserId, false)],
        }).catch(() => {});
        return;
      }
    } else {
      // Sync button (raid-check:sync:*) - handled by bot.js global router.
      return;
    }

    await i.update({
      embeds: [pages[currentPage]],
      components: buildComponents(currentPage, pages.length, selectedUserId, false),
    }).catch(() => {});
  });

  collector.on("end", async () => {
    try {
      const expiredFooter = `⏱️ Session đã hết hạn (${PAGINATION_SESSION_MS / 1000}s) · Dùng /raid-check để xem lại`;
      const source = pages[currentPage] || pages[0];
      const expiredEmbed = EmbedBuilder.from(source).setFooter({ text: expiredFooter });
      await interaction.editReply({
        embeds: [expiredEmbed],
        components: buildComponents(currentPage, pages.length, selectedUserId, true),
      });
    } catch {
      // Interaction token may have expired - ignore.
    }
  });
}

// ============================================================================
// /raid-check button handlers (Sync button only - Remind removed Apr 2026)
// ============================================================================

// Build the per-user DM embed sent by the Sync button (only to users whose
// auto-manage sync ACTUALLY produced new gate clears). delta is the
// `report.perChar` subset where `applied.length > 0`.
function buildRaidCheckSyncDMEmbed(raidMeta, delta) {
  const lines = delta.map((entry) => {
    const applied = Array.isArray(entry.applied) ? entry.applied : [];
    const gateInfo = applied
      .map((a) => `${a.raidLabel || a.raidKey} ${a.gate}`)
      .join(", ");
    return `- **${entry.charName}** - ${applied.length} gate mới: ${gateInfo || "(detail không có)"}`;
  });
  return new EmbedBuilder()
    .setColor(UI.colors.success)
    .setTitle(`${UI.icons.done} Raid progress auto-synced`)
    .setDescription(
      [
        `Raid Manager vừa trigger auto-sync cho char của cậu (qua \`/raid-check\`). Tớ đã pull bible logs mới và update:`,
        "",
        ...lines,
        "",
        `_Check \`/raid-status\` để xem full progress._`,
      ].join("\n")
    )
    .setTimestamp();
}

// Dispatcher for any button with customId starting "raid-check:". Re-checks
// Raid Manager auth on click (defense-in-depth - ephemeral filter SHOULD
// already prevent non-invokers but Discord button events can leak through
// on edge cases like reused message IDs).
async function handleRaidCheckButton(interaction) {
  if (!isRaidLeader(interaction)) {
    await interaction.reply({
      content: `${UI.icons.lock} Chỉ Raid Manager mới được dùng button này.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const raidKey = parts[2];
  const raidMeta = RAID_REQUIREMENT_MAP[raidKey];
  if (!raidMeta) {
    await interaction.reply({
      content: `${UI.icons.warn} Raid không hợp lệ trong button. Gõ \`/raid-check\` lại để refresh.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "sync") {
    await handleRaidCheckSyncClick(interaction, raidMeta);
  } else {
    await interaction.reply({
      content: `${UI.icons.warn} Button action không hỗ trợ: \`${action}\`.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleRaidCheckSyncClick(interaction, raidMeta) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const snapshot = await computeRaidCheckSnapshot(raidMeta);

  // Filter to opted-in pending users only (Option A from the earlier
  // privacy/quota discussion - never force-sync a user who hasn't
  // explicitly turned on auto-manage).
  const optedInDiscordIds = [
    ...new Set(
      snapshot.pendingChars
        .filter((c) => snapshot.userMeta.get(c.discordId)?.autoManageEnabled)
        .map((c) => c.discordId)
    ),
  ];
  if (optedInDiscordIds.length === 0) {
    await interaction.editReply({
      content: `${UI.icons.info} Không có user nào opt-in \`/raid-auto-manage\` trong list pending. Nhắc họ gõ \`/raid-auto-manage action:on\` hoặc tự update bằng \`/raid-set\`.`,
    });
    return;
  }

  const weekResetStart = weekResetStartMs();
  let syncedCount = 0;
  let attemptedOnlyCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const deltasPerUser = new Map();

  for (const discordId of optedInDiscordIds) {
    const guard = await acquireAutoManageSyncSlot(discordId);
    if (!guard.acquired) {
      skippedCount += 1;
      continue;
    }
    let bibleHit = false;
    try {
      const seedDoc = await User.findOne({ discordId });
      if (!seedDoc || !Array.isArray(seedDoc.accounts) || seedDoc.accounts.length === 0) {
        skippedCount += 1;
        continue;
      }
      if (!seedDoc.autoManageEnabled) {
        // Toggled off between snapshot + slot acquire. Respect the change.
        skippedCount += 1;
        continue;
      }
      ensureFreshWeek(seedDoc);
      const collected = await gatherAutoManageLogsForUserDoc(seedDoc, weekResetStart);
      bibleHit = true;
      let outcome = "attempted-only";
      let delta = null;
      await saveWithRetry(async () => {
        const fresh = await User.findOne({ discordId });
        if (!fresh || !Array.isArray(fresh.accounts) || fresh.accounts.length === 0) return;
        ensureFreshWeek(fresh);
        if (!fresh.autoManageEnabled) {
          fresh.lastAutoManageAttemptAt = Date.now();
          await fresh.save();
          return;
        }
        const report = applyAutoManageCollected(fresh, weekResetStart, collected);
        const now = Date.now();
        fresh.lastAutoManageAttemptAt = now;
        if (report.perChar.some((c) => !c.error)) {
          fresh.lastAutoManageSyncAt = now;
          outcome = "synced";
        }
        const appliedEntries = report.perChar.filter(
          (c) => Array.isArray(c.applied) && c.applied.length > 0
        );
        if (appliedEntries.length > 0) delta = appliedEntries;
        await fresh.save();
      });
      if (outcome === "synced") syncedCount += 1;
      else attemptedOnlyCount += 1;
      if (delta) deltasPerUser.set(discordId, delta);
    } catch (err) {
      failedCount += 1;
      if (bibleHit) await stampAutoManageAttempt(discordId);
      console.warn(
        `[raid-check sync] user ${discordId} failed:`,
        err?.message || err
      );
    } finally {
      releaseAutoManageSyncSlot(discordId);
    }
  }

  // DM only users whose sync produced ACTUAL new clears (delta non-empty).
  // Users who synced but had no changes don't get spammed.
  const dmResults = await Promise.all(
    [...deltasPerUser.entries()].map(([discordId, delta]) =>
      discordUserLimiter.run(async () => {
        try {
          const user = await interaction.client.users.fetch(discordId);
          const dmChannel = await user.createDM();
          const embed = buildRaidCheckSyncDMEmbed(raidMeta, delta);
          await dmChannel.send({ embeds: [embed] });
          return { ok: true };
        } catch {
          return { ok: false };
        }
      })
    )
  );
  const dmSent = dmResults.filter((r) => r.ok).length;
  const dmFailed = dmResults.length - dmSent;

  const lines = [
    `${UI.icons.done} Đã trigger sync cho **${optedInDiscordIds.length}** opted-in user.`,
    `- Synced (có data mới): **${syncedCount}** · Attempted-only (no fresh data): **${attemptedOnlyCount}**`,
    `- Skipped (cooldown/in-flight): **${skippedCount}** · Failed: **${failedCount}**`,
    `- Chars có update mới: **${deltasPerUser.size}** user · DM sent: **${dmSent}**${dmFailed > 0 ? ` · DM failed: **${dmFailed}**` : ""}`,
    "",
    `_Gõ \`/raid-check raid:${raidMeta.raidKey}_${normalizeName(raidMeta.modeKey)}\` để xem list pending mới._`,
  ];
  await interaction.editReply({ content: lines.join("\n") });
}

// Session timeout for any paginated command (/raid-status, /raid-check).
// 2 phút match với cadence user expect - đủ để scroll qua roster list, không
// lâu quá để giữ stale collector sống. Shared giữa nhiều command để consistent.
const PAGINATION_SESSION_MS = 2 * 60 * 1000;
// Shared English legend for footer of both /raid-status and /raid-check.
// Single source of truth - keeps the two paginated commands visually
// aligned.
const STATUS_FOOTER_LEGEND = `${UI.icons.done} done · ${UI.icons.partial} partial · ${UI.icons.pending} pending`;

// Lostark.bible updates each character roughly every 2 hours. We match that
// cadence to avoid wasted fetches: any account refreshed within this window
// is treated as fresh enough.
const ROSTER_REFRESH_COOLDOWN_MS = 2 * 60 * 60 * 1000;
// Short cooldown between failed refresh attempts. Without it, an account
// whose every seed fails (wrong accountName + stale char names) would re-queue
// the full seed list against bible on every /raid-status call - spam the
// command N times in a minute = N × seedCount bible fetches for a single user.
// 5 minutes is long enough to rate-limit retry spam but short enough that a
// user who just fixed their roster via /add-roster-char isn't stuck waiting
// 2h to see fresh data.
const ROSTER_REFRESH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

function isAccountRefreshStale(account, now = Date.now()) {
  const chars = Array.isArray(account?.characters) ? account.characters : [];
  // Empty rosters have nothing to validate upstream overlap against; skip so
  // they don't retry forever. /add-roster re-stamps lastRefreshedAt on its
  // own save path.
  if (chars.length === 0) return false;
  const lastSuccess = Number(account?.lastRefreshedAt) || 0;
  if ((now - lastSuccess) <= ROSTER_REFRESH_COOLDOWN_MS) return false;
  // Failure cooldown: if the last ATTEMPT is more recent than the last
  // SUCCESS, we're in a failing state - honor the shorter cooldown instead
  // of re-hitting bible on every /raid-status spam.
  const lastAttempt = Number(account?.lastRefreshAttemptAt) || 0;
  if (lastAttempt > lastSuccess && (now - lastAttempt) < ROSTER_REFRESH_FAILURE_COOLDOWN_MS) {
    return false;
  }
  return true;
}

/**
 * Gather phase of the stale-account refresh: runs bible fetches for every
 * stale account using the seed-with-overlap strategy. Does NOT mutate the
 * passed doc - returns a data-only array that `applyStaleAccountRefreshes`
 * can apply to a FRESH doc inside `saveWithRetry`. This separation matters
 * because a VersionError retry must NOT re-fire bible HTTP calls; the
 * expensive I/O happens once, outside the retry loop.
 *
 * Returns an array of `{ accountName, resolvedSeed, fetchedChars, attempted }`
 * entries - one per stale account. `fetchedChars` is null on total seed
 * failure; `attempted: true` means we burned bible quota (→ caller stamps
 * `lastRefreshAttemptAt` regardless of success).
 */
async function collectStaleAccountRefreshes(userDoc) {
  if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
    return [];
  }

  const now = Date.now();
  const staleAccounts = userDoc.accounts.filter((account) => isAccountRefreshStale(account, now));
  if (staleAccounts.length === 0) return [];

  // Snapshot other account names for the collision guard so the apply
  // phase doesn't need to re-derive them against the fresh doc (which may
  // have diverged).
  const otherAccountNames = userDoc.accounts.map((a) => normalizeName(a?.accountName));

  const results = await Promise.allSettled(
    staleAccounts.map(async (account) => {
      const originalName = account.accountName;
      const seeds = [];
      if (originalName) seeds.push(originalName);
      for (const c of (account.characters || [])) {
        const n = getCharacterName(c);
        if (n && !seeds.includes(n)) seeds.push(n);
      }
      if (seeds.length === 0) {
        return { accountName: originalName, fetchedChars: null, resolvedSeed: null, attempted: false };
      }

      const savedNames = (account.characters || [])
        .map((c) => normalizeName(getCharacterName(c)))
        .filter(Boolean);

      let attempted = false;
      for (const seed of seeds) {
        try {
          attempted = true;
          const fetched = await fetchRosterCharacters(seed);
          if (!Array.isArray(fetched) || fetched.length === 0) continue;

          // Require actual overlap with saved characters before accepting
          // this seed. A non-empty fetch alone is not enough: a wrong
          // fallback seed can pull someone else's roster. If overlap is
          // zero, try the next seed instead of returning early - otherwise
          // the account would keep hitting the same bad first seed and
          // never self-heal on subsequent /raid-status calls.
          const fetchedNames = new Set(fetched.map((c) => normalizeName(c.charName)));
          const hasOverlap = savedNames.some((n) => fetchedNames.has(n));
          if (!hasOverlap) {
            console.warn(
              `[refresh] seed "${seed}" returned ${fetched.length} chars but zero overlap with saved roster - trying next seed.`
            );
            continue;
          }

          // Plan accountName convergence: only commit the rename in apply
          // phase if the colliding-name check against the FRESH doc still
          // holds there. Record the intent here.
          let resolvedSeed = null;
          if (originalName !== seed) {
            const normalizedSeed = normalizeName(seed);
            const collides = otherAccountNames.some(
              (n, i) => userDoc.accounts[i] !== account && n === normalizedSeed
            );
            if (!collides) resolvedSeed = seed;
          }
          return { accountName: originalName, fetchedChars: fetched, resolvedSeed, attempted };
        } catch (err) {
          console.warn(`[refresh] seed "${seed}" failed: ${err?.message || err}`);
        }
      }
      return { accountName: originalName, fetchedChars: null, resolvedSeed: null, attempted };
    })
  );

  const collected = [];
  for (const r of results) {
    if (r.status === "rejected") {
      console.warn(`[refresh] account fetch failed: ${r.reason?.message || r.reason}`);
      continue;
    }
    collected.push(r.value);
  }
  return collected;
}

/**
 * Apply phase of the stale-account refresh: takes the data-only array from
 * `collectStaleAccountRefreshes` and writes it into a FRESH (possibly
 * re-fetched-on-VersionError) user doc. Does NO I/O - pure mutation.
 *
 * Returns true if the doc needs to be saved. Always stamps
 * `lastRefreshAttemptAt` on accounts where bible was actually queried, even
 * when every seed failed / had zero overlap - so the failure cooldown in
 * `isAccountRefreshStale` can throttle retry spam.
 */
function applyStaleAccountRefreshes(userDoc, collected) {
  if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
    return false;
  }
  if (!Array.isArray(collected) || collected.length === 0) return false;

  const byName = new Map(
    collected
      .filter((c) => c?.accountName)
      .map((c) => [normalizeName(c.accountName), c])
  );

  let didUpdate = false;
  const now = Date.now();

  for (const account of userDoc.accounts) {
    const entry = byName.get(normalizeName(account?.accountName));
    if (!entry) continue;
    if (!entry.attempted) continue;

    // Stamp attempt early - covers both success and failure branches below
    // so the failure cooldown always kicks in when bible was actually hit.
    account.lastRefreshAttemptAt = now;
    didUpdate = true;

    const fetched = entry.fetchedChars;
    if (!Array.isArray(fetched) || fetched.length === 0) {
      // All seeds failed - attempt stamp already applied above.
      continue;
    }

    const fetchedByName = new Map(
      fetched.map((c) => [normalizeName(c.charName), c])
    );
    let matchedAny = false;
    for (const character of (account.characters || [])) {
      const match = fetchedByName.get(normalizeName(getCharacterName(character)));
      if (!match) continue;
      matchedAny = true;
      character.itemLevel = Number(match.itemLevel) || character.itemLevel;
      character.combatScore = String(match.combatScore || character.combatScore || "");
      if (match.className) character.class = match.className;
    }
    if (!matchedAny) {
      // Zero overlap - skip success stamp but keep attempt stamp so retry
      // is rate-limited. Same "don't trust a foreign roster fallback"
      // reasoning as before.
      console.warn(
        `[refresh] account "${account.accountName}" fetched ${fetched.length} chars but zero overlap with saved roster - skipping success stamp.`
      );
      continue;
    }

    // Re-check collision against FRESH doc before committing the rename
    // planned in collect phase. Another /remove-roster or /add-roster
    // between collect and apply could have changed which names are taken.
    if (entry.resolvedSeed && account.accountName !== entry.resolvedSeed) {
      const normalizedSeed = normalizeName(entry.resolvedSeed);
      const freshCollides = userDoc.accounts.some(
        (other) => other !== account && normalizeName(other.accountName) === normalizedSeed
      );
      if (!freshCollides) account.accountName = entry.resolvedSeed;
    }

    account.lastRefreshedAt = now;
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

// Generic Prev/Next pagination row builder. Customize customId prefix per
// command so the same visual/behavioral pattern works without collision:
// /raid-status uses `status:prev` / `status:next`, /raid-check uses
// `raid-check-page:prev` / `raid-check-page:next`. Each command's collector
// matches its own prefix; bot.js's global router doesn't see either
// (status:* isn't routed, raid-check-page:* deliberately NOT prefixed
// "raid-check:" to avoid the existing handleRaidCheckButton dispatcher).
function buildPaginationRow(currentPage, totalPages, disabled, { prevId, nextId }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(prevId)
      .setLabel("◀ Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || currentPage === 0),
    new ButtonBuilder()
      .setCustomId(nextId)
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

  // Lazy refresh stale accounts in two phases so bible fetches run ONCE even
  // when saveWithRetry has to re-run the mutation against a fresh doc after
  // a VersionError. Phase A (collect) reads a seed doc + hits bible for every
  // stale account. Phase B (apply) runs inside saveWithRetry and is pure in-
  // memory mutation + save - cheap to retry. Without this split, a concurrent
  // save racing /raid-status would trigger a full roster re-scrape on every
  // retry.
  //
  // Phase 2 of /raid-auto-manage piggybacks here: if the user has opted in
  // (`autoManageEnabled === true`) AND the auto-manage 5-min cooldown allows
  // it (acquireAutoManageSyncSlot) we ALSO gather bible logs in the same
  // collect pass and apply them in the same save. This keeps Phase 2
  // automation gated by user intent (must invoke /raid-status) so we never
  // burn quota for offline users, and reuses the existing slot/cooldown so
  // spam-clicking /raid-status can't blast bible.
  let userDoc = null;
  let autoManageGuard = null;
  try {
    const seedDoc = await User.findOne({ discordId });
    if (!seedDoc) {
      userDoc = null;
    } else {
      // ensureFreshWeek on seedDoc so the staleness filter sees the post-
      // reset state. The fresh doc inside the retry loop runs it again
      // idempotently - second call is a no-op when already freshened.
      ensureFreshWeek(seedDoc);

      // Phase 2 auto-manage piggyback: gate on opt-in + slot acquire.
      // Slot acquire returns `acquired: false, reason: 'cooldown'|'in-flight'`
      // when within the 5-min throttle or another auto-manage sync is
      // running for this user - both cases silently fall through to cached
      // raid data. Render path doesn't care; user can run
      // `/raid-auto-manage action:status` for sync diagnostics.
      //
      // Acquire the slot BEFORE Promise.all so the in-flight Set is
      // populated synchronously - a racing /raid-auto-manage action:sync
      // sees the Set populated and bails. Then run BOTH the refresh
      // collect and the auto-manage gather in parallel - both share the
      // bibleLimiter (max 2 concurrent) so wall-clock doesn't double, but
      // they no longer serialize the way Phase 2 v1 did.
      let autoManagePromise = Promise.resolve(null);
      let autoManageWeekResetStart = null;
      const hasRoster = Array.isArray(seedDoc.accounts) && seedDoc.accounts.length > 0;
      if (seedDoc.autoManageEnabled && hasRoster) {
        autoManageGuard = await acquireAutoManageSyncSlot(discordId);
        if (autoManageGuard.acquired) {
          autoManageWeekResetStart = weekResetStartMs();
          autoManagePromise = gatherAutoManageLogsForUserDoc(
            seedDoc,
            autoManageWeekResetStart
          ).catch((err) => {
            console.warn(
              "[raid-status] auto-manage piggyback gather failed:",
              err?.message || err
            );
            // Returning null → apply branch below skips it. Slot still
            // releases in `finally` so the next call can retry.
            return null;
          });
        }
      }

      // Parallel collect: refresh fan-outs through Promise.allSettled
      // internally, auto-manage gather loops chars sequentially - both
      // bounded by bibleLimiter. Total wall-clock = max(refresh, auto-
      // manage) instead of refresh + auto-manage.
      const [refreshCollected, autoManageCollected] = await Promise.all([
        collectStaleAccountRefreshes(seedDoc),
        autoManagePromise,
      ]);
      // Track whether bible was actually hit on the auto-manage path -
      // controls whether we need to stamp `lastAutoManageAttemptAt` on
      // catch (Codex round 26 finding #2: cooldown bypass on save fail).
      const autoManageBibleHit = autoManageGuard?.acquired === true;

      userDoc = await saveWithRetry(async () => {
        const doc = await User.findOne({ discordId });
        if (!doc) return null;
        const didFreshenWeek = ensureFreshWeek(doc);
        const didRefresh = applyStaleAccountRefreshes(doc, refreshCollected);

        let didAutoManage = false;
        // Re-check `doc.autoManageEnabled` against the FRESH doc (not the
        // seedDoc snapshot) - Codex round 26 finding #1: user could have
        // bấm `action:off` between gather start and save, in which case
        // the in-flight piggyback should NOT write one more sync. We
        // already paid bible quota (covered by attempt stamp below) but
        // we don't apply the data or stamp success.
        if (autoManageCollected && doc.autoManageEnabled) {
          const autoReport = applyAutoManageCollected(
            doc,
            autoManageWeekResetStart,
            autoManageCollected
          );
          const now = Date.now();
          doc.lastAutoManageAttemptAt = now;
          if (autoReport.perChar.some((c) => !c.error)) {
            doc.lastAutoManageSyncAt = now;
          }
          didAutoManage = true;
        } else if (autoManageBibleHit) {
          // Bible was hit but user toggled off (or gather returned null
          // from a thrown error before save). Stamp attempt so cooldown
          // still kicks in for the next call - same reasoning as the
          // outer catch block below.
          doc.lastAutoManageAttemptAt = Date.now();
          didAutoManage = true;
        }

        if (didFreshenWeek || didRefresh || didAutoManage) await doc.save();
        return doc.toObject();
      });
    }
  } catch (err) {
    console.error("[raid-status] lazy refresh failed:", err?.message || err);
    // Codex round 26 finding #2: if auto-manage bible HTTP burned quota
    // but the saveWithRetry path threw (mongo blip, VersionError exhaust,
    // etc.), the in-loop attempt stamp never persisted. Without this
    // best-effort fallback, the next /raid-status would acquire the slot
    // immediately and re-hit bible. stampAutoManageAttempt swallows its
    // own DB errors so it never masks the real failure being logged.
    if (autoManageGuard?.acquired) {
      await stampAutoManageAttempt(discordId);
    }
    userDoc = await User.findOne({ discordId }).lean();
  } finally {
    // Release auto-manage slot we may have acquired above. Guard against
    // releasing twice or releasing when never acquired.
    if (autoManageGuard?.acquired) releaseAutoManageSyncSlot(discordId);
  }

  if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
    await interaction.editReply({
      content: `${UI.icons.info} Cậu chưa có roster nào. Dùng \`/add-roster\` để thêm trước nhé.`,
    });
    return;
  }

  // Memoize per-character raid status for the lifetime of this one render.
  // getStatusRaidsForCharacter is pure for a given character snapshot, so
  // sharing results lets global totals, per-account totals, and per-card
  // rendering reuse one computation instead of repeating it three times.
  //
  // Key by the character object reference itself (Map supports object keys)
  // rather than by id-or-name: legacy docs without `character.id` could have
  // two same-name characters across different rosters, and a name-fallback
  // key would make one card render the other's cached progress.
  const raidsCache = new Map();
  const getRaidsFor = (character) => {
    let result = raidsCache.get(character);
    if (!result) {
      result = getStatusRaidsForCharacter(character);
      raidsCache.set(character, result);
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
    components: [buildPaginationRow(currentPage, pages.length, false, { prevId: "status:prev", nextId: "status:next" })],
  });
  const message = await interaction.fetchReply();

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: PAGINATION_SESSION_MS,
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
      components: [buildPaginationRow(currentPage, pages.length, false, { prevId: "status:prev", nextId: "status:next" })],
    }).catch(() => {});
  });

  collector.on("end", async () => {
    try {
      const expiredFooter = `⏱️ Session đã hết hạn (${PAGINATION_SESSION_MS / 1000}s) · Dùng /raid-status để xem lại`;
      const expiredEmbed = EmbedBuilder.from(pages[currentPage]).setFooter({ text: expiredFooter });
      await interaction.editReply({
        embeds: [expiredEmbed],
        components: [buildPaginationRow(currentPage, pages.length, true, { prevId: "status:prev", nextId: "status:next" })],
      });
    } catch {
      // Interaction token may have expired - ignore.
    }
  });
}

// Finds a character by name inside a user doc. Optional `rosterName` narrows
// the search to a single account (accountName match) so /raid-set with the
// new roster field can disambiguate same-named characters across rosters.
// Without roster (e.g. text-monitor parser which only has the char name),
// falls back to first-by-iteration match - same behavior as before.
function findCharacterInUser(userDoc, characterName, rosterName = null) {
  if (!userDoc || !Array.isArray(userDoc.accounts)) return null;
  const target = normalizeName(characterName);
  const rosterTarget = rosterName ? normalizeName(rosterName) : null;
  for (const account of userDoc.accounts) {
    if (rosterTarget && normalizeName(account.accountName) !== rosterTarget) continue;
    const chars = Array.isArray(account.characters) ? account.characters : [];
    for (const character of chars) {
      if (normalizeName(getCharacterName(character)) === target) return character;
    }
  }
  return null;
}

// Autocomplete for the /raid-set `roster` option - lists user's accounts
// (rosters) with char count suffix so picker can see roster size at a glance.
// Same format as /remove-roster's roster autocomplete for visual consistency.
async function autocompleteRaidSetRoster(interaction, focused) {
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

// Character autocomplete for /raid-set. Reads the upstream `roster` option
// (now required) and filters to just that account's chars - sidesteps the
// Discord 25-result cap when the user has 5+ rosters worth of characters
// (~30+ total), which the flat "top 25 by iLvl" approach silently truncated.
async function autocompleteRaidSetCharacter(interaction, focused) {
  const needle = normalizeName(focused.value || "");
  const rosterInput = interaction.options.getString("roster") || "";
  const discordId = interaction.user.id;
  const userDoc = await loadUserForAutocomplete(discordId);
  if (!userDoc || !Array.isArray(userDoc.accounts)) {
    await interaction.respond([]).catch(() => {});
    return;
  }

  // Source accounts: roster-filtered if user has already picked one, else
  // all accounts (so the field works even before roster is filled - Discord
  // autocomplete fires per-keystroke regardless of fill order).
  const rosterTarget = rosterInput ? normalizeName(rosterInput) : null;
  const accounts = rosterTarget
    ? userDoc.accounts.filter((a) => normalizeName(a.accountName) === rosterTarget)
    : userDoc.accounts;

  const entries = [];
  const seen = new Set();
  for (const account of accounts) {
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
  const rosterInput = interaction.options.getString("roster") || "";
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
  // Pass rosterInput so same-named chars across rosters resolve to the
  // roster the user actually picked, not just first-by-iteration.
  const character = findCharacterInUser(userDoc, characterInput, rosterInput || null);
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
  const rosterInput = interaction.options.getString("roster") || "";
  const characterInput = interaction.options.getString("character") || "";
  const raidValue = interaction.options.getString("raid") || "";
  const needle = normalizeName(focused.value || "");
  const discordId = interaction.user.id;

  const baseChoices = [
    { name: "Complete - mark the whole raid as done", value: "complete" },
    { name: "Process - mark one specific gate as done (requires gate)", value: "process" },
    { name: "Reset - clear all gates back to 0", value: "reset" },
  ];

  const applyFilter = (list) =>
    list.filter((c) => !needle || normalizeName(c.name).includes(needle));

  const raidMeta = RAID_REQUIREMENT_MAP[raidValue];
  if (!characterInput || !raidMeta) {
    await interaction.respond(applyFilter(baseChoices)).catch(() => {});
    return;
  }

  const userDoc = await loadUserForAutocomplete(discordId);
  const character = findCharacterInUser(userDoc, characterInput, rosterInput || null);
  if (!character) {
    await interaction.respond(applyFilter(baseChoices)).catch(() => {});
    return;
  }

  const { isComplete } = computeRaidProgress(character, raidMeta);
  const choices = isComplete
    ? [{ name: "Reset (raid đã hoàn thành - chỉ có thể reset)", value: "reset" }]
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
    if (focused?.name === "roster") {
      await autocompleteRaidSetRoster(interaction, focused);
      return;
    }
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

/**
 * Core raid-set write path shared by `/raid-set` and the channel-monitor
 * text handler. Given a Discord user id and a raid/gate target, load the
 * user doc, find the single first-by-iteration character match, enforce
 * iLvl eligibility, wipe the raid on difficulty switch, and write the
 * gate(s). Returns a status object the caller can render into whatever
 * surface it owns (slash-command embed, message reaction, log line).
 *
 * Returns:
 *   { noRoster?, matched, updated, ineligibleItemLevel, modeResetCount }
 */
async function applyRaidSetForDiscordId({
  discordId,
  characterName,
  rosterName = null,
  raidMeta,
  statusType,
  effectiveGates,
}) {
  const gateList = Array.isArray(effectiveGates) ? effectiveGates.filter(Boolean) : [];
  const selectedDifficulty = toModeLabel(raidMeta.modeKey);

  let noRoster = false;
  let updatedCount = 0;
  let matchedCount = 0;
  let ineligibleItemLevel = 0;
  let modeResetCount = 0;
  let alreadyComplete = false;
  // The properly-cased character name from the roster - user's input may
  // be lowercase (especially from the text-channel parser which lowercases
  // for alias matching), but the embed should show the name the way the
  // owner registered it.
  let displayName = "";

  await saveWithRetry(async () => {
    // Reset outer counters on each retry attempt so VersionError retries
    // start from a clean slate of status flags.
    noRoster = false;
    updatedCount = 0;
    matchedCount = 0;
    ineligibleItemLevel = 0;
    modeResetCount = 0;
    alreadyComplete = false;
    displayName = "";

    const userDoc = await User.findOne({ discordId });
    if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
      // No roster at all - single-read detection inside retry, so we
      // avoid a duplicate pre-check findOne and stay consistent if the
      // document is created concurrently.
      noRoster = true;
      return;
    }

    ensureFreshWeek(userDoc);

    // Resolve exactly ONE character. When rosterName is provided (slash
    // command path, required field), scope the lookup to that roster so
    // same-named chars across rosters don't collide. When null (text-
    // monitor parser path), fall back to first-by-iteration match.
    const character = findCharacterInUser(userDoc, characterName, rosterName);
    if (!character) return;

    matchedCount = 1;
    displayName = getCharacterName(character);
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

    const gateKeys = gateList.length > 0 ? gateList : getGateKeys(raidData);
    const shouldMarkDone = statusType === "complete" || statusType === "process";

    // Short-circuit if the requested mark-done is a complete no-op: every
    // target gate already has completedDate > 0 for the selected difficulty,
    // and there's no mode-switch in play. Without this check the caller
    // would silently re-stamp timestamps and surface a fresh "Raid
    // Completed" DM - confusing the user into thinking a fresh clear was
    // recorded. Skip the write and let the handler surface a specific
    // "already DONE" notice.
    if (shouldMarkDone && !modeChangeDetected) {
      const everyTargetAlreadyDone = gateKeys.length > 0 && gateKeys.every((g) => {
        const entry = raidData[g];
        if (!entry) return false;
        if (!(Number(entry.completedDate) > 0)) return false;
        const entryDiff = normalizeName(entry.difficulty || "");
        return !entryDiff || entryDiff === normalizedSelectedDiff;
      });
      if (everyTargetAlreadyDone) {
        alreadyComplete = true;
        return;
      }
    }

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

  return {
    noRoster,
    matched: matchedCount > 0,
    updated: updatedCount > 0,
    alreadyComplete,
    ineligibleItemLevel,
    modeResetCount,
    selectedDifficulty,
    displayName,
  };
}

async function handleRaidSetCommand(interaction) {
  const discordId = interaction.user.id;
  const rosterName = interaction.options.getString("roster", true).trim();
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

  // /raid-set slash command keeps explicit single-gate semantics - admin
  // power-user surface needs the ability to mark exactly one gate without
  // cascading to earlier ones (edge cases like fixing a bad record).
  const result = await applyRaidSetForDiscordId({
    discordId,
    characterName,
    rosterName,
    raidMeta,
    statusType,
    effectiveGates: effectiveGate ? [effectiveGate] : [],
  });

  if (result.noRoster) {
    await interaction.reply({
      content: `${UI.icons.info} Cậu chưa có roster nào. Dùng \`/add-roster\` để thêm trước nhé.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!result.matched) {
    await interaction.reply({
      content: `${UI.icons.warn} Không tìm thấy character **${characterName}** trong roster.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (result.alreadyComplete) {
    const scope = effectiveGate ? `${raidMeta.label} · ${effectiveGate}` : raidMeta.label;
    const alreadyEmbed = new EmbedBuilder()
      .setColor(UI.colors.progress)
      .setTitle(`${UI.icons.info} Đã DONE từ trước rồi`)
      .setDescription(`**${characterName}** đã clear **${scope}** tuần này rồi - không update lại. Nếu cậu muốn reset, đổi \`status\` sang \`reset\` và chạy lại nhé.`)
      .addFields(
        { name: "Character", value: `**${characterName}**`, inline: true },
        { name: "Raid", value: `**${raidMeta.label}**`, inline: true },
        { name: "Gate", value: effectiveGate || "All gates", inline: true },
      )
      .setTimestamp();
    await interaction.reply({ embeds: [alreadyEmbed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (!result.updated) {
    await interaction.reply({
      content: `${UI.icons.warn} Character **${characterName}** đang ở iLvl **${result.ineligibleItemLevel}**, chưa đủ **${raidMeta.minItemLevel}+** để thao tác **${raidMeta.label}**.`,
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
  if (result.modeResetCount > 0) {
    resultEmbed.setFooter({
      text: `Switched difficulty to ${result.selectedDifficulty} - previous mode progress cleared for a consistent state.`,
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
      "• **Lazy refresh**: account nào quá 2h chưa update thì Artist scrape bible roster page để sync itemLevel/combatScore/class - match bible cadence ~2h. Share `bibleLimiter` với `/raid-auto-manage`. Mỗi HTTP fetch gắn `AbortSignal.timeout(15s)` chống bible treo connection.",
      "• **Failure cooldown**: nếu seed list của một account fail hết (wrong accountName + stale char names), Artist stamp `lastRefreshAttemptAt` và skip refresh account đó trong **5 phút** tiếp theo. Spam `/raid-status` trong lúc failing không còn queue N seed × bible fetch mỗi lần - tự heal khi hết cooldown hoặc khi user sửa roster qua `/add-roster`.",
      "• **Gather/apply split**: bible fetch chạy OUTSIDE `saveWithRetry` một lần duy nhất; apply phase (mutate fresh doc + save) mới ở trong retry loop. VersionError retry không re-fire bible HTTP call.",
      "• **Auto-manage piggyback (Phase 2)**: nếu user đã bật `/raid-auto-manage action:on` (`autoManageEnabled = true`), `/raid-status` cũng sẽ tự pull bible logs **song song** với roster refresh (Promise.all, share `bibleLimiter`) trước khi render. Re-check `autoManageEnabled` trên fresh doc trong save phase nên user bấm `action:off` giữa gather và save sẽ không bị apply thừa 1 sync. Save fail (mongo blip) → stamp attempt qua `stampAutoManageAttempt` để cooldown vẫn protect bible. Cooldown chưa hết / gather throw → render cached, không vỡ command.",
    ],
  },
  {
    key: "raid-set",
    label: "/raid-set",
    icon: "✏️",
    short: "Update raid completion per character",
    shortVn: "Cập nhật tiến độ raid cho character",
    options: [
      { name: "roster", required: true, desc: "Roster (account) chứa character - autocomplete list các account đã đăng ký với char count suffix. Required để narrow down character autocomplete khi user có nhiều roster (Discord autocomplete cap 25 entries, 5+ rosters × 6 chars = overflow). Pick roster trước thì character autocomplete chỉ show char trong roster đó." },
      { name: "character", required: true, desc: "Tên character - autocomplete filter theo roster đã chọn (chỉ show char trong roster đó). Nếu roster chưa pick, autocomplete show chars across all accounts (legacy fallback). Same-named chars across rosters không còn collide nhờ chained roster filter." },
      { name: "raid", required: true, desc: "Raid + difficulty - autocomplete filter theo character đã chọn, kèm icon tiến độ (🟢/🟡/⚪). Raid đã hoàn thành hiển thị suffix DONE." },
      { name: "status", required: true, desc: "complete | process | reset - autocomplete. `process` đánh dấu 1 gate cụ thể; khi raid đã DONE thì dropdown tự thu còn `reset` thôi." },
      { name: "gate", required: false, desc: "Gate cụ thể - autocomplete **chỉ active khi status = Process**, dropdown đọc số gate thực tế của raid (G1/G2 cho Act 4/Kazeros/Serca hiện tại)" },
    ],
    example: "/raid-set roster:Clauseduk character:Nailaduk raid:kazeros_hard status:process gate:G1",
    notes: [
      "EN: `complete` / `reset` act on every gate. Use `process` + `gate` to touch a single gate.",
      "VN: `complete`/`reset` luôn tác động toàn bộ gate; dùng `process` + `gate` để chỉ update 1 gate.",
      "• **Roster field chained autocomplete**: pick roster trước → character autocomplete sẽ chỉ show char trong roster đó. Fix issue cũ là Discord autocomplete cap 25 entries: user với 5+ rosters × 6 char (=30+ chars) bị cut off ở top-25 by iLvl desc, lower-iLvl chars không chọn được. Giờ mỗi roster max 6 char nên luôn visible đầy đủ.",
      "• **Same-named chars disambiguation**: nếu 2 roster cùng user có char cùng tên (e.g. 'Clauseduk' tồn tại cả main lẫn alt), trước đây apply path chỉ mark char đầu tiên (first-by-iteration). Giờ với roster field, `findCharacterInUser(doc, char, rosterName)` scope lookup vào roster đã chọn - update đúng char user muốn.",
      "• **Text-monitor parser vẫn OK**: kênh `/raid-channel` parse `Act4 Hard Clauseduk` không có roster context, `applyRaidSetForDiscordId` nhận `rosterName=null` và fallback first-by-iteration. Không breaking change cho text path.",
      "• Đổi mode (ví dụ Serca Nightmare → Hard) sẽ wipe progress cũ vì raid weekly entry là mode-scoped.",
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
      "EN: Restricted to Discord user IDs configured in the `RAID_MANAGER_ID` env var (comma-separated).",
      "VN: Chỉ Discord user IDs được liệt kê trong env `RAID_MANAGER_ID` (cách nhau bằng dấu phẩy) được phép gọi. Operator config qua deploy env, không qua Discord role.",
      "• **Header**: title embed hiện `⚠️ Raid Check · <raid label> (<minItemLevel>)` - gọn, chỉ command + raid + threshold (ví dụ `Act 4 Normal (1700)`). Description đã bỏ hoàn toàn - info đều ở title, per-roster headers, và footer. Page indicator + 3-state counts đều dưới footer.",
      "• **Per-char card (inline field)**: mỗi char = 1 Discord inline field mirroring `/raid-status`'s pattern. Field name `<charName> · <iLvl>` được Discord auto-bold = scan anchor. Field value `<icon> <done>/<total>` (ví dụ `⚪ 0/2`) - value line có content nên không waste height (earlier attempt pack everything vào name line + ZWS value tạo gap 'cách nhau quá'). Aggregate 3-state icon qua `pickProgressIcon` (🟢 done all / 🟡 partial / ⚪ none). Raid label nằm ở title không lặp trong value.",
      "• **2-column layout via inline fields + spacer**: Discord default pack 3 inline field/row; chèn zero-width-space spacer field giữa mỗi cặp char để force 2-per-row - y hệt kỹ thuật `/raid-status`. Odd char cuối cùng cặp với 1 spacer để không bị Discord stretch full-width.",
      "• **2 rosters per page (chunked)**: mỗi embed page chứa tối đa 2 roster sections stacked. Roster section = non-inline header field với RICH value line. Name = `📁 accountName (displayName)` (clean label). Value = `<state breakdown> · avg iLvl <N> · 📥<refreshRelative> · 🔄<autoManageRelative>`. **📥 badge** = roster data refresh (iLvl/class từ bible qua /raid-status lazy refresh) - applies to ALL users. **🔄 badge** = auto-manage bible log sync (raid progress) - chỉ opted-in user. Hai badges song song nếu đủ data. Ví dụ: `4 ⚪ · 1 🟡 · 1 🟢 · avg iLvl 1704 · 📥2h · 🔄1h`. Per roster cost: 1 header + N char + ceil(N/2) spacer fields. 2 × 6-char rosters = 20 fields, fit 25-cap.",
      "• **User filter dropdown** (action row 2): `StringSelectMenuBuilder` cho phép Raid Manager lọc pages theo Discord user. First option `🌐 All users (N pending)` reset filter. Tiếp theo top-24 users sort theo pending desc (`👤 displayName (N pending)`). Discord cap 25 options total. Selection → recompute pages chỉ chứa rosters của user đó, reset currentPage=0. `default: true` preserve selected state qua Prev/Next clicks. Rosters cùng user group consecutive, sort theo tổng pending user desc rồi per-roster pending desc. **Avatar in embed author**: khi filter = specific user, resolve Discord avatar cache-first (`client.users.cache` fallback to `fetch` via `discordUserLimiter`) và `setAuthor({name, iconURL})` trên mỗi page - visual confirmation filter đang active. Discord StringSelectMenu options không support per-option avatars (API limitation) nên embed author là compromise.",
      "• **Pagination buttons + session**: `◀ Previous` / `Next ▶` (shared helper `buildPaginationRow`) cycle giữa các roster-chunk pages. Title stable `⚠️ Raid Check · <raid> (<minItemLevel>)` không đổi theo page. Footer append page indicator. Collector locked theo người chạy, session timeout **2 phút** (`PAGINATION_SESSION_MS`), hết hạn disable all components + swap footer legend.",
      "• **Sync badge trong roster header**: opted-in user có sync data hiện `🔄5m` / `🔄2h` / `🔄3d` (compact relative time tự compute). Opted-in nhưng chưa sync lần nào → `🔄never`. Non-opted-in → không hiện segment này.",
      "• **Footer legend với counts + page**: `🟢 N done · 🟡 M partial · ⚪ K pending · Page X/Y` - icon + count + English label merged, page indicator append cuối khi > 1 roster (move từ title xuống đây). Dynamic per page (page index thay đổi) compute inline trong `buildRaidCheckPage`. Discord render timestamp (`Today at HH:MM`) sau footer text tự động.",
      "• **Sort order**: users có nhiều pending tổng nhất lên top; trong mỗi user rosters sort theo pending count desc; trong mỗi roster chars sort theo iLvl desc.",
      "• **Mode hierarchy satisfies lower-mode scans**: mode rank Normal (1) < Hard (2) < Nightmare (3). Gate stored với mode rank ≥ scan mode rank sẽ count as done. Ví dụ: char cleared Kazeros Hard → scan Kazeros Normal thấy char đó done (Hard ≥ Normal, weekly requirement satisfied). Reverse không apply: char chỉ cleared Normal → scan Hard vẫn pending (cần Hard specifically). Helper `modeRank(str)` map Normal→1, Hard→2, Nightmare→3.",
      "• **🔄 Sync button**: Raid Manager bấm → trigger auto-manage sync CHỈ cho opted-in user trong list pending (privacy-respecting - non-opted-in user KHÔNG bị force-sync). Operate trên ALL opted-in pending users (không chỉ current page). Reuse Phase 3 gather/apply pattern + `acquireAutoManageSyncSlot` (5-min cooldown share với /raid-auto-manage). User nào có char update mới sẽ nhận DM riêng (skip nếu sync chạy nhưng không có data mới). Disabled nếu không có opted-in user nào trong list.",
      "• **Button customId routing**: Pagination buttons dùng prefix `raid-check-page:prev` / `raid-check-page:next` (KHÔNG `raid-check:*`) để bot.js's global `handleRaidCheckButton` dispatcher bỏ qua - collector trên reply message handle pagination locally. Sync vẫn dùng `raid-check:sync:<raidKey>` qua global router.",
      "• **Remind button removed** (Apr 2026): nút 🔔 Remind đã bỏ theo Traine's cleanup request. Raid Manager ping user manual qua Discord @mention hoặc hướng dẫn họ dùng `/raid-auto-manage action:on` / `/raid-set` tự update.",
      "• **Discord username resolution**: cache-first (discord.js users cache). Cache miss đi qua `discordUserLimiter` (max 5 in-flight) để server đông không burst `client.users.fetch` parallel - bảo vệ khỏi Discord 50 req/s global ceiling.",
    ],
  },
  {
    key: "remove-roster",
    label: "/remove-roster",
    icon: "🗑️",
    short: "Remove a roster or a single character from it",
    shortVn: "Xóa roster hoặc 1 character trong roster",
    options: [
      { name: "roster", required: true, desc: "Roster name - autocomplete từ roster đã lưu" },
      { name: "action", required: true, desc: "`Remove entire roster` hoặc `Remove a single character`" },
      { name: "character", required: false, desc: "Character cần xóa - autocomplete theo roster đã chọn (required nếu action = Remove a single character)" },
    ],
    example: "/remove-roster roster:Qiylyn action:Remove a single character character:Zywang",
    notes: [
      "EN: Delete an entire account, or just one character from it. The account stays even if all characters are removed.",
      "VN: Xóa cả account roster, hoặc chỉ 1 character trong đó. Account vẫn giữ lại dù không còn character nào.",
      "• Dùng kết hợp với `/add-roster`: muốn refresh 1 roster → `/remove-roster` rồi `/add-roster` lại.",
    ],
  },
  {
    key: "raid-channel",
    label: "/raid-channel",
    icon: "📢",
    short: "[Admin] Configure the raid-clear monitor channel",
    shortVn: "[Admin] Config channel để bot tự parse text → update raid",
    options: [
      { name: "config action:<x> [channel:<y>]", required: true, desc: "Single subcommand `config` - all admin actions dispatched via the `action` option" },
      { name: "action:show", required: false, desc: "Hiển thị channel + health check permissions + deploy-flag warnings" },
      { name: "action:set channel:<channel>", required: false, desc: "Đăng ký 1 text channel làm monitor + post & pin welcome embed" },
      { name: "action:clear", required: false, desc: "Tắt monitor + reset schedule" },
      { name: "action:cleanup", required: false, desc: "Xóa thủ công mọi message không pin (giữ welcome pinned)" },
      { name: "action:repin", required: false, desc: "Delete stale welcomes + post & pin 1 welcome mới" },
      { name: "action:schedule-on", required: false, desc: "Bật auto-cleanup mỗi 00:00 giờ VN" },
      { name: "action:schedule-off", required: false, desc: "Tắt auto-cleanup daily" },
    ],
    example: "/raid-channel config action:set channel:#raid-clears",
    notes: [
      "EN: Users post short messages like `Serca Nightmare Clauseduk` or `Serca Nor Soulrano G1`; bot parses, deletes the source message, and DMs the author a private confirmation embed.",
      "VN: Post message dạng `<raid> <difficulty> <character> [gate]` vào channel đã config - bot tự update raid, xóa message, và DM xác nhận riêng cho chính người post.",
      "• **Whisper acknowledgement trước khi xóa** (Apr 2026): khi parse thành công + DM gửi được, Artist post 1 dòng whisper tag user trong channel (`*thì thầm* @user ...Artist nhận được rồi nha~ Chờ 5 giây gửi DM...`) rồi mới xóa tin nhắn gốc + whisper sau 5 giây. User có visual confirmation trước khi tin vanish, không bị nhầm với rejection silent. Nếu DM fail → fallback public message hiện tại đảm nhận confirm (không kèm whisper để không double-post).",
      "• **Aliases**: `act 4` / `act4` / `armoche` · `kazeros` / `kaz` · `serca` (accept typo `secra`) · `normal` / `nor` · `hard` · `nightmare` / `nm` · gates `G1` / `G2`.",
      "• Không có gate = đánh dấu cả raid done (complete). Có gate `G_N` = **cumulative: mark G1 đến G_N đều done** (Lost Ark sequential progression - đi tới G2 nghĩa là G1 đã qua).",
      "• Chỉ poster tự update char của mình (cần có roster đã đăng ký qua `/add-roster`).",
      "• **Multi-char trong 1 post**: liệt kê nhiều tên cách nhau bằng space/comma/+ - ví dụ `Act4 Hard Priscilladuk, Nailaduk`. Bot apply raid update cho từng char, DM 1 embed aggregated (done/already-done/not-found/iLvl-thiếu grouped).",
      "• Nếu trong post có char gõ sai, Artist sẽ ping user trong channel với tên char không tìm thấy - các char hợp lệ khác vẫn được update bình thường.",
      "• **Set**: kiểm tra bot permission trong channel đích, **post + pin welcome fresh trước**, rồi mới unpin welcome cũ (safe-order - partial failure giữ welcome cũ để channel không mất guidance).",
      "• **Show**: hiển thị channel + health check permissions + deploy-flag warnings.",
      "• **Clear**: tắt monitor ngay, luôn write-through Mongo; cũng reset `autoCleanupEnabled` để schedule không tự kích lại khi admin `/set` channel mới.",
      "• **Cleanup**: xóa thủ công mọi message không pin trong monitor channel (giữ welcome pinned). Paginate đến hết channel. Messages > 14 ngày Discord không cho bulk-delete, bot sẽ report `skipped (>14 ngày)` để admin xóa tay nếu cần.",
      "• **Repin**: safe-order như Set - post + pin fresh trước, unpin stale sau. `welcomeMessageId` tracked trong DB để unpin đúng message cũ, không ảnh hưởng bot pins khác trong channel.",
      "• **Schedule on/off**: toggle auto-cleanup daily. Bật → mỗi 00:00 VN time, bot tự xóa non-pinned trong channel. Enable stamp today's key ngay nên tick đầu tiên sau enable chờ đến 00:00 kế, không catch-up ngay. Bot-offline catch-up chỉ hoạt động khi schedule đã enable continuous. Tắt → chỉ cleanup thủ công.",
      "• Parse fail (không phải raid intent) → bot im lặng.",
      "• Lỗi phục hồi được (char không có, iLvl thiếu, combo sai, nhiều raid/difficulty/gate) → bot ping user reply persistent, tự dọn khi user post lại hoặc sau 5 phút TTL. Hint và message gốc của user cùng bị dọn để channel heal về clean state.",
      "• **Raid đã clear từ trước** → bot DM user embed `Raid đã DONE rồi~` thay vì re-stamp timestamp + fresh success DM. Không update DB, tránh nhầm lẫn. Muốn reset thì chạy `/raid-set status:reset`.",
      "• **Per-user cooldown 2 giây** content-aware: duplicate content trong cooldown → drop + delete message. Different content khi có pending hint (đang fix lỗi) → **1 exception duy nhất/cooldown window** (không spam-bypass). Spam ≥3 hit trong 10s → kitsune warning, dedup 60s.",
      "• Deploy: bật `Message Content Intent` ở Discord Developer Portal, hoặc set `TEXT_MONITOR_ENABLED=false` để chạy slash-command-only.",
      "• **Permissions bot cần trong channel đích**: `View Channel`, `Send Messages`, `Manage Messages`, `Read Message History`, `Embed Links`. Thiếu 1 trong 5 là `/raid-channel config action:set` reject.",
      "• Admin-only command (yêu cầu `Manage Server` permission).",
    ],
  },
  {
    key: "raid-auto-manage",
    label: "/raid-auto-manage",
    icon: "🤖",
    short: "Auto-sync raid progress from lostark.bible",
    shortVn: "Tự động sync tiến độ raid từ lostark.bible logs",
    options: [
      { name: "action:on", required: false, desc: "Bật auto-sync + **probe roster trước** → nếu có char chưa bật Public Log, Artist hiện warning với nút `Vẫn bật` / `Huỷ` (60s timeout). Pass thì kickstart 1 lần sync ngay." },
      { name: "action:off", required: false, desc: "Tắt auto-sync" },
      { name: "action:sync", required: false, desc: "Manual sync - pull logs từ bible ngay và reconcile vào DB" },
      { name: "action:status", required: false, desc: "Xem state on/off + **Last success** (lần sync có ≥1 char thành công) + **Last attempt** (lần gọi gần nhất - hiện `- fail` khi các attempt sau success đều lỗi)" },
    ],
    example: "/raid-auto-manage action:sync",
    notes: [
      "EN: Pulls clear logs from `lostark.bible/api/character/logs` for every character in your roster, maps each boss → raid/gate, and updates `assignedRaids` for this week (filtering by weekly-reset boundary).",
      "VN: Kéo clear logs từ lostark.bible cho tất cả char trong roster, map boss → raid/gate rồi update progress tuần này.",
      "• **Boss mapping**: Armoche G1 = Brelshaza Ember / G2 = Armoche Sentinel · Kazeros G1 = Abyss Lord / G2 = Archdemon (Normal) hoặc Death Incarnate (Hard) · Serca G1 = Witch of Agony / G2 = Corvus Tul Rak.",
      "• **Bus clears** (`isBus: true`) vẫn được count làm clear - theo decision của chủ git.",
      "• **Filter theo weekly reset**: chỉ logs `timestamp >= 5h chiều thứ 4 (17:00 VN = 10:00 UTC)` gần nhất mới được apply, cũ hơn skip.",
      "• **Pagination**: logs API được gọi lặp `page: 1, 2, …` (25 entries/page) cho tới khi gặp entry ra khỏi tuần HOẶC page partial HOẶC cap `maxPages=10` (=250 entries safety). Char nhiều clear trong tuần (practice, bus) không bị miss.",
      "• **Sort ASC trước reconcile**: bible trả newest-first nhưng Artist sort oldest→newest để latest-mode luôn thắng khi có mode-switch wipe.",
      "• **Mode-switch**: nếu bible log báo clear Serca NM nhưng DB đang track Serca Hard cho char đó, bible-wins - Artist wipe raid progress cũ rồi ghi theo mode mới.",
      "• **Cached meta**: lần đầu sync phải scrape HTML page `/roster` để lấy `characterSerial + cid + rid`; các lần sau dùng cache trong DB → chỉ tốn 1 API call per char.",
      "• **Rate limit + timeout**: cả meta-scrape (HTML `/roster` page) lẫn logs API đều đi qua `bibleLimiter` (max 2 request concurrent) - share với `/raid-status` refresh. Cold-cache sync (roster mới, cần meta+logs per char) không bypass được cap 2-in-flight. Mỗi HTTP call gắn `AbortSignal.timeout(15s)` - bible treo connection sẽ auto-abort thay vì giữ slot + inFlight guard vô hạn.",
      "• **Gather/apply split**: bible HTTP chạy trong **gather phase OUTSIDE `saveWithRetry`**, rồi apply phase trong retry loop chỉ mutate in-memory. VersionError retry KHÔNG re-fire bible call nữa. Probe + commit share cùng `collected` array → chi phí giảm từ 2× bible run xuống 1×.",
      "• **Last success vs Last attempt**: nếu Cloudflare block hoặc bible trả `Logs not enabled` cho TẤT CẢ char, `lastAutoManageSyncAt` không được stamp (chỉ `lastAutoManageAttemptAt`). `action:status` surface cả 2 để admin thấy rõ khi sync đang fail liên tục.",
      "• **Private logs → `Logs not enabled` body match**: chỉ phân loại char là private khi bible response body chứa chuỗi `Logs not enabled` (confirmed payload). Generic HTTP 403 (Cloudflare block, rate-limit, IP deny) KHÔNG bị misclassify thành private nữa - những case đó hiện ở bucket Fail với raw error message, bật `Show on Profile` sẽ không cứu được. Bot không auth thay user được (cookie HTTP-only, upload token write-only - đã test 2026-04-21).",
      "• **Probe-before-enable**: khi gõ `action:on`, Artist chạy 1 lần sync **in memory** (không save) để phân loại char visible vs private. Nếu có char private → hiện warn embed với 2 nút `Vẫn bật` / `Huỷ`, timeout 60s = default Huỷ. Confirm thì re-run sync trên fresh doc rồi save; Cancel/timeout thì flag giữ OFF, không save gì **nhưng `lastAutoManageAttemptAt` vẫn được stamp** - probe HTTP đã tốn bible quota, cooldown phải phản ánh điều đó (không thì user spam `on` + Huỷ bypass được 5-min cooldown).",
      "• **Per-user sync throttle**: 5 phút cooldown + in-flight guard. `action:sync` spam → reject ephemeral với remaining time (tránh N-roster × M-char HTTP calls dội bible). `action:on` đang in-flight thì reject; đang cooldown thì vẫn flip flag nhưng skip cả probe lẫn sync, báo user chờ X phút rồi gõ `sync` sau.",
      "• **Dynamic action dropdown**: dropdown autocomplete hide option dư thừa theo state - đang ON thì không show `on`, đang OFF thì không show `off`. Typed-paste `on`/`off` khi redundant → ephemeral reject. Action lạ (paste arbitrary string không thuộc `on/off/sync/status`) → ephemeral reject ngay đầu handler, không fall-through Discord-timeout.",
      "• **Phase 2 - auto-sync piggyback vào `/raid-status`**: khi `autoManageEnabled = true` + cooldown 5 phút cho phép, mỗi lần user gõ `/raid-status` Artist sẽ pull bible logs **song song** với roster refresh (Promise.all, share `bibleLimiter`) trước khi render embed. Reuse cùng `acquireAutoManageSyncSlot` nên spam `/raid-status` không spam bible. Race-safe: re-check `autoManageEnabled` trên fresh doc trong `saveWithRetry`, nếu user bấm `action:off` giữa gather và save → skip apply nhưng vẫn stamp `lastAutoManageAttemptAt` (bible quota đã tốn). Save fail (mongo blip) → catch stamp attempt qua `stampAutoManageAttempt` để cooldown vẫn kick in. Cooldown chưa hết / in-flight → render cached, silent skip. Gather throw (Cloudflare/timeout) → swallow + log + render cached, không vỡ `/raid-status`.",
      "• **Phase 3 - 24h passive auto-sync background scheduler**: opted-in user nào chưa sync trong 24h sẽ được background tick (mỗi 30 phút) tự pull bible logs, batch tối đa **3 user/tick** sort theo `lastAutoManageAttemptAt` ascending (chứ KHÔNG phải `lastAutoManageSyncAt`) - đảm bảo stuck user (perma-fail Cloudflare/private log) không monopolize batch forever, mọi user đều có rotation fair. Reuse cùng `acquireAutoManageSyncSlot` nên không double-fire với Phase 2 piggyback / manual `action:sync`. Filter ở DB level (`lastAutoManageSyncAt < now - 24h`) → user active đã sync gần đây tự bypass tick. **Tick overlap guard**: nếu tick trước chưa xong khi 30 phút mới đến (bible outage worst case), tick mới skip để không double traffic. **Summary log honesty**: tick log split 4 bucket (`synced` / `attempted-only` / `skipped` / `failed`) - chỉ count `synced` khi có ≥1 char success, tránh false-positive metric. **Killswitch**: env `AUTO_MANAGE_DAILY_DISABLED=true` skip mọi tick - flip nhanh nếu bible block, không cần redeploy. Bible HTTP load: batch 3 × 5 chars × ~6 HTTP avg = ~90 HTTP/tick max, spread qua 48 ticks/day cover được ~144 user-syncs/day capacity.",
    ],
  },
];

function buildHelpOverviewEmbed() {
  const embed = new EmbedBuilder()
    .setTitle("🎯 Raid Management Bot - Help")
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
      return `${req} \`${opt.name}\` - ${opt.desc}`;
    });
    addChunkedHelpField(embed, "Options", optionLines.join("\n"));
  } else {
    embed.addFields({ name: "Options", value: "_No options_", inline: false });
  }

  embed.addFields({ name: "Example", value: `\`${section.example}\``, inline: false });
  addChunkedHelpField(embed, "Notes", section.notes.join("\n"));

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
      // Walk the remaining characters for the first name that does NOT
      // collide with another account's accountName - roster autocomplete
      // and removal key off accountName as a per-user unique identifier,
      // so avoiding collision here preserves that invariant.
      for (const candidate of account.characters) {
        const fallbackName = getCharacterName(candidate);
        if (!fallbackName) continue;
        const normalizedFallback = normalizeName(fallbackName);
        const collides = userDoc.accounts.some(
          (other) => other !== account && normalizeName(other.accountName) === normalizedFallback
        );
        if (collides) continue;
        account.accountName = fallbackName;
        reseededTo = fallbackName;
        break;
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
    return;
  }

  if (interaction.commandName === "raid-channel") {
    await handleRaidChannelCommand(interaction);
    return;
  }

  if (interaction.commandName === "raid-auto-manage") {
    await handleRaidAutoManageCommand(interaction);
  }
}

// ---------------------------------------------------------------------------
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

function getMissingBotChannelPermissions(channel, botMember) {
  if (!channel || !botMember) return BOT_CHANNEL_PERMS.map((p) => p.label);
  const perms = channel.permissionsFor(botMember);
  if (!perms) return BOT_CHANNEL_PERMS.map((p) => p.label);
  return BOT_CHANNEL_PERMS.filter((p) => !perms.has(p.flag)).map((p) => p.label);
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
  ["nm",        "nightmare"],
  ["hard",      "hard"],
  ["normal",    "normal"],
  ["nor",       "normal"],
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
 * Difficulty aliases: normal / nor · hard · nightmare / nm
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
    .setTitle(`🦊 Chào các bạn~ Artist ngồi trông channel này nhé`)
    .setDescription(
      [
        "Mỗi lần clear raid xong, cứ post 1 tin nhắn ngắn dạng `<raid> <difficulty> <character[, character2, ...]> [gate]` vào đây là Artist sẽ tự đánh dấu progress giúp cậu, xong tớ dọn luôn tin nhắn cho channel khỏi rối nha~",
        "",
        "**Artist chỉ update được character trong roster của chính bạn thôi đấy.** Chưa có roster? Chạy `/add-roster` trước rồi hẵng post clear nhé. Muốn xem lại tiến độ của mình, dùng `/raid-status`.",
      ].join("\n")
    )
    .addFields(
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
          "**Difficulty**: `normal` / `nor` · `hard` · `nightmare` / `nm`",
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
          "• Post đúng → Artist DM bạn embed confirm riêng. Nếu DM bị tắt, tớ sẽ ping public ngắn rồi tự xóa sau 15 giây.",
          "• Post 1 raid đã clear từ trước → tớ DM notice riêng báo đã DONE rồi, không update lại. Tránh overwrite progress tuần này. Muốn reset thật sự thì dùng `/raid-set` với `status:reset`.",
          "• Post cách nhau ít nhất **2 giây** nha~ Spam nhanh quá tớ sẽ im lặng bỏ qua và nhắc khéo 1 lần.",
        ].join("\n"),
      },
      {
        name: "🤖 Lười post? Bật `/raid-auto-manage` nhé",
        value: [
          "Gõ `/raid-auto-manage action:on` để tớ tự update raid progress cho cậu, không cần post thủ công nha~",
          "Nhớ bật **Public Log** cho từng char muốn sync tại <https://lostark.bible/me/logs> trước nha.",
        ].join("\n"),
      }
    )
    .setFooter({ text: "Muốn xem full hướng dẫn tất cả commands? Gõ /raid-help nhé~" });
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
  if (!message.content || !message.content.trim()) return;

  // Cache lookup - no Mongo hit on the hot path. Miss means no config or
  // this channel isn't the configured monitor.
  const cachedChannelId = getCachedMonitorChannelId(message.guildId);
  if (!cachedChannelId || cachedChannelId !== message.channelId) return;

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
    let whisperMsg = null;
    if (dmSucceeded) {
      try {
        whisperMsg = await message.channel.send({
          content: `*thì thầm* <@${message.author.id}> ...Artist nhận được rồi nha~ Chờ Artist 5 giây gửi kết quả qua DM cho cậu nhé...`,
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
    const pinned = await channel.messages.fetchPinned();
    for (const [, msg] of pinned) {
      if (msg.author?.id !== botUserId) continue;
      const title = msg.embeds?.[0]?.title || "";
      // Welcome title signature is stable across versions (kitsune +
      // "Artist ngồi trông channel này"). Match loose enough to survive
      // minor wording tweaks but specific enough to miss other bot pins.
      if (title.includes("Artist ngồi trông channel này")) {
        staleIds.add(msg.id);
      }
    }
  } catch (err) {
    console.warn("[raid-channel] fetchPinned for stale-welcome scan failed:", err?.message || err);
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

// ---------------------------------------------------------------------------
// /raid-auto-manage - lostark.bible clear-log sync
// ---------------------------------------------------------------------------

// Per-user throttle for /raid-auto-manage sync runs. bibleLimiter already
// caps concurrency across the whole process, but a single user spamming
// action:sync still queues N-roster × M-char HTTP calls each time. Two
// guards combine: in-flight Set rejects parallel runs, cooldown rejects
// rapid-sequential runs within 5 min based on User.lastAutoManageAttemptAt
// (which is already stamped on every sync attempt, success or not).
const AUTO_MANAGE_SYNC_COOLDOWN_MS = 5 * 60 * 1000;
const inFlightAutoManageSyncs = new Set(); // discordId

/**
 * Atomically claim a sync slot for this user. The slot is reserved
 * BEFORE any `await` so two concurrent interactions racing into this
 * function can't both observe an empty Set - exactly one gets in-flight
 * acquired, the other gets `in-flight` reject. If the DB cooldown check
 * rejects, the slot is released before returning so `on`'s "flip flag
 * only" path doesn't block future sync attempts.
 *
 * Caller contract:
 *   - `acquired: true`  → caller MUST releaseAutoManageSyncSlot() in finally.
 *   - `acquired: false` → slot is NOT held; caller must not release.
 */
async function acquireAutoManageSyncSlot(discordId) {
  if (inFlightAutoManageSyncs.has(discordId)) {
    return { acquired: false, reason: "in-flight" };
  }
  // Reserve synchronously - this is the TOCTOU-safe step. Any second
  // caller that reaches this function before we release will see the
  // Set populated and reject.
  inFlightAutoManageSyncs.add(discordId);
  try {
    const user = await User.findOne(
      { discordId },
      { lastAutoManageAttemptAt: 1 }
    ).lean();
    const lastAttempt = user?.lastAutoManageAttemptAt || 0;
    const elapsed = Date.now() - lastAttempt;
    if (lastAttempt && elapsed < AUTO_MANAGE_SYNC_COOLDOWN_MS) {
      inFlightAutoManageSyncs.delete(discordId);
      return {
        acquired: false,
        reason: "cooldown",
        remainingMs: AUTO_MANAGE_SYNC_COOLDOWN_MS - elapsed,
      };
    }
    return { acquired: true };
  } catch (err) {
    // DB blip - release so the user isn't permanently stuck in the Set.
    inFlightAutoManageSyncs.delete(discordId);
    throw err;
  }
}

function releaseAutoManageSyncSlot(discordId) {
  inFlightAutoManageSyncs.delete(discordId);
}

function formatAutoManageCooldownRemaining(remainingMs) {
  const secs = Math.max(1, Math.ceil(remainingMs / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs - mins * 60;
  return rem > 0 ? `${mins}m${rem}s` : `${mins}m`;
}

/**
 * Fetch a character's lostark.bible identifiers (serial / cid / rid) by
 * loading their roster page and regex-extracting the SSR SvelteKit bootstrap
 * data. These IDs are required to call the logs API but only need to be
 * fetched once per character - caller caches them on the character doc.
 */
async function fetchBibleCharacterMeta(charName) {
  const url = `https://lostark.bible/character/NA/${encodeURIComponent(charName)}/roster`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; LostArkRaidManageBot/1.0)",
      Accept: "text/html",
    },
    // Timeout guards against bible hanging the connection: without it, a
    // stuck fetch holds the `bibleLimiter` slot AND the caller's
    // `inFlightAutoManageSyncs` guard indefinitely, making the user appear
    // "stuck in sync" with no way to recover. Same 15s budget as
    // /add-roster's roster scrape.
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`Bible roster page returned HTTP ${res.status} for "${charName}"`);
  }
  const html = await res.text();
  // SSR SvelteKit bootstrap data: {header:{id:<cid>,sn:"<serial>",rid:<rid>,...}}
  const match = html.match(/header:\{id:(\d+),sn:"([^"]+)",rid:(\d+)/);
  if (!match) {
    throw new Error(`Could not parse bible metadata for "${charName}" (page shape changed?)`);
  }
  return { cid: Number(match[1]), sn: match[2], rid: Number(match[3]) };
}

/**
 * Call lostark.bible's logs REST API. Returns the raw array of log entries
 * (max 25 per page). Each entry shape: { id, name, boss, difficulty, dps,
 * class, spec, gearScore, combatPower, percentile, duration, timestamp,
 * isBus, isDead }.
 */
async function fetchBibleCharacterLogs({ serial, cid, rid, className, page = 1 }) {
  const url = "https://lostark.bible/api/character/logs";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; LostArkRaidManageBot/1.0)",
    },
    body: JSON.stringify({
      region: "NA",
      characterSerial: serial,
      className,
      cid,
      rid,
      page,
    }),
    // See fetchBibleCharacterMeta - same hang-protection rationale.
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    // Read body so callers can distinguish "Logs not enabled" (private char,
    // user action fixes it) from Cloudflare/block 403s (bot-infra issue, user
    // bật Public Log cũng không cứu được). See reference_bible_api.md.
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      bodyText = "";
    }
    const snippet = bodyText ? ` - ${bodyText.slice(0, 200).replace(/\s+/g, " ").trim()}` : "";
    const err = new Error(`Bible logs API returned HTTP ${res.status}${snippet}`);
    err.status = res.status;
    err.bodyText = bodyText;
    throw err;
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchBibleLogsWithLimiter({ serial, cid, rid, className, page = 1 }) {
  return bibleLimiter.run(() => fetchBibleCharacterLogs({ serial, cid, rid, className, page }));
}

// Route the meta HTML scrape through the same limiter the logs API uses so a
// cold-cache sync (N chars, each needing both meta + logs) can't double
// bible's effective concurrency - max 2 in-flight across both endpoints
// combined, matching the UX promise in HELP_SECTIONS.
async function fetchBibleCharacterMetaWithLimiter(charName) {
  return bibleLimiter.run(() => fetchBibleCharacterMeta(charName));
}

/**
 * Paginate bible's logs API until we see an entry older than
 * `weekResetStart`, get an empty page, or hit `maxPages`. Bible returns
 * newest-first with 25 entries per page, so one pre-reset entry in a
 * page means every deeper page is irrelevant. Keeps us from missing
 * clears when a char has > 25 weekly-relevant log rows (practice runs,
 * multi-account sharing etc).
 */
async function fetchBibleLogsSinceWeekReset({ serial, cid, rid, className, weekResetStart, maxPages = 10 }) {
  const all = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const logs = await fetchBibleLogsWithLimiter({ serial, cid, rid, className, page });
    if (!Array.isArray(logs) || logs.length === 0) break;
    all.push(...logs);
    // If any log in this page is before the reset boundary, deeper
    // pages only contain older entries - stop early.
    const hasPreReset = logs.some((l) => Number(l?.timestamp) < weekResetStart);
    if (hasPreReset) break;
    // Partial page = last page bible has.
    if (logs.length < 25) break;
  }
  return all;
}

function normalizeDifficultyToModeKey(difficulty) {
  const normalized = normalizeName(difficulty || "");
  if (normalized === "nightmare") return "nightmare";
  if (normalized === "hard") return "hard";
  if (normalized === "normal") return "normal";
  return null;
}

/**
 * Given a character doc + array of bible log entries + the current week's
 * reset boundary, mutate `character.assignedRaids` in place to reflect
 * every clear that: (a) belongs to a raid in RAID_REQUIREMENTS, (b)
 * happened at-or-after the week-reset, (c) maps to a known boss via
 * `getRaidGateForBoss`. Returns an array of applied updates for the
 * caller to build a confirmation embed.
 */
function reconcileCharacterFromLogs(character, logs, weekResetStart) {
  const applied = [];
  if (!Array.isArray(logs) || logs.length === 0) return applied;

  const assignedRaids = ensureAssignedRaids(character);

  // Bible returns newest-first. Process oldest-first so mode-switch
  // wipes always use the *latest* mode as source of truth. Without this,
  // an older Serca Hard clear could wipe a newer Nightmare clear simply
  // because it appears later in the API's newest-first stream.
  const sortedLogs = [...logs].sort(
    (a, b) => (Number(a?.timestamp) || 0) - (Number(b?.timestamp) || 0)
  );

  for (const log of sortedLogs) {
    const ts = Number(log?.timestamp);
    if (!(ts >= weekResetStart)) continue;

    const mapping = getRaidGateForBoss(log.boss);
    if (!mapping) continue;

    const modeKey = normalizeDifficultyToModeKey(log.difficulty);
    if (!modeKey) continue;

    const raidMeta = RAID_REQUIREMENT_MAP[`${mapping.raidKey}_${modeKey}`];
    if (!raidMeta) continue; // e.g. Kazeros Nightmare if we ever see it but don't track it

    const difficultyLabel = toModeLabel(modeKey);
    const normalizedSelectedDiff = normalizeName(difficultyLabel);

    // Normalize existing raid data + detect mode mismatch (if user cleared
    // Serca Hard earlier but bible also logs a Nightmare clear this week,
    // bible is the source of truth - let the latest-mode win by wiping
    // the raid before writing the new gate).
    const existingRaid = normalizeAssignedRaid(
      assignedRaids[mapping.raidKey] || {},
      difficultyLabel,
      mapping.raidKey
    );

    let modeChange = false;
    for (const g of getGatesForRaid(mapping.raidKey)) {
      const existingDiff = existingRaid[g]?.difficulty;
      if (existingDiff && normalizeName(existingDiff) !== normalizedSelectedDiff) {
        modeChange = true;
        break;
      }
    }
    if (modeChange) {
      for (const g of getGatesForRaid(mapping.raidKey)) {
        existingRaid[g] = { difficulty: difficultyLabel, completedDate: undefined };
      }
    }

    // Only advance completedDate if we don't already have a later clear
    // for this gate. Bible sometimes shows multiple clears per week on
    // the same boss (e.g. practice runs) - latest-ts wins.
    const priorTs = Number(existingRaid[mapping.gate]?.completedDate) || 0;
    if (ts > priorTs) {
      existingRaid[mapping.gate] = {
        difficulty: difficultyLabel,
        completedDate: ts,
      };
      applied.push({
        raidKey: mapping.raidKey,
        raidLabel: raidMeta.label,
        gate: mapping.gate,
        modeKey,
        difficulty: difficultyLabel,
        timestamp: ts,
        boss: log.boss,
      });
    }

    assignedRaids[mapping.raidKey] = existingRaid;
  }

  character.assignedRaids = assignedRaids;
  return applied;
}

/**
 * Build the identity key used to match a gathered entry back to its
 * character in the apply phase. Composite of normalized accountName +
 * normalized charName so two same-name chars across different rosters
 * (e.g. "Clauseduk" in roster A and a separate "Clauseduk" in roster B)
 * don't collide in the apply-side Map and swap logs. We can't rely on
 * `character.id` alone - backfill only runs through `/raid-set`, so users
 * who only use `/raid-auto-manage` or text posts may have chars with no
 * id yet. `\x1f` (ASCII Unit Separator) is a control char that cannot
 * appear in Lost Ark character names.
 */
function autoManageEntryKey(accountName, charName) {
  return normalizeName(accountName) + "\x1f" + normalizeName(charName);
}

/**
 * Gather phase: fetch bible meta (if not cached) + logs for every char in
 * the roster WITHOUT mutating the doc. Returns an array keyed by the
 * composite account+char identity that `applyAutoManageCollected` can apply
 * to any fresh doc. Split from the monolithic sync so `commitAutoManageOn`
 * can run the bible I/O ONCE, outside saveWithRetry - VersionError retries
 * then skip the I/O and only re-run the in-memory apply.
 */
async function gatherAutoManageLogsForUserDoc(userDoc, weekResetStart) {
  const collected = [];
  for (const account of userDoc.accounts || []) {
    for (const character of account.characters || []) {
      const charName = getCharacterName(character);
      const entry = {
        accountName: account.accountName,
        charName,
        // Composite key: accountName + charName. See autoManageEntryKey
        // jsdoc for why charName alone is insufficient.
        entryKey: autoManageEntryKey(account.accountName, charName),
        className: getCharacterClass(character),
        // `meta` is only set when the char wasn't already cached -
        // apply phase propagates this into the fresh doc's character.
        meta: null,
        logs: null,
        error: null,
      };
      try {
        let serial = character.bibleSerial;
        let cid = character.bibleCid;
        let rid = character.bibleRid;
        if (!serial || !cid || !rid) {
          const meta = await fetchBibleCharacterMetaWithLimiter(entry.charName);
          serial = meta.sn;
          cid = meta.cid;
          rid = meta.rid;
          entry.meta = { sn: serial, cid, rid };
        }
        entry.logs = await fetchBibleLogsSinceWeekReset({
          serial,
          cid,
          rid,
          className: entry.className,
          weekResetStart,
        });
      } catch (err) {
        entry.error = err?.message || String(err);
        console.warn(
          `[auto-manage] gather for ${entry.charName} failed:`,
          err?.message || err
        );
      }
      collected.push(entry);
    }
  }
  return collected;
}

/**
 * Apply phase: pure in-memory mutation - take pre-gathered per-char data
 * and reconcile against a (possibly-just-re-fetched) user doc. NO I/O.
 * Safe to call multiple times under saveWithRetry.
 */
function applyAutoManageCollected(userDoc, weekResetStart, collected) {
  const report = { appliedTotal: 0, perChar: [] };
  // Key by composite account+char identity so same-name chars across
  // different rosters don't collide. See autoManageEntryKey jsdoc.
  const byKey = new Map(collected.map((c) => [c.entryKey, c]));

  for (const account of userDoc.accounts || []) {
    for (const character of account.characters || []) {
      const charName = getCharacterName(character);
      const entry = {
        accountName: account.accountName,
        charName,
        className: getCharacterClass(character),
        applied: [],
        error: null,
      };
      const gathered = byKey.get(autoManageEntryKey(account.accountName, charName));
      if (!gathered) {
        // Char was added between gather and apply (e.g. concurrent
        // /add-roster-char). Skip silently - next /raid-auto-manage run
        // will pick it up.
        continue;
      }
      if (gathered.error) {
        entry.error = gathered.error;
        report.perChar.push(entry);
        continue;
      }
      try {
        if (gathered.meta) {
          character.bibleSerial = gathered.meta.sn;
          character.bibleCid = gathered.meta.cid;
          character.bibleRid = gathered.meta.rid;
        }
        const applied = reconcileCharacterFromLogs(
          character,
          gathered.logs || [],
          weekResetStart
        );
        entry.applied = applied;
        report.appliedTotal += applied.length;
      } catch (err) {
        entry.error = err?.message || String(err);
        console.warn(
          `[auto-manage] apply for ${charName} failed:`,
          err?.message || err
        );
      }
      report.perChar.push(entry);
    }
  }

  return report;
}

/**
 * Convenience wrapper preserved for the probe path (no-save, single-pass
 * in-memory sim) and /raid-auto-manage action:sync (which also wraps with
 * saveWithRetry + gather-outside via its caller). Composes gather + apply
 * against the SAME doc.
 */
async function syncAutoManageForUserDoc(userDoc, weekResetStart) {
  const collected = await gatherAutoManageLogsForUserDoc(userDoc, weekResetStart);
  return applyAutoManageCollected(userDoc, weekResetStart, collected);
}

async function handleRaidAutoManageCommand(interaction) {
  const discordId = interaction.user.id;
  const action = interaction.options.getString("action", true);

  // Autocomplete only offers on/off/sync/status, but users can paste
  // arbitrary strings into slash command args. Reject early with a
  // specific hint - otherwise a typo falls through every branch and
  // Discord times out the interaction with no reply.
  if (!["on", "off", "sync", "status"].includes(action)) {
    await interaction.reply({
      content: `${UI.icons.warn} Action không hợp lệ: \`${action}\`. Chọn một trong \`on\` · \`off\` · \`sync\` · \`status\` (autocomplete sẽ gợi ý đúng).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Redundant-state reject for manually-typed `on`/`off` (autocomplete
  // already hides the redundant option, but users can paste the full
  // option value). Cheap lean read gates both branches with one query.
  if (action === "on" || action === "off") {
    const stateUser = await User.findOne(
      { discordId },
      { autoManageEnabled: 1 }
    ).lean();
    const enabled = !!stateUser?.autoManageEnabled;
    if (action === "on" && enabled) {
      await interaction.reply({
        content: `${UI.icons.info} Auto-manage đang bật rồi. Dùng \`/raid-auto-manage action:sync\` để sync ngay, hoặc \`action:status\` để xem trạng thái.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (action === "off" && !enabled) {
      await interaction.reply({
        content: `${UI.icons.info} Auto-manage đang tắt sẵn rồi - không có gì để disable nữa.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  if (action === "off") {
    await User.findOneAndUpdate(
      { discordId },
      { $set: { autoManageEnabled: false } },
      { upsert: true, setDefaultsOnInsert: true }
    );
    const embed = new EmbedBuilder()
      .setColor(UI.colors.muted)
      .setTitle(`${UI.icons.reset} Auto-manage disabled`)
      .setDescription(
        "Auto-manage đã tắt. Cậu vẫn có thể trigger sync thủ công qua `/raid-auto-manage action:sync` bất cứ lúc nào."
      )
      .setTimestamp();
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === "on") {
    // Two-phase enable flow:
    //   Phase A (probe): fetch user, run sync in-memory WITHOUT saving.
    //     Tell us which chars return "403 / logs not enabled" before we
    //     flip anything.
    //   Phase B (commit): re-run sync on a fresh doc inside saveWithRetry
    //     and persist. Runs either immediately (no hidden chars) or after
    //     the user clicks "Vẫn bật" on the warning.
    //
    // If phase A finds any hidden-log chars → show a warning with confirm
    // / cancel buttons. 60s collector, invoker-scoped. Cancel or timeout →
    // flag stays OFF, nothing saved.
    //
    // Guard semantics for `on` (preserved from earlier rounds):
    //   - in-flight  → reject hard.
    //   - cooldown   → flip flag only, skip both probe and sync.
    const guard = await acquireAutoManageSyncSlot(discordId);
    if (!guard.acquired && guard.reason === "in-flight") {
      await interaction.reply({
        content: `${UI.icons.info} Một sync khác đang chạy cho cậu rồi - đợi nó xong rồi mới bật nhé.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const cooldownSkip = !guard.acquired && guard.reason === "cooldown";
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      // --- Cooldown path: flip flag only, skip sync ---
      if (cooldownSkip) {
        await saveWithRetry(async () => {
          const userDoc = await User.findOne({ discordId });
          if (!userDoc) {
            await User.findOneAndUpdate(
              { discordId },
              { $set: { autoManageEnabled: true } },
              { upsert: true, setDefaultsOnInsert: true }
            );
            return;
          }
          userDoc.autoManageEnabled = true;
          await userDoc.save();
        });
        const embed = new EmbedBuilder()
          .setColor(UI.colors.success)
          .setTitle(`${UI.icons.done} Auto-manage enabled (sync skipped)`)
          .setDescription(
            `Flag đã bật. Sync vừa chạy gần đây nên tớ bỏ qua initial sync lần này - đợi **${formatAutoManageCooldownRemaining(
              guard.remainingMs
            )}** rồi gõ \`/raid-auto-manage action:sync\` để pull log mới nhất.`
          )
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // --- Phase A: probe (no save) ---
      const weekResetStart = weekResetStartMs();
      const probeDoc = await User.findOne({ discordId });

      // No user doc at all - flag flip only, show no-roster embed.
      if (!probeDoc) {
        await User.findOneAndUpdate(
          { discordId },
          { $set: { autoManageEnabled: true } },
          { upsert: true, setDefaultsOnInsert: true }
        );
        const embed = new EmbedBuilder()
          .setColor(UI.colors.success)
          .setTitle(`${UI.icons.done} Auto-manage enabled`)
          .setDescription(
            "Đã bật auto-manage. Chưa có roster nên tớ chưa sync được gì - chạy `/add-roster` trước rồi gọi `/raid-auto-manage action:sync` để pull logs."
          )
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // Roster empty - flag flip only.
      if (!Array.isArray(probeDoc.accounts) || probeDoc.accounts.length === 0) {
        probeDoc.autoManageEnabled = true;
        await probeDoc.save();
        const embed = new EmbedBuilder()
          .setColor(UI.colors.success)
          .setTitle(`${UI.icons.done} Auto-manage enabled`)
          .setDescription(
            "Đã bật auto-manage. Chưa có roster nên tớ chưa sync được gì - chạy `/add-roster` trước rồi gọi `/raid-auto-manage action:sync` để pull logs."
          )
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // Run gather + in-memory apply - DO NOT save probeDoc. Keep the
      // `collected` array so commit can reuse it without a second bible
      // run (previously probe + commit = 2× HTTP cost; now it's 1×).
      ensureFreshWeek(probeDoc);
      const probeCollected = await gatherAutoManageLogsForUserDoc(probeDoc, weekResetStart);
      const probeReport = applyAutoManageCollected(probeDoc, weekResetStart, probeCollected);
      const hiddenChars = (probeReport?.perChar || []).filter((c) =>
        isPublicLogDisabledError(c?.error)
      );

      // --- Direct commit path: no hidden chars found ---
      if (hiddenChars.length === 0) {
        const finalReport = await commitAutoManageOn(
          discordId,
          weekResetStart,
          probeCollected
        );
        const syncEmbed = buildAutoManageSyncReportEmbed(finalReport);
        syncEmbed.setTitle(
          `${UI.icons.done} Auto-manage enabled · initial sync ${
            (finalReport?.appliedTotal || 0) > 0 ? "complete" : "nothing to apply"
          }`
        );
        await interaction.editReply({ embeds: [syncEmbed] });
        return;
      }

      // --- Warn + confirm path: hidden chars detected ---
      const warnEmbed = buildAutoManageHiddenCharsWarningEmbed(
        hiddenChars,
        probeReport
      );
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("auto-manage:confirm-on")
          .setLabel("Vẫn bật")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("auto-manage:cancel-on")
          .setLabel("Huỷ")
          .setStyle(ButtonStyle.Secondary)
      );
      await interaction.editReply({ embeds: [warnEmbed], components: [row] });

      const replyMsg = await interaction.fetchReply();
      let decision = null;
      try {
        const btn = await replyMsg.awaitMessageComponent({
          filter: (i) =>
            i.user.id === discordId && i.customId.startsWith("auto-manage:"),
          componentType: ComponentType.Button,
          time: 60_000,
        });
        decision = btn.customId === "auto-manage:confirm-on" ? "confirm" : "cancel";
        await btn.deferUpdate().catch(() => {});
      } catch {
        decision = "timeout";
      }

      if (decision === "confirm") {
        // Reuse probeCollected so confirm doesn't re-hit bible. Data is at
        // most 60s old (collector timeout ceiling) - acceptable staleness
        // for a one-shot initial sync; next /raid-auto-manage action:sync
        // will pull fresher data under the normal cooldown.
        const finalReport = await commitAutoManageOn(
          discordId,
          weekResetStart,
          probeCollected
        );
        const syncEmbed = buildAutoManageSyncReportEmbed(finalReport);
        syncEmbed.setTitle(
          `${UI.icons.done} Auto-manage enabled · initial sync ${
            (finalReport?.appliedTotal || 0) > 0 ? "complete" : "nothing to apply"
          }`
        );
        await interaction.editReply({ embeds: [syncEmbed], components: [] });
      } else {
        // Probe HTTP already ran - stamp attempt so the cooldown reflects
        // the bible quota we consumed, even though we're not committing the
        // flag flip. Without this, spamming `action:on` + Huỷ would bypass
        // the 5-minute cooldown.
        await stampAutoManageAttempt(discordId);
        const title =
          decision === "timeout"
            ? "Auto-manage giữ OFF (timeout)"
            : "Auto-manage giữ OFF";
        const cancelEmbed = new EmbedBuilder()
          .setColor(UI.colors.muted)
          .setTitle(`${UI.icons.reset} ${title}`)
          .setDescription(
            "Không có gì thay đổi. Bật **Public Log** cho char trên <https://lostark.bible/me/logs> rồi gõ `/raid-auto-manage action:on` lại nhé."
          )
          .setTimestamp();
        await interaction.editReply({ embeds: [cancelEmbed], components: [] });
      }
    } catch (err) {
      // Same reasoning as the cancel/timeout branch: probe may have already
      // sent bible requests before the throw. Stamp so cooldown still kicks
      // in for the next attempt.
      await stampAutoManageAttempt(discordId);
      console.error("[auto-manage] enable-with-sync failed:", err?.message || err);
      await interaction.editReply({
        content: `${UI.icons.warn} Probe/sync fail: ${err?.message || err}. Auto-manage GIỮ OFF - thử lại sau.`,
        components: [],
      }).catch(() => {});
    } finally {
      if (!cooldownSkip) releaseAutoManageSyncSlot(discordId);
    }
    return;
  }

  if (action === "status") {
    const user = await User.findOne({ discordId }).lean();
    const enabled = !!user?.autoManageEnabled;
    const lastSync = user?.lastAutoManageSyncAt || 0;
    const lastAttempt = user?.lastAutoManageAttemptAt || 0;
    const embed = new EmbedBuilder()
      .setColor(UI.colors.neutral)
      .setTitle(`${UI.icons.info} Auto-manage Status`)
      .addFields(
        { name: "Opt-in", value: enabled ? `${UI.icons.done} ON` : `${UI.icons.reset} OFF`, inline: true },
        {
          name: "Last success",
          value: lastSync ? `<t:${Math.floor(lastSync / 1000)}:R>` : "Chưa có lần nào thành công",
          inline: true,
        },
        {
          name: "Last attempt",
          value: lastAttempt
            ? (lastAttempt === lastSync
                ? "(= last success)"
                : `<t:${Math.floor(lastAttempt / 1000)}:R> - fail`)
            : "Chưa chạy bao giờ",
          inline: true,
        }
      )
      .setTimestamp();
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === "sync") {
    // Acquire slot BEFORE deferReply so reply-reject is a normal reply (not editReply).
    // acquireAutoManageSyncSlot reserves the slot synchronously → no TOCTOU race between check and set.
    const guard = await acquireAutoManageSyncSlot(discordId);
    if (!guard.acquired) {
      if (guard.reason === "in-flight") {
        await interaction.reply({
          content: `${UI.icons.info} Một sync khác của cậu đang chạy rồi - đợi kết quả trước nhé, đừng gõ spam~`,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: `${UI.icons.info} Sync vừa chạy gần đây. Đợi thêm **${formatAutoManageCooldownRemaining(
            guard.remainingMs
          )}** rồi sync tiếp nhé (cooldown 5 phút để tránh gõ bible liên tục).`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const weekResetStart = weekResetStartMs();

      // Phase A: gather bible data OUTSIDE saveWithRetry so a VersionError
      // retry doesn't re-fire HTTP calls. The acquire guard already
      // prevents concurrent syncs for the same user, so the seedDoc we read
      // here is normally also the doc we save into - but /raid-set or
      // /add-roster-char could race between read and save, triggering a
      // VersionError that the retry path can handle in-memory.
      const seedDoc = await User.findOne({ discordId });
      if (!seedDoc || !Array.isArray(seedDoc.accounts) || seedDoc.accounts.length === 0) {
        await interaction.editReply({
          content: `${UI.icons.info} Cậu chưa có roster nào. Dùng \`/add-roster\` để thêm trước nhé.`,
        });
        return;
      }
      ensureFreshWeek(seedDoc);
      const collected = await gatherAutoManageLogsForUserDoc(seedDoc, weekResetStart);

      // Phase B: apply to fresh doc inside saveWithRetry - pure in-memory.
      let report;
      await saveWithRetry(async () => {
        const userDoc = await User.findOne({ discordId });
        if (!userDoc) {
          report = { noRoster: true };
          return;
        }
        if (!Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
          report = { noRoster: true };
          return;
        }
        ensureFreshWeek(userDoc);
        report = applyAutoManageCollected(userDoc, weekResetStart, collected);
        const now = Date.now();
        userDoc.lastAutoManageAttemptAt = now;
        if (report.perChar.some((c) => !c.error)) {
          userDoc.lastAutoManageSyncAt = now;
        }
        await userDoc.save();
      });

      if (report?.noRoster) {
        await interaction.editReply({
          content: `${UI.icons.info} Cậu chưa có roster nào. Dùng \`/add-roster\` để thêm trước nhé.`,
        });
        return;
      }

      const embed = buildAutoManageSyncReportEmbed(report);
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error("[auto-manage] sync failed:", err?.message || err);
      await interaction.editReply({
        content: `${UI.icons.warn} Sync fail: ${err?.message || err}. Check lostark.bible có block (Cloudflare) hoặc char names có đúng không.`,
      });
    } finally {
      releaseAutoManageSyncSlot(discordId);
    }
  }
}

/**
 * Stamp `lastAutoManageAttemptAt` without flipping any flag. Called after the
 * probe HTTP burst in cancel/timeout/error paths so the cooldown reflects
 * bible quota actually consumed - otherwise users can spam
 * `/raid-auto-manage action:on` + cancel to bypass the 5-min cooldown.
 * Best-effort: logs and swallows DB errors so cooldown drift never masks the
 * real UX (the cancel/error message itself).
 */
async function stampAutoManageAttempt(discordId) {
  try {
    await User.updateOne(
      { discordId },
      { $set: { lastAutoManageAttemptAt: Date.now() } }
    );
  } catch (err) {
    console.warn(
      "[auto-manage] stamp attempt failed:",
      err?.message || err
    );
  }
}

function isPublicLogDisabledError(err) {
  if (!err) return false;
  // Must match the bible-specific body ("Logs not enabled") - generic 403 is
  // ambiguous (Cloudflare / rate-limit / IP block all return 403 too) and
  // bật Public Log sẽ KHÔNG fix được Cloudflare, nên misclassify sẽ làm user
  // lạc hướng. Body text confirmed in reference_bible_api.md.
  const msg = String(err);
  return /logs\s*not\s*enabled/i.test(msg);
}

/**
 * Commit the "auto-manage on" transition: flip the flag, apply fresh
 * bible sync data against a re-fetched User doc, stamp
 * lastAutoManageAttemptAt (and lastAutoManageSyncAt if any char fetched
 * without error), save.
 *
 * Bible I/O runs in a gather phase OUTSIDE `saveWithRetry` so a VersionError
 * during save doesn't re-fire HTTP calls - the apply phase inside the retry
 * loop is pure in-memory mutation. Pre-gathered data from the probe phase
 * can be passed via `preCollected` to avoid the second (commit-phase) bible
 * run; when omitted, commit gathers on its own.
 *
 * Returns the sync report so the caller can render it. Safe to call under
 * an acquired sync slot - it only does findOne/save cycles and does not
 * re-acquire the slot.
 */
async function commitAutoManageOn(discordId, weekResetStart, preCollected = null) {
  let collected = preCollected;
  if (!collected) {
    const seedDoc = await User.findOne({ discordId });
    if (!seedDoc) return undefined;
    if (!Array.isArray(seedDoc.accounts) || seedDoc.accounts.length === 0) {
      // No roster - flip flag only, no bible to hit.
      await User.findOneAndUpdate(
        { discordId },
        { $set: { autoManageEnabled: true, lastAutoManageAttemptAt: Date.now() } },
        { upsert: true, setDefaultsOnInsert: true }
      );
      return { appliedTotal: 0, perChar: [] };
    }
    ensureFreshWeek(seedDoc);
    collected = await gatherAutoManageLogsForUserDoc(seedDoc, weekResetStart);
  }

  let finalReport;
  await saveWithRetry(async () => {
    const fresh = await User.findOne({ discordId });
    if (!fresh) return;
    fresh.autoManageEnabled = true;
    if (!Array.isArray(fresh.accounts) || fresh.accounts.length === 0) {
      fresh.lastAutoManageAttemptAt = Date.now();
      await fresh.save();
      return;
    }
    ensureFreshWeek(fresh);
    finalReport = applyAutoManageCollected(fresh, weekResetStart, collected);
    const now = Date.now();
    fresh.lastAutoManageAttemptAt = now;
    if (finalReport.perChar.some((c) => !c.error)) {
      fresh.lastAutoManageSyncAt = now;
    }
    await fresh.save();
  });
  return finalReport;
}

function buildAutoManageHiddenCharsWarningEmbed(hiddenChars, probeReport) {
  const visibleApplied = (probeReport?.perChar || []).filter(
    (c) => !c.error && Array.isArray(c.applied) && c.applied.length > 0
  );
  const lines = hiddenChars.slice(0, 20).map((c) => `• **${c.charName || "?"}**`);
  const extra = hiddenChars.length > 20 ? `\n• …và ${hiddenChars.length - 20} char khác` : "";

  const description = [
    `**${hiddenChars.length}/${(probeReport?.perChar || []).length}** char chưa bật **Public Log** trên <https://lostark.bible/me/logs>. Artist sẽ **bỏ qua** các char đó khi sync.`,
    "",
    "**Char bị skip:**",
    `${lines.join("\n")}${extra}`,
  ].join("\n");

  const embed = new EmbedBuilder()
    .setColor(UI.colors.progress)
    .setTitle(`${UI.icons.warn} Một vài char chưa bật Public Log`)
    .setDescription(description)
    .setTimestamp();

  if (visibleApplied.length > 0) {
    embed.addFields({
      name: "🟢 Các char sẽ sync được",
      value: visibleApplied
        .slice(0, 10)
        .map((c) => `• **${c.charName}** · ${c.applied.length} raid/gate`)
        .join("\n") +
        (visibleApplied.length > 10 ? `\n• …và ${visibleApplied.length - 10} char khác` : ""),
      inline: false,
    });
  }

  embed.addFields({
    name: "Lựa chọn",
    value: [
      "**Vẫn bật** - Artist bật auto-manage và sync các char visible (bỏ qua char private).",
      "**Huỷ** - giữ OFF. Bật Public Log cho chars cần sync rồi quay lại.",
      "_60s không bấm → mặc định Huỷ._",
    ].join("\n"),
    inline: false,
  });

  return embed;
}

function buildAutoManageSyncReportEmbed(report) {
  const appliedTotal = report?.appliedTotal || 0;
  const perChar = Array.isArray(report?.perChar) ? report.perChar : [];
  const errored = perChar.filter((c) => c.error);
  const withApplied = perChar.filter((c) => c.applied.length > 0);
  const allFailed = perChar.length > 0 && errored.length === perChar.length;

  // Three-state description so the user never sees "DB đã match" stapled
  // to a Fail field - ambiguous and looked like a bug in Codex review.
  let description;
  if (appliedTotal > 0) {
    description = `Đã update **${appliedTotal}** gate clear từ lostark.bible logs nha~ 🦊`;
    if (errored.length > 0) {
      description += `\n${UI.icons.warn} ${errored.length} char fail sync - chi tiết bên dưới.`;
    }
  } else if (allFailed) {
    description = `Không apply được gate nào vì **tất cả ${errored.length} char fail** sync. Check Cloudflare / "Logs not enabled" / char name bên dưới.`;
  } else if (errored.length > 0) {
    description = `Không có gate clear mới nào để apply. ${UI.icons.warn} ${errored.length}/${perChar.length} char fail - các char còn lại đã match DB.`;
  } else {
    description = `Không có gate clear mới nào để sync. Data DB đã match với bible logs tuần này.`;
  }

  const embed = new EmbedBuilder()
    .setColor(
      appliedTotal > 0
        ? UI.colors.success
        : allFailed
          ? UI.colors.progress
          : UI.colors.neutral
    )
    .setTitle(`${appliedTotal > 0 ? UI.icons.done : UI.icons.info} Auto-manage Sync`)
    .setDescription(description)
    .setTimestamp();

  for (const c of withApplied.slice(0, 10)) {
    const lines = c.applied.map(
      (a) => `• **${a.raidLabel}** \`${a.gate}\` (${a.difficulty})`
    );
    embed.addFields({
      name: `${UI.icons.done} ${c.charName} (${c.accountName})`,
      value: lines.join("\n"),
      inline: false,
    });
  }
  if (withApplied.length > 10) {
    embed.addFields({
      name: "… và thêm nhiều char khác",
      value: `${withApplied.length - 10} char khác cũng có update - xem \`/raid-status\` để thấy đủ.`,
    });
  }

  if (errored.length > 0) {
    // Per-line hard cap so one HTML-heavy Cloudflare 403 body (fetch now
    // embeds up to 200 chars of response body into err.message) can't blow
    // past Discord's 1024-char field limit on its own. addChunkedHelpField
    // below handles the aggregate case (many errors) by splitting into
    // continuation fields.
    const MAX_ERROR_LINE = 180;
    const DISPLAY_LIMIT = 10;
    const lines = errored.slice(0, DISPLAY_LIMIT).map((c) => {
      const raw = `\`${c.charName}\`: ${c.error}`;
      return raw.length > MAX_ERROR_LINE
        ? `${raw.slice(0, MAX_ERROR_LINE - 1)}…`
        : raw;
    });
    if (errored.length > DISPLAY_LIMIT) {
      lines.push(`_… và ${errored.length - DISPLAY_LIMIT} char khác fail - check bot logs cho full error._`);
    }
    addChunkedHelpField(
      embed,
      `${UI.icons.warn} Fail (${errored.length})`,
      lines.join("\n")
    );
  }

  return embed;
}

function weekResetStartMs(now = new Date()) {
  // Inverse of getTargetCleanupDayKey-ish logic: find the most recent
  // weekly-reset boundary that has passed - **5h chiều thứ 4 giờ Việt Nam**
  // (17:00 VN = 10:00 UTC, UTC+7). Matches the weekly-reset module so
  // "this week" means "after the last weekly-reset moment."
  const cursor = new Date(now.getTime());
  // Walk backwards day-by-day up to 7 days until we find the last
  // passed Wed 10:00 UTC moment (= 5h chiều thứ 4 VN).
  for (let i = 0; i < 8; i += 1) {
    const day = cursor.getUTCDay(); // 0=Sun .. 6=Sat
    if (day === 3 && cursor.getUTCHours() >= 10) {
      // Snap to the 10:00 UTC boundary of this Wednesday.
      return Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth(),
        cursor.getUTCDate(),
        10, 0, 0, 0
      );
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    cursor.setUTCHours(23, 59, 59, 999); // roll to end-of-prev-day before next check
  }
  // Fallback: 7 days ago at the current moment.
  return now.getTime() - 7 * 24 * 60 * 60 * 1000;
}

/**
 * Autocomplete for `/raid-channel config action:*`. Returns the full action
 * catalog filtered by the user's typed prefix AND by the guild's current
 * `autoCleanupEnabled` state - hides `schedule-on` when already enabled
 * and `schedule-off` when already disabled, so admin never sees an option
 * that would be a no-op. Read-only best-effort; any DB error falls back
 * to showing both schedule options so admin can still try to run them.
 */
async function handleRaidChannelAutocomplete(interaction) {
  try {
    const focused = interaction.options.getFocused(true);
    if (focused?.name !== "action") {
      await interaction.respond([]).catch(() => {});
      return;
    }

    let autoCleanupEnabled = false;
    if (interaction.guildId) {
      try {
        const cfg = await GuildConfig.findOne({ guildId: interaction.guildId }).lean();
        autoCleanupEnabled = !!cfg?.autoCleanupEnabled;
      } catch (err) {
        console.warn("[autocomplete] raid-channel config load failed:", err?.message || err);
      }
    }

    const needle = normalizeName(focused.value || "");
    const choices = RAID_CHANNEL_ACTION_CHOICES
      .filter((c) => {
        if (autoCleanupEnabled && c.value === "schedule-on") return false;
        if (!autoCleanupEnabled && c.value === "schedule-off") return false;
        if (!needle) return true;
        return normalizeName(c.name).includes(needle) || normalizeName(c.value).includes(needle);
      })
      .slice(0, 25);

    await interaction.respond(choices).catch(() => {});
  } catch (err) {
    console.error("[autocomplete] raid-channel error:", err?.message || err);
    await interaction.respond([]).catch(() => {});
  }
}

// /raid-auto-manage `action` autocomplete - filters the four actions by the
// user's current autoManageEnabled state so the dropdown never shows the
// redundant option (e.g. `on` while already ON).
const AUTO_MANAGE_ACTION_CHOICES = [
  { name: "on - enable auto-sync + run an initial sync now", value: "on", showWhenOn: false, showWhenOff: true },
  { name: "off - disable auto-sync", value: "off", showWhenOn: true, showWhenOff: false },
  { name: "sync - pull bible logs now and reconcile raid progress", value: "sync", showWhenOn: true, showWhenOff: true },
  { name: "status - show current opt-in + last sync time", value: "status", showWhenOn: true, showWhenOff: true },
];

async function handleRaidAutoManageAutocomplete(interaction) {
  try {
    const focused = interaction.options.getFocused(true);
    if (focused?.name !== "action") {
      await interaction.respond([]).catch(() => {});
      return;
    }

    let enabled = false;
    try {
      const user = await User.findOne(
        { discordId: interaction.user.id },
        { autoManageEnabled: 1 }
      ).lean();
      enabled = !!user?.autoManageEnabled;
    } catch (err) {
      console.warn("[autocomplete] auto-manage state load failed:", err?.message || err);
    }

    const needle = normalizeName(focused.value || "");
    const choices = AUTO_MANAGE_ACTION_CHOICES
      .filter((c) => (enabled ? c.showWhenOn : c.showWhenOff))
      .filter((c) => {
        if (!needle) return true;
        return normalizeName(c.name).includes(needle) || normalizeName(c.value).includes(needle);
      })
      .map(({ name, value }) => ({ name, value }))
      .slice(0, 25);

    await interaction.respond(choices).catch(() => {});
  } catch (err) {
    console.error("[autocomplete] raid-auto-manage error:", err?.message || err);
    await interaction.respond([]).catch(() => {});
  }
}

async function handleRaidChannelCommand(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: `${UI.icons.warn} Command này chỉ dùng trong server.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Single subcommand `config` - dispatch by the `action` option value.
  // Merged from six separate subcommands so the autocomplete dropdown at
  // `/raid-channel` shows one entry (discoverable + less visually cluttered)
  // and the admin picks the concrete action from the required `action`
  // choice list.
  const action = interaction.options.getString("action", true);

  if (action === "set") {
    const channel = interaction.options.getChannel("channel");
    if (!channel) {
      await interaction.reply({
        content: `${UI.icons.warn} Action \`set\` yêu cầu option \`channel\`. Ví dụ: \`/raid-channel config action:set channel:#raid-clears\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Refuse to set if the text monitor is disabled at the deploy layer -
    // saving config + posting a pinned welcome would mislead members into
    // thinking the channel is active when MessageCreate is silently dropped.
    if (!isTextMonitorEnabled()) {
      await interaction.reply({
        content: `${UI.icons.warn} Text monitor hiện đang tắt ở deploy layer (\`TEXT_MONITOR_ENABLED=false\`). Bật env var đó (+ enable Message Content Intent ở Developer Portal nếu chưa) rồi redeploy, xong mới \`/raid-channel config action:set\` nhé - không config sẽ không có effect.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Verify the bot has the channel-level permissions this feature needs
    // BEFORE persisting - otherwise admin gets a success embed for a
    // channel where the monitor will silently fail (can't read messages,
    // can't reply to errors, or can't delete on success).
    const botMember = interaction.guild?.members?.me;
    const missing = getMissingBotChannelPermissions(channel, botMember);
    if (missing.length > 0) {
      await interaction.reply({
        content: `${UI.icons.warn} Bot thiếu permission trong <#${channel.id}>: **${missing.join(", ")}**. Grant cho bot rồi chạy lại \`/raid-channel config action:set\` nhé.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await GuildConfig.findOneAndUpdate(
      { guildId },
      { guildId, raidChannelId: channel.id },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    setCachedMonitorChannelId(guildId, channel.id);

    // Post + pin a fresh welcome via the shared helper. It unpins the
    // previously-stored welcome (if any) using GuildConfig.welcomeMessageId
    // and persists the new pin's ID there so repeated `set` or `repin`
    // invocations target the exact bot welcome instead of all bot pins.
    const welcome = await postRaidChannelWelcome(channel, interaction.client.user.id, guildId);
    const welcomeStatus = welcome.posted
      ? welcome.pinned ? "posted & pinned" : "posted (pin failed)"
      : "NOT posted";

    const embed = new EmbedBuilder()
      .setColor(UI.colors.success)
      .setTitle(`${UI.icons.done} Raid Channel Set`)
      .setDescription(
        `Bot sẽ monitor <#${channel.id}> và parse message dạng \`<raid> <difficulty> <character> [gate]\`.`
      )
      .addFields(
        { name: "Examples", value: "`Serca Nightmare Clauseduk` → mark raid as DONE\n`Serca Nor Soulrano G1` → mark G1 as done" },
        { name: "Welcome message", value: `${welcome.posted ? UI.icons.done : UI.icons.warn} ${welcomeStatus} in <#${channel.id}>.` },
        { name: "Nếu cậu đổi channel trước đó", value: "Remember to unpin/delete welcome message ở channel cũ để members không nhầm." },
      )
      .setTimestamp();
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === "show") {
    const channelId = getCachedMonitorChannelId(guildId);
    const embed = new EmbedBuilder()
      .setColor(UI.colors.neutral)
      .setTitle(`${UI.icons.info} Raid Channel`);

    // Deploy-level state warnings regardless of config state.
    const deployNotes = [];
    if (!isTextMonitorEnabled()) {
      deployNotes.push(
        `${UI.icons.warn} Text monitor đang bị tắt ở deploy layer (\`TEXT_MONITOR_ENABLED=false\`). Bot bỏ qua mọi message đến.`
      );
    }
    const { healthy, error } = getMonitorCacheHealth();
    if (!healthy) {
      deployNotes.push(
        `${UI.icons.warn} Cache config chưa load được ở boot${error ? ` (\`${error}\`)` : ""}. Monitor inactive cho đến khi load lại. Bot cần redeploy hoặc fix kết nối Mongo.`
      );
    }

    if (!channelId) {
      const lines = ["Chưa config channel nào. Dùng `/raid-channel config action:set channel:#<channel>` để bật."];
      if (deployNotes.length > 0) lines.push("", ...deployNotes);
      embed.setDescription(lines.join("\n"));
    } else {
      // Channel cache can be cold right after bot restart - fall back to
      // an API fetch so we don't false-positive "inaccessible" on a
      // channel the bot actually has access to.
      let channel = interaction.guild?.channels?.cache?.get(channelId) || null;
      if (!channel && interaction.guild?.channels?.fetch) {
        try {
          channel = await interaction.guild.channels.fetch(channelId);
        } catch {
          channel = null;
        }
      }

      const botMember = interaction.guild?.members?.me;
      const missing = channel ? getMissingBotChannelPermissions(channel, botMember) : null;

      const lines = [`Monitoring <#${channelId}>.`];
      if (!channel) {
        lines.push(`${UI.icons.warn} Channel không truy cập được (bị xóa hoặc bot không có access).`);
      } else if (missing && missing.length > 0) {
        lines.push(`${UI.icons.warn} Bot thiếu permission: **${missing.join(", ")}**. Feature có thể fail im lặng.`);
      } else {
        lines.push(`${UI.icons.done} Permissions OK.`);
      }
      if (deployNotes.length > 0) lines.push("", ...deployNotes);
      embed.setDescription(lines.join("\n"));
    }
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === "clear") {
    // Always write-through Mongo regardless of cache state. Cache is a
    // mirror, not the source of truth - if loadMonitorChannelCache had
    // failed at boot the cache is empty, but Mongo might still have a
    // non-null raidChannelId that `clear` needs to actually clear.
    // findOneAndUpdate without upsert is a no-op when no doc exists.
    //
    // Also cascade `autoCleanupEnabled` to false so a previously-scheduled
    // auto-cleanup doesn't reactivate the moment admin /sets a fresh
    // channel later - that would silently purge the new channel before
    // admin has a chance to opt back in.
    await GuildConfig.findOneAndUpdate(
      { guildId },
      { $set: { raidChannelId: null, autoCleanupEnabled: false } }
    );
    setCachedMonitorChannelId(guildId, null);

    const embed = new EmbedBuilder()
      .setColor(UI.colors.muted)
      .setTitle(`${UI.icons.reset} Raid Channel Cleared`)
      .setDescription("Monitor đã được tắt và auto-cleanup schedule cũng bị reset. Bot sẽ không xử lý message text nữa. Dùng `/raid-channel config action:set channel:#<channel>` + `action:schedule-on` để bật lại.");
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === "cleanup") {
    const channelId = getCachedMonitorChannelId(guildId);
    if (!channelId) {
      await interaction.reply({
        content: `${UI.icons.warn} Chưa config channel nào. Dùng \`/raid-channel config action:set\` trước.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const channel = await resolveRaidMonitorChannel(interaction, channelId);
    if (!channel) {
      await interaction.reply({
        content: `${UI.icons.warn} Channel <#${channelId}> không truy cập được.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { deleted, skippedOld } = await cleanupRaidChannelMessages(channel);
      const embed = new EmbedBuilder()
        .setColor(UI.colors.success)
        .setTitle(`${UI.icons.done} Channel Cleaned`)
        .setDescription(`Đã dọn <#${channel.id}>, pinned messages giữ nguyên.`)
        .addFields({ name: "Deleted", value: `${deleted} message(s)`, inline: true })
        .setTimestamp();
      if (skippedOld > 0) {
        embed.addFields({ name: "Skipped (>14 ngày)", value: `${skippedOld}`, inline: true });
      }
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error("[raid-channel] manual cleanup failed:", err?.message || err);
      await interaction.editReply({
        content: `${UI.icons.warn} Cleanup fail: ${err?.message || err}. Check bot permissions (Manage Messages + Read Message History).`,
      });
    }
    return;
  }

  if (action === "repin") {
    const channelId = getCachedMonitorChannelId(guildId);
    if (!channelId) {
      await interaction.reply({
        content: `${UI.icons.warn} Chưa config channel nào. Dùng \`/raid-channel config action:set\` trước.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const channel = await resolveRaidMonitorChannel(interaction, channelId);
    if (!channel) {
      await interaction.reply({
        content: `${UI.icons.warn} Channel <#${channelId}> không truy cập được.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const welcome = await postRaidChannelWelcome(channel, interaction.client.user.id, guildId);
    const embed = new EmbedBuilder()
      .setColor(welcome.posted && welcome.pinned ? UI.colors.success : UI.colors.progress)
      .setTitle(`${UI.icons.roster} Welcome Repinned`)
      .setDescription(`<#${channel.id}>`)
      .addFields(
        { name: "Removed old welcome", value: `${welcome.removedOldCount}`, inline: true },
        { name: "New welcome", value: welcome.posted ? (welcome.pinned ? "posted & pinned" : "posted (pin failed)") : "NOT posted", inline: true },
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (action === "schedule-on" || action === "schedule-off") {
    const enabled = action === "schedule-on";

    // Defend against autocomplete bypass: autocomplete hides the
    // redundant option, but a user can still type + submit the
    // same-state action. Surface a specific no-op notice instead of
    // running a misleading success embed on an idempotent DB write.
    try {
      const cfg = await GuildConfig.findOne({ guildId }).lean();
      if (cfg && !!cfg.autoCleanupEnabled === enabled) {
        await interaction.reply({
          content: `${UI.icons.info} Schedule đang ở state \`${enabled ? "on" : "off"}\` rồi - không có gì để đổi.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    } catch (err) {
      // Tolerate DB read error - fall through to the normal toggle path
      // so admin still has a way to flip the flag.
      console.warn("[raid-channel] schedule no-op check failed:", err?.message || err);
    }

    // Refuse to enable schedule without a configured monitor channel -
    // the scheduler filters on `raidChannelId != null`, so enabling now
    // would give admin a success embed for a job that never runs.
    if (enabled && !getCachedMonitorChannelId(guildId)) {
      await interaction.reply({
        content: `${UI.icons.warn} Chưa config channel nào. Chạy \`/raid-channel config action:set channel:#<channel>\` trước rồi mới enable schedule nhé - không scheduler sẽ không có gì để dọn.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Enable ALWAYS stamps today's VN day key - even on re-enable after
    // days off - so the first tick after flipping the flag never runs a
    // catch-up cleanup. Admin expectation on "turn the schedule on" is
    // "schedule starts fresh", not "immediately purge everything since
    // the last run." Bot-offline catch-up still works when the schedule
    // stays enabled the whole time: the tick after restart sees a stale
    // lastAutoCleanupKey and runs once. Disable leaves the key alone so
    // it's available for debugging, but it's overwritten on the next
    // enable regardless.
    const update = enabled
      ? { $set: { autoCleanupEnabled: true, lastAutoCleanupKey: getTargetCleanupDayKey() } }
      : { $set: { autoCleanupEnabled: false } };
    await GuildConfig.findOneAndUpdate(
      { guildId },
      update,
      { upsert: true, setDefaultsOnInsert: true }
    );
    const embed = new EmbedBuilder()
      .setColor(enabled ? UI.colors.success : UI.colors.muted)
      .setTitle(`${enabled ? UI.icons.done : UI.icons.reset} Auto-cleanup ${enabled ? "enabled" : "disabled"}`)
      .setDescription(
        enabled
          ? "Mỗi 00:00 giờ Việt Nam (UTC+7), Artist sẽ tự xóa toàn bộ message không được pin trong monitor channel. Welcome pin giữ nguyên. Nếu bot offline qua midnight, tick tiếp theo sau khi online sẽ catch-up."
          : "Auto-cleanup đã tắt. Admin vẫn có thể chạy thủ công qua `/raid-channel config action:cleanup` bất cứ lúc nào."
      )
      .setTimestamp();
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

// ---------------------------------------------------------------------------
// Auto-cleanup scheduler (daily at 00:00 Vietnam time = 17:00 UTC)
// ---------------------------------------------------------------------------

/**
 * Returns "YYYY-MM-DD" in Vietnam (UTC+7) calendar for the given moment.
 * Used as the idempotency cursor `lastAutoCleanupKey`: once a guild runs
 * cleanup for a given VN day, subsequent ticks within the same VN day
 * short-circuit. Crossing the VN-midnight boundary produces a new key and
 * the next tick picks it up.
 */
function getTargetCleanupDayKey(now = new Date()) {
  const vnTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return vnTime.toISOString().slice(0, 10);
}

async function runAutoCleanupTick(client) {
  const targetKey = getTargetCleanupDayKey();
  let configs;
  try {
    configs = await GuildConfig.find({
      autoCleanupEnabled: true,
      raidChannelId: { $ne: null },
    }).lean();
  } catch (err) {
    console.error("[raid-channel] auto-cleanup config load failed:", err?.message || err);
    return;
  }
  if (!configs.length) return;

  for (const cfg of configs) {
    if (cfg.lastAutoCleanupKey === targetKey) continue; // already done for this VN day
    const guild = client.guilds.cache.get(cfg.guildId);
    if (!guild) continue;
    let channel = guild.channels.cache.get(cfg.raidChannelId);
    if (!channel) {
      try {
        channel = await guild.channels.fetch(cfg.raidChannelId);
      } catch {
        continue;
      }
    }
    if (!channel) continue;

    try {
      const { deleted, skippedOld } = await cleanupRaidChannelMessages(channel);
      await GuildConfig.findOneAndUpdate(
        { guildId: cfg.guildId },
        { $set: { lastAutoCleanupKey: targetKey } }
      );
      console.log(
        `[raid-channel] auto-cleanup guild=${cfg.guildId} key=${targetKey} deleted=${deleted} skippedOld=${skippedOld}`
      );
    } catch (err) {
      console.error(
        `[raid-channel] auto-cleanup failed guild=${cfg.guildId}:`,
        err?.message || err
      );
    }
  }
}

/**
 * Start the 30-minute tick for the auto-cleanup scheduler. Cadence matches
 * the weekly-reset job so operator has one mental model for background jobs.
 * The tick is cheap when no guilds have `autoCleanupEnabled=true` (single
 * filtered Mongo query returns empty, early-exit).
 */
function startRaidChannelScheduler(client) {
  const run = () =>
    runAutoCleanupTick(client).catch((err) => {
      console.error("[raid-channel] scheduler tick failed:", err?.message || err);
    });
  run();
  return setInterval(run, 30 * 60 * 1000);
}

// Phase 3: 24h passive auto-sync for opted-in users. Spreads sync work
// across the day so the bible footprint stays thin even at scale.
//
// Tunables:
//   - TICK_MS = 30 min (match other schedulers)
//   - CUTOFF = 24h since last successful sync (Phase 2 piggyback bypasses
//     this naturally because active users have lastAutoManageSyncAt < 24h)
//   - BATCH_SIZE = 3 users per tick (math: 48 ticks/day × 3 = 144 user-
//     syncs/day capacity, covers 100+ users without bursting bible)
//
// Killswitch: AUTO_MANAGE_DAILY_DISABLED=true in env → tick early-exits
// without DB query. Lets ops kill the scheduler without redeploy if
// bible starts blocking.
const AUTO_MANAGE_DAILY_TICK_MS = 30 * 60 * 1000;
const AUTO_MANAGE_DAILY_CUTOFF_MS = 24 * 60 * 60 * 1000;
const AUTO_MANAGE_DAILY_BATCH_SIZE = 3;

async function runAutoManageDailyTick() {
  if (process.env.AUTO_MANAGE_DAILY_DISABLED === "true") return;

  const cutoff = Date.now() - AUTO_MANAGE_DAILY_CUTOFF_MS;
  // Mongo-side filter so we don't pull every opted-in user into memory:
  //   - autoManageEnabled true (opted in)
  //   - has at least one account (Mongo "accounts.0 exists" pattern)
  //   - never synced (null) OR last success > 24h ago
  //
  // Sort by `lastAutoManageAttemptAt` ascending - NOT `lastAutoManageSyncAt`.
  // Why: stuck users (Cloudflare 403 forever, private-log forever) never
  // advance `lastAutoManageSyncAt`, so sorting by sync-time would pick
  // the same 3 stuck users every tick and starve everyone behind them
  // (Codex round 27 finding #1). Sorting by attempt-time lets stuck users
  // rotate out: each attempt stamps `lastAutoManageAttemptAt` (success
  // path, opt-out race, save-fail catch - all stamp it), so after a tick
  // they're no longer stalest by attempt and the next-stalest user gets
  // a turn. Fair coverage even when some users perma-fail.
  const candidates = await User.find({
    autoManageEnabled: true,
    "accounts.0": { $exists: true },
    $or: [
      { lastAutoManageSyncAt: null },
      { lastAutoManageSyncAt: { $lt: cutoff } },
    ],
  })
    .sort({ lastAutoManageAttemptAt: 1 })
    .limit(AUTO_MANAGE_DAILY_BATCH_SIZE)
    .select("discordId")
    .lean();

  if (candidates.length === 0) return;

  const weekResetStart = weekResetStartMs();
  // Counters split by actual outcome so the operator log never lies about
  // "synced N" when really nothing got refreshed (Codex round 27 #3):
  //   - syncedCount: at least 1 char succeeded → lastAutoManageSyncAt
  //     stamped. The metric operator actually cares about for "is the
  //     scheduler doing useful work?".
  //   - attemptedOnlyCount: bible was hit but no char succeeded (all
  //     errored, or user opted out mid-flight) → only attempt stamped,
  //     no fresh data. Burns quota with zero progress.
  //   - skippedCount: didn't hit bible (cooldown / in-flight / opt-out
  //     before gather / no roster).
  //   - failedCount: caught throw - usually bible HTTP error or save
  //     blowup.
  let syncedCount = 0;
  let attemptedOnlyCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const { discordId } of candidates) {
    // Reuse the same slot as Phase 2 piggyback + manual action:sync so
    // we never double-fire bible against the same user across paths.
    // Acquire failure (cooldown / in-flight) → skip silently, retry next
    // tick.
    const guard = await acquireAutoManageSyncSlot(discordId);
    if (!guard.acquired) {
      skippedCount += 1;
      continue;
    }
    let bibleHit = false;
    try {
      const seedDoc = await User.findOne({ discordId });
      if (!seedDoc || !Array.isArray(seedDoc.accounts) || seedDoc.accounts.length === 0) {
        // Roster removed between query + slot acquire - skip cleanly.
        skippedCount += 1;
        continue;
      }
      // Opt-out race: user could have bấm action:off between the candidate
      // query and the slot acquire. Skip silently - no point hitting bible
      // for a user who explicitly opted out.
      if (!seedDoc.autoManageEnabled) {
        skippedCount += 1;
        continue;
      }
      ensureFreshWeek(seedDoc);
      const collected = await gatherAutoManageLogsForUserDoc(seedDoc, weekResetStart);
      bibleHit = true;
      // Outcome bucket for THIS user, decided inside saveWithRetry and
      // read after to drive the right counter increment. Default
      // "attempted-only" - apply branches override to "synced" when at
      // least one char actually fetched without error.
      let outcome = "attempted-only";
      await saveWithRetry(async () => {
        const fresh = await User.findOne({ discordId });
        if (!fresh || !Array.isArray(fresh.accounts) || fresh.accounts.length === 0) return;
        ensureFreshWeek(fresh);
        // Same opt-out re-check as Phase 2 piggyback (Codex round 26 #1):
        // user can toggle off during the long bible HTTP. Stamp attempt
        // anyway so cooldown reflects the burned quota.
        if (!fresh.autoManageEnabled) {
          fresh.lastAutoManageAttemptAt = Date.now();
          await fresh.save();
          return;
        }
        const report = applyAutoManageCollected(fresh, weekResetStart, collected);
        const now = Date.now();
        fresh.lastAutoManageAttemptAt = now;
        if (report.perChar.some((c) => !c.error)) {
          fresh.lastAutoManageSyncAt = now;
          outcome = "synced";
        }
        await fresh.save();
      });
      if (outcome === "synced") syncedCount += 1;
      else attemptedOnlyCount += 1;
    } catch (err) {
      failedCount += 1;
      // Codex round 26 #2 parity: bible burned quota but save threw. Stamp
      // attempt so the slot's 5-min cooldown still kicks in for next tick.
      if (bibleHit) {
        await stampAutoManageAttempt(discordId);
      }
      console.warn(
        `[auto-manage daily] user ${discordId} sync failed:`,
        err?.message || err
      );
    } finally {
      releaseAutoManageSyncSlot(discordId);
    }
  }

  console.log(
    `[auto-manage daily] tick: ${candidates.length} candidate(s) · synced ${syncedCount} · attempted-only ${attemptedOnlyCount} · skipped ${skippedCount} · failed ${failedCount}`
  );
}

/**
 * Start the 24h passive auto-sync scheduler for /raid-auto-manage opted-in
 * users. Tick cadence (30 min) matches the other schedulers so operator
 * has one mental model. Per-tick batch size + per-user slot acquire keep
 * bible footprint thin even at scale - see runAutoManageDailyTick header.
 *
 * In-flight guard: a single tick can plausibly run > 30 min under bible
 * outage (sequential users × sequential chars × up to 10 paginated logs ×
 * 15s timeout per HTTP). `setInterval` doesn't block the next fire on a
 * slow callback, so without the guard, two ticks could overlap and double
 * bible traffic - defeating the per-tick batch cap (Codex round 27 #2).
 * The guard is module-scope (not persisted) - process restart resets it,
 * which is fine: a crash during a tick releases the slot anyway.
 *
 * Returns the interval handle. Caller doesn't need to track it for the
 * normal lifetime - process exit kills the timer.
 */
let dailyTickInFlight = false;
function startAutoManageDailyScheduler() {
  const run = async () => {
    if (dailyTickInFlight) {
      console.warn(
        "[auto-manage daily] previous tick still running - skipping this fire to avoid overlap"
      );
      return;
    }
    dailyTickInFlight = true;
    try {
      await runAutoManageDailyTick();
    } catch (err) {
      console.error("[auto-manage daily] scheduler tick failed:", err?.message || err);
    } finally {
      dailyTickInFlight = false;
    }
  };
  run();
  return setInterval(run, AUTO_MANAGE_DAILY_TICK_MS);
}

module.exports = {
  commands,
  handleRaidManagementCommand,
  handleRaidHelpSelect,
  handleRaidSetAutocomplete,
  handleRemoveRosterAutocomplete,
  handleRaidChannelAutocomplete,
  handleRaidAutoManageAutocomplete,
  handleRaidChannelMessage,
  handleRaidCheckButton,
  loadMonitorChannelCache,
  startRaidChannelScheduler,
  startAutoManageDailyScheduler,
  parseRaidMessage,
};
