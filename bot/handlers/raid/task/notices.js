"use strict";

const { t } = require("../../../services/i18n");
const {
  editNotice,
  replyNotice,
  updateNotice,
} = require("../../../utils/raid/common/shared");

function viewOnlyShareNotice(target, lang) {
  return {
    type: "error",
    title: t("raid-task.shareViewOnly.title", lang),
    description: t("raid-task.shareViewOnly.description", lang, {
      owner: target.ownerLabel || "(unknown)",
    }),
  };
}

function createRaidTaskNoticeHelpers({ EmbedBuilder }) {
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

  function replyViewOnlyShareNotice(interaction, target, lang) {
    return replyTaskNotice(interaction, viewOnlyShareNotice(target, lang));
  }

  function editViewOnlyShareNotice(interaction, target, lang) {
    return editTaskNotice(interaction, viewOnlyShareNotice(target, lang));
  }

  return {
    editTaskNotice,
    editViewOnlyShareNotice,
    replyTaskNotice,
    updateTaskNotice,
    replyViewOnlyShareNotice,
    viewOnlyShareNotice,
  };
}

module.exports = {
  createRaidTaskNoticeHelpers,
  viewOnlyShareNotice,
};
