"use strict";

const {
  getRosterMatches,
  getCharacterMatches,
  truncateChoice,
  buildRosterAutocompleteChoices,
  buildSharedRosterAutocompleteChoices,
} = require("../../../../utils/raid/common/autocomplete");
const { getAccessibleAccounts } = require("../../../../services/access/access-control");
const { t, getUserLanguage } = require("../../../../services/i18n");

function createRosterAutocompleteHandlers({
  User,
  loadUserForAutocomplete,
  loadUserDocForRosterAutocomplete,
}) {
  async function autocompleteRoster(interaction, focused) {
    const executorId = interaction.user.id;
    const lang = await getUserLanguage(executorId, { UserModel: User });
    const charsWord = (n) =>
      t(
        n === 1 ? "raid-task.autocomplete.charsSingular" : "raid-task.autocomplete.charsPlural",
        lang,
      );
    const taskSuffixFor = (n) =>
      n > 0 ? t("raid-task.autocomplete.taskSuffix", lang, { n }) : "";
    const userDoc = await loadUserForAutocomplete(executorId);
    const matches = getRosterMatches(userDoc, focused.value || "");
    const choices = buildRosterAutocompleteChoices(matches, {
      lang,
      t,
      choiceKey: "raid-task.autocomplete.ownChoice",
      charsWord,
      taskSuffixFor,
    });

    let shareChoices = [];
    try {
      const accessible = await getAccessibleAccounts(executorId);
      shareChoices = buildSharedRosterAutocompleteChoices(accessible, {
        needle: focused.value || "",
        lang,
        t,
        choiceKey: "raid-task.autocomplete.sharedChoice",
        accessTagKey: "raid-task.autocomplete.sharedAccessTagView",
        charsWord,
        taskSuffixFor,
      });
    } catch (err) {
      console.warn(
        "[raid-task autocomplete] getAccessibleAccounts failed:",
        err?.message || err,
      );
    }

    const merged = [...choices, ...shareChoices].slice(0, 25);
    await interaction.respond(merged).catch(() => {});
  }

  async function autocompleteCharacter(interaction, focused) {
    const rosterInput = interaction.options.getString("roster") || "";
    const userDoc = await loadUserDocForRosterAutocomplete(
      interaction.user.id,
      rosterInput,
    );
    const entries = getCharacterMatches(userDoc, {
      rosterFilter: rosterInput || null,
      needle: focused.value || "",
    });
    const choices = entries.map((entry) => {
      const taskSuffix =
        entry.sideTaskCount > 0 ? ` \u00b7 ${entry.sideTaskCount} task` : "";
      const label = `${entry.name} \u00b7 ${entry.className} \u00b7 ${entry.itemLevel}${taskSuffix}`;
      return truncateChoice(label, entry.name);
    });
    await interaction.respond(choices).catch(() => {});
  }

  return {
    autocompleteCharacter,
    autocompleteRoster,
  };
}

module.exports = {
  createRosterAutocompleteHandlers,
};
