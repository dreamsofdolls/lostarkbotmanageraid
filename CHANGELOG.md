# Changelog

Dates use the local calendar of the commit. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## 2026-04-25

### Changed (Phase 2.2)

- Continued splitting `src/raid-command.js`. Extracted the /raid-check Mongo query construction into `src/raid/raid-check-query.js`:
  - `RAID_CHECK_USER_BASE_QUERY` (filter), `RAID_CHECK_USER_QUERY_FIELDS` (projection)
  - `getRaidScanRange(raidKey, selfMin)` - per-raid iLvl range bounds (lowestMin / selfMin / nextMin)
  - `buildRaidCheckUserQuery(raidMeta, now)` - assembles the query object with the stale-roster carve-out
- Each function invocation-tested before commit (lesson from Phase 2.1 hotfix - static check + import resolver are not enough; runtime call validates internal symbol bindings). Full `require('./src/raid-command')` now loads cleanly past both extraction points.
- `raid-command.js`: 1239 -> 1145 lines (running total since Phase 2.1: 1568 -> 1145, -27%).

### Fixed

- `/raid-check raid:all` and per-char raid lists no longer surface a "0/2 pending Nightmare" card next to a completed Hard card on the same Serca character. In Lost Ark the weekly raid slot is shared across every difficulty of the same raid - clearing at any one mode (Normal/Hard/Nightmare) consumes the slot - so showing both as pending is misleading. The Serca 1740+ branch in `getStatusRaidsForCharacter` now checks `completedGateKeys.length > 0` first; if the char is locked for the week, only the actually-cleared mode card is emitted. The "show both options" fan-out is preserved for chars that haven't entered Serca yet this week. Same fix automatically benefits any future raid that surfaces multiple modes simultaneously.

### Changed

- Started splitting `src/raid-command.js` (was 1568 lines, single compose-root file). Step 1: extracted 20 pure character/raid normalization helpers into `src/raid/character.js` along with `RAID_REQUIREMENT_MAP`.
  - Extracted: `createCharacterId`, `buildFetchedRosterIndexes`, `pickUniqueFetchedRosterCandidate`, `findFetchedRosterMatchForCharacter`, `getRequirementFor`, `getBestEligibleModeKey`, `sanitizeTasks`, `getGateKeys`, `normalizeAssignedRaid`, `getCompletedGateKeys`, `buildAssignedRaidFromLegacy`, `ensureAssignedRaids`, `isAssignedRaidCompleted`, `buildCharacterRecord`, `ensureRaidEntries`, `getStatusRaidsForCharacter`, `pickProgressIcon`, `formatRaidStatusLine`, `summarizeRaidProgress`, `raidCheckGateIcon`.
  - All these functions are pure (no closure on Discord client / Mongoose / scheduler state) and trivially unit-testable in isolation.
  - `raid-command.js`: 1568 -> 1239 lines (-329, -21%).
- Source-tree cleanup. No behavior change. Aligns RaidManage layout with the LoaLogs convention so cross-project navigation feels the same:
  - **Deleted dead code** `src/models/GuildConfig.js`. It was a 36-line ESM file leftover from a copy-paste from LoaLogs, with a totally different schema than the live Mongoose model and never imported anywhere. Confirmed by full grep before removal.
  - **Moved** `db.js` (root) to `src/db.js`. Root now only holds entry/meta files (Dockerfile, railway.toml, package.json, etc.); all source lives under `src/`.
  - **Renamed** `src/schema/` to `src/models/` (Mongoose models - matches the standard Node convention and LoaLogs's `bot/models/`).
  - **Renamed** `src/models/` to `src/data/` (`Class.js` and `Raid.js` are pure constant lookup tables, not Mongoose models - the old `models/` name was misleading).
  - All 10 require() paths rewritten; relative-import resolver script confirms 31/31 source files resolve.

## 2026-04-24

### Added

- `/raid-check raid:all` synthetic overview choice: cross-raid view of every member's roster, mirroring `/raid-status`'s per-account page layout (inline 2-col char fields, account progress rollup, freshness badge) but scoped across every user in the guild instead of just the caller's own. Each page adds a `setAuthor` with display name + "Page X/Y" so leaders can tell users apart while flipping pages.
- Cross-raid **Edit** from all-mode: clicking ✏️ Edit on /raid-check raid:all opens the same Edit UI as specific-raid but with a **raid dropdown** prepended on top. Picking a raid reloads the per-raid snapshot + editable-user list on the fly and resets the user/char picks (a user who was editable for Serca Hard may have no char eligible for Act 4 Normal). Specific-raid Edit flow is unchanged - `state.scopeAll` flag in the shared state machine drives the branch.
- `/raid-status` **raid-filter dropdown**: "Filter by raid / Lọc theo raid..." lets the caller narrow char cards + footer counts down to a single raid across their own roster. Options format `{Raid Label} ({N} pending)` with N = self-scoped char count where `isCompleted === false`, sorted pending desc. Labels computed once at init for stable backlog reference. Shown on both single-account and multi-account callers (single-account no longer short-circuits past the collector). Orthogonal to pagination - `currentPage` doesn't reset on filter pick since page structure is unchanged. Dropdown suppressed entirely when the caller's roster has zero eligible raids (no useful filter targets).
- All-mode **raid-filter dropdown**: third action row "Filter by raid / Lọc theo raid..." lets leaders narrow every char card AND the footer `done/partial/pending` counts down to a single raid. Options are labeled `{Raid Label} ({N} pending)` with N = guild-wide count of char-raid entries where `isCompleted === false`; sorted pending desc so backlog-heaviest surfaces first. Labels computed once at init so toggling filters doesn't rewrite them underneath the leader's hand - counts stay as stable reference for backlog triage. Orthogonal to the user filter: combining `user:Du × raid:Kazeros Hard` shows Du's Kazeros Hard progress in the footer while dropdown labels still report guild totals. Page structure unchanged (raid filter only rewrites what each page displays internally, not which pages exist), so `currentLocalPage` does not reset on pick. 25-option cap leaves 24 raid slots after the All-raids entry (today's 6-raid roster has plenty of headroom).
- All-mode **user-filter dropdown**: "Jump to user / Lọc theo user..." below the pagination row lets a leader jump straight to a specific member's accounts without Prev/Next spam. Mirrors the user filter on specific-raid /raid-check but with accounts as the unit. Page counter in the author slot adapts: "Page 2/3" within a filter, "Page 4/14" across all users. 25-option cap means the first 24 users (alphabetical) appear in the dropdown; overflow users stay reachable via Prev/Next.
- All-mode Edit button **carries user context** from the viewed page: clicking ✏️ Edit while on Bao's page encodes Bao's discordId into the button customId, and the Edit flow pre-selects Bao once the leader picks a raid (if Bao is still editable for the picked raid - otherwise the pre-select silently drops and the user dropdown works as normal). Leader no longer has to re-pick the user they were already focused on.
- `/raid-check` leader **Edit button**: cascading select (user → char → raid → status → optional gate), Manager-only, reuses `applyRaidSetForDiscordId`.
  - Live gate state shown once raid is picked; Complete / Process buttons disable when no-op, gate buttons show 🟢 / 🟠 / ⚪ per stored state.
  - Auto-sync users skipped except for chars with `publicLogDisabled=true` (bible can't reach them).
  - On token/UI failure, bot posts a public tag telling the leader to rerun (auto-delete 30s).
- **Raid Manager privilege tier** off the existing `RAID_MANAGER_ID` allowlist: 30s auto-manage cooldown (vs 15m default), 👑 header icon on their rosters in `/raid-check` + `/raid-status`, gentle welcome-embed mention.
- **Artist quiet hours 03:00-08:00 VN**: bedtime embed at first tick ≥ 03:00 (3 variants, TTL 5m), wake-up + catch-up sweep at first tick ≥ 08:00 (4-bucket pool, TTL 10m). Message parsing stays active 24/7; only the scheduler sleeps.
- `character.publicLogDisabled` schema flag, stamped/cleared by `applyAutoManageCollected` on bible "Logs not enabled" errors.
- `/raid-status` + `/raid-check` freshness badges now pair with an "⏳ Next refresh/sync in Xm" countdown that flips to "✅ Refresh/Sync ready" on expiry.

### Changed

- `/raid-check raid:all` user-filter + raid-filter dropdowns are now **cross-reactive**: picking a user reshapes the raid-filter labels to that user's backlog (`Kazeros Hard (3 pending)` = Du's 3 pending, not guild 42), and picking a raid reshapes the user-filter labels to that raid's per-user backlog. `All users` / `All raids` header entries carry the running total for whatever scope the other filter defines. Both dropdowns pull from a single `computePendingAggregate` walker so the counts on screen are always consistent with each other - previously static guild-wide labels were disorienting during drill-down ("Du shows 7 pending but the raid dropdown says 42? Whose 42?"). User-filter labels also changed from `(N accs)` to `(N pending)` so both dropdowns surface pending counts as the unit of interest. Dead `raidAggregate` / `raidDropdownEntries` / `totalRaidPending` init block removed.
- `/raid-status` + `/raid-check raid:all` char cards **hide ineligible chars** when a raid filter is active. Previously a locked `🔒 Not eligible yet` card rendered for every char below the picked raid's iLvl gate, so the eligible chars sat buried in a wall of locks. Now `buildAccountPageEmbed` accepts a `hideIneligibleChars` option; both call sites pass `!!filterRaidId`, and chars whose `getRaidsFor` returns empty drop out of the 2-col layout. When the filter empties a roster entirely, the builder renders a single notice field `🔒 Không có character nào eligible cho raid này trong roster.` - distinguishes "nobody in this roster can do the picked raid" from the empty-account (`_No characters saved._`) and normal populated paths.
- `/raid-check raid:all` manager-roster title drops the leading 🟢/🟡/⚪/🔒 progress icon when the viewed user is a Raid Manager - the 👑 crown already carries stronger visual weight than the 3-state circle and leaving both reads as `orange · crown · name` (double header gate). Crown alone is the signal; per-user done/partial/pending still lives in the footer for leaders who want the progress glance. Scoped to `/raid-check` only, `/raid-status` keeps the title icon so non-manager callers still see account-level status at the top of each page.
- `/raid-status` + `/raid-check raid:all` footer now carries the subject's `X done · Y partial · Z pending` rollup (plus `Page N/M` when paginated), matching `/raid-check` specific-raid parity. Per-account description line `"N chars · X/Y raids done · K in progress"` dropped because its data already lives in the footer counts - description now holds only the optional `🌐 All accounts` cross-account rollup and the freshness/countdown line. Title no longer carries a page suffix in `/raid-status`, and `/raid-check raid:all` setAuthor is down to just display name + avatar. Shared `buildStatusFooterText(globalTotals, pageInfo)` helper wired from `createRaidStatusCommand` through `raid-command.js` into `createRaidCheckCommand`'s deps so both surfaces format counts identically.
- `/raid-check` now annotates mode-hierarchy clears in the char field: a 1740 char who cleared Kazeros Hard renders as "🟢 2/2 _(Hard)_" in a Kazeros Normal scan, while a same-mode Normal clear stays "🟢 2/2" (no annotation). Previously both rendered identically, so leaders couldn't tell whether the done stamp came from the scanned mode or a higher one. Added `doneModeAnnotation` to snapshot char entries with the set of higher-than-scan stored modes.
- Difficulty alias `nm` moved Nightmare → Normal (alongside `nor`). Nightmare keeps `9m` only. Breaking for anyone typing `nm` for Nightmare.
- Manager crown relocated from per-char name prefix to roster header (📁 → 👑) to keep the char line free for the planned class-icon swap.
- `/raid-status` auto-manage piggyback capped at a 2.5s foreground budget; overflow applies in the background.
- `/raid-check` main render now resolves display names via the same cache-first helper as the Edit flow (User-doc `discordDisplayName/globalName/username` before a live fetch). Main view and Edit dropdown stay in sync and skip unnecessary Discord REST round-trips when the doc is warm.
- Edit-apply DM fetch now goes through `discordUserLimiter`, matching the Sync DM path so burst-edit sessions stay under Discord's global rate ceiling.
- Edit flow **character dropdown** now shows per-raid gate rollup next to each char (🟢 DONE · 🟠 X/Y · 🟡 khác mode · ⚪ chưa clear) against the raid the leader is scanning, so picking a target no longer requires clicking into the char first to see if it's already done.
- Edit flow is now **locked to the raid the leader opened `/raid-check` against**. Raid select row removed - `/raid-check raid:serca_hard` + Edit only edits Serca Hard on the target char. The snapshot was already filtered by that raid, so free-picking another raid in the cascade was mostly dead weight (and confusing when it surfaced chars ineligible for the picked alternative). Cross-raid edit is out of scope until an "All raid" /raid-check mode is added, at which point the raid select would sit above the char select so char options can be filtered against the chosen raid.

### Fixed

- `/raid-check` out-grown chars leaked into lower-mode views when they had a done stamp: a 1732 char who cleared Serca Normal earlier in the week (at e.g. 1725, then grew past the 1730 nextMin) continued to appear in /raid-check raid:serca_normal as 2/2 done. High-side `nextMin` range filter previously ran only for `overallStatus === "none"`, bypassing done/partial chars entirely. Now applied unconditionally EXCEPT when the clear came from a higher mode via hierarchy (e.g. 1740 char cleared Kazeros Hard → still shows in kazeros_normal view as done, which is desired - they "satisfied Normal by doing Hard"). Regression test added covering the out-grown-at-exact-mode case.
- `/raid-check raid:all` → Edit progress opened a dead UI: an `opened raid=` console.log dereferenced `raidMeta.raidKey` / `raidMeta.modeKey` unguarded, but scopeAll enters with `raidMeta=null`. The TypeError fired after `editReply` but before `createMessageComponentCollector`, so the raid dropdown rendered with no handler to catch clicks. Log now branches to an "all" sentinel when scopeAll, else formats the specific raid label. Caught by Codex review of commit `e15b275`.
- `/raid-check` Edit Complete / Process / Reset silently no-op'd under the raid-lock flow: `selectedRaid` was initialized to `raidMeta.raidKey` (just the raid portion, e.g. `serca`) while `RAID_REQUIREMENT_MAP` is keyed by the combined `${raidKey}_${modeKey}` form (e.g. `serca_hard`). Every downstream lookup returned `undefined`, the apply call fell through without writing. Edit click now passes the combined key through from the button handler into state.
- `raid-channel-monitor` threw `ReferenceError: normalizeName is not defined` on every `MessageCreate`; bot.js's silent try/catch masked it. Now injected as a dep.
- Edit-flow user dropdown rendered raw Discord snowflake IDs: `resolveDiscordDisplay` returns a string, not `{ displayName }`. Falls back through cached User-doc identity strings first.
- `ensureFreshWeek` no longer wipes gate/task timestamps that land inside the current reset window (preserves current-week clears on stale-cursor users).
- Auto-sync self-heals diacritic-only roster name mismatches (`Lastdance` → `Lastdancë`) via a class/iLvl-gated `foldName` matcher.

## 2026-04-23

### Added

- `/raid-check` Mongo prefilter by raid iLvl floor + stale-account carveout; new indexes on `accounts.characters.itemLevel` and `accounts.lastRefreshedAt`.
- Empty raid-channel messages now post a warning instead of silent-dropping.

### Changed

- Auto-manage sync cooldown raised 5m → 15m to protect `bible.lostark`.
- Scheduler tick logging now distinguishes synced / attempted-only / skipped / failed buckets (no more "synced N" inflation).

### Fixed

- Auto-manage roster fallback no longer re-fetches the same roster per character in one gather pass.

## 2026-04-22

### Added

- `/raid-auto-manage` **Phase 3**: 24h passive auto-sync scheduler (30-min tick, batch of 3 users, killswitch `AUTO_MANAGE_DAILY_DISABLED`).
- Stuck private-log channel nudge (7-day per-user dedup via `User.lastPrivateLogNudgeAt`).
- `/raid-announce` command: list / enable-disable / redirect per-guild announcement types.

### Fixed

- Codex review rounds 21-27: gather/apply key collisions, parallel gather backpressure, cooldown slot leak on save-fail, scheduler fairness (stalled users starving the queue), operator-log outcome honesty.

## 2026-04-21

### Added

- `/raid-auto-manage` **Phase 1 + 2**: `on` / `off` / `sync` / `status` plus `/raid-status` piggyback sync for opted-in users.
- Text-channel monitor expansion: multi-char posts, whisper-ack with 5s TTL, per-user 2s cooldown with spam warning at ≥3 hits/10s.
- Bible private-log detection with an actionable Public Log prompt.

### Fixed

- Codex review rounds 8-20: gate/difficulty edge cases, same-name-char disambiguation across rosters, autocomplete 25-cap overflow, whisper-ack race conditions, misc polish.

## 2026-04-20

### Added

- Initial commit: Discord bot scaffolding, Mongoose schemas, weekly reset (Wed 17:00 VN), core slash commands (`/add-roster`, `/raid-status`, `/raid-set`, `/raid-check`), `/raid-channel` text monitor, `/raid-help` drill-down dropdown.

### Fixed

- Codex review round 1-7: initial hardening pass on command gating, error UX, permission checks.
