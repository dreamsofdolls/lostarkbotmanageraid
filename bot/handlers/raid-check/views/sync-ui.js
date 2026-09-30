/**
 * sync-ui.js
 *
 * The /raid-check Sync button flow.
 *
 * Two exports:
 *   - buildRaidCheckSyncDMEmbed: pure embed builder for the DM the
 *     target member receives after Sync surfaces new gates from bible.
 *   - handleRaidCheckSyncClick: the Sync button handler. Walks every
 *     opted-in pending user, runs the auto-manage gather + apply via
 *     limiter, then DMs each user whose progress changed.
 */

const {
  buildNoticeEmbed,
  getCharacterName,
  INLINE_SPACER,
} = require("../../../utils/raid/common/shared");
// tPick, not t: the refresh and sync titles are variant pools; other keys pass through.
const { tPick: t, getUserLanguage } = require("../../../services/i18n");
const {
  getAppliedAutoManageEntries,
  getAutoManageEntries,
} = require("../../../services/auto-manage/reports/utils");

/**
 * Build the /raid-check Sync UI service: the DM embed builder and the Sync
 * click handler.
 *
 * @param {object} deps - injected dependencies
 * @param {Function} deps.EmbedBuilder - discord.js builder
 * @param {object} deps.MessageFlags - discord.js flags enum
 * @param {object} deps.UI - shared color/icon palette
 * @param {object} deps.User - Mongoose User model
 * @param {Function} deps.ensureFreshWeek - week-reset advancer
 * @param {Function} deps.weekResetStartMs - current weekly reset epoch
 * @param {Function} deps.autoManageEntryKey - composite account+char key
 * @param {Function} deps.gatherAutoManageLogsForUserDoc - bible HTTP gather
 * @param {Function} deps.commitAutoManageCollected - retry-safe reconcile + stamp + save
 * @param {Function} deps.stampAutoManageAttempt - touch lastAutoManageAttemptAt
 * @param {Function} deps.acquireAutoManageSyncSlot - per-user mutex
 * @param {Function} deps.releaseAutoManageSyncSlot - mutex release
 * @param {object} deps.raidCheckSyncLimiter - per-user concurrency cap
 * @param {object} deps.discordUserLimiter - Discord REST fan-out limiter
 * @param {Function} deps.buildAutoManageSyncReportEmbed - the Bible sync report card
 * @returns {{
 *   buildRaidCheckSyncDMEmbed: Function,
 *   handleRaidCheckSyncClick: Function,
 * }}
 */
function createSyncUi({
  EmbedBuilder,
  MessageFlags,
  UI,
  User,
  ensureFreshWeek,
  weekResetStartMs,
  autoManageEntryKey,
  gatherAutoManageLogsForUserDoc,
  commitAutoManageCollected,
  isPublicLogDisabledError,
  stampAutoManageAttempt,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  raidCheckSyncLimiter,
  discordUserLimiter,
  buildAutoManageSyncReportEmbed,
}) {

  // Private logs are a user setting that no retry fixes, so a report whose
  // characters all failed on that alone counts as skipped, not failed.
  function hasOnlyPrivateLogErrors(report) {
    const entries = getAutoManageEntries(report);
    return entries.length > 0 &&
      entries.every((entry) => isPublicLogDisabledError(entry?.error));
  }

  /**
   * The DM a member gets when a Raid Manager's Sync wrote new gates for
   * them: the /raid-auto-manage sync report card, with its own title and
   * opening line. The owner's sync-timer line is left out; it says nothing
   * about a sync someone else ran.
   * @param {{appliedTotal: number, perChar: object[]}} report - the sync report
   * @param {object} userDoc - the member's user document as the sync saved it
   * @param {string} [lang="vi"] - the member's language
   * @returns {EmbedBuilder}
   */
  function buildRaidCheckSyncDMEmbed(report, userDoc, lang = "vi") {
    return buildAutoManageSyncReportEmbed(report, lang, {
      userDoc,
      titleText: t("raid-check.syncDm.title", lang),
      intro: t("raid-check.syncDm.intro", lang, { n: report.appliedTotal }),
    });
  }

  async function loadAllRaidSyncSnapshot() {
    const users = await User.find({
      autoManageEnabled: true,
      localSyncEnabled: { $ne: true },
      "accounts.0": { $exists: true },
    }).select("discordId autoManageEnabled localSyncEnabled accounts.accountName accounts.characters.name accounts.characters.charName").lean();
    const pendingChars = [];
    const userMeta = new Map();
    for (const user of users) {
      if (!user.autoManageEnabled || user.localSyncEnabled) continue;
      userMeta.set(user.discordId, user);
      for (const account of user.accounts || []) {
        for (const character of account.characters || []) {
          const charName = getCharacterName(character);
          if (charName) pendingChars.push({
            discordId: user.discordId,
            accountName: account.accountName,
            charName,
          });
        }
      }
    }
    return { pendingChars, userMeta };
  }

  /** Sync-check all: sync every opted-in roster across all raids. */
  async function handleRaidCheckSyncClick(interaction) {
    const started = Date.now();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Manager (clicker) views the ephemeral report - use their lang.
    const snapshotStarted = Date.now();
    const [managerLang, snapshot] = await Promise.all([
      getUserLanguage(interaction.user.id, { UserModel: User }),
      loadAllRaidSyncSnapshot(),
    ]);
    const snapshotMs = Date.now() - snapshotStarted;

    const pendingEntryKeysByDiscordId = new Map();
    for (const pendingChar of snapshot.pendingChars) {
      const meta = snapshot.userMeta.get(pendingChar.discordId);
      if (!meta?.autoManageEnabled || meta.localSyncEnabled) continue;
      if (!pendingEntryKeysByDiscordId.has(pendingChar.discordId)) {
        pendingEntryKeysByDiscordId.set(pendingChar.discordId, new Set());
      }
      pendingEntryKeysByDiscordId
        .get(pendingChar.discordId)
        .add(autoManageEntryKey(pendingChar.accountName, pendingChar.charName));
    }
    const optedInDiscordIds = [...pendingEntryKeysByDiscordId.keys()];
    const scopedCharCount = [...pendingEntryKeysByDiscordId.values()].reduce(
      (sum, entryKeys) => sum + entryKeys.size,
      0
    );
    const pendingUserCount = new Set(snapshot.pendingChars.map((c) => c.discordId)).size;
    if (optedInDiscordIds.length === 0) {
      console.log(
        `[raid-check sync] raid=all pendingUsers=${pendingUserCount} optedIn=0 snapshotMs=${snapshotMs} totalMs=${Date.now() - started}`
      );
      await interaction.editReply({
        content: null,
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: t("raid-check.syncFlow.noOptedInTitle", managerLang),
            description: t("raid-check.syncFlow.noOptedInAllDescription", managerLang),
          }),
        ],
      });
      return;
    }

    const weekResetStart = weekResetStartMs();
    let syncedCount = 0;
    let attemptedOnlyCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const reportsWithNewGates = new Map();

    const syncStarted = Date.now();
    await Promise.all(
      optedInDiscordIds.map((discordId) =>
        raidCheckSyncLimiter.run(async () => {
          let acquired = false;
          let bibleHit = false;
          try {
            const guard = await acquireAutoManageSyncSlot(discordId, { ignoreCooldown: true });
            if (!guard.acquired) {
              skippedCount += 1;
              return;
            }
            acquired = true;
            const seedDoc = await User.findOne({ discordId });
            if (!seedDoc || !Array.isArray(seedDoc.accounts) || seedDoc.accounts.length === 0) {
              skippedCount += 1;
              return;
            }
            if (!seedDoc.autoManageEnabled || seedDoc.localSyncEnabled) {
              skippedCount += 1;
              return;
            }

            ensureFreshWeek(seedDoc);
            const collected = await gatherAutoManageLogsForUserDoc(seedDoc, weekResetStart, {
              includeEntryKeys: pendingEntryKeysByDiscordId.get(discordId),
            });
            bibleHit = true;

            const committed = await commitAutoManageCollected(
              discordId,
              weekResetStart,
              collected,
              { requireRoster: true }
            );
            switch (committed?.status) {
              case "synced-with-delta":
              case "synced-no-delta":
                syncedCount += 1;
                break;
              case "all-chars-failed":
                if (hasOnlyPrivateLogErrors(committed.report)) {
                  skippedCount += 1;
                } else {
                  failedCount += 1;
                }
                break;
              case "local-sync-active":
              case "missing-roster":
              case "missing-user":
                skippedCount += 1;
                break;
              default:
                attemptedOnlyCount += 1;
            }

            if (getAppliedAutoManageEntries(committed?.report).length > 0) {
              reportsWithNewGates.set(discordId, { report: committed.report, userDoc: committed.snapshot });
            }
          } catch (err) {
            failedCount += 1;
            if (bibleHit) await stampAutoManageAttempt(discordId);
            console.warn(`[raid-check sync] user ${discordId} failed:`, err?.message || err);
          } finally {
            if (acquired) releaseAutoManageSyncSlot(discordId);
          }
        })
      )
    );
    const syncMs = Date.now() - syncStarted;

    const dmStarted = Date.now();
    const dmResults = await Promise.all(
      [...reportsWithNewGates.entries()].map(([discordId, { report, userDoc }]) =>
        discordUserLimiter.run(async () => {
          try {
            const user = await interaction.client.users.fetch(discordId);
            const dmChannel = await user.createDM();
            // DM is read by the target, render in their lang per the
            // viewer-language rule.
            const targetLang = await getUserLanguage(discordId, { UserModel: User });
            const embed = buildRaidCheckSyncDMEmbed(report, userDoc, targetLang);
            await dmChannel.send({ embeds: [embed] });
            return { ok: true };
          } catch {
            return { ok: false };
          }
        })
      )
    );
    const dmMs = Date.now() - dmStarted;
    const dmSent = dmResults.filter((result) => result.ok).length;
    const dmFailed = dmResults.length - dmSent;

    console.log(
      `[raid-check sync] raid=all pendingUsers=${pendingUserCount} optedIn=${optedInDiscordIds.length} scopedChars=${scopedCharCount} synced=${syncedCount} attemptedOnly=${attemptedOnlyCount} skipped=${skippedCount} failed=${failedCount} dmSent=${dmSent} dmFailed=${dmFailed} snapshotMs=${snapshotMs} syncMs=${syncMs} dmMs=${dmMs} totalMs=${Date.now() - started}`
    );

    // Counters render as inline fields, following the LoaLogs scan-result
    // shape: the three that answer "did this run work" always show, the
    // rest only when they have something to report. Discord packs 3 inline
    // fields per row, so pad to a multiple of 3 once past the first row -
    // a lone 4th field would stretch across its whole row.
    const counterFields = [
      {
        name: `🔍 ${t("raid-check.syncFlow.reportFields.checked", managerLang)}`,
        value: String(optedInDiscordIds.length),
        inline: true,
      },
      {
        name: `${UI.icons.done} ${t("raid-check.syncFlow.reportFields.synced", managerLang)}`,
        value: String(syncedCount),
        inline: true,
      },
      {
        name: `${UI.icons.warn} ${t("raid-check.syncFlow.reportFields.failed", managerLang)}`,
        value: String(failedCount),
        inline: true,
      },
    ];
    const optionalCounters = [
      [UI.icons.pending, "noNewData", attemptedOnlyCount],
      ["⏳", "skipped", skippedCount],
      ["🆕", "newGates", reportsWithNewGates.size],
    ];
    for (const [icon, key, count] of optionalCounters) {
      if (count === 0) continue;
      counterFields.push({
        name: `${icon} ${t(`raid-check.syncFlow.reportFields.${key}`, managerLang)}`,
        value: String(count),
        inline: true,
      });
    }
    if (dmSent > 0 || dmFailed > 0) {
      counterFields.push({
        name: `📩 ${t("raid-check.syncFlow.reportFields.dmSent", managerLang)}`,
        value: dmFailed > 0
          ? `${dmSent}${t("raid-check.syncFlow.reportDmFailedSuffix", managerLang, { n: dmFailed })}`
          : String(dmSent),
        inline: true,
      });
    }
    if (counterFields.length > 3) {
      while (counterFields.length % 3 !== 0) counterFields.push(INLINE_SPACER);
    }

    const allFailed = failedCount > 0 && syncedCount === 0;
    let noticeType = "success";
    let titleKey = "raid-check.syncFlow.reportTitle";
    if (allFailed) {
      noticeType = "error";
      titleKey = "raid-check.syncFlow.reportTitleFailed";
    } else if (failedCount > 0 || skippedCount > 0) {
      noticeType = "warn";
      titleKey = "raid-check.syncFlow.reportTitlePartial";
    }

    const lines = [
      t("raid-check.syncFlow.reportLineAllIntro", managerLang, {
        users: optedInDiscordIds.length,
        chars: scopedCharCount,
      }),
    ];
    if (failedCount > 0) {
      lines.push(t("raid-check.syncFlow.reportTailFailed", managerLang, { n: failedCount }));
    }
    if (skippedCount > 0) {
      lines.push(t("raid-check.syncFlow.reportTailSkipped", managerLang, { n: skippedCount }));
    }
    const hintKey = allFailed
      ? "raid-check.syncFlow.reportHintAllFailed"
      : "raid-check.syncFlow.reportLineAllHint";
    lines.push("", t(hintKey, managerLang));

    const embed = buildNoticeEmbed(EmbedBuilder, {
      type: noticeType,
      title: t(titleKey, managerLang),
      description: lines.join("\n"),
    });
    embed.addFields(counterFields);
    await interaction.editReply({ content: null, embeds: [embed] });
  }

  return {
    buildRaidCheckSyncDMEmbed,
    handleRaidCheckSyncClick,
  };
}

module.exports = { createSyncUi };
