"use strict";

const { getClassEmoji } = require("../../../models/Class");
const { buildAccountTaskFields } = require("../../../utils/raid/tasks/task-view");
const {
  getVisibleSharedTasks,
  getSharedTaskDisplay,
} = require("../../../utils/raid/tasks/shared-tasks");
const { isGoldProgressRaid } = require("../../../utils/raid/common/character");
const { t } = require("../../../services/i18n");

function displayNameForUser(userDoc, meta) {
  return (
    meta?.displayName ||
    userDoc.discordDisplayName ||
    userDoc.discordGlobalName ||
    userDoc.discordUsername ||
    `<@${userDoc.discordId}>`
  );
}

function createAllModePageRenderers({
  EmbedBuilder,
  UI,
  authorMeta,
  buildAccountPageEmbed,
  buildStatusFooterText,
  getState,
  getStatusRaidsForCharacter,
  isManagerId,
  lang,
  pagesData,
  summarizeRaidProgress,
  truncateText,
}) {
  function raidsForPage(userDoc, filterRaidId) {
    const raidsCache = new Map();
    const rawGetRaidsFor = (character) => {
      let result = raidsCache.get(character);
      if (!result) {
        result = getStatusRaidsForCharacter(character);
        raidsCache.set(character, result);
      }
      return result;
    };
    const getRaidsFor = filterRaidId
      ? (character) =>
          rawGetRaidsFor(character).filter(
            (raid) => `${raid.raidKey}:${raid.modeKey}` === filterRaidId
          )
      : rawGetRaidsFor;
    const getProgressRaidsFor = (character) => getRaidsFor(character).filter(isGoldProgressRaid);

    const userAccounts = Array.isArray(userDoc.accounts) ? userDoc.accounts : [];
    const userTotalChars = userAccounts.reduce(
      (sum, account) => sum + (Array.isArray(account.characters) ? account.characters.length : 0),
      0
    );
    const allRaidEntries = [];
    for (const account of userAccounts) {
      for (const character of account.characters || []) {
        allRaidEntries.push(...getProgressRaidsFor(character));
      }
    }
    return {
      allRaidEntries,
      getRaidsFor,
      getProgressRaidsFor,
      userAccounts,
      userTotalChars,
    };
  }

  function buildRaidPage(pageIndex) {
    const { userDoc, account } = pagesData[pageIndex];
    const { filterRaidId, filterUserId, currentLocalPage, filteredIndices, totalPages } = getState();
    const {
      allRaidEntries,
      getRaidsFor,
      getProgressRaidsFor,
      userAccounts,
      userTotalChars,
    } = raidsForPage(userDoc, filterRaidId);
    const globalTotals = {
      characters: userTotalChars,
      progress: summarizeRaidProgress(allRaidEntries),
    };
    const userMeta = {
      discordId: userDoc.discordId,
      autoManageEnabled: !!userDoc.autoManageEnabled,
      localSyncEnabled: !!userDoc.localSyncEnabled,
      lastAutoManageSyncAt: Number(userDoc.lastAutoManageSyncAt) || 0,
      lastAutoManageAttemptAt: Number(userDoc.lastAutoManageAttemptAt) || 0,
    };

    const embed = buildAccountPageEmbed(
      account,
      0,
      1,
      globalTotals,
      getRaidsFor,
      userMeta,
      { hideIneligibleChars: !!filterRaidId, getProgressRaidsFor, lang }
    );

    if (isManagerId && isManagerId(userDoc.discordId)) {
      const origTitle = embed.data?.title || "";
      const crownIdx = origTitle.indexOf("\u{1f451}");
      if (crownIdx > 0) {
        embed.setTitle(origTitle.slice(crownIdx));
      }
    }

    if (userAccounts.length > 1) {
      const rollupLine = t("raid-check.allMode.rollupLine", lang, {
        characters: globalTotals.characters,
        completed: globalTotals.progress.completed,
        total: globalTotals.progress.total,
      });
      const baseDescription = embed.data?.description || "";
      embed.setDescription(baseDescription ? `${rollupLine}\n${baseDescription}` : rollupLine);
    }

    const footerPageInfo = filterUserId === null
      ? { pageIndex, totalPages }
      : { pageIndex: currentLocalPage, totalPages: filteredIndices.length };
    embed.setFooter({
      text: buildStatusFooterText(globalTotals, footerPageInfo, lang),
    });

    const meta = authorMeta.get(userDoc.discordId);
    if (meta) {
      const authorPayload = {
        name: truncateText(meta.displayName, 256),
      };
      if (meta.avatarURL) authorPayload.iconURL = meta.avatarURL;
      embed.setAuthor(authorPayload);
    }

    return embed;
  }

  function buildTaskPage(pageIndex) {
    const { userDoc, account } = pagesData[pageIndex];
    const { currentLocalPage, filteredIndices } = getState();
    const accountName = String(
      account?.accountName || t("raid-check.allMode.unnamedRoster", lang)
    );
    const meta = authorMeta.get(userDoc.discordId);
    const displayName = displayNameForUser(userDoc, meta);

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`\u{1f4dd} ${displayName} \u00b7 ${accountName}`);

    const { fields, totals } = buildAccountTaskFields(account, {
      UI,
      getClassEmoji,
      truncateText,
      lang,
    });
    const now = new Date();
    const sharedTasks = getVisibleSharedTasks(account, now.getTime());

    if (fields.length > 0 || sharedTasks.length > 0) {
      embed.setDescription(
        [
          t("raid-check.allMode.taskHeaderDescription", lang),
          t("raid-check.allMode.taskHeaderResetLine", lang, { resetIcon: UI.icons.reset }),
        ].join("\n")
      );
      if (sharedTasks.length > 0) {
        const lines = sharedTasks.slice(0, 12).map((task) => {
          const display = getSharedTaskDisplay(task, now, lang);
          const icon = display.completed ? UI.icons.done : UI.icons.pending;
          return `${icon} ${display.emoji} **${display.name}** \u00b7 ${display.status}`;
        });
        if (sharedTasks.length > 12) {
          lines.push(t("raid-check.allMode.sharedTaskExtra", lang, { n: sharedTasks.length - 12 }));
        }
        embed.addFields({
          name: t("raid-check.allMode.sharedTaskHeader", lang),
          value: truncateText(lines.join("\n"), 1024),
          inline: false,
        });
      }
      const fieldBudget = sharedTasks.length > 0 ? 24 : 25;
      const visibleFields =
        fields.length > fieldBudget
          ? [
              ...fields.slice(0, fieldBudget - 1),
              {
                name: "...",
                value: t("raid-check.allMode.charsExtraField", lang, { n: fields.length - fieldBudget + 1 }),
                inline: false,
              },
            ]
          : fields;
      if (visibleFields.length > 0) embed.addFields(...visibleFields);
    } else {
      embed.setDescription(
        t("raid-check.allMode.noTasksDescription", lang, { accountName })
      );
    }

    const footerParts = [];
    if (sharedTasks.length > 0) {
      const sharedDone = sharedTasks.filter((task) =>
        getSharedTaskDisplay(task, now, lang).completed
      ).length;
      footerParts.push(t("raid-check.allMode.sharedFooter", lang, {
        doneIcon: UI.icons.done,
        done: sharedDone,
        total: sharedTasks.length,
      }));
    }
    if (totals.daily > 0) {
      footerParts.push(t("raid-check.allMode.dailyFooter", lang, {
        done: totals.dailyDone,
        total: totals.daily,
      }));
    }
    if (totals.weekly > 0) {
      footerParts.push(t("raid-check.allMode.weeklyFooter", lang, {
        done: totals.weeklyDone,
        total: totals.weekly,
      }));
    }
    const localTotal = filteredIndices.length;
    if (localTotal > 1) {
      footerParts.push(t("raid-check.allMode.pageFooter", lang, {
        current: currentLocalPage + 1,
        total: localTotal,
      }));
    }
    footerParts.push(t("raid-check.allMode.readOnlySuffix", lang));
    embed.setFooter({ text: footerParts.join(" \u00b7 ") });

    if (meta) {
      const authorPayload = { name: truncateText(displayName, 256) };
      if (meta.avatarURL) authorPayload.iconURL = meta.avatarURL;
      embed.setAuthor(authorPayload);
    }
    return embed;
  }

  return {
    buildRaidPage,
    buildTaskPage,
  };
}

module.exports = {
  createAllModePageRenderers,
  displayNameForUser,
};
