"use strict";

const SUCCESS_COPY = Object.freeze({
  process: {
    titleKey: "raid-set.success.processTitle",
    descriptionKey: "raid-set.success.processDescription",
    params({ effectiveGate, localizedRaid, characterName }) {
      return { gate: effectiveGate, raidLabel: localizedRaid, characterName };
    },
  },
  complete: {
    titleKey: "raid-set.success.completeTitle",
    descriptionKey: "raid-set.success.completeDescription",
    params({ localizedRaid, characterName }) {
      return { raidLabel: localizedRaid, characterName };
    },
  },
  reset: {
    titleKey: "raid-set.success.resetTitle",
    descriptionKey: "raid-set.success.resetDescription",
    params({ localizedRaid, characterName }) {
      return { raidLabel: localizedRaid, characterName };
    },
  },
});

function createRaidSetResultResponder({ EmbedBuilder, UI, t }) {
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

  function buildSuccessCopy({
    lang,
    statusType,
    localizedRaid,
    effectiveGate,
    characterName,
    actingForOther,
    targetDiscordId,
    ownerLabel,
  }) {
    const copy = SUCCESS_COPY[statusType] || SUCCESS_COPY.reset;
    let description = t(
      copy.descriptionKey,
      lang,
      copy.params({ effectiveGate, localizedRaid, characterName })
    );
    if (actingForOther) {
      const labelHint = ownerLabel
        ? t("raid-set.success.helperLabelHint", lang, { ownerLabel })
        : "";
      const helperPrefix = t("raid-set.success.helperPrefix", lang, {
        iconInfo: UI.icons.info,
        target: targetDiscordId,
        labelHint,
      });
      description = `${helperPrefix}${description}`;
    }
    return {
      title: t(copy.titleKey, lang),
      description,
    };
  }

  async function replySuccess({
    replySetEmbed,
    lang,
    result,
    statusType,
    localizedRaid,
    effectiveGate,
    characterName,
    actingForOther,
    targetDiscordId,
    ownerLabel,
  }) {
    const markedDone = statusType === "complete" || statusType === "process";
    const { title, description } = buildSuccessCopy({
      lang,
      statusType,
      localizedRaid,
      effectiveGate,
      characterName,
      actingForOther,
      targetDiscordId,
      ownerLabel,
    });
    const resultEmbed = new EmbedBuilder()
      .setTitle(`${markedDone ? UI.icons.done : UI.icons.reset} ${title}`)
      .setColor(markedDone ? UI.colors.success : UI.colors.muted)
      .setDescription(description)
      .setTimestamp();
    if (result.modeResetCount > 0) {
      resultEmbed.setFooter({
        text: t("raid-set.success.modeChangedFooter", lang, {
          mode: result.selectedDifficulty,
        }),
      });
    }
    await replySetEmbed(resultEmbed, {
      allowedMentions: { parse: [] },
    });
  }

  async function replyRaidSetResult({
    replySetNotice,
    replySetEmbed,
    result,
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
