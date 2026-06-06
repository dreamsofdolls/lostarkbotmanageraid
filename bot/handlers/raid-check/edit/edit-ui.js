"use strict";

const { buildNoticeEmbed, replyNotice } = require("../../../utils/raid/common/shared");
const { disableComponentRows } = require("../../../utils/discord/component-rows");
const { t, getUserLanguage } = require("../../../services/i18n");
const {
  getRaidCheckEditComponentRoute,
} = require("./edit-ui/component-routes");
const { createRaidCheckEditApplyActions } = require("./edit-ui/apply");
const { createRaidCheckEditRenderer } = require("./edit-ui/render");
const {
  createRaidCheckEditComponentHandlers,
} = require("./edit-ui/component-handlers");
const {
  createRaidCheckEditState,
  getOpenedRaidLabel,
  loadEditableRaidContext,
  resolvePreSelectedDisplayName,
} = require("./edit-ui/session");

function createEditUi({
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  UI,
  User,
  truncateText,
  RAID_REQUIREMENT_MAP,
  resolveDiscordDisplay,
  resolveCachedDisplayName,
  discordUserLimiter,
  applyRaidSetForDiscordId,
  computeRaidCheckSnapshot,
  buildEditableCharsByUser,
  getCharRaidGateStatus,
  formatGateStateLine,
  formatCharEditLabel,
  formatUserEditLabel,
  applyLocalRaidEditToChar,
  RAID_CHECK_EDIT_SESSION_MS,
}) {
  const { buildEditEmbed, buildEditComponents } = createRaidCheckEditRenderer({
    EmbedBuilder,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    UI,
    truncateText,
    RAID_REQUIREMENT_MAP,
    getCharRaidGateStatus,
    formatGateStateLine,
    formatCharEditLabel,
    formatUserEditLabel,
    RAID_CHECK_EDIT_SESSION_MS,
  });

  const {
    applyEditAndConfirm,
    buildRaidCheckEditDMEmbed,
    postEditSessionExpiredNotice,
  } = createRaidCheckEditApplyActions({
    EmbedBuilder,
    UI,
    User,
    RAID_REQUIREMENT_MAP,
    discordUserLimiter,
    applyRaidSetForDiscordId,
    applyLocalRaidEditToChar,
    buildEditEmbed,
    buildEditComponents,
  });

  async function handleRaidCheckEditClick(interaction, raidMeta, raidKey, preSelectedUserId = null) {
    const started = Date.now();
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const scopeAll = !raidMeta;
    const preSelectedDisplayName = await resolvePreSelectedDisplayName({
      scopeAll,
      preSelectedUserId,
      User,
      interaction,
      resolveDiscordDisplay,
    });

    let editableByUser = new Map();
    let displayMap = new Map();
    if (!scopeAll) {
      const context = await loadEditableRaidContext({
        raidMeta,
        computeRaidCheckSnapshot,
        buildEditableCharsByUser,
        resolveCachedDisplayName,
        client: interaction.client,
      });
      editableByUser = context.editableByUser;
      displayMap = context.displayMap;

      if (editableByUser.size === 0) {
        await interaction.editReply({
          content: null,
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "info",
              title: t("raid-check.editFlow.noEditableTitle", lang),
              description: t("raid-check.editFlow.noEditableDescription", lang, {
                minItemLevel: raidMeta.minItemLevel,
              }),
            }),
          ],
        });
        return;
      }
    }

    const state = createRaidCheckEditState({
      scopeAll,
      lang,
      raidMeta,
      raidKey,
      editableByUser,
      displayMap,
      preSelectedUserId,
      preSelectedDisplayName,
    });

    await interaction.editReply({
      embeds: [buildEditEmbed(state)],
      components: buildEditComponents(state),
    });
    const followup = await interaction.fetchReply();
    console.log(
      `[raid-check edit] opened raid=${getOpenedRaidLabel({ scopeAll, raidMeta })} users=${editableByUser.size} openMs=${Date.now() - started}`
    );

    const collector = followup.createMessageComponentCollector({
      time: RAID_CHECK_EDIT_SESSION_MS,
    });
    const editComponentHandlers = createRaidCheckEditComponentHandlers({
      state,
      interaction,
      collector,
      lang,
      EmbedBuilder,
      UI,
      RAID_REQUIREMENT_MAP,
      computeRaidCheckSnapshot,
      buildEditableCharsByUser,
      resolveCachedDisplayName,
      buildEditEmbed,
      buildEditComponents,
      applyEditAndConfirm,
    });

    collector.on("collect", async (component) => {
      if (component.user.id !== interaction.user.id) {
        const clickerLang = await getUserLanguage(component.user.id, { UserModel: User });
        await replyNotice(component, EmbedBuilder, {
          type: "lock",
          title: t("raid-check.editFlow.lockOtherTitle", clickerLang),
          description: t("raid-check.editFlow.lockOtherDescription", clickerLang),
        }).catch(() => {});
        return;
      }

      const route = getRaidCheckEditComponentRoute(component.customId);
      const handler = route ? editComponentHandlers[route.handler] : null;
      if (!handler) {
        await component.deferUpdate().catch(() => {});
        return;
      }
      await handler(component, route);
    });

    collector.on("end", async (_collected, reason) => {
      if (reason === "cancelled" || state.applied) return;
      let refreshed = false;
      try {
        await interaction.editReply({
          embeds: [
            EmbedBuilder.from(buildEditEmbed(state)).setFooter({
              text: t("raid-check.editFlow.footerExpired", lang),
            }),
          ],
          components: disableComponentRows(buildEditComponents(state)),
        });
        refreshed = true;
      } catch (err) {
        console.warn(`[raid-check edit] session-end edit failed:`, err?.message || err);
      }
      if (!refreshed) {
        await postEditSessionExpiredNotice(
          interaction,
          t("raid-check.editFlow.sessionExpiredNotice", lang)
        );
      }
    });
  }

  return {
    buildEditEmbed,
    buildEditComponents,
    handleRaidCheckEditClick,
    postEditSessionExpiredNotice,
    buildRaidCheckEditDMEmbed,
    applyEditAndConfirm,
  };
}

module.exports = { createEditUi };
