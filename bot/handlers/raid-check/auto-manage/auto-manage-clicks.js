"use strict";

const { t, getUserLanguage } = require("../../../services/i18n");
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

  async function handleRaidCheckEnableAutoOneClick(interaction, targetDiscordId) {
    await deferEphemeralReply(interaction);
    const managerLangPromise = getUserLanguage(interaction.user.id, { UserModel: User });
    if (!targetDiscordId) {
      const managerLang = await managerLangPromise;
      await editNoticeByKey(interaction, {
        type: "warn",
        titleKey: "raid-auto-manage.enableButton.expiredTitle",
        descriptionKey: "raid-auto-manage.enableButton.expiredDescription",
        lang: managerLang,
      });
      return;
    }

    const [managerLang, result] = await Promise.all([
      managerLangPromise,
      tryEnableAutoManage(User, targetDiscordId),
    ]);
    const handled = await replyAtomicOutcome(
      interaction,
      {
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
      { lang: managerLang, targetDiscordId, result }
    );
    if (handled) return;

    const dmSent = await sendTargetDm({
      interaction,
      targetDiscordId,
      buildEmbed: (targetLang) =>
        buildEnableAutoDmEmbed(
          EmbedBuilder,
          { managerId: interaction.user.id, userDoc: result.doc },
          targetLang
        ),
      buildRow: (targetLang) =>
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`raid-check:disable-auto-self:${targetDiscordId}`)
            .setLabel(t("raid-auto-manage.dm.enable.disableSelfButton", targetLang))
            .setEmoji("\u{1f6ab}")
            .setStyle(ButtonStyle.Danger)
        ),
    });

    console.log(
      `[raid-check enable-auto] manager=${interaction.user.id} target=${targetDiscordId} flipped=true dmSent=${dmSent}`
    );
    await editNotice(interaction, EmbedBuilder, {
      type: "success",
      title: t("raid-auto-manage.enableButton.successTitle", managerLang),
      description: [
        t("raid-auto-manage.enableButton.successLineIntro", managerLang),
        "",
        t("raid-auto-manage.enableButton.successLineTarget", managerLang, {
          target: targetDiscordId,
        }),
        t("raid-auto-manage.enableButton.successLineState", managerLang),
        dmSent
          ? t("raid-auto-manage.enableButton.successLineDmSent", managerLang)
          : t("raid-auto-manage.enableButton.successLineDmFailed", managerLang),
        "",
        t("raid-auto-manage.enableButton.successLineOutro", managerLang),
      ].join("\n"),
    });
  }

  async function handleRaidCheckDisableAutoOneClick(interaction, targetDiscordId) {
    await deferEphemeralReply(interaction);
    const managerLangPromise = getUserLanguage(interaction.user.id, { UserModel: User });
    if (!targetDiscordId) {
      const managerLang = await managerLangPromise;
      await editNoticeByKey(interaction, {
        type: "warn",
        titleKey: "raid-auto-manage.disableButton.expiredTitle",
        descriptionKey: "raid-auto-manage.disableButton.expiredDescription",
        lang: managerLang,
      });
      return;
    }

    const [managerLang, result] = await Promise.all([
      managerLangPromise,
      tryDisableAutoManage(User, targetDiscordId),
    ]);
    const handled = await replyAtomicOutcome(
      interaction,
      {
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
      { lang: managerLang, targetDiscordId, result }
    );
    if (handled) return;

    const dmSent = await sendTargetDm({
      interaction,
      targetDiscordId,
      buildEmbed: (targetLang) =>
        buildDisableAutoDmEmbed(
          EmbedBuilder,
          { managerId: interaction.user.id },
          targetLang
        ),
      buildRow: (targetLang) =>
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`raid-check:enable-auto-self:${targetDiscordId}`)
            .setLabel(t("raid-auto-manage.dm.disable.enableSelfButton", targetLang))
            .setEmoji("\u{1f504}")
            .setStyle(ButtonStyle.Primary)
        ),
    });

    console.log(
      `[raid-check disable-auto-one] manager=${interaction.user.id} target=${targetDiscordId} outcome=disabled dmSent=${dmSent}`
    );
    await editNotice(interaction, EmbedBuilder, {
      type: "muted",
      title: t("raid-auto-manage.disableButton.successTitle", managerLang),
      description: [
        t("raid-auto-manage.disableButton.successLineIntro", managerLang),
        "",
        t("raid-auto-manage.disableButton.successLineTarget", managerLang, {
          target: targetDiscordId,
        }),
        t("raid-auto-manage.disableButton.successLineState", managerLang),
        dmSent
          ? t("raid-auto-manage.disableButton.successLineDmSent", managerLang)
          : t("raid-auto-manage.disableButton.successLineDmFailed", managerLang),
        "",
        t("raid-auto-manage.disableButton.successLineOutro", managerLang),
      ].join("\n"),
    });
  }

  async function handleRaidCheckDisableAutoSelfClick(interaction, targetDiscordId) {
    if (!targetDiscordId) {
      await deferEphemeralReply(interaction);
      const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
      await editNoticeByKey(interaction, {
        type: "warn",
        titleKey: "raid-auto-manage.disableSelf.expiredTitle",
        descriptionKey: "raid-auto-manage.disableSelf.expiredDescription",
        lang,
      });
      return;
    }
    if (interaction.user.id !== targetDiscordId) {
      await deferEphemeralReply(interaction);
      const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
      await editNoticeByKey(interaction, {
        type: "lock",
        titleKey: "raid-auto-manage.disableSelf.notOwnerTitle",
        descriptionKey: "raid-auto-manage.disableSelf.notOwnerDescription",
        lang,
      });
      return;
    }

    await interaction.deferUpdate();
    const [lang, result] = await Promise.all([
      getUserLanguage(interaction.user.id, { UserModel: User }),
      tryDisableAutoManage(User, targetDiscordId),
    ]);
    const handled = await replyAtomicOutcome(
      interaction,
      {
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
      { lang, targetDiscordId, result },
      followUpNoticeByKey
    );
    if (handled) return;

    const textKeys = result.outcome === "disabled"
      ? {
          titleKey: "raid-auto-manage.disableSelf.disabledTitle",
          descriptionKey: "raid-auto-manage.disableSelf.disabledDescription",
        }
      : {
          titleKey: "raid-auto-manage.disableSelf.alreadyOffTitle",
          descriptionKey: "raid-auto-manage.disableSelf.alreadyOffDescription",
        };
    console.log(
      `[raid-check disable-auto-self] user=${targetDiscordId} outcome=${result.outcome}`
    );
    await editNoticeByText(interaction, {
      type: "muted",
      title: t(textKeys.titleKey, lang),
      description: t(textKeys.descriptionKey, lang),
    });
  }

  async function handleRaidCheckEnableAutoSelfClick(interaction, targetDiscordId) {
    if (!targetDiscordId) {
      await deferEphemeralReply(interaction);
      const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
      await editNoticeByKey(interaction, {
        type: "warn",
        titleKey: "raid-auto-manage.enableSelf.expiredTitle",
        descriptionKey: "raid-auto-manage.enableSelf.expiredDescription",
        lang,
      });
      return;
    }
    if (interaction.user.id !== targetDiscordId) {
      await deferEphemeralReply(interaction);
      const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
      await editNoticeByKey(interaction, {
        type: "lock",
        titleKey: "raid-auto-manage.enableSelf.notOwnerTitle",
        descriptionKey: "raid-auto-manage.enableSelf.notOwnerDescription",
        lang,
      });
      return;
    }

    await interaction.deferUpdate();
    const [lang, result] = await Promise.all([
      getUserLanguage(interaction.user.id, { UserModel: User }),
      tryEnableAutoManage(User, targetDiscordId),
    ]);
    const handled = await replyAtomicOutcome(
      interaction,
      {
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
      { lang, targetDiscordId, result },
      followUpNoticeByKey
    );
    if (handled) return;

    const textByOutcome = {
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
    };
    const textKeys = textByOutcome[result.outcome] || textByOutcome["already-on"];
    console.log(
      `[raid-check enable-auto-self] user=${targetDiscordId} outcome=${result.outcome}`
    );
    await editNoticeByText(interaction, {
      type: "success",
      title: t(textKeys.titleKey, lang),
      description: t(textKeys.descriptionKey, lang),
    });
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
