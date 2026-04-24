const {
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");
const GuildConfig = require("./schema/guildConfig");
const { randomUUID } = require("node:crypto");
const User = require("./schema/user");
const { saveWithRetry } = require("./schema/user");
const {
  ensureFreshWeek,
  getWeeklyResetSchedulerStartedAtMs,
  WEEKLY_RESET_TICK_MS,
} = require("./weekly-reset");
const {
  ConcurrencyLimiter,
  UI,
  normalizeName,
  foldName,
  parseCombatScore,
  toModeLabel,
  toModeKey,
  getCharacterName,
  getCharacterClass,
  truncateText,
  formatShortRelative,
  formatNextCooldownRemaining,
  waitWithBudget,
  buildDiscordIdentityFields,
} = require("./raid/shared");
const {
  announcementTypeKeys,
  announcementTypeEntry,
  announcementSubdocKeys,
} = require("./raid/announcements");
const {
  createRaidStatusCommand,
  STATUS_PAGINATION_SESSION_MS,
  STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS,
} = require("./commands/raid-status");
const {
  createRaidCheckCommand,
  RAID_CHECK_PAGINATION_SESSION_MS,
} = require("./commands/raid-check");
const { createAddRosterCommand } = require("./commands/add-roster");
const { createRaidCommandDefinitions } = require("./commands/definitions");
const { createRaidAutoManageCommand } = require("./commands/raid-auto-manage");
const { createRaidAnnounceCommand } = require("./commands/raid-announce");
const { createRemoveRosterCommand } = require("./commands/remove-roster");
const { createRaidChannelCommand } = require("./commands/raid-channel");
const { createRaidHelpCommand } = require("./commands/raid-help");
const { createRaidSetCommand } = require("./commands/raid-set");
const {
  createRosterRefreshService,
  ROSTER_REFRESH_COOLDOWN_MS,
  ROSTER_REFRESH_FAILURE_COOLDOWN_MS,
} = require("./services/roster-refresh");
const { createAutoManageSyncService } = require("./services/auto-manage-sync");
const { createRosterFetchService } = require("./services/roster-fetch");
const { createAutoManageCoreService } = require("./services/auto-manage-core");
const { createRaidChannelMonitorService } = require("./services/raid-channel-monitor");
const { createRaidSchedulerService } = require("./services/raid-schedulers");

const bibleLimiter = new ConcurrencyLimiter(2);
// Discord REST fan-out limiter: caps parallel `client.users.fetch` bursts in
// /raid-check (which resolves display names for every unique discordId with
// matching chars). discord.js serializes per-bucket internally, but a large
// raiding server could queue up dozens of fetches at once and trip the
// global 50-req/s ceiling - 5 in flight is a safe middle ground.
const discordUserLimiter = new ConcurrencyLimiter(5);
// /raid-check's initial render may pre-refresh multiple users before it scans.
// Keep that user-level fan-out bounded so one leader view doesn't stampede
// Mongo while still letting bible HTTP overlap through bibleLimiter.
const raidCheckRefreshLimiter = new ConcurrencyLimiter(3);
// Sync button can touch multiple opted-in users; bounded user-level fan-out
// keeps wall-clock reasonable without increasing bible HTTP concurrency beyond
// bibleLimiter's own max-2 global cap.
const raidCheckSyncLimiter = new ConcurrencyLimiter(3);
const rosterFetchService = createRosterFetchService({ bibleLimiter });
const { fetchRosterCharacters } = rosterFetchService;

// Narrow Mongo payload for /raid-check scans. The view only needs roster
// fields, refresh stamps, weekly cursor, and auto-manage badges - not the
// rest of the User document.
const RAID_CHECK_USER_BASE_QUERY = { "accounts.0": { $exists: true } };
const RAID_CHECK_USER_QUERY_FIELDS = [
  "discordId",
  "weeklyResetKey",
  "autoManageEnabled",
  "lastAutoManageSyncAt",
  "lastAutoManageAttemptAt",
  "accounts.accountName",
  "accounts.lastRefreshedAt",
  "accounts.lastRefreshAttemptAt",
  "accounts.characters.name",
  "accounts.characters.charName",
  "accounts.characters.class",
  "accounts.characters.className",
  "accounts.characters.itemLevel",
  "accounts.characters.raids",
  "accounts.characters.assignedRaids",
  "accounts.characters.publicLogDisabled",
  "discordUsername",
  "discordGlobalName",
  "discordDisplayName",
].join(" ");

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
//
// The same allowlist now also drives manager privileges (shorter auto-manage
// sync cooldown, on-roster visual tag). Shared helper lives in services/manager.js
// so raid-status / raid-check / auto-manage-core all read from one place.
const {
  MANAGER_IDS: RAID_MANAGER_ID,
  isManagerId,
  getAutoManageCooldownMs,
} = require("./services/manager");
if (RAID_MANAGER_ID.size === 0) {
  console.warn(
    "[raid-check] RAID_MANAGER_ID env not set or empty - /raid-check will reject every invocation. Set the env var to a comma-separated list of Discord user IDs to enable."
  );
}
const RAID_CHOICES = getRaidRequirementChoices();
// /raid-check-only extension: the synthetic "all" value pulls the
// cross-raid overview page (per-account roster with every eligible
// raid per char, mirrors /raid-status). NOT present in /raid-set's
// autocomplete because there is no "all-raid" write semantics.
const RAID_CHECK_CHOICES = [
  { name: "All raids (overview)", value: "all" },
  ...RAID_CHOICES,
];
const RAID_REQUIREMENT_MAP = getRaidRequirementMap();
const RAID_GROUP_KEYS = Object.keys(RAID_REQUIREMENTS);

function createCharacterId() {
  try {
    return randomUUID();
  } catch {
    return `char_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function buildFetchedRosterIndexes(fetchedChars) {
  const byName = new Map();
  const byFoldedName = new Map();

  for (const fetched of fetchedChars || []) {
    const charName = fetched?.charName;
    const normalized = normalizeName(charName);
    if (!normalized) continue;

    byName.set(normalized, fetched);

    const folded = foldName(charName);
    if (!folded) continue;
    if (!byFoldedName.has(folded)) byFoldedName.set(folded, []);
    byFoldedName.get(folded).push(fetched);
  }

  return { byName, byFoldedName };
}

function pickUniqueFetchedRosterCandidate(candidates, character) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const storedClass = normalizeName(getCharacterClass(character));
  const classMatches = storedClass
    ? candidates.filter((c) => normalizeName(c?.className) === storedClass)
    : [];
  if (classMatches.length === 1) return classMatches[0];

  const narrowed = classMatches.length > 0 ? classMatches : candidates;
  const storedItemLevel = Number(character?.itemLevel) || 0;
  if (storedItemLevel > 0) {
    const closeMatches = narrowed.filter((c) => {
      const fetchedItemLevel = Number(c?.itemLevel) || 0;
      return fetchedItemLevel > 0 && Math.abs(fetchedItemLevel - storedItemLevel) < 2;
    });
    if (closeMatches.length === 1) return closeMatches[0];
  }

  return null;
}

function findFetchedRosterMatchForCharacter(character, indexes) {
  const currentName = getCharacterName(character);
  const exact = indexes?.byName?.get(normalizeName(currentName));
  if (exact) return { match: exact, matchType: "exact" };

  const folded = foldName(currentName);
  if (!folded) return null;

  const foldedCandidates = indexes?.byFoldedName?.get(folded) || [];
  const foldedMatch = pickUniqueFetchedRosterCandidate(foldedCandidates, character);
  if (!foldedMatch) return null;

  return { match: foldedMatch, matchType: "folded" };
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

const commands = createRaidCommandDefinitions({
  // definitions.js wires these into /raid-check's `raid` option only,
  // so it's safe to feed the all-augmented list here. /raid-set uses
  // autocomplete (not static choices) and never sees this.
  RAID_CHOICES: RAID_CHECK_CHOICES,
  announcementTypeKeys,
  announcementTypeEntry,
});


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

// Shared scan+classify pass for /raid-check. Returns the raw eligible list
// + per-user metadata so both the initial command AND the button handlers
// (Remind / Sync) can operate on a fresh Mongo snapshot every time - no
// stale state map, no cache staleness bug. Initial render can optionally
// pre-refresh source users first so it matches `/raid-status` freshness.
// Composite key separator (Unit Separator \x1f) for maps keyed by
// discordId + accountName. Shared between rosterBuckets, rosterStats,
// and rosterRefreshMap so lookups line up across the three structures.
const ROSTER_KEY_SEP = "\x1f";

function toPlainUserSnapshot(userDoc) {
  if (!userDoc) return null;
  return typeof userDoc.toObject === "function" ? userDoc.toObject() : userDoc;
}

// Shared "render-facing" refresh helper: lazy-refresh stale roster data,
// optionally piggyback auto-manage, then return a plain object snapshot for
// commands that only need to read/render the result.
async function loadFreshUserSnapshotForRaidViews(
  seedDoc,
  { allowAutoManage = true, logLabel = "[raid-status]" } = {}
) {
  if (!seedDoc) return null;
  const discordId = seedDoc.discordId;
  if (!discordId) return toPlainUserSnapshot(seedDoc);

  const hasRoster = Array.isArray(seedDoc.accounts) && seedDoc.accounts.length > 0;
  const didFreshenSeedWeek = ensureFreshWeek(seedDoc);

  if (!hasRoster) {
    if (!didFreshenSeedWeek) return toPlainUserSnapshot(seedDoc);
    try {
      return await saveWithRetry(async () => {
        const doc = await User.findOne({ discordId });
        if (!doc) return null;
        const didFreshenWeek = ensureFreshWeek(doc);
        if (didFreshenWeek) await doc.save();
        return doc.toObject();
      });
    } catch (err) {
      console.error(`${logLabel} refresh failed for ${discordId}:`, err?.message || err);
      return await User.findOne({ discordId }).lean();
    }
  }

  let autoManageGuard = null;
  try {
    let autoManagePromise = Promise.resolve(null);
    let autoManageWeekResetStart = null;
    if (allowAutoManage && seedDoc.autoManageEnabled) {
      autoManageGuard = await acquireAutoManageSyncSlot(discordId);
      if (autoManageGuard.acquired) {
        autoManageWeekResetStart = weekResetStartMs();
        autoManagePromise = gatherAutoManageLogsForUserDoc(
          seedDoc,
          autoManageWeekResetStart
        ).catch((err) => {
          console.warn(
            `${logLabel} auto-manage piggyback gather failed:`,
            err?.message || err
          );
          return null;
        });
      }
    }

    const [refreshCollected, autoManageCollected] = await Promise.all([
      collectStaleAccountRefreshes(seedDoc),
      autoManagePromise,
    ]);
    const autoManageBibleHit = autoManageGuard?.acquired === true;
    const needsFreshWrite =
      didFreshenSeedWeek || refreshCollected.length > 0 || autoManageBibleHit;

    if (!needsFreshWrite) return toPlainUserSnapshot(seedDoc);

    return await saveWithRetry(async () => {
      const doc = await User.findOne({ discordId });
      if (!doc) return null;
      const didFreshenWeek = ensureFreshWeek(doc);
      const didRefresh = applyStaleAccountRefreshes(doc, refreshCollected);

      let didAutoManage = false;
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
        doc.lastAutoManageAttemptAt = Date.now();
        didAutoManage = true;
      }

      if (didFreshenWeek || didRefresh || didAutoManage) await doc.save();
      return doc.toObject();
    });
  } catch (err) {
    console.error(`${logLabel} refresh failed for ${discordId}:`, err?.message || err);
    if (autoManageGuard?.acquired) {
      await stampAutoManageAttempt(discordId);
    }
    return await User.findOne({ discordId }).lean();
  } finally {
    if (autoManageGuard?.acquired) releaseAutoManageSyncSlot(discordId);
  }
}

/**
 * For a given (raidKey, selfMin) compute the iLvl range bounds needed to
 * classify roster chars as eligible / too-low for the scan.
 *
 *   - lowestMin: min iLvl of the lowest-tier mode of this raid. Chars
 *     below this are outside the raid entirely and never render.
 *   - selfMin: scan mode's own min (usually === `raidMeta.minItemLevel`).
 *   - nextMin: min iLvl of the next higher mode. Chars at or above this
 *     floor have out-grown the selected mode and should not show in that
 *     mode's scan page.
 *
 * The `lowestMin` floor uses `Math.min(RAID_REQ lowest, selfMin)` so that
 * if a caller passes a selfMin below the actual lowest mode (e.g. older
 * tests), the range still degrades gracefully instead of hiding every
 * char.
 */
function getRaidScanRange(raidKey, selfMin) {
  const modes = RAID_REQUIREMENTS[raidKey]?.modes || {};
  const mins = Object.values(modes)
    .map((m) => Number(m.minItemLevel))
    .filter(Number.isFinite);
  const baseLowest = mins.length > 0 ? Math.min(...mins) : selfMin;
  const lowestMin = Math.min(baseLowest, selfMin);
  const higherMins = mins
    .filter((min) => min > selfMin)
    .sort((a, b) => a - b);
  const nextMin = higherMins.length > 0 ? higherMins[0] : Infinity;
  return { lowestMin, selfMin, nextMin };
}

function buildRaidCheckUserQuery(raidMeta, now = Date.now()) {
  const query = { ...RAID_CHECK_USER_BASE_QUERY };
  if (!raidMeta) return query;

  const { lowestMin } = getRaidScanRange(
    raidMeta.raidKey,
    Number(raidMeta.minItemLevel) || 0
  );
  if (Number.isFinite(lowestMin) && lowestMin > 0) {
    const refreshCutoff = now - ROSTER_REFRESH_COOLDOWN_MS;
    const failureCutoff = now - ROSTER_REFRESH_FAILURE_COOLDOWN_MS;
    // Keep stale/unrefreshed accounts in the candidate set even when their
    // cached iLvl is below the raid floor. Initial /raid-check intentionally
    // lazy-refreshes stale roster metadata before scanning; filtering only
    // by cached iLvl here would hide a character who honed past the floor
    // since the last successful refresh.
    query.$or = [
      { "accounts.characters.itemLevel": { $gte: lowestMin } },
      {
        accounts: {
          $elemMatch: {
            $and: [
              {
                $or: [
                  { lastRefreshedAt: null },
                  { lastRefreshedAt: { $exists: false } },
                  { lastRefreshedAt: { $lt: refreshCutoff } },
                ],
              },
              {
                $or: [
                  { lastRefreshAttemptAt: null },
                  { lastRefreshAttemptAt: { $exists: false } },
                  { lastRefreshAttemptAt: { $lt: failureCutoff } },
                ],
              },
            ],
          },
        },
      },
    ];
  }
  return query;
}

let handleAddRosterCommand;
let buildRaidCheckSnapshotFromUsers;
let formatRaidCheckNotEligibleFieldValue;
let getRaidCheckRenderableChars;
let computeRaidCheckSnapshot;
let buildEditableCharsByUser;
let getEligibleRaidsForChar;
let getCharRaidGateStatus;
let applyLocalRaidEditToChar;
let buildRaidCheckEditDMEmbed;
let handleRaidCheckCommand;
let handleRaidCheckButton;
let handleStatusCommand;
let applyAutoManageCollectedForStatus;
let collectStaleAccountRefreshes;
let applyStaleAccountRefreshes;
let formatRosterRefreshCooldownRemaining;
let buildAccountFreshnessLine;
let buildAccountPageEmbed;
let buildStatusFooterText;

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
      .setLabel("\u25C0 Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || currentPage === 0),
    new ButtonBuilder()
      .setCustomId(nextId)
      .setLabel("Next \u25B6")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || currentPage === totalPages - 1),
  );
}

let handleRaidSetAutocomplete;
let handleRaidSetCommand;
let applyRaidSetForDiscordId;

let handleRaidHelpCommand;
let handleRaidHelpSelect;

let handleRemoveRosterAutocomplete;
let handleRemoveRosterCommand;
let handleRaidChannelAutocomplete;
let handleRaidChannelCommand;

async function cacheDiscordIdentityForExistingUser(interaction) {
  const discordId = interaction?.user?.id;
  if (!discordId) return;

  const identity = buildDiscordIdentityFields(interaction);
  if (!Object.values(identity).some(Boolean)) return;

  try {
    await User.updateOne(
      {
        discordId,
        $or: Object.entries(identity).map(([field, value]) => ({
          [field]: { $ne: value },
        })),
      },
      { $set: identity }
    );
  } catch (err) {
    console.warn(
      `[user-cache] failed to cache Discord identity for ${discordId}:`,
      err?.message || err
    );
  }
}

async function handleRaidManagementCommand(interaction) {
  try {
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
      return;
    }

    if (interaction.commandName === "raid-announce") {
      await handleRaidAnnounceCommand(interaction);
    }
  } finally {
    await cacheDiscordIdentityForExistingUser(interaction);
  }
}

/**
 * Load (or lazily initialize) the `announcements` subdoc for a guild.
 * Legacy guilds that existed before the schema field landed may have
 * `cfg.announcements = undefined`; schema defaults kick in on save but
 * not on `.lean()` reads, so callers must normalize. Returns a plain
 * object with every type's config populated with defaults.
 */
function getAnnouncementsConfig(cfg) {
  const raw = cfg?.announcements || {};
  const normalized = {};
  for (const subdocKey of announcementSubdocKeys()) {
    const sub = raw[subdocKey] || {};
    normalized[subdocKey] = {
      enabled: sub.enabled !== false, // default true when missing
      channelId: sub.channelId || null,
    };
  }
  return normalized;
}

/**
 * Next scheduler wake-up time for an interval job that started at
 * `startedAtMs` and runs every `intervalMs`. We intentionally derive this
 * from the scheduler's REAL boot phase instead of wall-clock boundaries,
 * because `setInterval(30m)` keeps the process-start phase forever
 * (:17/:47, :03/:33, etc).
 */
function nextIntervalTickMs(startedAtMs, intervalMs, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return null;
  }
  if (nowMs < startedAtMs) return startedAtMs;
  const elapsed = nowMs - startedAtMs;
  const ticksElapsed = Math.floor(elapsed / intervalMs) + 1;
  return startedAtMs + (ticksElapsed * intervalMs);
}

/**
 * Wall-clock eligibility boundary for announcement types whose natural
 * trigger is tied to a calendar boundary. This is NOT always the same as
 * the next actual scheduler check because the bot polls every 30 minutes
 * from its boot phase.
 */
function nextAnnouncementEligibleBoundaryMs(typeKey, now = new Date()) {
  const nowMs = now.getTime();
  if (typeKey === "weekly-reset") {
    const candidate = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      10, 0, 0, 0
    ));
    const utcDay = now.getUTCDay();
    if (utcDay === 3 && now.getUTCHours() < 10) {
      return candidate.getTime();
    }
    // If today is Wed at/after 10 UTC, daysUntilWed collapses to 0 via
    // modulo; promote it to 7 so we advance a full week.
    const daysUntilWed = ((3 - utcDay + 7) % 7) || 7;
    candidate.setUTCDate(candidate.getUTCDate() + daysUntilWed);
    return candidate.getTime();
  }
  if (typeKey === "hourly-cleanup") {
    // Cadence bumped from hourly to 30-min per Traine (Apr 2026). Next
    // eligible boundary is the next :00 or :30 slot, same shape as the
    // stuck-nudge tick boundary below.
    const candidate = new Date(now);
    candidate.setUTCSeconds(0, 0);
    if (candidate.getUTCMinutes() < 30) {
      candidate.setUTCMinutes(30);
    } else {
      candidate.setUTCMinutes(60); // rolls into next hour
    }
    return candidate.getTime();
  }
  if (typeKey === "stuck-nudge") {
    const candidate = new Date(now);
    candidate.setUTCSeconds(0, 0);
    if (candidate.getUTCMinutes() < 30) {
      candidate.setUTCMinutes(30);
    } else {
      candidate.setUTCMinutes(60); // rolls into next hour
    }
    return candidate.getTime();
  }
  if (typeKey === "artist-bedtime" || typeKey === "artist-wakeup") {
    // Bedtime = 3:00 VN = 20:00 UTC previous day. Wake-up = 8:00 VN =
    // 1:00 UTC same day. Compute the next UTC boundary that matches.
    const targetUtcHour = typeKey === "artist-bedtime" ? 20 : 1;
    const candidate = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      targetUtcHour, 0, 0, 0
    ));
    if (candidate.getTime() <= nowMs) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    return candidate.getTime();
  }
  return null; // event-driven
}

function nextAnnouncementSchedulerCheckMs(typeKey, now = new Date(), schedulerState = {}) {
  const {
    weeklyResetStartedAtMs = getWeeklyResetSchedulerStartedAtMs(),
    autoCleanupStartedAtMs = getAutoCleanupSchedulerStartedAtMs?.(),
    autoManageStartedAtMs = getAutoManageSchedulerStartedAtMs?.(),
  } = schedulerState;
  if (typeKey === "weekly-reset") {
    return nextIntervalTickMs(weeklyResetStartedAtMs, WEEKLY_RESET_TICK_MS, now);
  }
  if (typeKey === "hourly-cleanup") {
    return nextIntervalTickMs(autoCleanupStartedAtMs, AUTO_CLEANUP_TICK_MS, now);
  }
  if (typeKey === "stuck-nudge") {
    return nextIntervalTickMs(autoManageStartedAtMs, AUTO_MANAGE_DAILY_TICK_MS, now);
  }
  if (typeKey === "artist-bedtime" || typeKey === "artist-wakeup") {
    // These piggyback on the auto-cleanup scheduler tick, so the next
    // scheduler check is the same cadence. The dispatch logic inside
    // runAutoCleanupTick decides which path fires at tick time.
    return nextIntervalTickMs(autoCleanupStartedAtMs, AUTO_CLEANUP_TICK_MS, now);
  }
  return null;
}

function formatDiscordTimestampPair(ms) {
  const unixSec = Math.floor(ms / 1000);
  return `<t:${unixSec}:R> (<t:${unixSec}:F>)`;
}

function buildAnnouncementWhenItFiresText(typeKey, entry, current, guildCfg, now = new Date(), schedulerState = {}) {
  const {
    autoManageDisabled = process.env.AUTO_MANAGE_DAILY_DISABLED === "true",
  } = schedulerState;
  const triggerLine = `**Trigger:** ${entry?.trigger || "*(not defined)*"}`;
  const dedupLine = `**Dedup:** ${entry?.dedup || "*(none)*"}`;
  const ttlLine = `**Message TTL:** ${entry?.messageTtl || "*(permanent until manual delete)*"}`;
  const effectiveDestinationId = current?.channelId || guildCfg?.raidChannelId || null;
  const lines = [triggerLine];

  if (current?.enabled === false) {
    lines.push("**Next check:** Disabled (`/raid-announce action:on` to re-enable)");
    lines.push(dedupLine, ttlLine);
    return lines.join("\n");
  }

  if (!effectiveDestinationId) {
    lines.push(
      entry?.channelOverridable
        ? "**Next check:** Waiting for a destination channel (`set-channel` here or `/raid-channel config action:set`)"
        : "**Next check:** Waiting for `/raid-channel config action:set` (monitor channel not configured)"
    );
    lines.push(dedupLine, ttlLine);
    return lines.join("\n");
  }

  if (typeKey === "set-greeting" || typeKey === "whisper-ack") {
    lines.push("**Next check:** On-demand (fires when the trigger condition happens; not on a fixed schedule)");
    lines.push(dedupLine, ttlLine);
    return lines.join("\n");
  }

  if (typeKey === "hourly-cleanup" && guildCfg?.autoCleanupEnabled !== true) {
    lines.push("**Next check:** Disabled until `/raid-channel config action:schedule-on` is enabled");
    lines.push(dedupLine, ttlLine);
    return lines.join("\n");
  }

  // Bedtime + wake-up both ride the auto-cleanup scheduler tick, so
  // they're silent whenever the scheduler itself is off.
  if ((typeKey === "artist-bedtime" || typeKey === "artist-wakeup") && guildCfg?.autoCleanupEnabled !== true) {
    lines.push("**Next check:** Disabled until `/raid-channel config action:schedule-on` is enabled (shares the cleanup scheduler)");
    lines.push(dedupLine, ttlLine);
    return lines.join("\n");
  }

  if (typeKey === "stuck-nudge" && autoManageDisabled) {
    lines.push("**Next check:** Disabled by deploy killswitch (`AUTO_MANAGE_DAILY_DISABLED=true`)");
    lines.push(dedupLine, ttlLine);
    return lines.join("\n");
  }

  const eligibleBoundaryMs = nextAnnouncementEligibleBoundaryMs(typeKey, now);
  if (eligibleBoundaryMs) {
    lines.push(`**Next eligible boundary:** ${formatDiscordTimestampPair(eligibleBoundaryMs)}`);
  }

  const nextCheckMs = nextAnnouncementSchedulerCheckMs(typeKey, now, schedulerState);
  if (nextCheckMs) {
    lines.push(`**Next scheduler check:** ${formatDiscordTimestampPair(nextCheckMs)}`);
  } else {
    lines.push("**Next scheduler check:** After bot startup");
  }

  if (typeKey === "weekly-reset") {
    lines.push("**Note:** The announcement posts only if that scheduler pass actually resets at least one user and is still inside the Wed→Thu reset window.");
  } else if (typeKey === "hourly-cleanup") {
    lines.push("**Note:** The notice posts only after this guild's cleanup run completes.");
  } else if (typeKey === "stuck-nudge") {
    lines.push("**Note:** The nudge posts only if that tick finds a user whose logs are private.");
  }

  lines.push(dedupLine, ttlLine);
  return lines.join("\n");
}

let handleRaidAnnounceCommand;
let handleRaidAnnounceAutocomplete;
let handleRaidAutoManageCommand;
let handleRaidAutoManageAutocomplete;

let AUTO_MANAGE_SYNC_COOLDOWN_MS;
let getAutoManageCooldownMsFromService;
let acquireAutoManageSyncSlot;
let releaseAutoManageSyncSlot;
let formatAutoManageCooldownRemaining;
let autoManageEntryKey;
let gatherAutoManageLogsForUserDoc;
let applyAutoManageCollected;
let syncAutoManageForUserDoc;
let stampAutoManageAttempt;
let isPublicLogDisabledError;
let commitAutoManageOn;
let buildAutoManageHiddenCharsWarningEmbed;
let buildAutoManageSyncReportEmbed;
let weekResetStartMs;

let AUTO_CLEANUP_TICK_MS;
let AUTO_MANAGE_DAILY_TICK_MS;
let postChannelAnnouncement;
let getTargetCleanupSlotKey;
let buildCleanupNoticePreview;
let startRaidChannelScheduler;
let startAutoManageDailyScheduler;
let getAutoCleanupSchedulerStartedAtMs;
let getAutoManageSchedulerStartedAtMs;

let loadMonitorChannelCache;
let getMonitorCacheHealth;
let getCachedMonitorChannelId;
let setCachedMonitorChannelId;
let isTextMonitorEnabled;
let getMissingBotChannelPermissions;
let getMissingAnnouncementChannelPermissions;
let parseRaidMessage;
let handleRaidChannelMessage;
let cleanupRaidChannelMessages;
let postRaidChannelWelcome;
let resolveRaidMonitorChannel;


const autoManageCoreService = createAutoManageCoreService({
  EmbedBuilder,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  normalizeName,
  toModeLabel,
  getCharacterName,
  getCharacterClass,
  fetchRosterCharacters,
  buildFetchedRosterIndexes,
  findFetchedRosterMatchForCharacter,
  getRaidGateForBoss,
  RAID_REQUIREMENT_MAP,
  getGatesForRaid,
  normalizeAssignedRaid,
  ensureAssignedRaids,
  bibleLimiter,
});
({
  AUTO_MANAGE_SYNC_COOLDOWN_MS,
  getAutoManageCooldownMs: getAutoManageCooldownMsFromService,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  formatAutoManageCooldownRemaining,
  autoManageEntryKey,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  syncAutoManageForUserDoc,
  stampAutoManageAttempt,
  isPublicLogDisabledError,
  commitAutoManageOn,
  buildAutoManageHiddenCharsWarningEmbed,
  buildAutoManageSyncReportEmbed,
  weekResetStartMs,
} = autoManageCoreService);

const addRosterCommandHandlers = createAddRosterCommand({
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
});
({
  handleAddRosterCommand,
} = addRosterCommandHandlers);

const rosterRefreshService = createRosterRefreshService({
  normalizeName,
  foldName,
  getCharacterName,
  formatNextCooldownRemaining,
  buildFetchedRosterIndexes,
  findFetchedRosterMatchForCharacter,
  fetchRosterCharacters,
});
({
  collectStaleAccountRefreshes,
  applyStaleAccountRefreshes,
  formatRosterRefreshCooldownRemaining,
} = rosterRefreshService);

const autoManageSyncService = createAutoManageSyncService({
  User,
  saveWithRetry,
  ensureFreshWeek,
  applyAutoManageCollected,
});
({ applyAutoManageCollectedForStatus } = autoManageSyncService);

const raidStatusCommand = createRaidStatusCommand({
  EmbedBuilder,
  ComponentType,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  MessageFlags,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  getCharacterName,
  truncateText,
  formatShortRelative,
  formatNextCooldownRemaining,
  waitWithBudget,
  summarizeRaidProgress,
  formatRaidStatusLine,
  getStatusRaidsForCharacter,
  buildPaginationRow,
  collectStaleAccountRefreshes,
  applyStaleAccountRefreshes,
  formatRosterRefreshCooldownRemaining,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  applyAutoManageCollectedForStatus,
  stampAutoManageAttempt,
  weekResetStartMs,
  AUTO_MANAGE_SYNC_COOLDOWN_MS,
  getAutoManageCooldownMs,
  isManagerId,
});
({
  handleStatusCommand,
  buildAccountFreshnessLine,
  buildAccountPageEmbed,
  buildStatusFooterText,
} = raidStatusCommand);

const raidCheckCommandHandlers = createRaidCheckCommand({
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
  normalizeName,
  toModeLabel,
  getCharacterName,
  truncateText,
  getGatesForRaid,
  ensureAssignedRaids,
  getGateKeys,
  getRaidScanRange,
  buildRaidCheckUserQuery,
  buildAccountFreshnessLine,
  buildAccountPageEmbed,
  buildStatusFooterText,
  summarizeRaidProgress,
  getStatusRaidsForCharacter,
  buildPaginationRow,
  pickProgressIcon,
  resolveDiscordDisplay,
  loadFreshUserSnapshotForRaidViews,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  autoManageEntryKey,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  stampAutoManageAttempt,
  weekResetStartMs,
  isRaidLeader,
  isManagerId,
  getAutoManageCooldownMs,
  // Late-bind thunk wrapper: raid-set's factory composes AFTER
  // raid-check's below, so the `applyRaidSetForDiscordId` `let` binding
  // is still undefined at the moment this dep object is built. The
  // arrow captures the outer binding by reference and is only invoked
  // at interaction time when raid-set has long since composed and
  // filled in the value.
  applyRaidSetForDiscordId: (args) => applyRaidSetForDiscordId(args),
  RAID_REQUIREMENT_MAP,
  RAID_CHECK_USER_QUERY_FIELDS,
  ROSTER_KEY_SEP,
  raidCheckRefreshLimiter,
  raidCheckSyncLimiter,
  discordUserLimiter,
});
({
  buildRaidCheckSnapshotFromUsers,
  formatRaidCheckNotEligibleFieldValue,
  getRaidCheckRenderableChars,
  computeRaidCheckSnapshot,
  buildEditableCharsByUser,
  getEligibleRaidsForChar,
  getCharRaidGateStatus,
  applyLocalRaidEditToChar,
  buildRaidCheckEditDMEmbed,
  handleRaidCheckCommand,
  handleRaidCheckButton,
} = raidCheckCommandHandlers);

const raidSetCommandHandlers = createRaidSetCommand({
  EmbedBuilder,
  MessageFlags,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  normalizeName,
  getCharacterName,
  getCharacterClass,
  createCharacterId,
  loadUserForAutocomplete,
  getRaidRequirementList,
  RAID_REQUIREMENT_MAP,
  getGatesForRaid,
  ensureAssignedRaids,
  normalizeAssignedRaid,
  getGateKeys,
  toModeLabel,
});
({
  handleRaidSetAutocomplete,
  handleRaidSetCommand,
  applyRaidSetForDiscordId,
} = raidSetCommandHandlers);

const raidChannelMonitorService = createRaidChannelMonitorService({
  PermissionFlagsBits,
  EmbedBuilder,
  UI,
  GuildConfig,
  RAID_REQUIREMENT_MAP,
  getGatesForRaid,
  applyRaidSetForDiscordId,
  getAnnouncementsConfig,
  normalizeName,
});
({
  loadMonitorChannelCache,
  getMonitorCacheHealth,
  getCachedMonitorChannelId,
  setCachedMonitorChannelId,
  isTextMonitorEnabled,
  getMissingBotChannelPermissions,
  getMissingAnnouncementChannelPermissions,
  parseRaidMessage,
  handleRaidChannelMessage,
  cleanupRaidChannelMessages,
  postRaidChannelWelcome,
  resolveRaidMonitorChannel,
} = raidChannelMonitorService);

const raidSchedulerService = createRaidSchedulerService({
  GuildConfig,
  User,
  saveWithRetry,
  ensureFreshWeek,
  getAnnouncementsConfig,
  cleanupRaidChannelMessages,
  weekResetStartMs,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  isPublicLogDisabledError,
  stampAutoManageAttempt,
});
({
  AUTO_CLEANUP_TICK_MS,
  AUTO_MANAGE_DAILY_TICK_MS,
  postChannelAnnouncement,
  getTargetCleanupSlotKey,
  buildCleanupNoticePreview,
  startRaidChannelScheduler,
  startAutoManageDailyScheduler,
  getAutoCleanupSchedulerStartedAtMs,
  getAutoManageSchedulerStartedAtMs,
} = raidSchedulerService);

// Expose quiet-hours helpers for __test access. Tests exercise them via
// raid-command.__test so they stay behind the public boundary and aren't
// part of the runtime contract other callers can reach for.
const {
  getTargetVNDayKey,
  getCurrentVNHour,
  isInArtistQuietHours,
  hasReachedArtistWakeupBoundary,
  pickBedtimeNoticeContent,
  pickWakeupNoticeContent,
  ARTIST_QUIET_START_HOUR_VN,
  ARTIST_QUIET_END_HOUR_VN,
} = raidSchedulerService;

const raidHelpCommandHandlers = createRaidHelpCommand({
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  MessageFlags,
  UI,
});
({
  handleRaidHelpCommand,
  handleRaidHelpSelect,
} = raidHelpCommandHandlers);

const removeRosterCommandHandlers = createRemoveRosterCommand({
  EmbedBuilder,
  MessageFlags,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  normalizeName,
  getCharacterName,
  getCharacterClass,
  createCharacterId,
  loadUserForAutocomplete,
});
({
  handleRemoveRosterAutocomplete,
  handleRemoveRosterCommand,
} = removeRosterCommandHandlers);

const raidAnnounceCommandHandlers = createRaidAnnounceCommand({
  EmbedBuilder,
  MessageFlags,
  UI,
  GuildConfig,
  normalizeName,
  truncateText,
  announcementTypeEntry,
  getAnnouncementsConfig,
  buildCleanupNoticePreview,
  buildAnnouncementWhenItFiresText,
  getMissingAnnouncementChannelPermissions,
});
({
  handleRaidAnnounceCommand,
  handleRaidAnnounceAutocomplete,
} = raidAnnounceCommandHandlers);

const raidAutoManageCommandHandlers = createRaidAutoManageCommand({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  normalizeName,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  formatAutoManageCooldownRemaining,
  getAutoManageCooldownMs,
  weekResetStartMs,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  isPublicLogDisabledError,
  commitAutoManageOn,
  buildAutoManageSyncReportEmbed,
  buildAutoManageHiddenCharsWarningEmbed,
  stampAutoManageAttempt,
});
({
  handleRaidAutoManageCommand,
  handleRaidAutoManageAutocomplete,
} = raidAutoManageCommandHandlers);

const raidChannelCommandHandlers = createRaidChannelCommand({
  EmbedBuilder,
  MessageFlags,
  UI,
  GuildConfig,
  normalizeName,
  getCachedMonitorChannelId,
  setCachedMonitorChannelId,
  getMonitorCacheHealth,
  isTextMonitorEnabled,
  getMissingBotChannelPermissions,
  postRaidChannelWelcome,
  postChannelAnnouncement,
  getAnnouncementsConfig,
  resolveRaidMonitorChannel,
  cleanupRaidChannelMessages,
  getTargetCleanupSlotKey,
});
({
  handleRaidChannelCommand,
  handleRaidChannelAutocomplete,
} = raidChannelCommandHandlers);


module.exports = {
  commands,
  handleRaidManagementCommand,
  handleRaidHelpSelect,
  handleRaidSetAutocomplete,
  handleRemoveRosterAutocomplete,
  handleRaidChannelAutocomplete,
  handleRaidAutoManageAutocomplete,
  handleRaidAnnounceAutocomplete,
  handleRaidChannelMessage,
  handleRaidCheckButton,
  loadMonitorChannelCache,
  startRaidChannelScheduler,
  startAutoManageDailyScheduler,
  parseRaidMessage,
  __test: {
    buildRaidCheckSnapshotFromUsers,
    formatRaidCheckNotEligibleFieldValue,
    getRaidCheckRenderableChars,
    STATUS_PAGINATION_SESSION_MS,
    RAID_CHECK_PAGINATION_SESSION_MS,
    nextIntervalTickMs,
    nextAnnouncementEligibleBoundaryMs,
    nextAnnouncementSchedulerCheckMs,
    buildAnnouncementWhenItFiresText,
    buildRaidCheckUserQuery,
    foldName,
    buildFetchedRosterIndexes,
    findFetchedRosterMatchForCharacter,
    applyStaleAccountRefreshes,
    formatNextCooldownRemaining,
    buildAccountFreshnessLine,
    formatRosterRefreshCooldownRemaining,
    ROSTER_REFRESH_COOLDOWN_MS,
    ROSTER_REFRESH_FAILURE_COOLDOWN_MS,
    AUTO_MANAGE_SYNC_COOLDOWN_MS,
    isManagerId,
    getAutoManageCooldownMs,
    getTargetVNDayKey,
    getCurrentVNHour,
    isInArtistQuietHours,
    hasReachedArtistWakeupBoundary,
    pickBedtimeNoticeContent,
    pickWakeupNoticeContent,
    ARTIST_QUIET_START_HOUR_VN,
    ARTIST_QUIET_END_HOUR_VN,
    buildEditableCharsByUser,
    getEligibleRaidsForChar,
    getCharRaidGateStatus,
    applyLocalRaidEditToChar,
    buildRaidCheckEditDMEmbed,
  },
};
