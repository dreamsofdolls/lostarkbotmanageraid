"use strict";

const {
  getRosterMatches,
  getCharacterMatches,
  truncateChoice,
  buildRosterAutocompleteChoices,
  buildSharedRosterAutocompleteChoices,
} = require("../../../utils/raid/common/autocomplete");
const { t, getUserLanguage } = require("../../../services/i18n");

function computeRaidProgress({
  character,
  req,
  UI,
  ensureAssignedRaids,
  normalizeName,
  getGatesForRaid,
  getGateKeys,
  toModeLabel,
}) {
  const assignedRaids = ensureAssignedRaids(character);
  const assigned = assignedRaids[req.raidKey] || {};
  const rawGates = getGateKeys(assigned);
  const allGates = rawGates.length > 0 ? rawGates : getGatesForRaid(req.raidKey);
  const total = allGates.length;
  const storedDifficulty = assigned?.modeKey
    ? toModeLabel(assigned.modeKey)
    : (assigned?.G1?.difficulty || assigned?.G2?.difficulty || "Normal");
  const sameDifficulty =
    normalizeName(storedDifficulty) === normalizeName(toModeLabel(req.modeKey));
  const done = sameDifficulty
    ? allGates.filter((gate) => Number(assigned?.[gate]?.completedDate) > 0).length
    : 0;
  const isComplete = total > 0 && done === total;
  const icon = isComplete
    ? UI.icons.done
    : done > 0
      ? UI.icons.partial
      : UI.icons.pending;
  return { done, total, isComplete, icon };
}

function createRaidSetAutocompleteService({
  UI,
  User,
  normalizeName,
  loadUserForAutocomplete,
  getAccessibleAccounts,
  flattenRegisteredAccounts,
  resolveRosterOwner,
  loadAccountsRegisteredBy,
  getRaidRequirementList,
  RAID_REQUIREMENT_MAP,
  getGatesForRaid,
  ensureAssignedRaids,
  getGateKeys,
  toModeLabel,
  findCharacterInUser,
}) {
  async function resolveAutocompleteUserDoc(executorId, rosterInput) {
    if (rosterInput) {
      const resolved = await resolveRosterOwner(executorId, rosterInput);
      if (resolved && !resolved.ambiguous && resolved.ownerDoc) {
        return resolved.ownerDoc;
      }
    }
    return loadUserForAutocomplete(executorId);
  }

  function buildRaidProgressChoice({ req, character, lang }) {
    const { done, total, isComplete, icon } = computeRaidProgress({
      character,
      req,
      UI,
      ensureAssignedRaids,
      normalizeName,
      getGatesForRaid,
      getGateKeys,
      toModeLabel,
    });
    const base = `${icon} ${req.label} · ${done}/${total}`;
    return {
      name: isComplete ? `${base} · DONE` : base,
      value: `${req.raidKey}_${req.modeKey}`,
    };
  }

  async function autocompleteRoster(interaction, focused) {
    const executorId = interaction.user.id;
    const needle = focused.value || "";
    const target = normalizeName(needle);
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const charsWord = (n) =>
      t(
        n === 1 ? "raid-set.autocomplete.charsSingular" : "raid-set.autocomplete.charsPlural",
        lang
      );
    const ownDoc = await loadUserForAutocomplete(executorId);
    const ownMatches = getRosterMatches(ownDoc, needle);
    const ownChoices = buildRosterAutocompleteChoices(ownMatches, {
      lang,
      t,
      choiceKey: "raid-set.autocomplete.ownChoice",
      charsWord,
    });

    let helperChoices = [];
    try {
      const registeredDocs = await loadAccountsRegisteredBy(executorId);
      helperChoices = flattenRegisteredAccounts(registeredDocs, executorId)
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
      console.warn(
        "[raid-set autocomplete] loadAccountsRegisteredBy failed:",
        err?.message || err
      );
    }

    let shareChoices = [];
    try {
      const accessible = await getAccessibleAccounts(executorId);
      shareChoices = buildSharedRosterAutocompleteChoices(accessible, {
        needle,
        lang,
        t,
        choiceKey: "raid-set.autocomplete.sharedChoice",
        accessTagKey: "raid-set.autocomplete.sharedAccessTagView",
        charsWord,
      });
    } catch (err) {
      console.warn(
        "[raid-set autocomplete] getAccessibleAccounts failed:",
        err?.message || err
      );
    }

    await interaction.respond([...ownChoices, ...helperChoices, ...shareChoices].slice(0, 25)).catch(() => {});
  }

  async function autocompleteCharacter(interaction, focused) {
    const executorId = interaction.user.id;
    const rosterInput = interaction.options.getString("roster") || "";
    const userDoc = await resolveAutocompleteUserDoc(executorId, rosterInput);
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

  function buildPlainRaidChoices({ needle }) {
    return getRaidRequirementList()
      .filter((req) => !needle || normalizeName(req.label).includes(needle))
      .slice(0, 25)
      .map((req) => ({
        name: `${req.label} · ${req.minItemLevel}+`,
        value: `${req.raidKey}_${req.modeKey}`,
      }));
  }

  async function autocompleteRaid(interaction, focused) {
    const rosterInput = interaction.options.getString("roster") || "";
    const characterInput = interaction.options.getString("character") || "";
    const needle = normalizeName(focused.value || "");
    const executorId = interaction.user.id;
    const renderPlain = () => buildPlainRaidChoices({ needle });

    if (!characterInput) {
      await interaction.respond(renderPlain()).catch(() => {});
      return;
    }

    const userDoc = await resolveAutocompleteUserDoc(executorId, rosterInput);
    const character = findCharacterInUser(userDoc, characterInput, rosterInput || null);
    if (!character) {
      await interaction.respond(renderPlain()).catch(() => {});
      return;
    }

    const itemLevel = Number(character.itemLevel) || 0;
    const choices = [];
    for (const req of getRaidRequirementList()) {
      if (itemLevel < req.minItemLevel) continue;
      if (needle && !normalizeName(req.label).includes(needle)) continue;
      choices.push(buildRaidProgressChoice({ req, character }));
      if (choices.length >= 25) break;
    }
    await interaction.respond(choices).catch(() => {});
  }

  async function autocompleteStatus(interaction, focused) {
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
      list.filter((choice) => !needle || normalizeName(choice.name).includes(needle));
    const raidMeta = RAID_REQUIREMENT_MAP[raidValue];
    if (!characterInput || !raidMeta) {
      await interaction.respond(applyFilter(baseChoices)).catch(() => {});
      return;
    }

    const userDoc = await resolveAutocompleteUserDoc(executorId, rosterInput);
    const character = findCharacterInUser(userDoc, characterInput, rosterInput || null);
    if (!character) {
      await interaction.respond(applyFilter(baseChoices)).catch(() => {});
      return;
    }
    const { isComplete } = computeRaidProgress({
      character,
      req: raidMeta,
      UI,
      ensureAssignedRaids,
      normalizeName,
      getGatesForRaid,
      getGateKeys,
      toModeLabel,
    });
    if (isComplete) {
      await interaction
        .respond([{ name: t("raid-set.statusChoices.resetOnly", lang), value: "reset" }])
        .catch(() => {});
      return;
    }
    await interaction.respond(applyFilter(baseChoices)).catch(() => {});
  }

  async function autocompleteGate(interaction, focused) {
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
    const choices = getGatesForRaid(raidMeta.raidKey)
      .filter((gate) => !needle || normalizeName(gate).includes(needle))
      .map((gate) => ({ name: gate, value: gate }));
    await interaction.respond(choices).catch(() => {});
  }

  const AUTOCOMPLETE_HANDLERS = Object.freeze({
    roster: autocompleteRoster,
    character: autocompleteCharacter,
    raid: autocompleteRaid,
    status: autocompleteStatus,
    gate: autocompleteGate,
  });

  async function handleRaidSetAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      const handler = AUTOCOMPLETE_HANDLERS[focused?.name];
      if (!handler) {
        await interaction.respond([]).catch(() => {});
        return;
      }
      await handler(interaction, focused);
    } catch (error) {
      console.error("[autocomplete] raid-set error:", error?.message || error);
      await interaction.respond([]).catch(() => {});
    }
  }

  return {
    handleRaidSetAutocomplete,
  };
}

module.exports = {
  computeRaidProgress,
  createRaidSetAutocompleteService,
};
