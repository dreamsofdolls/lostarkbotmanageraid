"use strict";

const { t } = require("../../../services/i18n");
const { isShareStillListed } = require("../../../services/access/access-control");
const {
  NoticeKind,
  editNotice,
  replyNotice,
} = require("../../../utils/raid/common/shared");

// The view-only pair shows while the owner still shares a roster with the
// viewer; the revoked pair once nothing is shared.
const SHARE_REFUSAL_NOTICES = Object.freeze({
  viewOnly: "raid-task.shareViewOnly",
  revoked: "raid-task.shareRevoked",
});

/**
 * Build the notice for a refused shared-roster write.
 * @param {"viewOnly"|"revoked"} refusal - downgraded share or revoked share
 * @param {{ownerLabel?: string}} target - write target of the refused share
 * @param {string} lang - language code
 * @returns {{kind: string, title: string, description: string, tip: string}} notice options
 */
function buildShareRefusalNotice(refusal, target, lang) {
  const stem = SHARE_REFUSAL_NOTICES[refusal];
  return {
    kind: NoticeKind.GUARD,
    title: t(`${stem}.title`, lang),
    description: t(`${stem}.description`, lang, {
      owner: target.ownerLabel || "(unknown)",
    }),
    tip: t(`${stem}.tip`, lang),
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
    replyViewOnlyShareNotice,
  };
}

module.exports = {
  buildShareRefusalNotice,
  createRaidTaskNoticeHelpers,
};
