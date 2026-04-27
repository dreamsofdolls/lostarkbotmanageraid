/**
 * all-mode.js
 *
 * /raid-check raid:all - cross-raid overview handler. Builds per-account
 * pages with every eligible raid listed per char, mirroring /raid-status
 * but scoped guild-wide instead of just the caller's roster.
 *
 * Self-contained handler (uses character-helpers via outer-scope deps,
 * not the snapshot/edit-helpers factories). Pulled out as its own module
 * because at 528 lines it dominated the file and made navigating the
 * other handlers harder.
 */

const { isSupportClass } = require("../../data/Class");
const { buildNoticeEmbed } = require("../../raid/shared");

function createAllModeHandler({
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  User,
  ensureFreshWeek,
  truncateText,
  buildAccountPageEmbed,
  buildStatusFooterText,
  summarizeRaidProgress,
  getStatusRaidsForCharacter,
  buildPaginationRow,
  isRaidLeader,
  isManagerId,
  discordUserLimiter,
  RAID_CHECK_PAGINATION_SESSION_MS,
}) {

  async function handleRaidCheckAllCommand(interaction) {
    if (!isRaidLeader(interaction)) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "lock",
            title: "Chỉ Raid Manager mới được dùng",
            description: "Lệnh `/raid-check raid:all` chỉ Raid Manager mới chạy được nha cậu (config qua env `RAID_MANAGER_ID`). Gõ `/raid-status` nếu cậu muốn xem progress của roster mình.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const started = Date.now();

    // Only users with at least one account matter for the overview.
    // Select enough identity fields to resolve an avatar-less fallback
    // display name (same cache-first preference the Edit flow uses).
    const users = await User.find({ "accounts.0": { $exists: true } })
      .select(
        "discordId accounts autoManageEnabled lastAutoManageSyncAt lastAutoManageAttemptAt discordUsername discordGlobalName discordDisplayName"
      )
      .lean();

    for (const userDoc of users) {
      ensureFreshWeek(userDoc);
    }

    // Each page = one (user, account) pair. Empty accounts (0 chars)
    // still render a blank page so the leader knows the slot exists
    // rather than have it silently disappear - same contract /raid-status
    // uses for its own caller's empty accounts.
    const pagesData = [];
    for (const userDoc of users) {
      const accounts = Array.isArray(userDoc.accounts) ? userDoc.accounts : [];
      for (let idx = 0; idx < accounts.length; idx += 1) {
        pagesData.push({ userDoc, account: accounts[idx], accountIdx: idx });
      }
    }

    if (pagesData.length === 0) {
      await interaction.editReply({
        content: null,
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: "Server chưa có roster nào",
            description: "Artist không thấy member nào đã `/add-roster` cả nha. Bảo các cậu trong server gõ `/add-roster` trước rồi `/raid-check raid:all` mới có data để overview.",
          }),
        ],
      });
      return;
    }

    // Resolve Discord display name + avatar for each visible user once.
    // Cache-first on discord.js users cache, limiter-gated miss path
    // (same helper the existing /raid-check render already uses).
    const visibleUserIds = [...new Set(pagesData.map((p) => p.userDoc.discordId))];
    const authorMeta = new Map();
    await Promise.all(
      visibleUserIds.map(async (discordId) => {
        const userDoc = users.find((u) => u.discordId === discordId);
        const cachedDisplayName =
          userDoc?.discordDisplayName ||
          userDoc?.discordGlobalName ||
          userDoc?.discordUsername ||
          "";
        let displayName = cachedDisplayName || discordId;
        let avatarURL = null;
        try {
          let userObj = interaction.client.users.cache.get(discordId);
          if (!userObj) {
            userObj = await discordUserLimiter.run(() =>
              interaction.client.users.fetch(discordId)
            );
          }
          if (userObj) {
            avatarURL = userObj.displayAvatarURL({ size: 64 });
            if (!cachedDisplayName) {
              displayName = userObj.username || displayName;
            }
          }
        } catch {
          // Fallback to cached name / snowflake; avatar stays null.
        }
        authorMeta.set(discordId, { displayName, avatarURL });
      })
    );

    const totalPages = pagesData.length;

    // Quick lookup of auto-manage state by discordId, used by the
    // "Bật auto-sync hộ" button which only renders when the user filter
    // is narrowed to a single user AND that user hasn't opted in. One
    // entry per user (pagesData has 1+ pages per user but autoManageEnabled
    // is user-level so first-seen wins).
    const autoManageStateByDiscordId = new Map();
    for (const p of pagesData) {
      const id = p.userDoc?.discordId;
      if (!id || autoManageStateByDiscordId.has(id)) continue;
      autoManageStateByDiscordId.set(id, !!p.userDoc.autoManageEnabled);
    }

    // User filter state. Starts as null (show all users). When a user
    // is picked from the filter dropdown, filteredIndices shrinks to
    // just that user's accounts (absolute indices into pagesData),
    // and currentLocalPage is the index INTO filteredIndices. Mirrors
    // the filter on specific-raid /raid-check but with accounts as
    // the unit instead of char-pages.
    const FILTER_ALL = "__all__";
    const FILTER_ALL_RAIDS = "__all_raids__";
    let filterUserId = null;
    let filterRaidId = null;
    let filteredIndices = pagesData.map((_, i) => i);
    let currentLocalPage = 0;

    const applyUserFilter = (pickedValue) => {
      filterUserId = pickedValue === FILTER_ALL ? null : pickedValue;
      if (filterUserId === null) {
        filteredIndices = pagesData.map((_, i) => i);
      } else {
        filteredIndices = [];
        for (let i = 0; i < pagesData.length; i += 1) {
          if (pagesData[i].userDoc.discordId === filterUserId) {
            filteredIndices.push(i);
          }
        }
      }
      // Reset to first page of the filtered subset; the previously
      // viewed absolute page may be outside the new filter.
      currentLocalPage = 0;
    };

    // Dropdown counts (both user-filter and raid-filter labels) are
    // computed lazily on each render via `computePendingAggregate` below,
    // so the two dropdowns stay cross-reactive: picking a user reshapes
    // the raid-filter labels to that user's backlog, and picking a raid
    // reshapes the user-filter labels to that raid's backlog per user.
    // Per Traine's ask - stable guild-wide labels were disorienting
    // during drill-down ("Du's filter says 7 pending for Kazeros Hard
    // but the raid dropdown shows 42? Whose 42?"), dynamic labels keep
    // every number on the screen consistent with the current focus.

    const buildPage = (pageIndex) => {
      const { userDoc, account } = pagesData[pageIndex];
      // Per-user raids cache. Lives inside buildPage so it rebuilds
      // per render - cheap, and keeps stale computed entries from
      // persisting if userDoc state changes in-session (it does not,
      // but the defensive reset keeps this identical to /raid-status
      // where raidsCache is per-command invocation).
      const raidsCache = new Map();
      const rawGetRaidsFor = (character) => {
        let result = raidsCache.get(character);
        if (!result) {
          result = getStatusRaidsForCharacter(character);
          raidsCache.set(character, result);
        }
        return result;
      };
      // Raid filter narrows each character's raid list down to the
      // single picked raid (or empty if the char isn't eligible for it).
      // getRaidsFor is the only source of raid entries for both the
      // char fields AND the globalTotals rollup below, so wrapping it
      // here makes the footer counts automatically reflect "just the
      // picked raid's done/partial/pending across this user's chars" -
      // no separate filter pass needed downstream.
      const getRaidsFor = filterRaidId
        ? (character) =>
            rawGetRaidsFor(character).filter(
              (r) => `${r.raidKey}:${r.modeKey}` === filterRaidId
            )
        : rawGetRaidsFor;

      const userAccounts = Array.isArray(userDoc.accounts) ? userDoc.accounts : [];
      const userTotalChars = userAccounts.reduce(
        (sum, a) => sum + (Array.isArray(a.characters) ? a.characters.length : 0),
        0
      );
      const allRaidEntries = [];
      for (const a of userAccounts) {
        for (const ch of a.characters || []) {
          allRaidEntries.push(...getRaidsFor(ch));
        }
      }
      // globalTotals in buildAccountPageEmbed is "this user's all-
      // accounts rollup" - that's what /raid-status uses for its
      // single-user case too. For all-mode, the outer page X/Y is
      // cross-user so this rollup stays user-scoped.
      const globalTotals = {
        characters: userTotalChars,
        progress: summarizeRaidProgress(allRaidEntries),
      };

      const userMeta = {
        discordId: userDoc.discordId,
        autoManageEnabled: !!userDoc.autoManageEnabled,
        lastAutoManageSyncAt: Number(userDoc.lastAutoManageSyncAt) || 0,
        lastAutoManageAttemptAt: Number(userDoc.lastAutoManageAttemptAt) || 0,
      };

      // Pass totalPages=1 so buildAccountPageEmbed does NOT emit its own
      // "🌐 All accounts" rollup line (that line is gated on
      // `totalPages > 1`, and in /raid-status pages==accounts so they
      // align - but in all-mode our pagination is cross-user, so we must
      // suppress the builder's rollup and re-inject based on the viewed
      // user's own account count below). The builder's footer page
      // counter is also suppressed here; we overlay the all-mode one
      // (absolute or filtered, depending on user filter state) right
      // after so leaders can tell "Page X/Y" from the footer next to the
      // done/partial/pending counts, matching /raid-check parity.
      const embed = buildAccountPageEmbed(
        account,
        0,
        1,
        globalTotals,
        getRaidsFor,
        userMeta,
        { hideIneligibleChars: !!filterRaidId }
      );

      // Manager roster: drop the 3-state progress icon (🟢/🟡/⚪/🔒)
      // from the title and leave the crown alone. The builder emits
      // "{progressIcon} 👑 {accountName}" for every account; when the
      // owner is a Raid Manager, that leading circle reads as visual
      // noise next to the much heavier 👑 (both compete for the leader's
      // eye on scroll). Crown alone is enough signal - the footer
      // already carries the per-user done/partial/pending rollup for
      // anyone wanting the progress at a glance. Per Traine's ask this
      // is scoped to /raid-check only; /raid-status keeps the progress
      // icon so non-manager callers still see their own account-level
      // status at the top of each page.
      if (isManagerId && isManagerId(userDoc.discordId)) {
        const origTitle = embed.data?.title || "";
        const crownIdx = origTitle.indexOf("👑");
        if (crownIdx > 0) {
          embed.setTitle(origTitle.slice(crownIdx));
        }
      }

      // Re-inject the cross-account rollup line when the viewed user
      // owns more than one account. Prepended above the freshness line
      // so visual order stays: global → freshness (description now
      // contains only those two lines at most, per /raid-check parity).
      if (userAccounts.length > 1) {
        const rollupLine = `🌐 All accounts: **${globalTotals.characters}** chars · **${globalTotals.progress.completed}/${globalTotals.progress.total}** raids done`;
        const baseDescription = embed.data?.description || "";
        embed.setDescription(baseDescription ? `${rollupLine}\n${baseDescription}` : rollupLine);
      }

      // Overlay the footer with all-mode-aware page info. Counts come
      // from globalTotals (viewed user's entire roster), matching how
      // /raid-status scopes its footer to the caller's own roster -
      // "same subject, footer = subject's rollup" keeps the semantics
      // consistent across both commands.
      //
      // Page counter adapts to the filter state: no filter = absolute
      // cross-user index; user filter active = local index within that
      // user's accounts. The leader cares about "where am I in Du's
      // accounts" once they've focused, not the absolute page number.
      const footerPageInfo = filterUserId === null
        ? { pageIndex, totalPages }
        : { pageIndex: currentLocalPage, totalPages: filteredIndices.length };
      embed.setFooter({
        text: buildStatusFooterText(globalTotals, footerPageInfo),
      });

      // Overlay a setAuthor with Discord avatar + display name. Page
      // indicator used to live here ("Du · Page 5/14") but moved to the
      // footer above for /raid-check parity - author now carries only
      // identity (name + avatar) so the header stays uncluttered.
      const meta = authorMeta.get(userDoc.discordId);
      if (meta) {
        const authorPayload = {
          name: truncateText(meta.displayName, 256),
        };
        if (meta.avatarURL) authorPayload.iconURL = meta.avatarURL;
        embed.setAuthor(authorPayload);
      }

      return embed;
    };

    const buildButtonRow = (disabled) => {
      const localTotal = filteredIndices.length;
      const row = buildPaginationRow(currentLocalPage, localTotal, disabled, {
        prevId: "raid-check-all-page:prev",
        nextId: "raid-check-all-page:next",
      });
      // Append the cross-raid Edit button. customId encodes the
      // discordId of the user currently shown on this page so the
      // Edit flow can pre-select them after the leader picks a raid.
      // Per Traine: clicking Edit while viewing Bao's page should
      // target Bao, not force re-picking from a fresh dropdown.
      // `raid-check:edit-all:<discordId>` is still routed by bot.js's
      // global dispatcher (matches the `raid-check:*` prefix) and
      // handleRaidCheckButton splits parts[2] out as the pre-select.
      const currentAbs = currentAbsoluteIndex();
      const currentViewUserId =
        pagesData[currentAbs]?.userDoc?.discordId || "";
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`raid-check:edit-all:${currentViewUserId}`)
          .setLabel("Edit progress")
          .setEmoji("✏️")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled)
      );
      // Enable-/disable-auto-on-behalf buttons: visible only when the
      // user filter narrows the view to one specific user. Direction
      // depends on that user's current opt-in state. Both buttons reuse
      // the shared raid-check.js handlers (`enable-auto-one` /
      // `disable-auto-one`) since the action is raid-agnostic.
      // Button label drops the target's display name on purpose: filter
      // narrow has already established which user is in focus (author
      // section + filter dropdown both show the name), so repeating it
      // on the button is just visual weight. The customId still carries
      // the discordId for the dispatch handler.
      if (filterUserId) {
        const focusedUserOptedIn = autoManageStateByDiscordId.get(filterUserId);
        if (focusedUserOptedIn === false) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`raid-check:enable-auto-one:${filterUserId}`)
              .setLabel("Bật auto-sync")
              .setEmoji("🔄")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(disabled)
          );
        } else if (focusedUserOptedIn === true) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`raid-check:disable-auto-one:${filterUserId}`)
              .setLabel("Tắt auto-sync")
              .setEmoji("🚫")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(disabled)
          );
        }
      }
      return row;
    };

    // Pending aggregation walker shared by both filter-row builders.
    // Returns { perUserPending: Map<discordId,count>, perRaidPending:
    // Map<"raidKey:modeKey",{label,pending}>, totalPending } scoped to
    // the (raidFilter, userFilter) args. Single pass over pagesData ×
    // chars × raids so both dropdowns pull from the same in-memory tally
    // instead of walking twice per render - guild scale is small enough
    // that the double-use is free, but the DRY keeps both counts
    // guaranteed consistent.
    // perUserPending entries are { count, supports, dps } so the
    // user-filter dropdown can render "Du · 8 pending (2🛡️ 6⚔️)" instead
    // of bare "(8 pending)". Hard-support classes (Bard / Paladin /
    // Artist / Valkyrie) get the 🛡️ bucket; everything else is DPS.
    // Without this split it's hard to tell whether a heavy backlog is
    // composition-blocking (no supports ready) or just queue depth.
    const computePendingAggregate = ({ raidFilter, userFilter }) => {
      const perUserPending = new Map();
      const perRaidPending = new Map();
      let totalPending = 0;
      for (const p of pagesData) {
        const discordId = p.userDoc.discordId;
        if (userFilter && discordId !== userFilter) continue;
        const chars = Array.isArray(p.account.characters) ? p.account.characters : [];
        for (const ch of chars) {
          const charIsSupport = isSupportClass(ch?.class);
          for (const raid of getStatusRaidsForCharacter(ch)) {
            const key = `${raid.raidKey}:${raid.modeKey}`;
            // Record the raid existence for the per-raid dropdown BEFORE
            // the pending gate so a raid all chars have cleared still
            // appears in the dropdown (with pending=0) rather than
            // silently vanishing once the backlog hits zero.
            let raidEntry = perRaidPending.get(key);
            if (!raidEntry) {
              raidEntry = { key, label: raid.raidName, pending: 0, supports: 0, dps: 0 };
              perRaidPending.set(key, raidEntry);
            }
            if (raidFilter && key !== raidFilter) continue;
            if (raid.isCompleted) continue;
            let userEntry = perUserPending.get(discordId);
            if (!userEntry) {
              userEntry = { count: 0, supports: 0, dps: 0 };
              perUserPending.set(discordId, userEntry);
            }
            userEntry.count += 1;
            if (charIsSupport) userEntry.supports += 1;
            else userEntry.dps += 1;
            raidEntry.pending += 1;
            if (charIsSupport) raidEntry.supports += 1;
            else raidEntry.dps += 1;
            totalPending += 1;
          }
        }
      }
      return { perUserPending, perRaidPending, totalPending };
    };

    // User filter dropdown, reactive to the active raid filter. When a
    // raid is picked, each user's label shows pending count FOR THAT
    // RAID ("Du (7 pending)"); when no raid is picked, labels show
    // guild-wide backlog per user. The "All users" entry carries the
    // running total so the leader can see at a glance how much work is
    // outstanding in the currently-filtered view (pre/post raid pick).
    //
    // Users sorted pending desc so the heaviest backlog surfaces first -
    // in specific-raid /raid-check the same rule applies (most-pending
    // user on top). Discord StringSelect caps at 25 options; 1 is the
    // All-users entry so 24 users fit below. Overflow users fall off
    // but stay reachable via Prev/Next pagination.
    const buildFilterRow = (disabled) => {
      const { perUserPending, totalPending } = computePendingAggregate({
        raidFilter: filterRaidId,
        userFilter: null, // user dropdown always lists every user, scope here is raid-only
      });
      const options = [
        {
          label: truncateText(
            `All users (${totalPending === 0 ? "DONE" : `${totalPending} pending`})`,
            100
          ),
          value: FILTER_ALL,
          emoji: "🌐",
          default: filterUserId === null,
        },
      ];
      const sortedUsers = visibleUserIds
        .map((discordId) => {
          const tally = perUserPending.get(discordId) || { count: 0, supports: 0, dps: 0 };
          return {
            discordId,
            pending: tally.count,
            supports: tally.supports,
            dps: tally.dps,
            displayName: authorMeta.get(discordId)?.displayName || discordId,
          };
        })
        .sort(
          (a, b) =>
            b.pending - a.pending || a.displayName.localeCompare(b.displayName)
        );
      for (const u of sortedUsers.slice(0, 24)) {
        // 0 pending -> "DONE" instead of "0 pending · 0🛡️ 0⚔️". The
        // breakdown suffix only adds info when there's actual backlog.
        const suffix = u.pending === 0
          ? "DONE"
          : `${u.pending} pending · ${u.supports}🛡️ ${u.dps}⚔️`;
        options.push({
          label: truncateText(
            `${u.displayName} (${suffix})`,
            100
          ),
          value: u.discordId,
          emoji: "👤",
          default: filterUserId === u.discordId,
        });
      }
      return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("raid-check-all-filter:user")
          .setPlaceholder("Jump to user / Lọc theo user...")
          .setDisabled(disabled)
          .addOptions(options)
      );
    };

    // Raid filter dropdown, reactive to the active user filter. When a
    // user is picked, each raid's label shows pending count FOR THAT
    // USER ONLY ("Kazeros Hard (3 pending)"); when no user is picked,
    // labels are guild-wide backlog per raid. Leader pick-flow is
    // naturally two-step: first narrow to a user, then see which raid
    // that user still needs → both labels update so the shown counts
    // always match the current drill-down, no stale guild numbers
    // confusing the per-user scope.
    const buildRaidFilterRow = (disabled) => {
      const { perRaidPending, totalPending } = computePendingAggregate({
        raidFilter: null, // raid dropdown always lists every raid, scope here is user-only
        userFilter: filterUserId,
      });
      const raidEntries = [...perRaidPending.values()].sort(
        (a, b) => b.pending - a.pending || a.label.localeCompare(b.label)
      );
      const options = [
        {
          label: truncateText(
            `All raids (${totalPending === 0 ? "DONE" : `${totalPending} total pending`})`,
            100
          ),
          value: FILTER_ALL_RAIDS,
          emoji: "🌐",
          default: filterRaidId === null,
        },
      ];
      // StringSelect caps at 25 options; 1 slot is All-raids entry so
      // 24 actual raids fit. Act 4 Normal/Hard + Kazeros Normal/Hard +
      // Serca Hard/Nightmare = 6 today, plenty of headroom for future
      // raid additions.
      for (const r of raidEntries.slice(0, 24)) {
        // Same DONE-vs-breakdown rule as the user dropdown above:
        // "0 pending · 0🛡️ 0⚔️" reads as noise; collapse to "DONE" so
        // the leader scans the raid list for actually-pending entries.
        const suffix = r.pending === 0
          ? "DONE"
          : `${r.pending} pending · ${r.supports}🛡️ ${r.dps}⚔️`;
        options.push({
          label: truncateText(`${r.label} (${suffix})`, 100),
          value: r.key,
          emoji: "⚔️",
          default: filterRaidId === r.key,
        });
      }
      return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("raid-check-all-filter:raid")
          .setPlaceholder("Filter by raid / Lọc theo raid...")
          .setDisabled(disabled)
          .addOptions(options)
      );
    };

    const buildComponents = (disabled) => [
      buildButtonRow(disabled),
      buildFilterRow(disabled),
      buildRaidFilterRow(disabled),
    ];

    const currentAbsoluteIndex = () =>
      filteredIndices[currentLocalPage] ?? filteredIndices[0] ?? 0;

    await interaction.editReply({
      embeds: [buildPage(currentAbsoluteIndex())],
      components: buildComponents(false),
    });
    const followup = await interaction.fetchReply();
    console.log(
      `[raid-check all] rendered pages=${totalPages} users=${visibleUserIds.length} openMs=${Date.now() - started}`
    );

    const collector = followup.createMessageComponentCollector({
      time: RAID_CHECK_PAGINATION_SESSION_MS,
    });

    collector.on("collect", async (component) => {
      if (component.user.id !== interaction.user.id) {
        // Only reply-lock on components we own; a stray click on some
        // other bot's component shouldn't get a scolding message.
        const customId = component.customId || "";
        const ours =
          customId.startsWith("raid-check-all-page:") ||
          customId === "raid-check-all-filter:user" ||
          customId === "raid-check-all-filter:raid";
        if (ours) {
          await component
            .reply({
              embeds: [
                buildNoticeEmbed(EmbedBuilder, {
                  type: "lock",
                  title: "Chỉ người mở mới bấm được",
                  description: "Component này thuộc session `/raid-check raid:all` của người khác nha cậu, Artist chỉ cho người mở session điều khiển. Cậu mở session riêng bằng `/raid-check` của mình nhé.",
                }),
              ],
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
        }
        return;
      }
      const customId = component.customId || "";

      if (customId === "raid-check-all-filter:user") {
        const value =
          Array.isArray(component.values) && component.values.length > 0
            ? component.values[0]
            : FILTER_ALL;
        applyUserFilter(value);
        await component
          .update({
            embeds: [buildPage(currentAbsoluteIndex())],
            components: buildComponents(false),
          })
          .catch(() => {});
        return;
      }

      if (customId === "raid-check-all-filter:raid") {
        const value =
          Array.isArray(component.values) && component.values.length > 0
            ? component.values[0]
            : FILTER_ALL_RAIDS;
        filterRaidId = value === FILTER_ALL_RAIDS ? null : value;
        // Deliberately NOT resetting currentLocalPage - raid filter is
        // orthogonal to page structure (unlike user filter, which shrinks
        // `filteredIndices`, the raid filter just changes what each page
        // shows internally). Resetting would confuse "I was on page 3 of
        // Du's accounts, why am I back at page 1?" when the page list
        // didn't change size at all.
        await component
          .update({
            embeds: [buildPage(currentAbsoluteIndex())],
            components: buildComponents(false),
          })
          .catch(() => {});
        return;
      }

      if (customId.startsWith("raid-check-all-page:")) {
        const action = customId.split(":")[1];
        const localTotal = filteredIndices.length;
        if (action === "prev") currentLocalPage = Math.max(0, currentLocalPage - 1);
        else if (action === "next") currentLocalPage = Math.min(localTotal - 1, currentLocalPage + 1);
        else return;
        await component
          .update({
            embeds: [buildPage(currentAbsoluteIndex())],
            components: buildComponents(false),
          })
          .catch(() => {});
        return;
      }

      // raid-check:edit-all + other non-owned components fall through
      // to the bot.js global dispatcher.
    });

    collector.on("end", async () => {
      await followup
        .edit({ components: buildComponents(true) })
        .catch(() => {});
    });
  }

  return { handleRaidCheckAllCommand };
}

module.exports = { createAllModeHandler };
