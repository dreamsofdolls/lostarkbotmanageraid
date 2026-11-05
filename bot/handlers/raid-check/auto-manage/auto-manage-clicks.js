"use strict";

// tPick, not t: the self enable/disable hero sentences resolved through these
// key tables are variant pools. Non-pool keys pass through to t() unchanged.
const { tPick: t, getUserLanguage } = require("../../../services/i18n");
const {
  NoticeKind,
  buildDetailField,
  deferEphemeralReply,
  editNotice,
  followUpNotice,
} = require("../../../utils/raid/common/shared");
const {
  buildDisableAutoDmEmbed,
  buildEnableAutoDmEmbed,
} = require("./auto-manage-dm");
const {
  tryDisableAutoManage,
  tryEnableAutoManage,
} = require("./auto-manage-state");

function createRaidCheckAutoManageUi(deps) {
  const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    User,
  } = deps;

  // Every notice here reads `${keyPrefix}.${stem}Title|Description|Tip`; a
  // failure also carries the raw error in the detail field.
  const keyedNotice = ({ kind, keyPrefix, stem, lang, vars, detail }) => ({
    kind,
    title: t(`${keyPrefix}.${stem}Title`, lang),
    description: t(`${keyPrefix}.${stem}Description`, lang, vars),
    tip: t(`${keyPrefix}.${stem}Tip`, lang),
    fields: detail ? [buildDetailField(detail, lang)] : [],
  });

  const editKeyedNotice = (interaction, options) =>
    editNotice(interaction, EmbedBuilder, keyedNotice(options));

  const followUpKeyedNotice = (interaction, options) =>
    followUpNotice(interaction, EmbedBuilder, keyedNotice(options));

  // The self buttons sit on a DM; the result replaces that DM and its button.
  const replaceWithKeyedNotice = (interaction, options) =>
    editNotice(interaction, EmbedBuilder, keyedNotice(options), { components: [] })
      .catch(() => {});

  async function sendTargetDm({ interaction, targetDiscordId, buildEmbed, buildRow }) {
    try {
      const targetUser = await interaction.client.users
        .fetch(targetDiscordId)
        .catch(() => null);
      if (!targetUser) return false;

      const targetLang = await getUserLanguage(targetDiscordId, { UserModel: User });
      await targetUser.send({
        embeds: [buildEmbed(targetLang)],
        components: [buildRow(targetLang)],
      });
      return true;
    } catch (err) {
      console.warn(
        `[raid-check auto-manage] DM failed user=${targetDiscordId}:`,
        err?.message || err
      );
      return false;
    }
  }

  async function replyAtomicOutcome(
    interaction,
    { keyPrefix, outcomes },
    { lang, targetDiscordId, result },
    sendKeyedNotice = editKeyedNotice
  ) {
    const outcome = outcomes[result.outcome];
    if (!outcome) return false;
    const errorText = result.error?.message || result.error;
    if (outcome.logError) {
      console.error(outcome.logError(targetDiscordId), errorText);
    }
    await sendKeyedNotice(interaction, {
      kind: outcome.kind,
      keyPrefix,
      stem: outcome.stem,
      lang,
      vars: { target: targetDiscordId },
      detail: outcome.kind === NoticeKind.FAILURE && errorText ? String(errorText) : null,
    });
    return true;
  }

  // A refusal from the stored state is input when nothing would change and
  // guard when the other sync mode blocks it; a user gone since the card
  // rendered makes the button expired.
  const MANAGER_AUTO_ACTIONS = Object.freeze({
    enable: {
      transition: tryEnableAutoManage,
      keyPrefix: "raid-auto-manage.enableButton",
      outcomes: {
        error: {
          kind: NoticeKind.FAILURE,
          stem: "flipFail",
          logError: (target) => `[raid-check enable-auto] flip failed user=${target}:`,
        },
        missing: { kind: NoticeKind.EXPIRED, stem: "userMissing" },
        "already-on": { kind: NoticeKind.INPUT, stem: "alreadyOn" },
        "local-locked": { kind: NoticeKind.GUARD, stem: "localLocked" },
      },
      buildDmEmbed: ({ managerId, result, targetLang }) =>
        buildEnableAutoDmEmbed(
          EmbedBuilder,
          { managerId, userDoc: result.doc },
          targetLang
        ),
      selfButton: {
        customIdAction: "disable-auto-self",
        labelKey: "raid-auto-manage.dm.enable.disableSelfButton",
        emoji: "\u{1f6ab}",
        style: ButtonStyle.Danger,
      },
      successLog: ({ managerId, targetDiscordId, dmSent }) =>
        `[raid-check enable-auto] manager=${managerId} target=${targetDiscordId} flipped=true dmSent=${dmSent}`,
    },
    disable: {
      transition: tryDisableAutoManage,
      keyPrefix: "raid-auto-manage.disableButton",
      outcomes: {
        error: {
          kind: NoticeKind.FAILURE,
          stem: "flipFail",
          logError: (target) => `[raid-check disable-auto-one] flip failed user=${target}:`,
        },
        missing: { kind: NoticeKind.EXPIRED, stem: "userMissing" },
        "already-off": { kind: NoticeKind.INPUT, stem: "alreadyOff" },
      },
      buildDmEmbed: ({ managerId, targetLang }) =>
        buildDisableAutoDmEmbed(EmbedBuilder, { managerId }, targetLang),
      selfButton: {
        customIdAction: "enable-auto-self",
        labelKey: "raid-auto-manage.dm.disable.enableSelfButton",
        emoji: "\u{1f504}",
        style: ButtonStyle.Primary,
      },
      successLog: ({ managerId, targetDiscordId, dmSent }) =>
        `[raid-check disable-auto-one] manager=${managerId} target=${targetDiscordId} outcome=disabled dmSent=${dmSent}`,
    },
  });

  // `outcomes` arrive as a follow-up and leave the DM as it is; a
  // `resultNotices` entry replaces the DM and its button.
  const SELF_AUTO_ACTIONS = Object.freeze({
    disable: {
      transition: tryDisableAutoManage,
      keyPrefix: "raid-auto-manage.disableSelf",
      logTag: "raid-check disable-auto-self",
      outcomes: {
        error: {
          kind: NoticeKind.FAILURE,
          stem: "fail",
          logError: (target) => `[raid-check disable-auto-self] flip failed user=${target}:`,
        },
        missing: { kind: NoticeKind.EXPIRED, stem: "accountMissing" },
      },
      resultNotices: {
        disabled: { kind: NoticeKind.DONE, stem: "disabled" },
        "already-off": { kind: NoticeKind.INPUT, stem: "alreadyOff" },
      },
      defaultOutcome: "already-off",
    },
    enable: {
      transition: tryEnableAutoManage,
      keyPrefix: "raid-auto-manage.enableSelf",
      logTag: "raid-check enable-auto-self",
      outcomes: {
        error: {
          kind: NoticeKind.FAILURE,
          stem: "fail",
          logError: (target) => `[raid-check enable-auto-self] flip failed user=${target}:`,
        },
        missing: { kind: NoticeKind.EXPIRED, stem: "accountMissing" },
      },
      resultNotices: {
        flipped: { kind: NoticeKind.DONE, stem: "flipped" },
        "local-locked": { kind: NoticeKind.GUARD, stem: "localLocked" },
        "already-on": { kind: NoticeKind.INPUT, stem: "alreadyOn" },
      },
      defaultOutcome: "already-on",
    },
  });

  async function handleManagerAutoClick(interaction, targetDiscordId, config) {
    await deferEphemeralReply(interaction);
    const managerLangPromise = getUserLanguage(interaction.user.id, { UserModel: User });
    if (!targetDiscordId) {
      const managerLang = await managerLangPromise;
      await editKeyedNotice(interaction, {
        kind: NoticeKind.EXPIRED,
        keyPrefix: config.keyPrefix,
        stem: "expired",
        lang: managerLang,
      });
      return;
    }

    const [managerLang, result] = await Promise.all([
      managerLangPromise,
      config.transition(User, targetDiscordId),
    ]);
    const handled = await replyAtomicOutcome(
      interaction,
      config,
      { lang: managerLang, targetDiscordId, result }
    );
    if (handled) return;

    const dmSent = await sendTargetDm({
      interaction,
      targetDiscordId,
      buildEmbed: (targetLang) => config.buildDmEmbed({
        managerId: interaction.user.id,
        result,
        targetLang,
      }),
      buildRow: (targetLang) =>
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`raid-check:${config.selfButton.customIdAction}:${targetDiscordId}`)
            .setLabel(t(config.selfButton.labelKey, targetLang))
            .setEmoji(config.selfButton.emoji)
            .setStyle(config.selfButton.style)
        ),
    });

    console.log(config.successLog({
      managerId: interaction.user.id,
      targetDiscordId,
      dmSent,
    }));
    await editNotice(interaction, EmbedBuilder, {
      ...keyedNotice({
        kind: NoticeKind.DONE,
        keyPrefix: config.keyPrefix,
        stem: "success",
        lang: managerLang,
        vars: { target: targetDiscordId },
      }),
      fields: [{
        name: t(`${config.keyPrefix}.successDmLabel`, managerLang),
        value: t(`${config.keyPrefix}.${dmSent ? "successDmSent" : "successDmFailed"}`, managerLang),
        inline: true,
      }],
    });
  }

  async function rejectInvalidSelfTarget(interaction, targetDiscordId, config) {
    const reason = !targetDiscordId
      ? "expired"
      : interaction.user.id !== targetDiscordId
        ? "notOwner"
        : null;
    if (!reason) return false;

    await deferEphemeralReply(interaction);
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    await editKeyedNotice(interaction, {
      kind: reason === "expired" ? NoticeKind.EXPIRED : NoticeKind.GUARD,
      keyPrefix: config.keyPrefix,
      stem: reason,
      lang,
    });
    return true;
  }

  async function handleSelfAutoClick(interaction, targetDiscordId, config) {
    if (await rejectInvalidSelfTarget(interaction, targetDiscordId, config)) return;

    await interaction.deferUpdate();
    const [lang, result] = await Promise.all([
      getUserLanguage(interaction.user.id, { UserModel: User }),
      config.transition(User, targetDiscordId),
    ]);
    const handled = await replyAtomicOutcome(
      interaction,
      config,
      { lang, targetDiscordId, result },
      followUpKeyedNotice
    );
    if (handled) return;

    const notice = config.resultNotices[result.outcome]
      || config.resultNotices[config.defaultOutcome];
    console.log(`[${config.logTag}] user=${targetDiscordId} outcome=${result.outcome}`);
    await replaceWithKeyedNotice(interaction, {
      kind: notice.kind,
      keyPrefix: config.keyPrefix,
      stem: notice.stem,
      lang,
    });
  }

  async function handleRaidCheckEnableAutoOneClick(interaction, targetDiscordId) {
    return handleManagerAutoClick(interaction, targetDiscordId, MANAGER_AUTO_ACTIONS.enable);
  }

  async function handleRaidCheckDisableAutoOneClick(interaction, targetDiscordId) {
    return handleManagerAutoClick(interaction, targetDiscordId, MANAGER_AUTO_ACTIONS.disable);
  }

  async function handleRaidCheckDisableAutoSelfClick(interaction, targetDiscordId) {
    return handleSelfAutoClick(interaction, targetDiscordId, SELF_AUTO_ACTIONS.disable);
  }

  async function handleRaidCheckEnableAutoSelfClick(interaction, targetDiscordId) {
    return handleSelfAutoClick(interaction, targetDiscordId, SELF_AUTO_ACTIONS.enable);
  }

  return {
    handleRaidCheckEnableAutoOneClick,
    handleRaidCheckDisableAutoSelfClick,
    handleRaidCheckDisableAutoOneClick,
    handleRaidCheckEnableAutoSelfClick,
  };
}

module.exports = {
  createRaidCheckAutoManageUi,
};
