"use strict";

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
    {
      when: ({ bibleOn }) => bibleOn,
      type: "info",
      titleKey: "raid-auto-manage.redundant.alreadyOnTitle",
      descriptionKey: "raid-auto-manage.redundant.alreadyOnDescription",
    },
    {
      when: ({ localOn }) => localOn,
      type: "warn",
      titleKey: "raid-auto-manage.mutex.bibleBlockedByLocalTitle",
      descriptionKey: "raid-auto-manage.mutex.bibleBlockedByLocalDescription",
    },
  ],
  off: [
    {
      when: ({ bibleOn }) => !bibleOn,
      type: "info",
      titleKey: "raid-auto-manage.redundant.alreadyOffTitle",
      descriptionKey: "raid-auto-manage.redundant.alreadyOffDescription",
    },
  ],
  sync: [
    {
      when: ({ localOn }) => localOn,
      type: "warn",
      titleKey: "raid-auto-manage.sync.localLockedTitle",
      descriptionKey: "raid-auto-manage.sync.localLockedDescription",
    },
  ],
  "local-on": [
    {
      when: ({ localOn }) => localOn,
      type: "info",
      titleKey: "raid-auto-manage.redundant.localAlreadyOnTitle",
      descriptionKey: "raid-auto-manage.redundant.localAlreadyOnDescription",
    },
  ],
  "local-off": [
    {
      when: ({ localOn }) => !localOn,
      type: "info",
      titleKey: "raid-auto-manage.redundant.localAlreadyOffTitle",
      descriptionKey: "raid-auto-manage.redundant.localAlreadyOffDescription",
    },
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

function buildAutoManageAutocompleteChoices({ bibleOn = false, localOn = false, needle = "", lang, t, normalizeName }) {
  const normalizedNeedle = normalizeName(needle || "");
  return AUTO_MANAGE_ACTION_CHOICES
    .filter((choice) => choice.show({ bibleOn, localOn }))
    .map((choice) => ({
      name: t(`raid-auto-manage.autocomplete.${choice.key}`, lang),
      value: choice.value,
    }))
    .filter((choice) => {
      if (!normalizedNeedle) return true;
      return normalizeName(choice.name).includes(normalizedNeedle) ||
        normalizeName(choice.value).includes(normalizedNeedle);
    })
    .slice(0, 25);
}

module.exports = {
  AUTO_MANAGE_ACTIONS,
  buildAutoManageAutocompleteChoices,
  getAutoManageStateGate,
  isValidAutoManageAction,
  shouldReadAutoManageState,
};
