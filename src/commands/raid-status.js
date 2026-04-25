const { isSupportClass, getClassEmoji } = require("../data/Class");

const STATUS_PAGINATION_SESSION_MS = 3 * 60 * 1000;
const STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS = 2500;

function createRaidStatusCommand(deps) {
  const {
    EmbedBuilder,
    ComponentType,
    StringSelectMenuBuilder,
    ActionRowBuilder,
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
    // Class emoji prepended to char name when the class is mapped in
    // CLASS_EMOJI_MAP. Empty string fallback when unmapped - safe no-op
    // so the field renders cleanly while emoji are still being uploaded.
    const classIcon = getClassEmoji(character.class);
    const namePrefix = classIcon ? `${classIcon} ` : "";
    const fieldName = truncateText(`${namePrefix}${name} · ${itemLevel}`, 256);

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

  // Map the piggyback outcome captured during handleRaidStatusCommand
  // into a single description line. Returns null when the line would
  // add noise without information (no piggyback was attempted, or it
  // ran cleanly but found nothing new - the freshness line above
  // already covers the "data is fresh" case).
  function buildPiggybackOutcomeLine(piggybackOutcome) {
    if (!piggybackOutcome) return null;
    switch (piggybackOutcome.outcome) {
      case "applied": {
        const n = piggybackOutcome.newGatesApplied || 0;
        return `${UI.icons.reset} Bible vừa sync · **${n}** gate mới đã apply`;
      }
      case "timeout":
        return `${UI.icons.warn} Bible sync chậm · render data cache, gather đang chạy nền (mở lại sau ~10s để thấy data mới)`;
      case "failed":
        return `${UI.icons.warn} Bible sync gặp vấn đề · đang xem cache, thử mở lại sau vài phút`;
      case "cooldown":
      case "synced-no-new":
      case "not-applicable":
      default:
        return null;
    }
  }

  function buildAccountPageEmbed(
    account,
    pageIndex,
    totalPages,
    globalTotals,
    getRaidsFor,
    userMeta = null,
    options = {}
  ) {
    const { hideIneligibleChars = false } = options;
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

    // Surface the bible-piggyback outcome from THIS open so the user
    // (regular member, /raid-status is their only sync entry point) can
    // tell whether the data they're seeing reflects a fresh pull, a
    // silently-failed attempt, or a cached read because they were within
    // the 15m cooldown. Skip the "not-applicable" / "synced-no-new"
    // cases on purpose - they add noise without information (the freshness
    // line above already tells them when bible was last successfully
    // synced + countdown to next free attempt).
    const outcomeLine = buildPiggybackOutcomeLine(userMeta?.piggybackOutcome);
    if (outcomeLine) descriptionLines.push(outcomeLine);

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
    // When `hideIneligibleChars` is on (caller has an active raid filter),
    // drop chars whose getRaidsFor returns empty - a locked "🔒 Not
    // eligible yet" card for every char below the iLvl gate is pure
    // noise when the caller just wants to see who CAN do the picked raid.
    // Filter state lives at the call site; passing the flag lets the
    // builder render an "all chars ineligible" notice when the roster
    // has zero relevant chars, vs "no chars saved" (empty account) vs
    // the normal fields path.
    const visibleChars = hideIneligibleChars
      ? characters.filter((c) => getRaidsFor(c).length > 0)
      : characters;

    if (visibleChars.length === 0 && hideIneligibleChars) {
      embed.addFields({
        name: "​",
        value: `${UI.icons.lock} _Không có character nào eligible cho raid này trong roster._`,
        inline: false,
      });
      return embed;
    }

    for (let i = 0; i < visibleChars.length; i += 2) {
      embed.addFields(buildCharacterField(visibleChars[i], getRaidsFor));
      embed.addFields(inlineSpacer);
      embed.addFields(
        visibleChars[i + 1]
          ? buildCharacterField(visibleChars[i + 1], getRaidsFor)
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

    // Piggyback outcome tracker so we can surface "what just happened on
    // this open" in the embed. /raid-status is the only sync entry point
    // for regular users (they cannot use /raid-check Sync); without an
    // outcome surface the user has no way to tell whether the data they
    // see reflects a fresh bible pull, a silently-timed-out attempt, or
    // a cached read because they were within the 15m cooldown.
    //
    // outcome values:
    //   - "not-applicable": user not opted-in / no roster, no piggyback
    //   - "cooldown": slot guard rejected (within 15m of last attempt)
    //   - "failed": gather promise rejected (bible API issue)
    //   - "timeout": gather exceeded the 2.5s budget, running in bg
    //   - "synced-no-new": gather + apply succeeded but no new gates
    //   - "applied": gather + apply succeeded, N new gates applied
    const piggybackOutcome = {
      outcome: "not-applicable",
      newGatesApplied: 0,
    };

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
        } else {
          piggybackOutcome.outcome = "cooldown";
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
      // Gather rejected: budget didn't time out, slot was acquired, but
      // the value is null (the .catch in the gather chain converts a
      // throw into null). Distinct from timeout because the bg task is
      // already settled - nothing keeps running.
      const autoManageGatherFailed =
        autoManageGuard?.acquired &&
        !autoManageBudgetResult.timedOut &&
        autoManageBudgetResult.value === null;
      if (autoManageTimedOut) piggybackOutcome.outcome = "timeout";
      else if (autoManageGatherFailed) piggybackOutcome.outcome = "failed";

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
          // Count newly-applied gates so the surface line can show
          // "synced N new gates" instead of just "synced". Sums
          // perChar[].applied[].length across every char in the report.
          const newGates = autoReport.perChar.reduce(
            (sum, entry) =>
              sum + (Array.isArray(entry.applied) ? entry.applied.length : 0),
            0
          );
          piggybackOutcome.newGatesApplied = newGates;
          piggybackOutcome.outcome = newGates > 0 ? "applied" : "synced-no-new";
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
    const baseGetRaidsFor = (character) => {
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

    const statusUserMeta = {
      discordId: userDoc.discordId,
      autoManageEnabled: !!userDoc.autoManageEnabled,
      lastAutoManageSyncAt: Number(userDoc.lastAutoManageSyncAt) || 0,
      lastAutoManageAttemptAt: Number(userDoc.lastAutoManageAttemptAt) || 0,
      // Captured upstream during the piggyback flow so buildAccountPageEmbed
      // can surface "what just happened on this open" without re-deriving
      // outcome from timestamp deltas (which can't distinguish "we just
      // synced and got nothing new" from "bible was unreachable so we kept
      // the cached data" - both leave lastAutoManageSyncAt unchanged).
      piggybackOutcome,
    };

    // Raid-filter aggregate for the caller's own roster. Parallel to the
    // all-mode dropdown in /raid-check raid:all, but counts here are
    // self-scoped (chars across caller's accounts where the raid isn't
    // fully cleared yet). Computed once at init with the unfiltered
    // getRaidsFor so toggling filters later doesn't rewrite the labels
    // underneath the user's hand - labels stay as a stable "my backlog
    // per raid" reference. Sorted pending desc so the heaviest backlog
    // surfaces first.
    // Per-raid entries also track {supports, dps} so the dropdown label
    // can render "Aegir Hard (3 pending · 1🪄 2⚔️)" - lets the caller see
    // at a glance whether a raid's backlog is composition-blocking (no
    // supports left) or just queue depth. Hard-support classes are Bard
    // / Paladin / Artist / Valkyrie; everyone else counts as DPS.
    const FILTER_ALL_RAIDS = "__all_raids__";
    const raidAggregate = new Map();
    for (const account of accounts) {
      for (const ch of account.characters || []) {
        const charIsSupport = isSupportClass(ch?.class);
        for (const raid of baseGetRaidsFor(ch)) {
          const key = `${raid.raidKey}:${raid.modeKey}`;
          let entry = raidAggregate.get(key);
          if (!entry) {
            entry = {
              key,
              label: raid.raidName,
              raidKey: raid.raidKey,
              modeKey: raid.modeKey,
              pending: 0,
              supports: 0,
              dps: 0,
            };
            raidAggregate.set(key, entry);
          }
          if (!raid.isCompleted) {
            entry.pending += 1;
            if (charIsSupport) entry.supports += 1;
            else entry.dps += 1;
          }
        }
      }
    }
    const raidDropdownEntries = [...raidAggregate.values()].sort(
      (a, b) => b.pending - a.pending || a.label.localeCompare(b.label)
    );
    const totalRaidPending = raidDropdownEntries.reduce(
      (sum, r) => sum + r.pending,
      0
    );

    let currentPage = 0;
    let filterRaidId = null;

    // Build the current page's embed given the active (page, raid-filter)
    // pair. Rebuilt on every state change instead of pre-baking a pages[]
    // array because any filter pick invalidates every pre-built embed -
    // /raid-status's roster count is small enough (<10 accounts typical)
    // that one buildAccountPageEmbed per interaction is zero-cost.
    const buildCurrentEmbed = () => {
      const getRaidsFor = filterRaidId
        ? (ch) =>
            baseGetRaidsFor(ch).filter(
              (r) => `${r.raidKey}:${r.modeKey}` === filterRaidId
            )
        : baseGetRaidsFor;

      // Recompute globalTotals against the filtered view so the footer
      // (and the cross-account rollup line, when >1 account) reflect
      // only the picked raid's done/partial/pending when a filter is
      // active. Characters count stays at totalCharacters regardless -
      // "12 chars in roster" is a static fact of the roster, not
      // something the filter narrows.
      const filteredEntries = [];
      for (const a of accounts) {
        for (const c of a.characters || []) {
          filteredEntries.push(...getRaidsFor(c));
        }
      }
      const filteredTotals = {
        characters: totalCharacters,
        progress: summarizeRaidProgress(filteredEntries),
      };

      return buildAccountPageEmbed(
        accounts[currentPage],
        currentPage,
        accounts.length,
        filteredTotals,
        getRaidsFor,
        statusUserMeta,
        { hideIneligibleChars: !!filterRaidId }
      );
    };

    const buildRaidFilterRow = (disabled) => {
      const options = [
        {
          label: truncateText(`All raids (${totalRaidPending} total pending)`, 100),
          value: FILTER_ALL_RAIDS,
          emoji: "🌐",
          default: filterRaidId === null,
        },
      ];
      for (const r of raidDropdownEntries.slice(0, 24)) {
        options.push({
          label: truncateText(
            `${r.label} (${r.pending} pending · ${r.supports}🪄 ${r.dps}⚔️)`,
            100
          ),
          value: r.key,
          emoji: "⚔️",
          default: filterRaidId === r.key,
        });
      }
      return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("status-filter:raid")
          .setPlaceholder("Filter by raid / Lọc theo raid...")
          .setDisabled(disabled)
          .addOptions(options)
      );
    };

    const buildComponents = (disabled) => {
      const rows = [];
      if (accounts.length > 1) {
        rows.push(
          buildPaginationRow(currentPage, accounts.length, disabled, {
            prevId: "status:prev",
            nextId: "status:next",
          })
        );
      }
      // Skip the raid-filter row when the caller has no eligible raids
      // at all (empty roster / all chars below minItemLevel gates) -
      // dropdown with only the All-raids entry is just noise.
      if (raidDropdownEntries.length > 0) {
        rows.push(buildRaidFilterRow(disabled));
      }
      return rows;
    };

    const initialComponents = buildComponents(false);

    await interaction.editReply({
      embeds: [buildCurrentEmbed()],
      components: initialComponents,
    });

    // No interactive surface (single account + no eligible raids) - skip
    // the collector entirely. Without this guard the collector would
    // spin for STATUS_PAGINATION_SESSION_MS doing nothing.
    if (initialComponents.length === 0) return;

    const message = await interaction.fetchReply();

    // No componentType filter - collector must listen to both Button
    // (prev/next) AND StringSelect (raid filter) interactions.
    const collector = message.createMessageComponentCollector({
      time: STATUS_PAGINATION_SESSION_MS,
    });

    collector.on("collect", async (component) => {
      if (component.user.id !== interaction.user.id) {
        await component.reply({
          content: `${UI.icons.lock} Chỉ người chạy \`/raid-status\` mới điều khiển được.`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      const id = component.customId || "";
      if (id === "status:prev") {
        currentPage = Math.max(0, currentPage - 1);
      } else if (id === "status:next") {
        currentPage = Math.min(accounts.length - 1, currentPage + 1);
      } else if (id === "status-filter:raid") {
        const value =
          Array.isArray(component.values) && component.values.length > 0
            ? component.values[0]
            : FILTER_ALL_RAIDS;
        filterRaidId = value === FILTER_ALL_RAIDS ? null : value;
        // Do NOT reset currentPage - raid filter is orthogonal to page
        // structure (pages still map 1:1 to accounts, only what each
        // page displays internally changes). Resetting to page 0 on
        // filter pick would feel broken: "I was viewing account 3, why
        // did I jump back to account 1 just because I filtered a raid?"
      } else {
        return;
      }

      await component.update({
        embeds: [buildCurrentEmbed()],
        components: buildComponents(false),
      }).catch(() => {});
    });

    collector.on("end", async () => {
      try {
        const expiredFooter =
          `⏱️ Session đã hết hạn (${STATUS_PAGINATION_SESSION_MS / 1000}s) · Dùng /raid-status để xem lại`;
        const expiredEmbed = EmbedBuilder.from(buildCurrentEmbed()).setFooter({
          text: expiredFooter,
        });
        await interaction.editReply({
          embeds: [expiredEmbed],
          components: buildComponents(true),
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
