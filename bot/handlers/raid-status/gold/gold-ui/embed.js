"use strict";

const { pack2Columns } = require("../../../../utils/raid/common/shared");
const {
  GOLD_RAID_CAP_PER_CHARACTER,
  summarizeAccountGold,
  summarizeGlobalGold,
} = require("../../../../utils/raid/common/character");
const {
  GOLD_RECEIVE_ICON,
  localizedRaidLabel,
  rawGoldTotal,
} = require("../gold-formatting");

const PAGE_CHAR_CAP = 11;

function createGoldViewEmbedBuilder({
  EmbedBuilder,
  UI,
  getClassEmoji,
  getCharacterName,
  truncateText,
  formatGold,
  getAccounts,
  getCurrentPage,
  getRaidsFor,
  lang,
  t,
  filterState,
}) {
  const {
    goldCharactersOnPage,
  } = filterState;

  function goldBoundTail(gold) {
    const totalBound = Number(gold?.totalBound) || 0;
    if (totalBound <= 0) return "";
    const earnedBound = Number(gold?.earnedBound) || 0;
    return t("raid-status.embed.goldBoundTail", lang, {
      bound: `${formatGold(earnedBound)} / ${formatGold(totalBound)}`,
    });
  }

  // Pending-mode tail for the gold view. Reuses the raid-view marker string so
  // both surfaces read the same "-> {mode} (sau reset)" vocabulary. Only shows
  // when a change is queued (raid ran this week so modeKey was not flipped yet).
  function goldPendingTail(raid) {
    if (!raid.pendingModeKey || raid.pendingModeKey === raid.modeKey) return "";
    const { getRaidSpecificModeLabel } = require("../../../../utils/raid/common/labels");
    const modeLabel = getRaidSpecificModeLabel(raid.raidKey, raid.pendingModeKey, lang)
      || raid.pendingModeKey;
    return ` ${t("raid-status.raidView.pendingModeMark", lang, { mode: modeLabel })}`;
  }

  function formatGoldRaidLine(raid) {
    const label = localizedRaidLabel(raid, lang);
    const pendingTail = goldPendingTail(raid);
    if (!raid.goldReceives) {
      // Not receiving. The leading lock only means roster-bound gold; an
      // unbound raid outside the cap stays neutral so lock never doubles as
      // an "excluded" marker.
      let reason;
      if (raid.goldDisabled) reason = t("raid-status.goldView.manualOff", lang);
      else if (raid.goldExcludedReason === "bound") reason = t("raid-status.goldView.autoBound", lang);
      else reason = t("raid-status.goldView.outsideCap", lang, { cap: GOLD_RAID_CAP_PER_CHARACTER });
      const icon = raid.goldBound ? UI.icons.lock : UI.icons.pending;
      return `${icon} ${label} - ${reason}${pendingTail}`;
    }

    // Receiving raids keep the gold icon as the leading marker. Bound gold
    // gets a lock next to the amount so forced bound slots still read as gold.
    const rank = Number(raid.goldSlotRank) || 0;
    const slot = rank > 0 ? `#${rank} ` : "";
    const goldStr = formatGold(rawGoldTotal(raid));
    const amount = raid.goldBound ? `${UI.icons.lock} ${goldStr}` : goldStr;
    return `${GOLD_RECEIVE_ICON} ${slot}${label} - ${amount}${pendingTail}`;
  }

  function buildGoldCharacterField(character) {
    const raids = getRaidsFor(character);
    const name = getCharacterName(character);
    const classIcon = getClassEmoji(character.class || character.className);
    const namePrefix = classIcon ? `${classIcon} ` : "";
    const itemLevel = Number(character.itemLevel) || 0;
    const counted = raids.filter((raid) => raid.goldReceives).length;
    const header = `${namePrefix}${name} \u00B7 ${itemLevel} \u00B7 ${counted}/${GOLD_RAID_CAP_PER_CHARACTER}`;
    const lines = raids.length === 0
      ? [`${UI.icons.lock} ${t("raid-status.embed.notEligible", lang)}`]
      : raids.map(formatGoldRaidLine);
    return {
      name: truncateText(header, 256),
      value: truncateText(lines.join("\n"), 1024),
      inline: true,
    };
  }

  return function buildGoldViewEmbed(account) {
    const accountName = String(account?.accountName || "(unnamed roster)");
    const accountGold = summarizeAccountGold(account, getRaidsFor);
    const globalGold = summarizeGlobalGold(getAccounts(), getRaidsFor);
    const goldChars = goldCharactersOnPage();
    const embed = new EmbedBuilder()
      .setColor(accountGold.earned > 0 ? UI.colors.success : UI.colors.neutral)
      .setTitle(t("raid-status.goldView.embedTitle", lang, { accountName }))
      .setTimestamp();

    if (goldChars.length === 0) {
      embed.setDescription(t("raid-status.goldView.emptyDescription", lang, {
        cap: GOLD_RAID_CAP_PER_CHARACTER,
      }));
      return embed;
    }

    // Disjoint buckets: 💰 shows the tradeable (unbound) gold, the bound tail
    // shows the roster-bound gold; they never overlap.
    const descriptionLines = [];
    if (getAccounts().length > 1) {
      descriptionLines.push(t("raid-status.goldView.allAccounts", lang, {
        earned: formatGold(globalGold.earnedUnbound),
        total: formatGold(globalGold.totalUnbound),
        boundTail: goldBoundTail(globalGold),
      }));
    }
    descriptionLines.push(t("raid-status.goldView.accountLine", lang, {
      earned: formatGold(accountGold.earnedUnbound),
      total: formatGold(accountGold.totalUnbound),
      boundTail: goldBoundTail(accountGold),
    }));
    descriptionLines.push(t("raid-status.goldView.mainDescription", lang, {
      cap: GOLD_RAID_CAP_PER_CHARACTER,
    }));
    embed.setDescription(descriptionLines.join("\n"));

    const fields = goldChars.map(buildGoldCharacterField);
    const visibleFields = fields.length <= PAGE_CHAR_CAP
      ? pack2Columns(fields)
      : fields.map((field) => ({ ...field, inline: false }));
    const fieldBudget = fields.length > PAGE_CHAR_CAP && fields.length > 25 ? 24 : 25;
    embed.addFields(...visibleFields.slice(0, fieldBudget));
    if (fields.length > PAGE_CHAR_CAP && fields.length > fieldBudget) {
      embed.addFields({
        name: "...",
        value: t("raid-status.goldView.moreCharacters", lang, { n: fields.length - fieldBudget }),
        inline: false,
      });
    }

    const footerParts = [
      t("raid-status.goldView.footerGold", lang, {
        earned: formatGold(accountGold.earnedUnbound),
        total: formatGold(accountGold.totalUnbound),
      }),
    ];
    if (accountGold.totalBound > 0) {
      footerParts.push(t("raid-status.goldView.footerBound", lang, {
        bound: `${formatGold(accountGold.earnedBound)} / ${formatGold(accountGold.totalBound)}`,
      }));
    }
    if (getAccounts().length > 1) {
      footerParts.push(t("raid-status.taskView.footerPage", lang, {
        current: getCurrentPage() + 1,
        total: getAccounts().length,
      }));
    }
    embed.setFooter({ text: footerParts.join(" \u00B7 ") });
    return embed;
  };
}

module.exports = {
  createGoldViewEmbedBuilder,
};
