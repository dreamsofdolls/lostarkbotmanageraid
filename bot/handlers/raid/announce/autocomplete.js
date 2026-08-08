"use strict";

const { t } = require("../../../services/i18n");

function buildRaidAnnounceAutocompleteOptions({
  current,
  overridable,
  lang,
  includeAllActions = false,
}) {
  const options = [
    { name: t("raid-announce.autocomplete.show", lang), value: "show" },
  ];
  if (current) {
    options.push(
      current.enabled
        ? { name: t("raid-announce.autocomplete.turnOffWithState", lang), value: "off" }
        : { name: t("raid-announce.autocomplete.turnOnWithState", lang), value: "on" }
    );
  } else {
    options.push(
      { name: t("raid-announce.autocomplete.turnOnGeneric", lang), value: "on" },
      { name: t("raid-announce.autocomplete.turnOffGeneric", lang), value: "off" }
    );
  }

  if (overridable) {
    options.push({ name: t("raid-announce.autocomplete.setChannel", lang), value: "set-channel" });
    if (includeAllActions || current?.channelId) {
      options.push({
        name: t("raid-announce.autocomplete.clearChannel", lang),
        value: "clear-channel",
      });
    }
  }
  return options;
}

function resolveAutocompleteLanguage(interaction) {
  const locale = String(interaction?.locale || interaction?.guildLocale || "").toLowerCase();
  if (locale.startsWith("ja")) return "jp";
  if (locale.startsWith("en")) return "en";
  return "vi";
}

function filterRaidAnnounceAutocompleteOptions({ options, needle, normalizeName }) {
  const normalizedNeedle = normalizeName(needle || "");
  const filtered = !normalizedNeedle
    ? options
    : options.filter(
        (choice) =>
          normalizeName(choice.name).includes(normalizedNeedle) ||
          normalizeName(choice.value).includes(normalizedNeedle)
      );
  return filtered.slice(0, 25);
}

function createRaidAnnounceAutocompleteHandler({
  normalizeName,
  announcementTypeEntry,
}) {
  return async function handleRaidAnnounceAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused?.name !== "action") {
        await interaction.respond([]).catch(() => {});
        return;
      }

      // New command schemas use static action choices. This path remains as a
      // transition fallback for Discord clients still holding the old
      // autocomplete schema, so it must answer without any DB dependency.
      const lang = resolveAutocompleteLanguage(interaction);
      const typeValue = interaction.options.getString("type");
      const entry = typeValue ? announcementTypeEntry(typeValue) : null;

      const options = buildRaidAnnounceAutocompleteOptions({
        current: null,
        overridable: entry?.channelOverridable === true,
        lang,
        includeAllActions: true,
      });
      await interaction.respond(
        filterRaidAnnounceAutocompleteOptions({
          options,
          needle: focused.value,
          normalizeName,
        })
      ).catch(() => {});
    } catch (err) {
      console.error("[autocomplete] raid-announce error:", err?.message || err);
      await interaction.respond([]).catch(() => {});
    }
  };
}

module.exports = {
  createRaidAnnounceAutocompleteHandler,
  __test: {
    buildRaidAnnounceAutocompleteOptions,
    filterRaidAnnounceAutocompleteOptions,
    resolveAutocompleteLanguage,
  },
};
