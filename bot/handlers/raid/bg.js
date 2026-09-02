/**
 * handlers/raid/bg.js
 *
 * Thin dispatcher for /raid-bg. Subcommand behavior lives under bg/actions/;
 * shared browser, library, persistence, and image-processing helpers live in
 * the parent bg/ folder.
 */

"use strict";

const { getUserLanguage } = require("../../services/i18n");
const {
  detectMime,
  stripPngAncillaryChunks,
} = require("./bg/image-pipeline");
const { compactAssignmentsAfterRemove } = require("./bg/library");
const { handleSet } = require("./bg/actions/set");
const { handleView } = require("./bg/actions/view");
const { handleEdit } = require("./bg/actions/edit");

function createRaidBgCommand(deps) {
  const { User } = deps;
  const subcommandHandlers = Object.freeze({
    set: handleSet,
    view: handleView,
    edit: handleEdit,
  });

  async function handleRaidBgCommand(interaction) {
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    const sub = interaction.options.getSubcommand();
    const handler = subcommandHandlers[sub];
    if (handler) return handler({ interaction, deps, lang });
    return undefined;
  }

  return {
    handleRaidBgCommand,
  };
}

module.exports = {
  createRaidBgCommand,
  __test: {
    detectMime,
    stripPngAncillaryChunks,
    compactAssignmentsAfterRemove,
  },
};
