"use strict";

const {
  filterAutocompleteChoices,
} = require("../../../utils/discord/select-options");
const { t } = require("../../../services/i18n");
const { NoticeKind } = require("../../../utils/raid/common/shared");

// One definition per state notice. The action gates below and the handlers
// that hit the same state later (a Local Sync conflict found while saving)
// all build from here.
const STATE_NOTICES = Object.freeze({
  alreadyOn: { kind: NoticeKind.INPUT, keyBase: "raid-auto-manage.redundant.alreadyOn" },
  alreadyOff: { kind: NoticeKind.INPUT, keyBase: "raid-auto-manage.redundant.alreadyOff" },
  localAlreadyOn: { kind: NoticeKind.INPUT, keyBase: "raid-auto-manage.redundant.localAlreadyOn" },
  localAlreadyOff: { kind: NoticeKind.INPUT, keyBase: "raid-auto-manage.redundant.localAlreadyOff" },
  bibleBlockedByLocal: { kind: NoticeKind.GUARD, keyBase: "raid-auto-manage.mutex.bibleBlockedByLocal" },
  localBlockedByBible: { kind: NoticeKind.GUARD, keyBase: "raid-auto-manage.mutex.localBlockedByBible" },
  localLocked: { kind: NoticeKind.GUARD, keyBase: "raid-auto-manage.sync.localLocked" },
});

const AUTO_MANAGE_ACTIONS = Object.freeze([
  "on",
  "off",
  "sync",
  "status",
  "local-on",
  "local-off",
  "reset",
]);

const AUTO_MANAGE_STATE_ACTIONS = new Set(["on", "off", "sync", "local-on", "local-off"]);
const AUTO_MANAGE_ACTION_SET = new Set(AUTO_MANAGE_ACTIONS);

const STATE_GATES = Object.freeze({
  on: [
    { when: ({ bibleOn }) => bibleOn, notice: "alreadyOn" },
    { when: ({ localOn }) => localOn, notice: "bibleBlockedByLocal" },
  ],
  off: [
    { when: ({ bibleOn }) => !bibleOn, notice: "alreadyOff" },
  ],
  sync: [
    { when: ({ localOn }) => localOn, notice: "localLocked" },
  ],
  "local-on": [
    { when: ({ localOn }) => localOn, notice: "localAlreadyOn" },
  ],
  "local-off": [
    { when: ({ localOn }) => !localOn, notice: "localAlreadyOff" },
  ],
});

const AUTO_MANAGE_ACTION_CHOICES = Object.freeze([
  {
    key: "onLabel",
    value: "on",
    show: ({ bibleOn, localOn }) => !bibleOn && !localOn,
  },
  {
    key: "offLabel",
    value: "off",
    show: ({ bibleOn }) => bibleOn,
  },
  {
    key: "syncLabel",
    value: "sync",
    show: ({ localOn }) => !localOn,
  },
  {
    key: "statusLabel",
    value: "status",
    show: () => true,
  },
  {
    key: "localOnLabel",
    value: "local-on",
    show: ({ bibleOn, localOn }) => !bibleOn && !localOn,
  },
  {
    key: "localOffLabel",
    value: "local-off",
    show: ({ localOn }) => localOn,
  },
  {
    key: "resetLabel",
    value: "reset",
    show: () => true,
  },
]);

function isValidAutoManageAction(action) {
  return AUTO_MANAGE_ACTION_SET.has(action);
}

function shouldReadAutoManageState(action) {
  return AUTO_MANAGE_STATE_ACTIONS.has(action);
}

function getAutoManageStateGate(action, state = {}) {
  const gates = STATE_GATES[action] || [];
  return gates.find((gate) => gate.when(state)) || null;
}

/**
 * The notice for one auto-manage state: already on or off, or blocked by the
 * other sync mode.
 * @param {"alreadyOn"|"alreadyOff"|"localAlreadyOn"|"localAlreadyOff"|"bibleBlockedByLocal"|"localBlockedByBible"|"localLocked"} name
 * @param {string} lang
 * @returns {{kind: string, title: string, description: string, tip: string}}
 */
function buildAutoManageStateNotice(name, lang) {
  const { kind, keyBase } = STATE_NOTICES[name];
  return {
    kind,
    title: t(`${keyBase}Title`, lang),
    description: t(`${keyBase}Description`, lang),
    tip: t(`${keyBase}Tip`, lang),
  };
}

function buildAutoManageAutocompleteChoices({ bibleOn = false, localOn = false, needle = "", lang, t, normalizeName }) {
  const choices = AUTO_MANAGE_ACTION_CHOICES
    .filter((choice) => choice.show({ bibleOn, localOn }))
    .map((choice) => ({
      name: t(`raid-auto-manage.autocomplete.${choice.key}`, lang),
      value: choice.value,
    }));
  return filterAutocompleteChoices(choices, {
    needle,
    normalize: normalizeName,
  });
}

module.exports = {
  buildAutoManageAutocompleteChoices,
  buildAutoManageStateNotice,
  getAutoManageStateGate,
  isValidAutoManageAction,
  shouldReadAutoManageState,
};
