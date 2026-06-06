"use strict";

const { t, getUserLanguage } = require("../../../services/i18n");
const {
  buildRaidCheckEditDMEmbed: buildRaidCheckEditDMEmbedPayload,
} = require("./dm");
const { buildRaidCheckEditApplySummary } = require("./summary");

function createRaidCheckEditApplyActions({
  EmbedBuilder,
  UI,
  User,
  RAID_REQUIREMENT_MAP,
  discordUserLimiter,
  applyRaidSetForDiscordId,
  applyLocalRaidEditToChar,
  buildEditEmbed,
  buildEditComponents,
}) {
  async function postEditSessionExpiredNotice(interaction, note) {
    const channel = interaction.channel;
    if (!channel || typeof channel.send !== "function") return;
    try {
      const sent = await channel.send({
        content: `<@${interaction.user.id}> ${note}`,
        allowedMentions: { users: [interaction.user.id] },
      });
      setTimeout(() => {
        sent.delete().catch(() => {});
      }, 30_000);
    } catch (err) {
      console.warn(
        `[raid-check edit] session-expired tag post failed:`,
        err?.message || err
      );
    }
  }

  function buildRaidCheckEditDMEmbed(args) {
    return buildRaidCheckEditDMEmbedPayload({
      EmbedBuilder,
      UI,
      ...args,
    });
  }

  async function sendTargetDm({ component, state, targetChar, raidMeta, statusType, gate, result }) {
    const isSelfEdit = state.selectedUser === component.user.id;
    const didApplyWrite =
      result?.updated === true &&
      !result?.noRoster &&
      result?.matched !== 0 &&
      !result?.ineligibleItemLevel;
    if (!didApplyWrite) return null;
    if (isSelfEdit) return "skipped-self";

    try {
      const user = await discordUserLimiter.run(() =>
        component.client.users.fetch(state.selectedUser)
      );
      const dmChannel = await user.createDM();
      const targetLang = await getUserLanguage(state.selectedUser, { UserModel: User });
      const dmEmbed = buildRaidCheckEditDMEmbed({
        targetChar,
        raidMeta,
        statusType,
        gate,
        modeResetHappened: result?.modeResetCount > 0,
        lang: targetLang,
      });
      await dmChannel.send({ embeds: [dmEmbed] });
      return "sent";
    } catch (err) {
      console.warn(
        `[raid-check edit] DM to ${state.selectedUser} failed:`,
        err?.message || err
      );
      return "failed";
    }
  }

  async function applyRaidEdit(component, state, statusType, gate, effectiveGates) {
    return applyRaidSetForDiscordId({
      discordId: state.selectedUser,
      characterName: state.selectedChar.charName,
      rosterName: state.selectedChar.accountName,
      raidMeta: RAID_REQUIREMENT_MAP[state.selectedRaid],
      statusType,
      effectiveGates,
    });
  }

  async function handleApplyFailure(component, state, err) {
    const lang = state.lang || "vi";
    state.locked = false;
    state.applied = false;
    state.warning = t("raid-check.editFlow.applyFailedWarning", lang, {
      warnIcon: UI.icons.warn,
      error: err?.message || String(err),
    });
    await component.message.edit({
      embeds: [buildEditEmbed(state)],
      components: buildEditComponents(state),
    }).catch(() => {});
    console.warn(`[raid-check edit] apply failed:`, err?.message || err);
  }

  async function refreshAppliedUi({ component, state, targetChar, raidKey, statusType, gate, statusLabel, raidLabel }) {
    const lang = state.lang || "vi";
    let uiRefreshed = false;
    try {
      await component.message.edit({
        embeds: [buildEditEmbed(state)],
        components: buildEditComponents(state),
      });
      uiRefreshed = true;
    } catch (err) {
      console.warn(
        `[raid-check edit] post-apply UI refresh failed:`,
        err?.message || err
      );
    }

    console.log(
      `[raid-check edit] applied user=${state.selectedUser} char=${targetChar.charName} raid=${raidKey} status=${statusType}${gate ? ` gate=${gate}` : ""}`
    );
    if (uiRefreshed) return;

    await postEditSessionExpiredNotice(
      component,
      t("raid-check.editFlow.applyUiRefreshFailNotice", lang, {
        statusLabel,
        charName: targetChar.charName,
        raidLabel,
      })
    );
  }

  async function applyEditAndConfirm(component, state, statusType, gate) {
    const lang = state.lang || "vi";
    state.locked = true;
    await component.update({
      embeds: [buildEditEmbed(state)],
      components: buildEditComponents(state),
    }).catch(() => {});

    const raidKey = state.selectedRaid;
    const raidMeta = RAID_REQUIREMENT_MAP[raidKey];
    const targetChar = state.selectedChar;
    const effectiveGates = statusType === "process" && gate ? [gate] : [];

    let result;
    try {
      result = await applyRaidEdit(component, state, statusType, gate, effectiveGates);
    } catch (err) {
      await handleApplyFailure(component, state, err);
      return;
    }

    if (result?.updated) {
      applyLocalRaidEditToChar(targetChar, raidMeta, statusType, effectiveGates);
    }
    state.applied = true;

    const dmOutcome = await sendTargetDm({
      component,
      state,
      targetChar,
      raidMeta,
      statusType,
      gate,
      result,
    });
    const {
      message,
      statusLabel,
      raidLabel: raidLabelManager,
    } = buildRaidCheckEditApplySummary({
      result,
      targetChar,
      raidMeta,
      statusType,
      gate,
      dmOutcome,
      lang,
      UI,
    });
    state.message = message;

    await refreshAppliedUi({
      component,
      state,
      targetChar,
      raidKey,
      statusType,
      gate,
      statusLabel,
      raidLabel: raidLabelManager,
    });
  }

  return {
    applyEditAndConfirm,
    buildRaidCheckEditDMEmbed,
    postEditSessionExpiredNotice,
  };
}

module.exports = {
  createRaidCheckEditApplyActions,
};
