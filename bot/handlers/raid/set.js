const { buildNoticeEmbed } = require("../../utils/raid/common/shared");
const {
  getRosterMatches,
  getCharacterMatches,
  truncateChoice,
} = require("../../utils/raid/common/autocomplete");
const {
  getAccessibleAccounts,
  canEditAccount,
} = require("../../services/access/access-control");
const { t, getUserLanguage } = require("../../services/i18n");
const { createRosterOwnerResolver } = require("../../services/raid/roster-owner-resolver");
const { getRaidModeLabel } = require("../../utils/raid/common/labels");
const {
  findCharacterInUser: findCharacterEntryInUser,
} = require("../../utils/raid/tasks/side-tasks");

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

  const { flattenRegisteredAccounts, resolveRosterOwner } = createRosterOwnerResolver({
    User,
    normalizeName,
    loadUserForAutocomplete,
    loadAccountsRegisteredBy,
    getAccessibleAccounts,
  });

  function findCharacterInUser(userDoc, characterName, rosterName = null) {
    return findCharacterEntryInUser(userDoc, characterName, rosterName)?.character || null;
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
    const storedDifficulty = assigned?.modeKey
      ? toModeLabel(assigned.modeKey)
      : (assigned?.G1?.difficulty || assigned?.G2?.difficulty || "Normal");
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

  function makeRaidSetResult(raidMeta) {
    return {
      noRoster: false,
      authLost: false,
      syncDisabled: false,
      matched: false,
      updated: false,
      alreadyComplete: false,
      alreadyReset: false,
      ineligibleItemLevel: 0,
      modeResetCount: 0,
      selectedDifficulty: toModeLabel(raidMeta?.modeKey),
      displayName: "",
    };
  }

  async function applyRaidSetToLoadedUserDoc(userDoc, {
    discordId,
    executorId = null,
    characterName,
    rosterName = null,
    raidMeta,
    statusType,
    effectiveGates,
    requireLocalSyncEnabled = false,
  }, now = Date.now()) {
    const result = makeRaidSetResult(raidMeta);
    const gateList = Array.isArray(effectiveGates) ? effectiveGates.filter(Boolean) : [];
    const selectedDifficulty = result.selectedDifficulty;
    if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
      result.noRoster = true;
      return result;
    }
    if (requireLocalSyncEnabled && !userDoc.localSyncEnabled) {
      result.syncDisabled = true;
      return result;
    }
    if (executorId && executorId !== discordId) {
      const rosterTarget = rosterName ? normalizeName(rosterName) : "";
      const account = userDoc.accounts.find(
        (item) => normalizeName(item.accountName) === rosterTarget
      );
      if (!account) {
        result.authLost = true;
        return result;
      }
      const isHelperManager = account.registeredBy === executorId;
      const isShareEdit = !isHelperManager
        && (await canEditAccount(executorId, discordId));
      if (!isHelperManager && !isShareEdit) {
        result.authLost = true;
        return result;
      }
    }

    const character = findCharacterInUser(userDoc, characterName, rosterName);
    if (!character) return result;
    result.matched = true;
    result.displayName = getCharacterName(character);
    const charItemLevel = Number(character.itemLevel) || 0;
    if (charItemLevel < raidMeta.minItemLevel) {
      result.ineligibleItemLevel = charItemLevel;
      return result;
    }

    const normalizedSelectedDiff = normalizeName(selectedDifficulty);
    const officialGateList = getGatesForRaid(raidMeta.raidKey);
    const assignedRaids = ensureAssignedRaids(character);
    const raidData = normalizeAssignedRaid(
      assignedRaids[raidMeta.raidKey] || {},
      selectedDifficulty,
      raidMeta.raidKey
    );
    const existingModeKey = raidData.modeKey || "";
    const shouldMarkDone = statusType === "complete" || statusType === "process";
    let modeChangeDetected = false;
    let modeHadProgress = false;
    if (shouldMarkDone && existingModeKey && existingModeKey !== raidMeta.modeKey) {
      modeChangeDetected = true;
    }
    if (shouldMarkDone) {
      for (const g of officialGateList) {
        const existingDiff = raidData[g]?.difficulty;
        if (existingDiff && normalizeName(existingDiff) !== normalizedSelectedDiff) {
          modeChangeDetected = true;
          if (Number(raidData[g]?.completedDate) > 0) modeHadProgress = true;
          break;
        }
      }
    }
    if (modeChangeDetected) {
      for (const g of officialGateList) {
        raidData[g] = { difficulty: selectedDifficulty, completedDate: undefined };
      }
      result.modeResetCount = modeHadProgress ? 1 : 0;
    }
    if (shouldMarkDone) raidData.modeKey = raidMeta.modeKey;
    const gateKeys = gateList.length > 0 ? gateList : getGateKeys(raidData);
    if (shouldMarkDone && !modeChangeDetected) {
      const everyTargetAlreadyDone = gateKeys.length > 0 && gateKeys.every((g) => {
        const entry = raidData[g];
        if (!entry) return false;
        if (!(Number(entry.completedDate) > 0)) return false;
        const entryDiff = normalizeName(entry.difficulty || "");
        return !entryDiff || entryDiff === normalizedSelectedDiff;
      });
      if (everyTargetAlreadyDone) {
        result.alreadyComplete = true;
        return result;
      }
    }
    if (!shouldMarkDone && !modeChangeDetected) {
      const everyTargetAlreadyEmpty = gateKeys.length === 0 || gateKeys.every((g) => {
        const entry = raidData[g];
        return !entry || !(Number(entry.completedDate) > 0);
      });
      if (everyTargetAlreadyEmpty) {
        result.alreadyReset = true;
        return result;
      }
    }

    for (const gate of gateKeys) {
      const existingEntry = raidData[gate] || {};
      raidData[gate] = {
        difficulty: shouldMarkDone
          ? selectedDifficulty
          : (existingEntry.difficulty || selectedDifficulty),
        completedDate: shouldMarkDone ? now : null,
      };
    }
    if (shouldMarkDone) raidData.modeKey = raidMeta.modeKey;
    assignedRaids[raidMeta.raidKey] = raidData;
    character.assignedRaids = assignedRaids;
    if (!character.name) character.name = getCharacterName(character);
    if (!character.class) character.class = getCharacterClass(character);
    if (!character.id) character.id = createCharacterId();
    result.updated = true;
    return result;
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
    let result = makeRaidSetResult(raidMeta);
    await saveWithRetry(async () => {
      // Reset result on each retry attempt so VersionError retries start
      // from a clean status object.
      result = makeRaidSetResult(raidMeta);
      const userDoc = await User.findOne({ discordId });
      if (userDoc) ensureFreshWeek(userDoc);
      result = await applyRaidSetToLoadedUserDoc(userDoc, {
        discordId,
        executorId,
        characterName,
        rosterName,
        raidMeta,
        statusType,
        effectiveGates,
        requireLocalSyncEnabled,
      });
      if (result.updated) await userDoc.save();
    });
    return result;
  }

  async function applyRaidSetBatchForDiscordId({
    discordId,
    entries,
    requireLocalSyncEnabled = false,
  }) {
    const list = Array.isArray(entries) ? entries : [];
    let results = list.map((entry) => makeRaidSetResult(entry?.raidMeta));
    await saveWithRetry(async () => {
      results = [];
      const userDoc = await User.findOne({ discordId });
      if (!userDoc) {
        results = list.map((entry) => ({
          ...makeRaidSetResult(entry?.raidMeta),
          noRoster: true,
        }));
        return;
      }
      ensureFreshWeek(userDoc);
      const now = Date.now();
      let didUpdate = false;
      for (const entry of list) {
        const result = await applyRaidSetToLoadedUserDoc(userDoc, {
          discordId,
          executorId: null,
          characterName: entry.characterName,
          rosterName: entry.rosterName || null,
          raidMeta: entry.raidMeta,
          statusType: entry.statusType || "process",
          effectiveGates: entry.effectiveGates,
          requireLocalSyncEnabled,
        }, now);
        results.push(result);
        if (result.updated) didUpdate = true;
      }
      if (didUpdate) {
        if (typeof userDoc.markModified === "function") userDoc.markModified("accounts");
        await userDoc.save();
      }
    });
    return results;
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
    applyRaidSetBatchForDiscordId,
    // Exposed for tests in test/raid-set.test.js so the helper-Manager
    // routing can be exercised without driving the full slash-command
    // handler through a mock Discord interaction.
    resolveRosterOwner,
  };
}

module.exports = {
  createRaidSetCommand,
};
