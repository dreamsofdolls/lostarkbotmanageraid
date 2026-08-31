"use strict";

const {
  filterAutocompleteChoices,
} = require("../../../utils/discord/select-options");

const RAID_CHANNEL_ACTION_CHOICES = Object.freeze([
  { value: "show", labelKey: "show" },
  { value: "set", labelKey: "set" },
  { value: "clear", labelKey: "clear" },
  { value: "cleanup", labelKey: "cleanup" },
  { value: "repin", labelKey: "repin" },
  { value: "schedule-on", labelKey: "scheduleOn" },
  { value: "schedule-off", labelKey: "scheduleOff" },
  { value: "set-language", labelKey: "setLanguage", external: true },
]);

function isRaidChannelActionVisible(choice, autoCleanupEnabled) {
  if (autoCleanupEnabled && choice.value === "schedule-on") return false;
  if (!autoCleanupEnabled && choice.value === "schedule-off") return false;
  return true;
}

function raidChannelActionLabel(choice, lang, t) {
  return choice.external
    ? t(`raid-channel-language.${choice.labelKey === "setLanguage" ? "autocompleteLabel" : choice.labelKey}`, lang)
    : t(`raid-channel.autocomplete.${choice.labelKey}`, lang);
}

function buildRaidChannelActionChoices({
  lang,
  needle = "",
  autoCleanupEnabled = false,
  t,
  normalizeName,
  choices = RAID_CHANNEL_ACTION_CHOICES,
}) {
  const visibleChoices = choices
    .filter((choice) => isRaidChannelActionVisible(choice, autoCleanupEnabled))
    .map((choice) => ({
      name: raidChannelActionLabel(choice, lang, t),
      value: choice.value,
    }));
  return filterAutocompleteChoices(visibleChoices, {
    needle,
    normalize: normalizeName,
  });
}

module.exports = {
  RAID_CHANNEL_ACTION_CHOICES,
  buildRaidChannelActionChoices,
  isRaidChannelActionVisible,
  raidChannelActionLabel,
};
