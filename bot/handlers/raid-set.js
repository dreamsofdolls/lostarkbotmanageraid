const { buildNoticeEmbed } = require("../utils/raid/shared");
const {
  getRosterMatches,
  getCharacterMatches,
  truncateChoice,
} = require("../utils/raid/autocomplete-helpers");
const {
  getAccessibleAccounts,
  canEditAccount,
} = require("../services/access-control");
const { t, getUserLanguage } = require("../services/i18n");
const { getRaidModeLabel } = require("../utils/raid/labels");

function createRaidSetCommand(deps) {
  const {
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
    // Cross-user loader injected by the wiring layer. Returns lean user
    // docs whose accounts include at least one entry with
    // `registeredBy === discordId`. Optional - test harnesses that don't
    // exercise the helper-Manager path can omit it (default no-op).
    loadAccountsRegisteredBy = async () => [],
    getRaidRequirementList,
    RAID_REQUIREMENT_MAP,
    getGatesForRaid,
    ensureAssignedRaids,
    normalizeAssignedRaid,
    getGateKeys,
    toModeLabel,
  } = deps;

  // Build a human-readable owner label from the cached Discord identity
  // fields on the user doc. Preference order matches what shows up in
  // the Discord client: server display name > global name > legacy
  // username > raw discordId. Used only for autocomplete picker labels;
  // the discordId remains the source of truth for routing the write.
  function pickOwnerLabel(userDoc) {
    if (!userDoc) return "(unknown user)";
    const candidates = [
      userDoc.discordDisplayName,
      userDoc.discordGlobalName,
      userDoc.discordUsername,
    ];
    for (const candidate of candidates) {
      const trimmed = String(candidate || "").trim();
      if (trimmed) return trimmed;
    }
    return userDoc.discordId || "(unknown user)";
  }

  // Flatten the cross-user query result into per-account rows so
  // autocomplete and resolveRosterOwner can iterate without re-walking
  // the user docs each time. Filters out any account whose
  // `registeredBy` doesn't actually match the executor (defensive: the
  // Mongo query matches at the user-doc level via the multikey index,
  // so a user doc with mixed-helper accounts could surface unrelated
  // siblings without this per-account filter).
  function flattenRegisteredAccounts(userDocs, executorId) {
    const out = [];
    if (!Array.isArray(userDocs)) return out;
    for (const doc of userDocs) {
      if (!doc || !Array.isArray(doc.accounts)) continue;
      const ownerLabel = pickOwnerLabel(doc);
      for (const account of doc.accounts) {
        if (account?.registeredBy !== executorId) continue;
        out.push({
          ownerDiscordId: doc.discordId,
          ownerLabel,
          account,
        });
      }
    }
    return out;
  }

  // Resolve a roster name picked in /raid-set to the user doc that
  // actually owns it. Search order:
  //   1. The executor's own accounts (self-add path - status quo).
  //   2. Helper-added accounts where `registeredBy === executor.id`
  //      (Manager onboarding flow).
  // Returns null when neither matches, an `{ ambiguous, matches }`
  // sentinel when the helper-side search hits >1 owner with the same
  // accountName (rare but possible if char-name uniqueness is broken
  // across regions), or `{ ownerDiscordId, ownerLabel, account }`
  // when exactly one match is found.
  async function resolveRosterOwner(executorId, rosterName) {
    if (!rosterName) return null;
    const target = normalizeName(rosterName);
    const ownDoc = await loadUserForAutocomplete(executorId);
    if (ownDoc && Array.isArray(ownDoc.accounts)) {
      const ownAccount = ownDoc.accounts.find(
        (a) => normalizeName(a.accountName) === target
      );
      if (ownAccount) {
        return {
          ownerDiscordId: executorId,
          ownerLabel: null,
          ownerDoc: ownDoc,
          account: ownAccount,
          actingForOther: false,
        };
      }
    }
    const registeredDocs = await loadAccountsRegisteredBy(executorId);
    const flattened = flattenRegisteredAccounts(registeredDocs, executorId);
    const matches = flattened.filter(
      (entry) => normalizeName(entry.account.accountName) === target
    );
    if (matches.length === 1) {
      // Surface the full owner doc so autocomplete callers that need the
      // whole accounts array (character / raid filtering) can reuse the
      // registered-by query result instead of round-tripping again via
      // loadUserForAutocomplete(ownerDiscordId).
      const ownerDoc =
        Array.isArray(registeredDocs)
          ? registeredDocs.find((doc) => doc?.discordId === matches[0].ownerDiscordId) || null
          : null;
      return { ...matches[0], ownerDoc, actingForOther: true };
    }
    if (matches.length > 1) {
      return { ambiguous: true, matches };
    }
    // Final lookup tier: rosters Manager A has shared with the executor
    // via /raid-share grant. Distinct from the helper-registered path
    // above (which keys off `account.registeredBy === executor`); a share
    // grants access without changing roster ownership. Returns
    // `actingForOther: true` so the existing executor-not-owner branches
    // (auth re-check, etc.) trigger naturally.
    let accessible = [];
    try {
      accessible = await getAccessibleAccounts(executorId);
    } catch (err) {
      console.warn("[raid-set] getAccessibleAccounts failed:", err.message);
      return null;
    }
    const sharedMatch = accessible.find(
      (entry) => !entry.isOwn && normalizeName(entry.accountName) === target
    );
    if (!sharedMatch) return null;

    const ownerDoc = await User.findOne({ discordId: sharedMatch.ownerDiscordId });
    if (!ownerDoc || !Array.isArray(ownerDoc.accounts)) return null;
    const ownerAccount = ownerDoc.accounts.find(
      (a) => normalizeName(a.accountName) === target
    );
    if (!ownerAccount) return null;
    return {
      ownerDiscordId: sharedMatch.ownerDiscordId,
      ownerLabel: sharedMatch.ownerLabel,
      ownerDoc,
      account: ownerAccount,
      actingForOther: true,
      viaShare: true,
      shareLevel: sharedMatch.accessLevel,
    };
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
  // Autocomplete for the /raid-set `roster` option - lists user's own
  // accounts AND any account where the executor is `registeredBy` (i.e.
  // Manager onboarding flow's helper rosters). Own-rosters use the
  // existing `📁` glyph; helper-added rosters use `👥` plus the owner's
  // display name suffix so the Manager can tell at a glance whose
  // progress they are about to edit.
  async function autocompleteRaidSetRoster(interaction, focused) {
    const executorId = interaction.user.id;
    const needle = focused.value || "";
    const target = normalizeName(needle);
    // Resolve executor's locale once per autocomplete tick so all 3
    // choice categories render in their language. getUserLanguage hits
    // the in-process cache after the first call so per-keystroke fan-out
    // stays cheap.
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const charsWord = (n) =>
      t(
        n === 1 ? "raid-set.autocomplete.charsSingular" : "raid-set.autocomplete.charsPlural",
        lang,
      );
    const ownDoc = await loadUserForAutocomplete(executorId);
    const ownMatches = getRosterMatches(ownDoc, needle);
    const ownChoices = ownMatches.map((a) => {
      const charCount = Array.isArray(a.characters) ? a.characters.length : 0;
      const label = t("raid-set.autocomplete.ownChoice", lang, {
        name: a.accountName,
        charCount,
        charsWord: charsWord(charCount),
      });
      return truncateChoice(label, a.accountName);
    });
    let helperChoices = [];
    try {
      const registeredDocs = await loadAccountsRegisteredBy(executorId);
      const flattened = flattenRegisteredAccounts(registeredDocs, executorId);
      helperChoices = flattened
        .filter(
          (entry) =>
            !target || normalizeName(entry.account.accountName).includes(target)
        )
        .map((entry) => {
          const charCount = Array.isArray(entry.account.characters)
            ? entry.account.characters.length
            : 0;
          const label = t("raid-set.autocomplete.helperChoice", lang, {
            name: entry.account.accountName,
            charCount,
            charsWord: charsWord(charCount),
            owner: entry.ownerLabel,
          });
          return truncateChoice(label, entry.account.accountName);
        });
    } catch (err) {
      // Helper-added lookup is best-effort - if Mongo flakes here we
      // still want to surface the executor's own rosters rather than
      // failing the entire autocomplete.
      console.warn(
        "[raid-set autocomplete] loadAccountsRegisteredBy failed:",
        err?.message || err
      );
    }
    // Roster shares granted by Manager A to executor via /raid-share grant.
    // Distinct from helperChoices because share access doesn't change
    // roster ownership; the autocomplete tag therefore differs ("shared
    // by" vs the helper-Manager equivalent). View-level shares carry the
    // 👁️ tag so the executor sees they cannot /raid-set on that roster
    // even if it's pickable.
    let shareChoices = [];
    try {
      const accessible = await getAccessibleAccounts(executorId);
      shareChoices = accessible
        .filter(
          (entry) =>
            !entry.isOwn &&
            (!target || normalizeName(entry.accountName).includes(target))
        )
        .map((entry) => {
          const charCount = Array.isArray(entry.account?.characters)
            ? entry.account.characters.length
            : 0;
          const accessTag =
            entry.accessLevel === "view"
              ? t("raid-set.autocomplete.sharedAccessTagView", lang, {
                  viewLabel: t("share.accessLevel.view", lang),
                })
              : "";
          const label = t("raid-set.autocomplete.sharedChoice", lang, {
            name: entry.accountName,
            charCount,
            charsWord: charsWord(charCount),
            owner: entry.ownerLabel,
            accessTag,
          });
          return truncateChoice(label, entry.accountName);
        });
    } catch (err) {
      console.warn(
        "[raid-set autocomplete] getAccessibleAccounts failed:",
        err?.message || err
      );
    }

    const merged = [...ownChoices, ...helperChoices, ...shareChoices].slice(0, 25);
    await interaction.respond(merged).catch(() => {});
  }
  // Character autocomplete for /raid-set. Reads the upstream `roster` option
  // (now required) and filters to just that account's chars - sidesteps the
  // Discord 25-result cap when the user has 5+ rosters worth of characters
  // (~30+ total), which the flat "top 25 by iLvl" approach silently truncated.
  // When the picked roster is helper-added (Manager onboarding), this
  // resolves the actual owner's user doc via resolveRosterOwner so the char
  // list reflects the registered user's roster, not the executor's own.
  async function autocompleteRaidSetCharacter(interaction, focused) {
    const executorId = interaction.user.id;
    const rosterInput = interaction.options.getString("roster") || "";
    let userDoc = null;
    if (rosterInput) {
      const resolved = await resolveRosterOwner(executorId, rosterInput);
      if (resolved && !resolved.ambiguous && resolved.ownerDoc) {
        userDoc = resolved.ownerDoc;
      }
    }
    if (!userDoc) {
      // Fallback when roster hasn't been picked yet, or pick is invalid:
      // surface the executor's own chars. Discord autocomplete fires
      // per-keystroke regardless of field-fill order, so the char field
      // has to render something useful before roster is finalized.
      userDoc = await loadUserForAutocomplete(executorId);
    }
    const entries = getCharacterMatches(userDoc, {
      rosterFilter: rosterInput || null,
      needle: focused.value || "",
    });
    const choices = entries.map((entry) =>
      truncateChoice(
        `${entry.name} · ${entry.className} · ${entry.itemLevel}`,
        entry.name
      )
    );
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
    const executorId = interaction.user.id;
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
    // Resolve owner from the picked roster so the iLvl-aware progress
    // labels read from the right user's character. Without this, a
    // Manager picking a helper-added roster would see their own roster's
    // (or empty) progress instead of the registered user's.
    let userDoc = null;
    if (rosterInput) {
      const resolved = await resolveRosterOwner(executorId, rosterInput);
      if (resolved && !resolved.ambiguous && resolved.ownerDoc) {
        userDoc = resolved.ownerDoc;
      }
    }
    if (!userDoc) {
      userDoc = await loadUserForAutocomplete(executorId);
    }
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
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const baseChoices = [
      { name: t("raid-set.statusChoices.complete", lang), value: "complete" },
      { name: t("raid-set.statusChoices.process", lang), value: "process" },
      { name: t("raid-set.statusChoices.reset", lang), value: "reset" },
    ];
    const applyFilter = (list) =>
      list.filter((c) => !needle || normalizeName(c.name).includes(needle));
    const raidMeta = RAID_REQUIREMENT_MAP[raidValue];
    if (!characterInput || !raidMeta) {
      await interaction.respond(applyFilter(baseChoices)).catch(() => {});
      return;
    }
    // Same owner-resolution as autocompleteRaidSetRaid: helper-added
    // rosters need to read the registered user's character to detect the
    // "raid already complete -> only Reset is offered" branch correctly.
    let userDoc = null;
    if (rosterInput) {
      const resolved = await resolveRosterOwner(executorId, rosterInput);
      if (resolved && !resolved.ambiguous && resolved.ownerDoc) {
        userDoc = resolved.ownerDoc;
      }
    }
    if (!userDoc) {
      userDoc = await loadUserForAutocomplete(executorId);
    }
    const character = findCharacterInUser(userDoc, characterInput, rosterInput || null);
    if (!character) {
      await interaction.respond(applyFilter(baseChoices)).catch(() => {});
      return;
    }
    const { isComplete } = computeRaidProgress(character, raidMeta);
    if (isComplete) {
      // Raid is fully done — Reset is the only valid action. Do NOT
      // run the typed-needle filter against the single choice: if the
      // user previously typed "complete" or "process" against a different
      // raid then switched here, that needle would filter out the Reset
      // option entirely and Discord would render an empty dropdown the
      // user can't escape. Always surface Reset for done raids.
      await interaction
        .respond([{ name: t("raid-set.statusChoices.resetOnly", lang), value: "reset" }])
        .catch(() => {});
      return;
    }
    await interaction.respond(applyFilter(baseChoices)).catch(() => {});
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
   *   { noRoster?, authLost?, matched, updated, ineligibleItemLevel, modeResetCount }
   */
  async function applyRaidSetForDiscordId({
    discordId,
    executorId = null,
    characterName,
    rosterName = null,
    raidMeta,
    statusType,
    effectiveGates,
    requireLocalSyncEnabled = false,
  }) {
    const gateList = Array.isArray(effectiveGates) ? effectiveGates.filter(Boolean) : [];
    const selectedDifficulty = toModeLabel(raidMeta.modeKey);
    let noRoster = false;
    let updatedCount = 0;
    let matchedCount = 0;
    let ineligibleItemLevel = 0;
    let modeResetCount = 0;
    let alreadyComplete = false;
    let alreadyReset = false;
    let authLost = false;
    let syncDisabled = false;
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
      alreadyReset = false;
      authLost = false;
      syncDisabled = false;
      displayName = "";
      const userDoc = await User.findOne({ discordId });
      if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
        // No roster at all - single-read detection inside retry, so we
        // avoid a duplicate pre-check findOne and stay consistent if the
        // document is created concurrently.
        noRoster = true;
        return;
      }
      if (requireLocalSyncEnabled && !userDoc.localSyncEnabled) {
        syncDisabled = true;
        return;
      }
      ensureFreshWeek(userDoc);
      // Helper-Manager slash writes are authorized by account.registeredBy,
      // which was read once during resolveRosterOwner. Re-check it on the
      // fresh document inside the retry/write closure so a remove/re-add or
      // ownership change between resolve and save cannot write into a new
      // same-named roster.
      if (executorId && executorId !== discordId) {
        const rosterTarget = rosterName ? normalizeName(rosterName) : "";
        const account = userDoc.accounts.find(
          (item) => normalizeName(item.accountName) === rosterTarget
        );
        if (!account) {
          authLost = true;
          return;
        }
        const isHelperManager = account.registeredBy === executorId;
        // /raid-share edit grant: executor is allowed to edit the
        // owner's roster because Manager A (the owner) ran
        // /raid-share grant target:executor permission:edit. View-level
        // shares are filtered out by canEditAccount so a share-only
        // viewer can never bypass the helper-Manager auth path.
        const isShareEdit = !isHelperManager
          && (await canEditAccount(executorId, discordId));
        if (!isHelperManager && !isShareEdit) {
          authLost = true;
          return;
        }
      }
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
      // Symmetric short-circuit for reset: if no mode-change would fire AND
      // every target gate is already unstamped (completedDate missing or 0),
      // the reset is a pure no-op. Without this, applyRaidSetForDiscordId
      // re-writes { completedDate: null } on top of already-null gates, still
      // returns updated: true, and the /raid-check Edit DM ends up telling
      // the member "Artist vừa Reset về 0" for a raid they never touched.
      // Codex flagged this after the Edit DM landed.
      if (!shouldMarkDone && !modeChangeDetected) {
        const everyTargetAlreadyEmpty = gateKeys.length === 0 || gateKeys.every((g) => {
          const entry = raidData[g];
          return !entry || !(Number(entry.completedDate) > 0);
        });
        if (everyTargetAlreadyEmpty) {
          alreadyReset = true;
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
      authLost,
      syncDisabled,
      matched: matchedCount > 0,
      updated: updatedCount > 0,
      alreadyComplete,
      alreadyReset,
      ineligibleItemLevel,
      modeResetCount,
      selectedDifficulty,
      displayName,
    };
  }
  async function handleRaidSetCommand(interaction) {
    const executorId = interaction.user.id;
    // Executor's locale - the slash invoker IS the only viewer of every
    // ephemeral reply on /raid-set, so this lang threads through every
    // notice + success embed without any clicker-vs-owner split.
    const lang = await getUserLanguage(executorId, { UserModel: User });
    // Localized raid label ("アクト4 ハード" / "Act 4 Hard") for use in
    // user-facing strings. Models keep canonical EN; locale lookup
    // happens here at render time.
    const localizedRaidLabel = (key) => {
      const meta = RAID_REQUIREMENT_MAP[key];
      if (!meta) return key;
      return getRaidModeLabel(meta.raidKey, meta.modeKey, lang);
    };
    const rosterName = interaction.options.getString("roster", true).trim();
    const characterName = interaction.options.getString("character", true).trim();
    const raidKey = interaction.options.getString("raid", true);
    const statusType = interaction.options.getString("status", true);
    const targetGate = interaction.options.getString("gate") || "";
    const raidMeta = RAID_REQUIREMENT_MAP[raidKey];
    if (!raidMeta) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-set.invalid.raidTitle", lang),
            description: t("raid-set.invalid.raidDescription", lang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!["complete", "reset", "process"].includes(statusType)) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-set.invalid.statusTitle", lang),
            description: t("raid-set.invalid.statusDescription", lang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const effectiveGate = statusType === "process" ? targetGate : "";
    if (statusType === "process") {
      if (!targetGate) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: t("raid-set.invalid.processNeedsGateTitle", lang),
              description: t("raid-set.invalid.processNeedsGateDescription", lang),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const validGates = getGatesForRaid(raidMeta.raidKey);
      if (!validGates.includes(targetGate)) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: t("raid-set.invalid.gateTitle", lang),
              description: t("raid-set.invalid.gateDescription", lang, {
                gate: targetGate,
                raidLabel: localizedRaidLabel(raidKey),
                validGates: validGates.map((g) => `\`${g}\``).join(", "),
              }),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
    // Resolve which user actually owns the picked roster. This is the
    // single point where /raid-set decides between self-edit (executor's
    // own roster) and helper-Manager edit (a roster the executor
    // previously registered for someone else via /raid-add-roster target:).
    // Anything below this line operates on `targetDiscordId`, never
    // `executorId`, so the rest of the handler is owner-agnostic.
    // Deliberately runs AFTER the cheap input validations above so a
    // bad raid / status / gate input does not pay an extra Mongo round
    // trip.
    const resolvedOwner = await resolveRosterOwner(executorId, rosterName);
    if (!resolvedOwner) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-set.roster.notFoundTitle", lang),
            description: t("raid-set.roster.notFoundDescription", lang, { rosterName }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (resolvedOwner.ambiguous) {
      const ownerNames = resolvedOwner.matches
        .map((entry) => entry.ownerLabel)
        .join(", ");
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-set.roster.ambiguousTitle", lang),
            description: t("raid-set.roster.ambiguousDescription", lang, {
              count: resolvedOwner.matches.length,
              rosterName,
              ownerNames,
            }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const targetDiscordId = resolvedOwner.ownerDiscordId;
    const actingForOther = resolvedOwner.actingForOther;
    const ownerLabel = resolvedOwner.ownerLabel;
    // /raid-set slash command keeps explicit single-gate semantics - admin
    // power-user surface needs the ability to mark exactly one gate without
    // cascading to earlier ones (edge cases like fixing a bad record).
    // Routes through `targetDiscordId` rather than `executorId` so a
    // helper Manager (registeredBy match) writes to the registered
    // user's doc, not their own.
    const result = await applyRaidSetForDiscordId({
      discordId: targetDiscordId,
      executorId,
      characterName,
      rosterName,
      raidMeta,
      statusType,
      effectiveGates: effectiveGate ? [effectiveGate] : [],
    });
    if (result.noRoster) {
      // After resolveRosterOwner succeeded but applyRaidSetForDiscordId
      // still saw no accounts, the registered user's roster was deleted
      // (or never existed) between the two reads. Surface a precise
      // notice depending on whether we were acting on our own behalf or
      // a helper-Manager target so the executor knows who has to act.
      const description = actingForOther
        ? t("raid-set.roster.deletedForOtherDescription", lang, {
            target: targetDiscordId,
          })
        : t("raid-set.roster.noRosterDescription", lang);
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: actingForOther
              ? t("raid-set.roster.deletedForOtherTitle", lang)
              : t("raid-set.roster.noRosterTitle", lang),
            description,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (result.authLost) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "lock",
            title: t("raid-set.roster.authLostTitle", lang),
            description: t("raid-set.roster.authLostDescription", lang, {
              rosterName,
              target: targetDiscordId,
            }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (!result.matched) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-set.character.notFoundTitle", lang),
            description: t("raid-set.character.notFoundDescription", lang, {
              characterName,
              rosterName,
            }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (result.alreadyComplete) {
      const localizedRaid = localizedRaidLabel(raidKey);
      const scope = effectiveGate ? `${localizedRaid} · ${effectiveGate}` : localizedRaid;
      // Description carries the same trio of facts (character / raid /
      // gate) inline. Dropping the cold 3-field inline table avoids the
      // "tabular log entry" feel the embed used to have — Artist voice
      // reads as a sentence instead of a database row.
      const alreadyEmbed = new EmbedBuilder()
        .setColor(UI.colors.progress)
        .setTitle(`${UI.icons.info} ${t("raid-set.already.completeTitle", lang)}`)
        .setDescription(
          t("raid-set.already.completeDescription", lang, {
            characterName,
            scope,
          }),
        )
        .setTimestamp();
      await interaction.reply({ embeds: [alreadyEmbed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (result.alreadyReset) {
      const localizedRaid = localizedRaidLabel(raidKey);
      const scope = effectiveGate ? `${localizedRaid} · ${effectiveGate}` : localizedRaid;
      const alreadyResetEmbed = new EmbedBuilder()
        .setColor(UI.colors.muted)
        .setTitle(`${UI.icons.info} ${t("raid-set.already.resetTitle", lang)}`)
        .setDescription(
          t("raid-set.already.resetDescription", lang, {
            characterName,
            scope,
          }),
        )
        .setTimestamp();
      await interaction.reply({ embeds: [alreadyResetEmbed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (!result.updated) {
      // By this point noRoster / matched / alreadyComplete / alreadyReset are
      // all handled. The only remaining not-updated branch is ineligible iLvl.
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-set.character.notEligibleTitle", lang),
            description: t("raid-set.character.notEligibleDescription", lang, {
              characterName,
              itemLevel: result.ineligibleItemLevel,
              minItemLevel: raidMeta.minItemLevel,
              raidLabel: localizedRaidLabel(raidKey),
            }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const markedDone = statusType === "complete" || statusType === "process";
    // Title + Artist-voice description. Dropping the 3-column inline
    // field table (Character / Raid / Gates) - that read like a
    // database log entry. Description carries the same facts as a
    // sentence, with statusType-specific phrasing for nuance:
    //   - process: "vừa clear G_X" + roadmap hint
    //   - complete: "mark cả raid done"
    //   - reset:    "xoá sạch tiến độ"
    const localizedRaid = localizedRaidLabel(raidKey);
    let titleText;
    let descText;
    if (statusType === "process") {
      titleText = t("raid-set.success.processTitle", lang);
      descText = t("raid-set.success.processDescription", lang, {
        gate: effectiveGate,
        raidLabel: localizedRaid,
        characterName,
      });
    } else if (statusType === "complete") {
      titleText = t("raid-set.success.completeTitle", lang);
      descText = t("raid-set.success.completeDescription", lang, {
        raidLabel: localizedRaid,
        characterName,
      });
    } else {
      titleText = t("raid-set.success.resetTitle", lang);
      descText = t("raid-set.success.resetDescription", lang, {
        raidLabel: localizedRaid,
        characterName,
      });
    }
    // Helper-Manager hint: prepend a line so the executor sees clearly
    // that the write landed on someone else's roster (a roster they
    // previously registered via /raid-add-roster target:). Reply is
    // ephemeral, so the `<@id>` mention does not ping the target - it
    // just renders as a clickable display-name pill for confirmation.
    if (actingForOther) {
      const labelHint = ownerLabel
        ? t("raid-set.success.helperLabelHint", lang, { ownerLabel })
        : "";
      const helperPrefix = t("raid-set.success.helperPrefix", lang, {
        iconInfo: UI.icons.info,
        target: targetDiscordId,
        labelHint,
      });
      descText = `${helperPrefix}${descText}`;
    }
    const resultEmbed = new EmbedBuilder()
      .setTitle(`${markedDone ? UI.icons.done : UI.icons.reset} ${titleText}`)
      .setColor(markedDone ? UI.colors.success : UI.colors.muted)
      .setDescription(descText)
      .setTimestamp();
    if (result.modeResetCount > 0) {
      resultEmbed.setFooter({
        text: t("raid-set.success.modeChangedFooter", lang, {
          mode: result.selectedDifficulty,
        }),
      });
    }
    await interaction.reply({
      embeds: [resultEmbed],
      flags: MessageFlags.Ephemeral,
      // Belt-and-braces: even though ephemeral replies do not fire
      // notifications, suppress mention parse so the target user
      // never gets a phantom ping while the Manager is reviewing.
      allowedMentions: { parse: [] },
    });
  }
  return {
    handleRaidSetAutocomplete,
    handleRaidSetCommand,
    applyRaidSetForDiscordId,
    // Exposed for tests in test/raid-set.test.js so the helper-Manager
    // routing can be exercised without driving the full slash-command
    // handler through a mock Discord interaction.
    resolveRosterOwner,
  };
}

module.exports = {
  createRaidSetCommand,
};
