"use strict";

const {
  createRaidChannelEmbedBuilders,
} = require("../../../services/raid/channel-monitor/channel-monitor-embeds");

function createRaidSetResultResponder({ EmbedBuilder, UI, t }) {
  const { buildRaidChannelReceiptEmbed } = createRaidChannelEmbedBuilders({ EmbedBuilder, UI });

  async function replyRosterOwnerFailure({
    replySetNotice,
    resolvedOwner,
    lang,
    rosterName,
  }) {
    if (!resolvedOwner) {
      await replySetNotice({
        type: "warn",
        title: t("raid-set.roster.notFoundTitle", lang),
        description: t("raid-set.roster.notFoundDescription", lang, { rosterName }),
      });
      return true;
    }

    if (!resolvedOwner.ambiguous) return false;

    const ownerNames = resolvedOwner.matches
      .map((entry) => entry.ownerLabel)
      .join(", ");
    await replySetNotice({
      type: "warn",
      title: t("raid-set.roster.ambiguousTitle", lang),
      description: t("raid-set.roster.ambiguousDescription", lang, {
        count: resolvedOwner.matches.length,
        rosterName,
        ownerNames,
      }),
    });
    return true;
  }

  async function replyMissingRoster({
    replySetNotice,
    actingForOther,
    targetDiscordId,
    lang,
  }) {
    const description = actingForOther
      ? t("raid-set.roster.deletedForOtherDescription", lang, { target: targetDiscordId })
      : t("raid-set.roster.noRosterDescription", lang);
    await replySetNotice({
      type: "info",
      title: actingForOther
        ? t("raid-set.roster.deletedForOtherTitle", lang)
        : t("raid-set.roster.noRosterTitle", lang),
      description,
    });
  }

  async function replyAuthLost({
    replySetNotice,
    lang,
    rosterName,
    targetDiscordId,
  }) {
    await replySetNotice({
      type: "lock",
      title: t("raid-set.roster.authLostTitle", lang),
      description: t("raid-set.roster.authLostDescription", lang, {
        rosterName,
        target: targetDiscordId,
      }),
    }, {
      allowedMentions: { parse: [] },
    });
  }

  async function replyCharacterMissing({
    replySetNotice,
    lang,
    characterName,
    rosterName,
  }) {
    await replySetNotice({
      type: "warn",
      title: t("raid-set.character.notFoundTitle", lang),
      description: t("raid-set.character.notFoundDescription", lang, {
        characterName,
        rosterName,
      }),
    });
  }

  async function replyAlready({
    replySetEmbed,
    lang,
    type,
    localizedRaid,
    effectiveGate,
    characterName,
  }) {
    const scope = effectiveGate ? `${localizedRaid} \u00b7 ${effectiveGate}` : localizedRaid;
    const color = type === "complete" ? UI.colors.progress : UI.colors.muted;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${UI.icons.info} ${t(`raid-set.already.${type}Title`, lang)}`)
      .setDescription(
        t(`raid-set.already.${type}Description`, lang, {
          characterName,
          scope,
        })
      )
      .setTimestamp();
    await replySetEmbed(embed);
  }

  async function replyIneligible({
    replySetNotice,
    lang,
    characterName,
    result,
    raidMeta,
    localizedRaid,
  }) {
    await replySetNotice({
      type: "warn",
      title: t("raid-set.character.notEligibleTitle", lang),
      description: t("raid-set.character.notEligibleDescription", lang, {
        characterName,
        itemLevel: result.ineligibleItemLevel,
        minItemLevel: raidMeta.minItemLevel,
        raidLabel: localizedRaid,
      }),
    });
  }

  /** The command in Discord's option order, echoed on the receipt's first line. */
  function formatRaidSetCommand({ rosterName, characterName, localizedRaid, statusType, effectiveGate }) {
    const gate = effectiveGate ? ` gate:${effectiveGate}` : "";
    return `/raid-set roster:${rosterName} character:${characterName} raid:${localizedRaid} status:${statusType}${gate}`;
  }

  function buildHelperLine({ lang, targetDiscordId, ownerLabel }) {
    const labelHint = ownerLabel
      ? t("raid-set.success.helperLabelHint", lang, { ownerLabel })
      : "";
    return t("raid-set.success.helperLine", lang, {
      iconInfo: UI.icons.info,
      target: targetDiscordId,
      labelHint,
    });
  }

  // The same "Raid Update" card a clear post in the raid channel gets, so a
  // write reads the same whichever way it was made.
  async function replySuccess({
    replySetEmbed,
    lang,
    result,
    raidMeta,
    accounts,
    rosterName,
    statusType,
    localizedRaid,
    effectiveGate,
    characterName,
    actingForOther,
    targetDiscordId,
    ownerLabel,
  }) {
    const receipt = buildRaidChannelReceiptEmbed({
      text: formatRaidSetCommand({ rosterName, characterName, localizedRaid, statusType, effectiveGate }),
      resultGroups: [{ raidMeta, statusType, results: [result] }],
      accounts,
      lang,
    });
    if (actingForOther) {
      receipt.setDescription(`${receipt.data.description}\n${buildHelperLine({ lang, targetDiscordId, ownerLabel })}`);
    }
    const footer = [
      result.modeResetCount > 0
        ? t("raid-set.success.modeChangedFooter", lang, { mode: result.selectedDifficulty })
        : null,
      t(`raid-set.success.nextStep.${statusType}`, lang),
    ].filter(Boolean).join(" ");
    receipt.setFooter({ text: footer });
    await replySetEmbed(receipt, {
      allowedMentions: { parse: [] },
    });
  }

  /**
   * Reply to a /raid-set run with the notice or receipt its result calls for.
   * @param {object} params
   * @param {object} params.result - from applyRaidSetForDiscordId
   * @param {Array<{accountName: string, account: object}>} params.accounts -
   *   the owner's rosters read after the write; the receipt draws the
   *   character's card from them
   * @returns {Promise<void>}
   */
  async function replyRaidSetResult({
    replySetNotice,
    replySetEmbed,
    result,
    accounts,
    lang,
    rosterName,
    characterName,
    raidMeta,
    localizedRaid,
    effectiveGate,
    statusType,
    actingForOther,
    targetDiscordId,
    ownerLabel,
  }) {
    if (result.noRoster) {
      await replyMissingRoster({ replySetNotice, actingForOther, targetDiscordId, lang });
      return;
    }
    if (result.authLost) {
      await replyAuthLost({ replySetNotice, lang, rosterName, targetDiscordId });
      return;
    }
    if (!result.matched) {
      await replyCharacterMissing({ replySetNotice, lang, characterName, rosterName });
      return;
    }
    if (result.alreadyComplete) {
      await replyAlready({
        replySetEmbed,
        lang,
        type: "complete",
        localizedRaid,
        effectiveGate,
        characterName,
      });
      return;
    }
    if (result.alreadyReset) {
      await replyAlready({
        replySetEmbed,
        lang,
        type: "reset",
        localizedRaid,
        effectiveGate,
        characterName,
      });
      return;
    }
    if (!result.updated) {
      await replyIneligible({
        replySetNotice,
        lang,
        characterName,
        result,
        raidMeta,
        localizedRaid,
      });
      return;
    }

    await replySuccess({
      replySetEmbed,
      lang,
      result,
      raidMeta,
      accounts,
      rosterName,
      statusType,
      localizedRaid,
      effectiveGate,
      characterName,
      actingForOther,
      targetDiscordId,
      ownerLabel,
    });
  }

  return {
    replyRaidSetResult,
    replyRosterOwnerFailure,
  };
}

module.exports = {
  createRaidSetResultResponder,
};
