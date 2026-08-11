"use strict";

// tPick, not t: the enable/disable titles resolved through these key tables are
// variant pools. Non-pool keys pass through to t() unchanged.
const { tPick: t, getUserLanguage } = require("../../../services/i18n");
const {
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

  const localizeNotice = ({ type, titleKey, descriptionKey, lang, vars }) => ({
    type,
    title: t(titleKey, lang),
    description: t(descriptionKey, lang, vars),
  });

  const editNoticeByKey = (interaction, options) =>
    editNotice(interaction, EmbedBuilder, localizeNotice(options));

  const followUpNoticeByKey = (interaction, options) =>
    followUpNotice(interaction, EmbedBuilder, localizeNotice(options));

  const editNoticeByText = (interaction, { type, title, description }) =>
    editNotice(
      interaction,
      EmbedBuilder,
      { type, title, description },
      { components: [] }
    ).catch(() => {});

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
    outcomeConfig,
    { lang, targetDiscordId, result },
    sendNoticeByKey = editNoticeByKey
  ) {
    const config = outcomeConfig[result.outcome];
    if (!config) return false;
    if (config.logError) {
      console.error(config.logError(targetDiscordId), result.error?.message || result.error);
    }
    await sendNoticeByKey(interaction, {
      type: config.type,
      titleKey: config.titleKey,
      descriptionKey: config.descriptionKey,
      lang,
      vars: {
        error: result.error?.message || result.error,
        target: targetDiscordId,
      },
    });
    return true;
  }

  const MANAGER_AUTO_ACTIONS = Object.freeze({
    enable: {
      transition: tryEnableAutoManage,
      keyPrefix: "raid-auto-manage.enableButton",
      successType: "success",
      outcomes: {
        error: {
          type: "error",
          titleKey: "raid-auto-manage.enableButton.flipFailTitle",
          descriptionKey: "raid-auto-manage.enableButton.flipFailDescription",
          logError: (target) => `[raid-check enable-auto] flip failed user=${target}:`,
        },
        missing: {
          type: "warn",
          titleKey: "raid-auto-manage.enableButton.userMissingTitle",
          descriptionKey: "raid-auto-manage.enableButton.userMissingDescription",
        },
        "already-on": {
          type: "info",
          titleKey: "raid-auto-manage.enableButton.alreadyOnTitle",
          descriptionKey: "raid-auto-manage.enableButton.alreadyOnDescription",
        },
        "local-locked": {
          type: "info",
          titleKey: "raid-auto-manage.enableButton.localLockedTitle",
          descriptionKey: "raid-auto-manage.enableButton.localLockedDescription",
        },
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
      successType: "muted",
      outcomes: {
        error: {
          type: "error",
          titleKey: "raid-auto-manage.disableButton.flipFailTitle",
          descriptionKey: "raid-auto-manage.disableButton.flipFailDescription",
          logError: (target) => `[raid-check disable-auto-one] flip failed user=${target}:`,
        },
        missing: {
          type: "warn",
          titleKey: "raid-auto-manage.disableButton.userMissingTitle",
          descriptionKey: "raid-auto-manage.disableButton.userMissingDescription",
        },
        "already-off": {
          type: "info",
          titleKey: "raid-auto-manage.disableButton.alreadyOffTitle",
          descriptionKey: "raid-auto-manage.disableButton.alreadyOffDescription",
        },
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

  const SELF_AUTO_ACTIONS = Object.freeze({
    disable: {
      transition: tryDisableAutoManage,
      keyPrefix: "raid-auto-manage.disableSelf",
      resultType: "muted",
      logTag: "raid-check disable-auto-self",
      outcomes: {
        error: {
          type: "error",
          titleKey: "raid-auto-manage.disableSelf.failTitle",
          descriptionKey: "raid-auto-manage.disableSelf.failDescription",
          logError: (target) => `[raid-check disable-auto-self] flip failed user=${target}:`,
        },
        missing: {
          type: "warn",
          titleKey: "raid-auto-manage.disableSelf.accountMissingTitle",
          descriptionKey: "raid-auto-manage.disableSelf.accountMissingDescription",
        },
      },
      resultText: {
        disabled: {
          titleKey: "raid-auto-manage.disableSelf.disabledTitle",
          descriptionKey: "raid-auto-manage.disableSelf.disabledDescription",
        },
        "already-off": {
          titleKey: "raid-auto-manage.disableSelf.alreadyOffTitle",
          descriptionKey: "raid-auto-manage.disableSelf.alreadyOffDescription",
        },
      },
      defaultOutcome: "already-off",
    },
    enable: {
      transition: tryEnableAutoManage,
      keyPrefix: "raid-auto-manage.enableSelf",
      resultType: "success",
      logTag: "raid-check enable-auto-self",
      outcomes: {
        error: {
          type: "error",
          titleKey: "raid-auto-manage.enableSelf.failTitle",
          descriptionKey: "raid-auto-manage.enableSelf.failDescription",
          logError: (target) => `[raid-check enable-auto-self] flip failed user=${target}:`,
        },
        missing: {
          type: "warn",
          titleKey: "raid-auto-manage.enableSelf.accountMissingTitle",
          descriptionKey: "raid-auto-manage.enableSelf.accountMissingDescription",
        },
      },
      resultText: {
        flipped: {
          titleKey: "raid-auto-manage.enableSelf.flippedTitle",
          descriptionKey: "raid-auto-manage.enableSelf.flippedDescription",
        },
        "local-locked": {
          titleKey: "raid-auto-manage.enableSelf.localLockedTitle",
          descriptionKey: "raid-auto-manage.enableSelf.localLockedDescription",
        },
        "already-on": {
          titleKey: "raid-auto-manage.enableSelf.alreadyOnTitle",
          descriptionKey: "raid-auto-manage.enableSelf.alreadyOnDescription",
        },
      },
      defaultOutcome: "already-on",
    },
  });

  async function handleManagerAutoClick(interaction, targetDiscordId, config) {
    await deferEphemeralReply(interaction);
    const managerLangPromise = getUserLanguage(interaction.user.id, { UserModel: User });
    if (!targetDiscordId) {
      const managerLang = await managerLangPromise;
      await editNoticeByKey(interaction, {
        type: "warn",
        titleKey: `${config.keyPrefix}.expiredTitle`,
        descriptionKey: `${config.keyPrefix}.expiredDescription`,
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
      config.outcomes,
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
      type: config.successType,
      title: t(`${config.keyPrefix}.successTitle`, managerLang),
      description: [
        t(`${config.keyPrefix}.successLineIntro`, managerLang),
        "",
        t(`${config.keyPrefix}.successLineTarget`, managerLang, {
          target: targetDiscordId,
        }),
        t(`${config.keyPrefix}.successLineState`, managerLang),
        dmSent
          ? t(`${config.keyPrefix}.successLineDmSent`, managerLang)
          : t(`${config.keyPrefix}.successLineDmFailed`, managerLang),
        "",
        t(`${config.keyPrefix}.successLineOutro`, managerLang),
      ].join("\n"),
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
    await editNoticeByKey(interaction, {
      type: reason === "expired" ? "warn" : "lock",
      titleKey: `${config.keyPrefix}.${reason}Title`,
      descriptionKey: `${config.keyPrefix}.${reason}Description`,
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
      config.outcomes,
      { lang, targetDiscordId, result },
      followUpNoticeByKey
    );
    if (handled) return;

    const textKeys = config.resultText[result.outcome]
      || config.resultText[config.defaultOutcome];
    console.log(`[${config.logTag}] user=${targetDiscordId} outcome=${result.outcome}`);
    await editNoticeByText(interaction, {
      type: config.resultType,
      title: t(textKeys.titleKey, lang),
      description: t(textKeys.descriptionKey, lang),
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
