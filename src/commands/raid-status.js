const STATUS_PAGINATION_SESSION_MS = 2 * 60 * 1000;
const STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS = 2500;

function createRaidStatusCommand(deps) {
  const {
    EmbedBuilder,
    ComponentType,
    MessageFlags,
    UI,
    User,
    saveWithRetry,
    ensureFreshWeek,
    getCharacterName,
    truncateText,
    formatShortRelative,
    formatNextCooldownRemaining,
    waitWithBudget,
    summarizeRaidProgress,
    formatRaidStatusLine,
    getStatusRaidsForCharacter,
    buildPaginationRow,
    collectStaleAccountRefreshes,
    applyStaleAccountRefreshes,
    formatRosterRefreshCooldownRemaining,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    applyAutoManageCollectedForStatus,
    stampAutoManageAttempt,
    weekResetStartMs,
    AUTO_MANAGE_SYNC_COOLDOWN_MS,
    getAutoManageCooldownMs,
    isManagerId,
  } = deps;

  // Manager rosters get a 👑 at the account header (swapping the default
  // 📁 folder icon) instead of stamping every character name with a crown.
  // Per-char crown was scan-hostile once there were many chars and collides
  // with the planned class-icon swap for the char name slot, so the visual
  // cue lives at the roster boundary where it only appears once per group.
  function pickRosterHeaderIcon(discordId) {
    return isManagerId && isManagerId(discordId) ? "👑" : UI.icons.roster;
  }

  // Footer shows subject-scoped rollup (done/partial/pending across the
  // viewed user's entire roster) + optional page counter, matching
  // /raid-check's footer semantics. In /raid-status the "subject" is the
  // caller themselves, so counts stay identical across pagination pages;
  // the `pageInfo` tail appends only when totalPages > 1.
  function buildStatusFooterText(globalTotals, pageInfo = null) {
    const { completed = 0, partial = 0, total = 0 } = globalTotals?.progress || {};
    const pending = Math.max(0, total - completed - partial);
    const parts = [
      `${UI.icons.done} ${completed} done`,
      `${UI.icons.partial} ${partial} partial`,
      `${UI.icons.pending} ${pending} pending`,
    ];
    if (pageInfo && Number(pageInfo.totalPages) > 1) {
      parts.push(`Page ${Number(pageInfo.pageIndex) + 1}/${Number(pageInfo.totalPages)}`);
    }
    return parts.join(" · ");
  }

  function buildCharacterField(character, getRaidsFor) {
    const name = getCharacterName(character);
    const itemLevel = Number(character.itemLevel) || 0;
    const fieldName = truncateText(`${name} · ${itemLevel}`, 256);

    const raids = getRaidsFor(character);
    const fieldValue = raids.length === 0
      ? `${UI.icons.lock} _Not eligible yet_`
      : raids.map((raid) => formatRaidStatusLine(raid)).join("\n");

    return {
      name: fieldName,
      value: truncateText(fieldValue, 1024),
      inline: true,
    };
  }

  function buildAccountFreshnessLine(account, userMeta) {
    const parts = [];
    const lastRefreshedAt = Number(account?.lastRefreshedAt) || 0;
    if (lastRefreshedAt > 0) {
      const remain = formatRosterRefreshCooldownRemaining(account);
      const lastUpdated = `${UI.icons.roster} Last updated ${formatShortRelative(lastRefreshedAt)} ago`;
      parts.push(
        remain
          ? `${lastUpdated} · ⏳ Next refresh in ${remain}`
          : `${lastUpdated} · ✅ Refresh ready`
      );
    }

    if (userMeta?.autoManageEnabled) {
      const lastSyncAt = Number(userMeta?.lastAutoManageSyncAt) || 0;
      const lastSync = lastSyncAt > 0
        ? `${UI.icons.reset} Last synced ${formatShortRelative(lastSyncAt)} ago`
        : `${UI.icons.reset} Never synced`;
      // Manager (in RAID_MANAGER_ID allowlist) has a 30s sync cooldown vs 15m
      // for regular users - the countdown must reflect the per-user value or
      // it would mislead managers into waiting minutes after a click when
      // they're actually sync-ready within seconds.
      const cooldownMs = typeof getAutoManageCooldownMs === "function" && userMeta?.discordId
        ? getAutoManageCooldownMs(userMeta.discordId)
        : AUTO_MANAGE_SYNC_COOLDOWN_MS;
      const remain = formatNextCooldownRemaining(
        Number(userMeta?.lastAutoManageAttemptAt) || 0,
        cooldownMs
      );
      parts.push(
        remain
          ? `${lastSync} · ⏳ Next sync in ${remain}`
          : `${lastSync} · ✅ Sync ready`
      );
    }

    return parts.join(" · ");
  }

  function buildAccountPageEmbed(
    account,
    pageIndex,
    totalPages,
    globalTotals,
    getRaidsFor,
    userMeta = null
  ) {
    const characters = Array.isArray(account.characters) ? account.characters : [];

    const accountRaids = [];
    for (const character of characters) {
      accountRaids.push(...getRaidsFor(character));
    }
    const accountProgress = summarizeRaidProgress(accountRaids);

    const titleIcon = accountProgress.total === 0
      ? UI.icons.lock
      : accountProgress.completed === accountProgress.total
        ? UI.icons.done
        : accountProgress.completed + accountProgress.partial > 0
          ? UI.icons.partial
          : UI.icons.pending;

    // Page counter lives in the footer (next to done/partial/pending
    // counts) per /raid-check parity; title stays as just icon + account
    // so the identity of the rendered roster is the sole headline.
    const headerIcon = pickRosterHeaderIcon(userMeta?.discordId);
    const title = `${titleIcon} ${headerIcon} ${account.accountName}`;

    // Description used to lead with a per-account "N chars · X/Y raids
    // done · K in progress" line, but those counts are now carried by
    // the footer legend itself (X done · Y partial · Z pending) - keeping
    // both would duplicate the same information in two places. The
    // cross-account rollup stays because it's a different scope
    // (subject-wide, not per-account) and helps when flipping pages.
    const descriptionLines = [];
    if (totalPages > 1) {
      descriptionLines.push(
        `🌐 All accounts: **${globalTotals.characters}** chars · **${globalTotals.progress.completed}/${globalTotals.progress.total}** raids done`
      );
    }
    const freshnessLine = buildAccountFreshnessLine(account, userMeta);
    if (freshnessLine) descriptionLines.push(freshnessLine);

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(accountProgress.color)
      .setFooter({
        text: buildStatusFooterText(globalTotals, { pageIndex, totalPages }),
      })
      .setTimestamp();

    if (descriptionLines.length > 0) {
      embed.setDescription(descriptionLines.join("\n"));
    }

    if (characters.length === 0) {
      embed.addFields({ name: "\u200B", value: "_No characters saved._", inline: false });
      return embed;
    }

    const inlineSpacer = { name: "\u200B", value: "\u200B", inline: true };
    for (let i = 0; i < characters.length; i += 2) {
      embed.addFields(buildCharacterField(characters[i], getRaidsFor));
      embed.addFields(inlineSpacer);
      embed.addFields(
        characters[i + 1]
          ? buildCharacterField(characters[i + 1], getRaidsFor)
          : inlineSpacer
      );
    }

    return embed;
  }

  async function handleStatusCommand(interaction) {
    const discordId = interaction.user.id;
    const seedDoc = await User.findOne({ discordId });
    if (!seedDoc || !Array.isArray(seedDoc.accounts) || seedDoc.accounts.length === 0) {
      await interaction.reply({
        content: `${UI.icons.info} Cậu chưa có roster nào. Dùng \`/add-roster\` để thêm trước nhé.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();

    let userDoc = null;
    let autoManageGuard = null;
    let autoManageReleaseInBackground = false;

    try {
      ensureFreshWeek(seedDoc);

      let autoManagePromise = Promise.resolve(null);
      let autoManageWeekResetStart = null;
      const hasRoster = Array.isArray(seedDoc.accounts) && seedDoc.accounts.length > 0;
      if (seedDoc.autoManageEnabled && hasRoster) {
        autoManageGuard = await acquireAutoManageSyncSlot(discordId);
        if (autoManageGuard.acquired) {
          autoManageWeekResetStart = weekResetStartMs();
          autoManagePromise = gatherAutoManageLogsForUserDoc(
            seedDoc,
            autoManageWeekResetStart
          ).catch((err) => {
            console.warn(
              "[raid-status] auto-manage piggyback gather failed:",
              err?.message || err
            );
            return null;
          });
        }
      }

      const [refreshCollected, autoManageBudgetResult] = await Promise.all([
        collectStaleAccountRefreshes(seedDoc),
        autoManageGuard?.acquired
          ? waitWithBudget(autoManagePromise, STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS)
          : Promise.resolve({ timedOut: false, value: null }),
      ]);
      let autoManageCollected = autoManageBudgetResult.value;
      const autoManageBibleHit = autoManageGuard?.acquired === true;
      const autoManageTimedOut = autoManageGuard?.acquired && autoManageBudgetResult.timedOut;

      if (autoManageTimedOut) {
        autoManageCollected = null;
        autoManageReleaseInBackground = true;
        autoManagePromise
          .then((backgroundCollected) =>
            applyAutoManageCollectedForStatus(
              discordId,
              autoManageWeekResetStart,
              backgroundCollected,
              "background"
            )
          )
          .catch(async (err) => {
            console.warn(
              "[raid-status] background auto-manage apply failed:",
              err?.message || err
            );
            await stampAutoManageAttempt(discordId);
          })
          .finally(() => releaseAutoManageSyncSlot(discordId));
        console.log(
          `[raid-status] auto-manage exceeded ${STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS}ms budget for user=${discordId}; rendering cached data and continuing in background`
        );
      }

      userDoc = await saveWithRetry(async () => {
        const doc = await User.findOne({ discordId });
        if (!doc) return null;

        const didFreshenWeek = ensureFreshWeek(doc);
        const didRefresh = applyStaleAccountRefreshes(doc, refreshCollected);

        let didAutoManage = false;
        if (autoManageCollected && doc.autoManageEnabled) {
          const autoReport = applyAutoManageCollected(
            doc,
            autoManageWeekResetStart,
            autoManageCollected
          );
          const now = Date.now();
          doc.lastAutoManageAttemptAt = now;
          if (autoReport.perChar.some((c) => !c.error)) {
            doc.lastAutoManageSyncAt = now;
          }
          didAutoManage = true;
        } else if (autoManageBibleHit) {
          doc.lastAutoManageAttemptAt = Date.now();
          didAutoManage = true;
        }

        if (didFreshenWeek || didRefresh || didAutoManage) await doc.save();
        return doc.toObject();
      });
    } catch (err) {
      console.error("[raid-status] lazy refresh failed:", err?.message || err);
      if (autoManageGuard?.acquired) {
        await stampAutoManageAttempt(discordId);
      }
      userDoc = await User.findOne({ discordId }).lean();
    } finally {
      if (autoManageGuard?.acquired && !autoManageReleaseInBackground) {
        releaseAutoManageSyncSlot(discordId);
      }
    }

    if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
      await interaction.editReply({
        content: `${UI.icons.info} Cậu chưa có roster nào. Dùng \`/add-roster\` để thêm trước nhé.`,
      });
      return;
    }

    const raidsCache = new Map();
    const getRaidsFor = (character) => {
      let result = raidsCache.get(character);
      if (!result) {
        result = getStatusRaidsForCharacter(character);
        raidsCache.set(character, result);
      }
      return result;
    };

    const accounts = userDoc.accounts;
    const totalCharacters = accounts.reduce(
      (sum, account) => sum + (Array.isArray(account.characters) ? account.characters.length : 0),
      0
    );
    const allRaidEntries = [];
    for (const account of accounts) {
      for (const character of account.characters || []) {
        allRaidEntries.push(...getRaidsFor(character));
      }
    }
    const globalProgress = summarizeRaidProgress(allRaidEntries);
    const globalTotals = { characters: totalCharacters, progress: globalProgress };

    const statusUserMeta = {
      discordId: userDoc.discordId,
      autoManageEnabled: !!userDoc.autoManageEnabled,
      lastAutoManageSyncAt: Number(userDoc.lastAutoManageSyncAt) || 0,
      lastAutoManageAttemptAt: Number(userDoc.lastAutoManageAttemptAt) || 0,
    };
    const pages = accounts.map((account, idx) =>
      buildAccountPageEmbed(
        account,
        idx,
        accounts.length,
        globalTotals,
        getRaidsFor,
        statusUserMeta
      )
    );

    if (pages.length === 1) {
      await interaction.editReply({ embeds: [pages[0]] });
      return;
    }

    let currentPage = 0;
    await interaction.editReply({
      embeds: [pages[currentPage]],
      components: [
        buildPaginationRow(currentPage, pages.length, false, {
          prevId: "status:prev",
          nextId: "status:next",
        }),
      ],
    });
    const message = await interaction.fetchReply();

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: STATUS_PAGINATION_SESSION_MS,
    });

    collector.on("collect", async (btn) => {
      if (btn.user.id !== interaction.user.id) {
        await btn.reply({
          content: `${UI.icons.lock} Chỉ người chạy \`/raid-status\` mới điều khiển được pagination.`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      if (btn.customId === "status:prev") currentPage = Math.max(0, currentPage - 1);
      else if (btn.customId === "status:next") {
        currentPage = Math.min(pages.length - 1, currentPage + 1);
      } else {
        return;
      }

      await btn.update({
        embeds: [pages[currentPage]],
        components: [
          buildPaginationRow(currentPage, pages.length, false, {
            prevId: "status:prev",
            nextId: "status:next",
          }),
        ],
      }).catch(() => {});
    });

    collector.on("end", async () => {
      try {
        const expiredFooter =
          `⏱️ Session đã hết hạn (${STATUS_PAGINATION_SESSION_MS / 1000}s) · Dùng /raid-status để xem lại`;
        const expiredEmbed = EmbedBuilder.from(pages[currentPage]).setFooter({
          text: expiredFooter,
        });
        await interaction.editReply({
          embeds: [expiredEmbed],
          components: [
            buildPaginationRow(currentPage, pages.length, true, {
              prevId: "status:prev",
              nextId: "status:next",
            }),
          ],
        });
      } catch {
        // Interaction token may have expired.
      }
    });
  }

  return {
    handleStatusCommand,
    buildAccountFreshnessLine,
    buildAccountPageEmbed,
    buildStatusFooterText,
  };
}

module.exports = {
  createRaidStatusCommand,
  STATUS_PAGINATION_SESSION_MS,
  STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS,
};
