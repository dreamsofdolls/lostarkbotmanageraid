"use strict";

const { disableComponentRows } = require("../../../../utils/discord/component-rows");
const { firstSelectValue } = require("../../../../utils/discord/component-values");
const { t } = require("../../../../services/i18n");
const { getRaidModeLabel } = require("../../../../utils/raid/common/labels");
const { RAID_CHECK_EDIT_COMPONENT_ACTION } = require("./component-routes");
const { loadEditableRaidContext } = require("./session");

function applyPreSelectedUser({
  state,
  editableByUser,
  pickedRaidMeta,
  lang,
  UI,
}) {
  if (!state.preSelectedUserId) return;
  if (editableByUser.has(state.preSelectedUserId)) {
    state.selectedUser = state.preSelectedUserId;
  } else {
    const preName = state.preSelectedDisplayName || state.preSelectedUserId;
    state.warning = t("raid-check.editFlow.preSelectDropped", lang, {
      infoIcon: UI.icons.info,
      name: preName,
      raidLabel: getRaidModeLabel(pickedRaidMeta.raidKey, pickedRaidMeta.modeKey, lang),
    });
  }
  state.preSelectedUserId = null;
  state.preSelectedDisplayName = null;
}

function createRaidCheckEditComponentHandlers({
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
}) {
  return {
    [RAID_CHECK_EDIT_COMPONENT_ACTION.raid]: async (component) => {
      const pickedRaidKey = firstSelectValue(component, "");
      const pickedRaidMeta = RAID_REQUIREMENT_MAP[pickedRaidKey];
      if (!pickedRaidMeta) {
        state.warning = t("raid-check.editFlow.raidInvalidWarning", lang, {
          warnIcon: UI.icons.warn,
        });
        await component.update({
          embeds: [buildEditEmbed(state)],
          components: buildEditComponents(state),
        }).catch(() => {});
        return;
      }

      await component.deferUpdate().catch(() => {});
      try {
        const {
          editableByUser: newEditableByUser,
          displayMap: newDisplayMap,
        } = await loadEditableRaidContext({
          raidMeta: pickedRaidMeta,
          computeRaidCheckSnapshot,
          buildEditableCharsByUser,
          resolveCachedDisplayName,
          client: interaction.client,
        });

        state.raidMeta = pickedRaidMeta;
        state.selectedRaid = pickedRaidKey;
        state.editableByUser = newEditableByUser;
        state.displayMap = newDisplayMap;
        state.selectedUser = null;
        state.selectedChar = null;
        state.awaitingGate = false;
        state.warning = null;
        applyPreSelectedUser({
          state,
          editableByUser: newEditableByUser,
          pickedRaidMeta,
          lang,
          UI,
        });
      } catch (err) {
        state.warning = t("raid-check.editFlow.snapshotLoadFailWarning", lang, {
          warnIcon: UI.icons.warn,
          error: err?.message || String(err),
        });
        console.warn(`[raid-check edit scopeAll] raid-pick load failed:`, err?.message || err);
      }

      await interaction.editReply({
        embeds: [buildEditEmbed(state)],
        components: buildEditComponents(state),
      }).catch(() => {});
    },

    [RAID_CHECK_EDIT_COMPONENT_ACTION.user]: async (component) => {
      state.selectedUser = firstSelectValue(component);
      state.selectedChar = null;
      state.awaitingGate = false;
      state.warning = null;
      await component.update({
        embeds: [buildEditEmbed(state)],
        components: buildEditComponents(state),
      }).catch(() => {});
    },

    [RAID_CHECK_EDIT_COMPONENT_ACTION.char]: async (component) => {
      const group = state.editableByUser.get(state.selectedUser);
      const [accountName, charName] = firstSelectValue(component, "").split("||");
      const picked = (group?.chars || []).find(
        (item) => item.accountName === accountName && item.charName === charName
      );
      state.selectedChar = picked || null;
      state.awaitingGate = false;
      state.warning = null;
      await component.update({
        embeds: [buildEditEmbed(state)],
        components: buildEditComponents(state),
      }).catch(() => {});
    },

    [RAID_CHECK_EDIT_COMPONENT_ACTION.status]: async (component, route) => {
      const statusType = route.statusType;
      if (statusType === "process") {
        state.awaitingGate = true;
        state.warning = t("raid-check.editFlow.pickGateWarning", lang);
        await component.update({
          embeds: [buildEditEmbed(state)],
          components: buildEditComponents(state),
        }).catch(() => {});
        return;
      }
      await applyEditAndConfirm(component, state, statusType, null);
    },

    [RAID_CHECK_EDIT_COMPONENT_ACTION.gate]: async (component, route) => {
      await applyEditAndConfirm(component, state, "process", route.gate);
    },

    [RAID_CHECK_EDIT_COMPONENT_ACTION.cancel]: async (component) => {
      state.locked = true;
      await component.update({
        embeds: [
          EmbedBuilder.from(buildEditEmbed(state)).setFooter({
            text: t("raid-check.editFlow.footerClosed", lang),
          }),
        ],
        components: disableComponentRows(buildEditComponents(state)),
      }).catch(() => {});
      collector.stop("cancelled");
    },
  };
}

module.exports = {
  createRaidCheckEditComponentHandlers,
};
