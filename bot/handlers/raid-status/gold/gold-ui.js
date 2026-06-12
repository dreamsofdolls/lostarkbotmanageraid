"use strict";

const { getClassEmoji } = require("../../../models/Class");
const { t } = require("../../../services/i18n");
const { getRaidModeLabel } = require("../../../utils/raid/common/labels");
const { pack2Columns } = require("../../../utils/raid/common/shared");
const {
  GOLD_RAID_CAP_PER_CHARACTER,
  summarizeAccountGold,
  summarizeCharacterGold,
  summarizeGlobalGold,
} = require("../../../utils/raid/common/character");
const { parseCustomEmoji } = require("../task/task-ui/toggle-rows");

const PAGE_CHAR_CAP = 11;

function sameName(left, right) {
  return String(left || "").trim().toLowerCase() ===
    String(right || "").trim().toLowerCase();
}

function createRaidStatusGoldUi(deps) {
  const {
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    UI,
    getCharacterName,
    truncateText,
    formatGold,
    getAccounts,
    getCurrentPage,
    getGoldCharFilter,
    getRaidsFor,
    lang = "vi",
  } = deps;

  function goldCharactersOnPage() {
    const account = getAccounts()[getCurrentPage()];
    const characters = Array.isArray(account?.characters) ? account.characters : [];
    return characters.filter((character) => {
      if (character?.isGoldEarner === false) return false;
      return getRaidsFor(character).length > 0;
    });
  }

  function resolveGoldCharFilter() {
    const explicit = getGoldCharFilter(getCurrentPage());
    const candidates = goldCharactersOnPage();
    if (candidates.length === 0) return null;
    if (explicit) {
      const stillExists = candidates.find((character) =>
        sameName(getCharacterName(character), explicit)
      );
      if (stillExists) return getCharacterName(stillExists);
    }
    return getCharacterName(candidates[0]);
  }

  function activeGoldCharacter() {
    const activeName = resolveGoldCharFilter();
    if (!activeName) return null;
    const account = getAccounts()[getCurrentPage()];
    return (account?.characters || []).find((character) =>
      sameName(getCharacterName(character), activeName)
    ) || null;
  }

  function goldBoundTail(amount) {
    return amount > 0
      ? t("raid-status.embed.goldBoundTail", lang, { bound: formatGold(amount) })
      : "";
  }

  function localizedRaidLabel(raid) {
    return getRaidModeLabel(raid.raidKey, raid.modeKey, lang) || raid.raidName;
  }

  function rawGoldTotal(raid) {
    return Number(raid?.rawTotalGold ?? raid?.totalGold) || 0;
  }

  function formatGoldRaidLine(raid) {
    const label = localizedRaidLabel(raid);
    if (raid.goldDisabled) {
      return `${UI.icons.lock} ${label} - ${t("raid-status.goldView.manualOff", lang)}`;
    }
    if (!raid.goldReceives) {
      if (raid.goldExcludedReason === "bound") {
        return `${UI.icons.lock} ${label} - ${t("raid-status.goldView.autoBound", lang)}`;
      }
      return `${UI.icons.pending} ${label} - ${t("raid-status.goldView.outsideCap", lang, {
        cap: GOLD_RAID_CAP_PER_CHARACTER,
      })}`;
    }

    // A receiving raid reads as a plain gold line (\uD83D\uDCB0 #slot label - amount),
    // whether the slot was auto-picked or force-included - that distinction is
    // not useful once a raid holds a slot. Bound gold gets a lock right before
    // the amount so the player can tell the slot's gold is roster-bound; the
    // leading \uD83D\uDCB0 stays consistent so forced raids never look excluded.
    const rank = Number(raid.goldSlotRank) || 0;
    const slot = rank > 0 ? `#${rank} ` : "";
    const goldStr = formatGold(rawGoldTotal(raid));
    const amount = raid.goldBound ? `${UI.icons.lock} ${goldStr}` : goldStr;
    return `\uD83D\uDCB0 ${slot}${label} - ${amount}`;
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

  function buildGoldViewEmbed(account) {
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

    const descriptionLines = [];
    if (getAccounts().length > 1) {
      descriptionLines.push(t("raid-status.goldView.allAccounts", lang, {
        earned: formatGold(globalGold.earned),
        total: formatGold(globalGold.total),
        boundTail: goldBoundTail(globalGold.earnedBound),
      }));
    }
    descriptionLines.push(t("raid-status.goldView.accountLine", lang, {
      earned: formatGold(accountGold.earned),
      total: formatGold(accountGold.total),
      boundTail: goldBoundTail(accountGold.earnedBound),
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
        earned: formatGold(accountGold.earned),
        total: formatGold(accountGold.total),
      }),
    ];
    if (accountGold.earnedBound > 0) {
      footerParts.push(t("raid-status.goldView.footerBound", lang, {
        bound: formatGold(accountGold.earnedBound),
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
  }

  function buildEmptyGoldToggleRow({ placeholder }) {
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("status-gold:toggle")
        .setPlaceholder(placeholder)
        .setDisabled(true)
        .addOptions([{ label: "(empty)", value: "noop" }])
    );
  }

  function buildGoldCharFilterRow(disabled) {
    const candidates = goldCharactersOnPage();
    if (candidates.length === 0) return null;
    const activeName = resolveGoldCharFilter();
    const options = candidates.slice(0, 25).map((character) => {
      const name = getCharacterName(character);
      const raids = getRaidsFor(character);
      const totals = summarizeCharacterGold(raids);
      const option = {
        label: truncateText(
          `${name} \u00B7 ${Number(character.itemLevel) || 0} \u00B7 ${formatGold(totals.earned)}/${formatGold(totals.total)}`,
          100
        ),
        value: name.slice(0, 100),
        default: sameName(name, activeName),
      };
      const classEmojiObj = parseCustomEmoji(
        getClassEmoji(character.class || character.className)
      );
      if (classEmojiObj) option.emoji = classEmojiObj;
      return option;
    });

    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("status-gold:char-filter")
        .setPlaceholder(t("raid-status.goldView.charFilterPlaceholder", lang))
        .setDisabled(disabled)
        .addOptions(options)
    );
  }

  function buildGoldToggleRow(disabled) {
    const character = activeGoldCharacter();
    if (!character) {
      return buildEmptyGoldToggleRow({
        placeholder: t("raid-status.goldView.noGoldPlaceholder", lang),
      });
    }

    const activeName = getCharacterName(character);
    const raids = getRaidsFor(character);
    if (raids.length === 0) {
      return buildEmptyGoldToggleRow({
        placeholder: t("raid-status.goldView.charNoRaidPlaceholder", lang, {
          name: activeName,
        }),
      });
    }

    const options = raids.slice(0, 25).map((raid) => {
      const label = localizedRaidLabel(raid);
      let icon = raid.goldReceives ? (raid.goldBound ? UI.icons.lock : "\uD83D\uDCB0") : UI.icons.pending;
      let status;
      if (raid.goldOverride === "include") {
        icon = raid.goldBound ? UI.icons.lock : "\uD83D\uDCB0";
        status = t("raid-status.goldView.toggleManualOn", lang);
      } else if (raid.goldDisabled) {
        icon = UI.icons.lock;
        status = t("raid-status.goldView.toggleManualOff", lang);
      } else if (raid.goldExcludedReason === "bound") {
        icon = UI.icons.lock;
        status = t("raid-status.goldView.toggleAutoBound", lang);
      } else if (raid.goldReceives) {
        status = t("raid-status.goldView.toggleAutoReceiving", lang, {
          rank: raid.goldSlotRank || "?",
        });
      } else {
        status = t("raid-status.goldView.toggleOutsideCap", lang);
      }
      return {
        label: truncateText(`${icon} ${label} \u00B7 ${status}`, 100),
        description: truncateText(formatGold(rawGoldTotal(raid)), 100),
        value: `${activeName}::${raid.raidKey}`.slice(0, 100),
      };
    });

    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("status-gold:toggle")
        .setPlaceholder(t("raid-status.goldView.togglePlaceholder", lang, {
          name: activeName,
        }))
        .setDisabled(disabled)
        .addOptions(options)
    );
  }

  return {
    buildGoldViewEmbed,
    buildGoldCharFilterRow,
    buildGoldToggleRow,
    goldCharactersOnPage,
    resolveGoldCharFilter,
  };
}

module.exports = {
  createRaidStatusGoldUi,
};
