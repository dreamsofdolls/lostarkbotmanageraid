"use strict";

const { t } = require("../../../services/i18n");
const { firstSelectValue } = require("../../../utils/discord/component-values");
const { followUpNotice } = require("../../../utils/raid/common/shared");
const { replaceRaidGoldSelection } = require("./gold-actions");
const {
  goldReceiveIcon,
  localizedRaidLabel,
  rawGoldTotal,
} = require("./gold-formatting");

const GOLD_REPLACE_SELECT_ID = "status-gold:replace";

function noRedraw() {
  return { redraw: false };
}

function redraw() {
  return { redraw: true };
}

function makeGoldReplaceSelectId() {
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${GOLD_REPLACE_SELECT_ID}:${token}`;
}

function goldReplaceTokenFromId(customId) {
  const prefix = `${GOLD_REPLACE_SELECT_ID}:`;
  const id = String(customId || "");
  return id.startsWith(prefix) ? id.slice(prefix.length) : "";
}

function createGoldReplacementFlow(ctx) {
  const {
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    UI,
    User,
    saveWithRetry,
    interaction,
    discordId,
    lang,
    reloadViewerAccounts,
    formatGold,
    truncateText,
  } = ctx;
  const sessions = new Map();

  function buildPrompt(replacement, selectId) {
    const targetRaid = localizedRaidLabel(replacement.targetRaid, lang);
    const embed = new EmbedBuilder()
      .setColor(UI.colors.progress)
      .setTitle(`${UI.icons.lock} ${t("raid-status.goldView.replaceRequiredTitle", lang, {
        cap: replacement.cap,
      })}`)
      .setDescription(t("raid-status.goldView.replaceRequiredDescription", lang, {
        cap: replacement.cap,
        characterName: replacement.targetCharName,
        targetRaid,
      }));

    const options = (replacement.options || []).slice(0, 25).map((raid) => {
      const rank = Number(raid.goldSlotRank) || 0;
      const rankPrefix = rank > 0 ? `#${rank} ` : "";
      return {
        label: truncateText(`${goldReceiveIcon(raid, UI)} ${rankPrefix}${localizedRaidLabel(raid, lang)}`, 100),
        description: truncateText(formatGold(rawGoldTotal(raid)), 100),
        value: raid.raidKey,
      };
    });

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(selectId)
        .setPlaceholder(t("raid-status.goldView.replacePlaceholder", lang))
        .addOptions(options.length > 0 ? options : [{ label: "(empty)", value: "noop" }])
        .setDisabled(options.length === 0)
    );

    return { embed, row };
  }

  async function warn(component) {
    await followUpNotice(component, EmbedBuilder, {
      type: "warn",
      title: t("raid-status.goldView.toggleFailedTitle", lang),
      description: t("raid-status.goldView.toggleFailedDescription", lang),
    }).catch(() => {});
  }

  async function prompt({
    component,
    replacement,
    writeDiscordId,
    targetAccountName,
  }) {
    const selectId = makeGoldReplaceSelectId();
    const token = goldReplaceTokenFromId(selectId);
    const { embed, row } = buildPrompt(replacement, selectId);
    sessions.set(token, {
      replacement,
      writeDiscordId,
      targetAccountName,
    });

    const edited = await interaction.editReply({
      embeds: [embed],
      components: [row],
      attachments: [],
      files: [],
    }).then(() => true).catch((err) => {
      console.warn("[raid-status gold replace] prompt edit failed:", err?.message || err);
      return false;
    });

    if (!edited) {
      sessions.delete(token);
      await warn(component);
    }
    return noRedraw();
  }

  async function complete(component) {
    const token = goldReplaceTokenFromId(component?.customId);
    const pending = token ? sessions.get(token) : null;
    if (!pending) {
      await warn(component);
      return redraw();
    }

    const removedRaidKey = firstSelectValue(component, "");
    if (!removedRaidKey || removedRaidKey === "noop") {
      return noRedraw();
    }

    sessions.delete(token);
    const { replacement, writeDiscordId, targetAccountName } = pending;
    const targetRaid = localizedRaidLabel(replacement.targetRaid, lang);
    const removedRaid = (replacement.options || []).find((raid) => raid.raidKey === removedRaidKey);
    let replaceResult;
    try {
      replaceResult = await replaceRaidGoldSelection({
        User,
        saveWithRetry,
        discordId: writeDiscordId,
        targetAccountName,
        targetCharName: replacement.targetCharName,
        includeRaidKey: replacement.targetRaid.raidKey,
        excludeRaidKey: removedRaidKey,
      });
    } catch (err) {
      console.warn("[raid-status gold replace] save failed:", err?.message || err);
      replaceResult = { ok: false };
    }

    if (!replaceResult.ok) {
      await warn(component);
      return redraw();
    }

    await reloadViewerAccounts(writeDiscordId === discordId ? replaceResult.userDoc : null);
    await followUpNotice(component, EmbedBuilder, {
      type: "success",
      title: t("raid-status.goldView.replaceSuccessTitle", lang),
      description: t("raid-status.goldView.replaceSuccessDescription", lang, {
        characterName: replacement.targetCharName,
        targetRaid,
        removedRaid: localizedRaidLabel(removedRaid, lang),
      }),
    }).catch(() => {});
    return redraw();
  }

  return {
    complete,
    prompt,
  };
}

module.exports = {
  GOLD_REPLACE_SELECT_ID,
  createGoldReplacementFlow,
  goldReplaceTokenFromId,
};
