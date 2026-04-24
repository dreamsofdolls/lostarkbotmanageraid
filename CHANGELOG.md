# Changelog

Dates use the local calendar of the commit. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## 2026-04-24

### Added

- `/raid-check raid:all` synthetic overview choice: cross-raid view of every member's roster, mirroring `/raid-status`'s per-account page layout (inline 2-col char fields, account progress rollup, freshness badge) but scoped across every user in the guild instead of just the caller's own. Each page adds a `setAuthor` with display name + "Page X/Y" so leaders can tell users apart while flipping pages.
- Cross-raid **Edit** from all-mode: clicking ✏️ Edit on /raid-check raid:all opens the same Edit UI as specific-raid but with a **raid dropdown** prepended on top. Picking a raid reloads the per-raid snapshot + editable-user list on the fly and resets the user/char picks (a user who was editable for Serca Hard may have no char eligible for Act 4 Normal). Specific-raid Edit flow is unchanged - `state.scopeAll` flag in the shared state machine drives the branch.
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
