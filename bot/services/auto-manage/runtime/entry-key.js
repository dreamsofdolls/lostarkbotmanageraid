"use strict";

const AUTO_MANAGE_ENTRY_SEP = "\x1f";

function createAutoManageEntryKey(normalizeName) {
  return function autoManageEntryKey(accountName, charName) {
    return normalizeName(accountName) + AUTO_MANAGE_ENTRY_SEP + normalizeName(charName);
  };
}

module.exports = {
  AUTO_MANAGE_ENTRY_SEP,
  createAutoManageEntryKey,
};
