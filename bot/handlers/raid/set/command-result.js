"use strict";

const {
  createRaidChannelEmbedBuilders,
} = require("../../../services/raid/channel-monitor/channel-monitor-embeds");
const {
  NoticeKind,
  buildNoRosterNotice,
  buildRosterNotFoundNotice,
  formatCharacterLabel,
} = require("../../../utils/raid/common/shared");

function createRaidSetResultResponder({ EmbedBuilder, UI, t }) {
  const { buildRaidChannelReceiptEmbed } = createRaidChannelEmbedBuilders({ EmbedBuilder, UI });

  // A notice whose copy lives at `raid-set.<stem>{Title,Description,Tip}`.
  function setNotice(kind, stem, lang, vars) {
    return {
      kind,
      title: t(`raid-set.${stem}Title`, lang),
      description: t(`raid-set.${stem}Description`, lang, vars),
      tip: t(`raid-set.${stem}Tip`, lang),
    };
  }

  async function replyRosterOwnerFailure({
    replySetNotice,
    resolvedOwner,
    lang,
    rosterName,
  }) {
    if (!resolvedOwner) {
      await replySetNotice(buildRosterNotFoundNotice(rosterName, lang));
      return true;
    }

    if (!resolvedOwner.ambiguous) return false;

    const ownerNames = resolvedOwner.matches
      .map((entry) => entry.ownerLabel)
      .join(", ");
    await replySetNotice(setNotice(NoticeKind.INPUT, "roster.ambiguous", lang, {
      count: resolvedOwner.matches.length,
      rosterName,
      ownerNames,
    }));
    return true;
  }

  async function replyMissingRoster({
    replySetNotice,
    actingForOther,
    targetDiscordId,
    lang,
  }) {
    await replySetNotice(actingForOther
      ? setNotice(NoticeKind.EMPTY, "roster.deletedForOther", lang, { target: targetDiscordId })
      : buildNoRosterNotice(lang));
  }

  async function replyAuthLost({
    replySetNotice,
    lang,
    rosterName,
    targetDiscordId,
  }) {
    await replySetNotice(setNotice(NoticeKind.GUARD, "roster.authLost", lang, {
      rosterName,
      target: targetDiscordId,
    }), {
      allowedMentions: { parse: [] },
    });
  }

  async function replyCharacterMissing({
    replySetNotice,
    lang,
    characterName,
    rosterName,
  }) {
    await replySetNotice(setNotice(NoticeKind.EMPTY, "character.notFound", lang, {
      characterName,
      rosterName,
    }));
  }

  async function replyAlready({
    replySetNotice,
    lang,
    type,
    localizedRaid,
    effectiveGate,
    characterLabel,
  }) {
    const scope = effectiveGate ? `${localizedRaid} \u00b7 ${effectiveGate}` : localizedRaid;
    await replySetNotice(setNotice(NoticeKind.INPUT, `already.${type}`, lang, { characterLabel, scope }));
  }

  async function replyIneligible({
    replySetNotice,
    lang,
    characterLabel,
    result,
    raidMeta,
    localizedRaid,
  }) {
    await replySetNotice(setNotice(NoticeKind.INPUT, "character.notEligible", lang, {
      characterLabel,
      itemLevel: result.ineligibleItemLevel,
      minItemLevel: raidMeta.minItemLevel,
      raidLabel: localizedRaid,
    }));
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

  // Results that answer with a notice, in the order they are checked: the
  // first that applies is the reply. A result past all of them was written
  // and gets the receipt.
  const RESULT_NOTICES = Object.freeze([
    { applies: (result) => result.noRoster, reply: replyMissingRoster },
    { applies: (result) => result.authLost, reply: replyAuthLost },
    { applies: (result) => !result.matched, reply: replyCharacterMissing },
    { applies: (result) => result.alreadyComplete, reply: (context) => replyAlready({ ...context, type: "complete" }) },
    { applies: (result) => result.alreadyReset, reply: (context) => replyAlready({ ...context, type: "reset" }) },
    { applies: (result) => !result.updated, reply: replyIneligible },
  ]);

  /**
   * Reply to a /raid-set run with the notice or receipt its result calls for.
   * @param {object} params - the reply functions, the run's inputs and:
   * @param {object} params.result - from applyRaidSetForDiscordId
   * @param {Array<{accountName: string, account: object}>} params.accounts -
   *   the owner's rosters read after the write; the receipt draws the
   *   character's card from them
   * @returns {Promise<void>}
   */
  async function replyRaidSetResult(params) {
    const { result, characterName } = params;
    const context = {
      ...params,
      characterLabel: formatCharacterLabel(result.displayName || characterName, result.displayClass),
    };
    const notice = RESULT_NOTICES.find((rule) => rule.applies(result));
    await (notice ? notice.reply(context) : replySuccess(context));
  }

  return {
    replyRaidSetResult,
    replyRosterOwnerFailure,
  };
}

module.exports = {
  createRaidSetResultResponder,
};
