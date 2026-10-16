"use strict";

const { t } = require("../../../services/i18n");
const { isShareStillListed } = require("../../../services/access/access-control");
const {
  editNotice,
  replyNotice,
  updateNotice,
} = require("../../../utils/raid/common/shared");

// The view-only pair shows while the owner still shares a roster with the
// viewer; the revoked pair once nothing is shared.
const SHARE_REFUSAL_NOTICES = Object.freeze({
  viewOnly: {
    title: "raid-task.shareViewOnly.title",
    description: "raid-task.shareViewOnly.description",
  },
  revoked: {
    title: "raid-task.shareRevoked.title",
    description: "raid-task.shareRevoked.description",
  },
});

/**
 * Build the notice for a refused shared-roster write.
 * @param {"viewOnly"|"revoked"} kind - downgraded share or revoked share
 * @param {{ownerLabel?: string}} target - write target of the refused share
 * @param {string} lang - language code
 * @returns {{type: string, title: string, description: string}} notice options
 */
function buildShareRefusalNotice(kind, target, lang) {
  const keys = SHARE_REFUSAL_NOTICES[kind];
  return {
    type: "error",
    title: t(keys.title, lang),
    description: t(keys.description, lang, {
      owner: target.ownerLabel || "(unknown)",
    }),
  };
}

/**
 * Build the /raid-task notice helpers.
 * @param {object} deps
 * @param {Function} deps.EmbedBuilder - discord.js embed builder
 * @param {Function} deps.getAccessibleAccounts - share lookup that tells a
 *   downgraded share from a revoked one; only the share-refusal helpers call it
 * @returns {object} reply, edit and update helpers for task notices
 */
function createRaidTaskNoticeHelpers({ EmbedBuilder, getAccessibleAccounts }) {
  function replyTaskNotice(interaction, options, extras = null) {
    return replyNotice(interaction, EmbedBuilder, options, extras || undefined);
  }

  function updateTaskNotice(interaction, options, extras) {
    return updateNotice(interaction, EmbedBuilder, options, extras);
  }

  function editTaskNotice(interaction, options, extras = null) {
    return editNotice(interaction, EmbedBuilder, options, {
      components: [],
      ...(extras || {}),
    });
  }

  // The first resolve denies a share its own lookup just listed, so that refusal
  // is always view-only and needs no second lookup.
  function replyViewOnlyShareNotice(interaction, target, lang) {
    return replyTaskNotice(interaction, buildShareRefusalNotice("viewOnly", target, lang));
  }

  function editViewOnlyShareNotice(interaction, target, lang) {
    return editTaskNotice(interaction, buildShareRefusalNotice("viewOnly", target, lang));
  }

  // A refused save attempt only says the viewer cannot edit any more. The
  // owner's shares to the viewer tell a downgraded share, which is still listed,
  // from a revoked one.
  async function resolveShareRefusalNotice(interaction, target, lang) {
    const stillShared = await isShareStillListed(interaction.user.id, target.discordId, {
      getAccessibleAccounts,
    });
    return buildShareRefusalNotice(stillShared ? "viewOnly" : "revoked", target, lang);
  }

  async function replyShareRefusalNotice(interaction, target, lang) {
    return replyTaskNotice(interaction, await resolveShareRefusalNotice(interaction, target, lang));
  }

  async function editShareRefusalNotice(interaction, target, lang) {
    return editTaskNotice(interaction, await resolveShareRefusalNotice(interaction, target, lang));
  }

  return {
    editShareRefusalNotice,
    editTaskNotice,
    editViewOnlyShareNotice,
    replyShareRefusalNotice,
    replyTaskNotice,
    updateTaskNotice,
    replyViewOnlyShareNotice,
  };
}

module.exports = {
  buildShareRefusalNotice,
  createRaidTaskNoticeHelpers,
};
