/**
 * services/raid/channel-monitor/channel-monitor-embeds.js
 * Discord embed builders used by the raid text-channel monitor: the receipt
 * DM for a monitored post and the channel welcome embed.
 */

"use strict";

const { getArtistEmoji } = require("../../../models/ArtistEmoji");
const { t, tPick } = require("../../i18n");
const {
  formatRaidStatusLine,
  getStatusRaidsForCharacter,
} = require("../../../utils/raid/common/character");
const {
  BLANK_FIELD_VALUE,
  appendGroupFields,
  buildCharacterStatusField,
} = require("../../../utils/raid/common/changed-characters");
const {
  getAccessibleCharacterCandidates,
  toCharacterLookupKey,
} = require("./channel-monitor-characters");

const RECEIPT_TEXT_LIMIT = 200;

function joinIfArray(value) {
  return Array.isArray(value) ? value.join("\n") : value;
}

/** The post as typed, on one line and safe inside a code span. */
function formatReceiptText(text) {
  const oneLine = text.replace(/\s+/g, " ").trim().replace(/`/g, "'");
  return oneLine.length > RECEIPT_TEXT_LIMIT
    ? `${oneLine.slice(0, RECEIPT_TEXT_LIMIT - 1)}…`
    : oneLine;
}

function resultOutcome(result) {
  if (result.error) return "errored";
  if (result.updated) return "updated";
  if (result.alreadyComplete || result.alreadyReset) return "already";
  if (!result.matched) return "notFound";
  return "ineligible";
}

/**
 * One outcome per character and raid of the post, plus the totals. A
 * character typed twice finds the raid already DONE on its second write;
 * this post wrote that raid, so "updated" replaces any other outcome for it.
 */
function collectReceiptOutcomes(resultGroups) {
  const byCharacter = new Map();
  const notFoundNames = [];
  for (const group of resultGroups) {
    for (const result of group.results) {
      const outcome = resultOutcome(result);
      if (outcome === "notFound") {
        if (!notFoundNames.includes(result.charName)) notFoundNames.push(result.charName);
        continue;
      }
      // A failed write has no displayName, only the name as typed.
      const key = toCharacterLookupKey(result.displayName || result.charName);
      const raids = byCharacter.get(key) || new Map();
      if (!raids.has(group.raidMeta.raidKey) || outcome === "updated") {
        raids.set(group.raidMeta.raidKey, { raidMeta: group.raidMeta, outcome });
      }
      byCharacter.set(key, raids);
    }
  }
  const counts = { updated: 0, already: 0, ineligible: 0, errored: 0 };
  let writtenCharacterCount = 0;
  for (const raids of byCharacter.values()) {
    const outcomes = [...raids.values()].map((entry) => entry.outcome);
    for (const outcome of outcomes) counts[outcome] += 1;
    if (outcomes.includes("updated")) writtenCharacterCount += 1;
  }
  return { byCharacter, counts, writtenCharacterCount, notFoundNames };
}

function createRaidChannelEmbedBuilders({ EmbedBuilder, UI }) {
  function resolveReceiptStyle(counts, notFoundCount, isReset) {
    if (counts.ineligible + counts.errored + notFoundCount > 0) {
      return { icon: UI.icons.warn, color: UI.colors.progress };
    }
    if (isReset) return { icon: counts.updated > 0 ? UI.icons.reset : UI.icons.info, color: UI.colors.muted };
    if (counts.updated > 0) return { icon: UI.icons.done, color: UI.colors.success };
    return { icon: UI.icons.info, color: UI.colors.neutral };
  }

  function buildReceiptDescription({ text, counts, writtenCharacterCount, notFoundNames, isReset, lang }) {
    const lines = [t("text-parser.receiptLine", lang, { text: formatReceiptText(text) })];
    if (counts.updated > 0) {
      lines.push(tPick(isReset ? "text-parser.raidResetDescription" : "text-parser.raidUpdateDescription", lang, {
        raids: counts.updated,
        count: writtenCharacterCount,
      }));
      if (counts.already > 0) {
        lines.push(t(isReset ? "text-parser.tailAlreadyReset" : "text-parser.tailAlready", lang, {
          icon: UI.icons.info,
          n: counts.already,
        }));
      }
    } else if (counts.already > 0) {
      lines.push(tPick(isReset ? "text-parser.raidResetNothing" : "text-parser.raidUpdateNothingNew", lang));
    }
    if (counts.ineligible > 0) lines.push(t("text-parser.tailIneligible", lang, { icon: UI.icons.warn, n: counts.ineligible }));
    if (counts.errored > 0) lines.push(t("text-parser.tailErrored", lang, { icon: UI.icons.warn, n: counts.errored }));
    if (notFoundNames.length > 0) {
      lines.push(t("text-parser.tailNotFound", lang, {
        icon: UI.icons.warn,
        names: notFoundNames.map((name) => `\`${name}\``).join(", "),
      }));
    }
    return lines.join("\n");
  }

  function buildCharacterRows(character, raids, { afterWrite, isReset, lang }) {
    const entries = [...raids.values()];
    const isRecorded = (entry) => entry?.outcome === "updated" || entry?.outcome === "already";
    // One post cannot name two modes of one raid, and a reset's raidMeta
    // does not carry the stored mode, so rows match on raidKey.
    const statusRaids = afterWrite
      ? getStatusRaidsForCharacter(character).filter((raid) => isRecorded(raids.get(raid.raidKey)))
      : [];
    const statusRows = statusRaids.map((raid) => {
      const line = formatRaidStatusLine(raid, lang);
      return raids.get(raid.raidKey).outcome === "already"
        ? line.replace(/^\S+ /u, `${UI.icons.info} `)
        : line;
    });
    // A raid the status view leaves out (a reset on a character below the
    // raid's item level) or a roster read before the write shows the raid
    // name without progress, so no card is left without rows.
    const shownRaidKeys = new Set(statusRaids.map((raid) => raid.raidKey));
    const labelRows = entries
      .filter((entry) => isRecorded(entry) && !shownRaidKeys.has(entry.raidMeta.raidKey))
      .map(({ raidMeta, outcome }) => {
        const icon = outcome === "already" ? UI.icons.info : isReset ? UI.icons.reset : UI.icons.done;
        return `${icon} ${raidMeta.label}`;
      });
    const skipped = entries
      .filter(({ outcome }) => outcome === "ineligible" || outcome === "errored")
      .map(({ raidMeta, outcome }) => {
        const note = outcome === "ineligible"
          ? t("text-parser.rowNeedsItemLevel", lang, { minItemLevel: raidMeta.minItemLevel })
          : t("text-parser.rowWriteFailed", lang);
        return `${UI.icons.warn} ${raidMeta.label} · _${note}_`;
      });
    return [...statusRows, ...labelRows, ...skipped];
  }

  function buildReceiptFields(accounts, byCharacter, options) {
    const groups = [];
    const drawn = new Set();
    for (const entry of accounts) {
      const charFields = [];
      for (const character of entry.account?.characters || []) {
        const key = getAccessibleCharacterCandidates(character).find((k) => byCharacter.has(k) && !drawn.has(k));
        if (!key) continue;
        drawn.add(key);
        charFields.push(buildCharacterStatusField(character, buildCharacterRows(character, byCharacter.get(key), options)));
      }
      if (charFields.length > 0) groups.push({ accountName: entry.accountName, charFields });
    }
    const fields = [];
    for (const group of groups) {
      // Same rule as the Local Sync and Bible sync cards: a roster header
      // only when more than one roster has cards.
      const header = groups.length > 1
        ? { name: `${UI.icons.folder} ${group.accountName} (${group.charFields.length})`, value: BLANK_FIELD_VALUE, inline: false }
        : null;
      appendGroupFields(fields, header, group.charFields);
    }
    return fields;
  }

  /**
   * The receipt DM for one monitored post: what was typed, what was written,
   * and a /raid-status card per character.
   * @param {object} params
   * @param {string} params.text - the post as typed
   * @param {Array<{raidMeta: object, statusType: string, results: object[]}>} params.resultGroups
   * @param {Array<object>} params.accounts - accessible accounts, read after the write when possible
   * @param {boolean} [params.afterWrite=true] - false when the accounts predate the write;
   *   rows then name the raid without progress
   * @param {string} [params.guildName]
   * @param {string} params.lang
   * @returns {EmbedBuilder}
   */
  function buildRaidChannelReceiptEmbed({ text, resultGroups, accounts, afterWrite = true, guildName, lang }) {
    const isReset = resultGroups[0].statusType === "reset";
    const { byCharacter, counts, writtenCharacterCount, notFoundNames } = collectReceiptOutcomes(resultGroups);
    const style = resolveReceiptStyle(counts, notFoundNames.length, isReset);
    const embed = new EmbedBuilder()
      .setColor(style.color)
      .setTitle(`${style.icon} ${t(isReset ? "text-parser.raidResetTitle" : "text-parser.raidUpdateTitle", lang)}`)
      .setDescription(buildReceiptDescription({ text, counts, writtenCharacterCount, notFoundNames, isReset, lang }))
      .setTimestamp();
    const fields = buildReceiptFields(accounts, byCharacter, { afterWrite, isReset, lang });
    if (fields.length > 0) embed.addFields(fields);
    if (guildName) {
      embed.setFooter({ text: t("text-parser.raidUpdateFooterServer", lang, { guildName }) });
    }
    return embed;
  }

  function buildRaidChannelWelcomeEmbed(lang) {
    return new EmbedBuilder()
      .setColor(UI.colors.neutral)
      .setTitle(t("welcome.title", lang, { icon: getArtistEmoji("shy") }).trim())
      .setDescription(joinIfArray(t("welcome.description", lang)))
      .addFields(
        { name: t("welcome.onboardingName", lang), value: joinIfArray(t("welcome.onboardingValue", lang)) },
        { name: t("welcome.examplesName", lang), value: joinIfArray(t("welcome.examplesValue", lang)) },
        { name: t("welcome.aliasesName", lang), value: joinIfArray(t("welcome.aliasesValue", lang)) },
        { name: t("welcome.notesName", lang), value: joinIfArray(t("welcome.notesValue", lang)) },
        { name: t("welcome.voiceName", lang), value: joinIfArray(t("welcome.voiceValue", lang)) },
        { name: t("welcome.maintenanceName", lang), value: joinIfArray(t("welcome.maintenanceValue", lang)) },
        { name: t("welcome.autoManageName", lang), value: joinIfArray(t("welcome.autoManageValue", lang)) },
        { name: t("welcome.sideTasksName", lang), value: joinIfArray(t("welcome.sideTasksValue", lang)) },
        { name: t("welcome.goldName", lang), value: joinIfArray(t("welcome.goldValue", lang)) },
        { name: t("welcome.iconName", lang), value: joinIfArray(t("welcome.iconValue", lang)) },
      )
      .setFooter({ text: t("welcome.footer", lang) });
  }

  return {
    buildRaidChannelReceiptEmbed,
    buildRaidChannelWelcomeEmbed,
  };
}

module.exports = {
  createRaidChannelEmbedBuilders,
  joinIfArray,
};
