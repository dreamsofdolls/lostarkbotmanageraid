# Changelog

Dates use the local calendar of the commit. Format follows [Keep a Changelog](https://keepachangelog.com/).

## 2026-04-26

### Added
- **`/edit-roster <roster>`** - interactive picker that diffs your saved roster against bible. Tick `🆕` chars to add, untick saved chars to remove, Confirm to apply. Preserves raid completion state. Self-only, 5-min session.
- **`/add-roster` interactive picker** - replaces the old auto top-N-by-CP slicing. Default-tick all chars, untick alts, Confirm. 5-min session, auth-gated.
- **`/add-roster target:<user>`** - Raid Manager onboarding option to add a roster on behalf of a lazy member.
- **Class icon system** - 27 class PNGs in `assets/class-icons/` auto-uploaded as Discord application emoji on bot startup. Content-addressed naming (`{name}_{md5short}`); editing a PNG and pushing is the whole deploy flow.
- **Artist persona emoji** (`shy`, `neutral`, `note`) for bot-voice surfaces. Pinned welcome embed uses `shy`.
- **`/raid-status` Sync button** on the pagination row, with cooldown countdown in the label (`Sync (5m)` / `Sync ngay`). In-place embed update on click.
- **`interaction-router.js` `selectRoutes`** prefix-match branch for select menus carrying dynamic customIds (e.g. session IDs).

### Changed
- `MAX_CHARACTERS_PER_ACCOUNT` raised **6 → 25** (Discord StringSelectMenu cap).
- `/add-roster` slash schema: dropped the `total` integer option (picker replaces it).
- Auto-manage sync cooldown tightened: **15m → 10m** (regular), **30s → 15s** (Manager).
- `/raid-check` runs a bible piggyback sync on command-open (budget 2.5s, max 8 users).
- `/raid-check` dropdowns show **DONE** label when 0 pending. Footer freshness line splits to 2 rows.
- `/raid-status` outcome line moved from description top to a final field above the legend; reworded to remove English (`gather` → `đang lấy`, `data tươi` → `data mới`).
- `bot.js` interaction handler extracted to `src/services/interaction-router.js` factory.
- Support emoji **🪄 → 🛡️** for universal coverage (Unicode 7.0 vs spotty 13.0).

### Added (test coverage expanded across all commands — 137 tests total)
- **47 more tests** added on top of the earlier 25, bringing full-suite to **137 / 137 passing**:
  - `test/raid-set.test.js` (13 tests): `applyRaidSetForDiscordId` complete/process/reset paths, alreadyComplete + alreadyReset short-circuits, mode-switch wipe, ineligible iLvl, no-roster, char-not-found, roster-scoped lookup vs first-by-iteration, case-insensitive char match, cumulative process semantics.
  - `test/remove-roster.test.js` (10 tests): `remove_roster` whole-account delete, `remove_char` single-char delete, **seed-reseed when removing the seed char** (skips colliding accountNames), empty-account edge case, validation rejections, and case-insensitive accountName match.
  - `test/raid-help.test.js` (10 tests): overview + dropdown shape, every section key renders without throwing, **Discord 1024-char field-chunking holds across all sections**, required vs optional option markers, no-options notice, dropdown emoji + ≤100-char description.
  - `test/raid-status.test.js` (14 tests): `buildStatusFooterText` math + page-counter visibility, `buildAccountPageEmbed` title-icon flips (done/lock), 'All accounts' rollup shown only when paginating, `hideIneligibleChars` filter notice, Manager 👑 vs regular 📥 header swap.
- **25 earlier tests** (`test/add-roster.test.js` + `test/edit-roster.test.js`): race-safe overlap guard, single-session dup detection, account-match merge, per-char state preservation, multi-seed fallback, zero-overlap reject, saved-first sort against truncation, diff-apply add/remove/keep summary, vanished-account / vanished-user error paths.
- Extracted `buildEditRosterPickerChars` helper in `commands/edit-roster.js` so the saved-first sort + cap truncation contract is unit-testable without driving the full Discord handler.

### Fixed
- **`raid-channel-monitor` stale-welcome pin scan crashed** with `pinned is not iterable` on every guild boot. discord.js v14.18+ replaced the deprecated `fetchPinned()` (returned `Collection<id, Message>`) with `fetchPins()` whose new shape is `{items: MessagePin[], hasMore}` — `items` is a plain array (not a Collection), and each entry wraps the actual Message under `.message`. Iterating the response object directly threw, so the welcome-pin dedup pass silently failed and would have left an old welcome embed pinned alongside a new one. Fix: destructure `items`, iterate plain array, read `pin.message`. Caught from Railway logs (deploy `Apr 26 18:47:14`).
- **`/edit-roster` wiped bible-side identifiers** on Confirm — `buildCharacterRecord` (shared helper) intentionally ships only the minimal char shape (no `bibleSerial` / `bibleCid` / `bibleRid` / `publicLogDisabled`), so every edit silently dropped them. Next `/raid-auto-manage` sync had to re-resolve serials from bible's SSR page (extra HTTP per char) and the bot would re-attempt sync on chars with public log off. Fix: explicitly overlay these fields back onto the rebuilt record. Caught by the new test suite, not Codex.
- **`/add-roster` duplicate-roster split** - one bible roster could be split across two accounts when the seed char wasn't yet saved but its roster was already saved under a different accountName. Fix: post-fetch overlap guard against the full bible char list.
- **`/add-roster` race-safe overlap guard** - two pickers opened concurrently against the same bible roster could still split it on Confirm. Fix: re-run the overlap check inside `saveWithRetry` against the freshly-loaded user doc; throw `RACE_DUP_ROSTER` on collision and steer the user to `/edit-roster`.
- **`/add-roster` Manager target ping** - target user wasn't actually notified because the `<@id>` mention only lived in the embed description; Discord only fires notifications for mentions in the message `content` field. Fix: add an explicit content line with the target mention.
- **`/edit-roster` saved-char drop on > 25 merged** - merging saved + bible could push some saved chars out of the top-25 picker window when bible returned new high-CP chars; Confirm would silently delete them. Fix: sort saved chars first within the picker so they always fit, with an embed warning when bible-only chars get excluded.
- **`/edit-roster` wrong-roster trust** - trusted a single bible seed without overlap check; if the seed char was renamed in-game, bible could return another roster's chars and the picker would merge them in. Fix: multi-seed fetch with zero-overlap reject (mirrors `roster-refresh.js` pattern).
- **Class icon: real Machinist art** (was an Artillerist placeholder).

## 2026-04-25

### Added
- `/raid-status` embed surfaces the bible-piggyback outcome on each open (sync ok / cooldown / timeout / failed) so non-Manager users can tell fresh data from cache.
- `/raid-check` user-filter dropdowns show a per-user support/DPS breakdown (`Du (8 pending · 2🪄 6⚔️)`); `/raid-status` raid-filter dropdown gets the same.
- `data/Class.js`: `SUPPORT_CLASS_NAMES` set + `isSupportClass()` helper.

### Changed
- **Refactor Phase 3**: split `commands/raid-check.js` into 5 focused modules under `commands/raid-check/`: `snapshot.js`, `edit-helpers.js`, `all-mode.js`, `edit-ui.js`, `sync-ui.js`. Net: 2590 → 740 lines (-71%).
- **Refactor Phase 2**: split `raid-command.js` into `raid/character.js`, `raid/raid-check-query.js`, `raid/scheduling.js`. Net: 1568 → 961 lines (-38%).
- **Source-tree cleanup**: `db.js` → `src/db.js`; `src/schema/` → `src/models/` (Mongoose); `src/models/` → `src/data/` (lookup tables); deleted dead `GuildConfig.js`.

### Fixed
- `/raid-check raid:all` no longer shows a pending Nightmare card next to a completed Hard card on the same Serca character. Lost Ark shares the weekly slot across difficulties of one raid — clearing any mode locks all others.

## 2026-04-24

### Added
- **`/raid-check raid:all`** synthetic overview: cross-raid view of every member's roster, mirroring `/raid-status`'s per-account page layout. Includes cross-raid Edit (raid dropdown prepended), user-filter dropdown, raid-filter dropdown, and Edit-button user context.
- **`/raid-status` raid-filter dropdown** scoped to the caller's roster.
- **`/raid-check` Edit button** (Manager-only): cascading user → char → status → optional gate select, reuses `applyRaidSetForDiscordId`. Auto-sync users skipped except for `publicLogDisabled=true` chars.
- **Raid Manager privilege tier** off existing `RAID_MANAGER_ID`: 30s auto-manage cooldown (vs 15m), 👑 header icon on rosters.
- **Artist quiet hours 03:00-08:00 VN**: bedtime + wake-up embeds; message parsing stays active 24/7.
- `character.publicLogDisabled` schema flag.
- Freshness countdown on `/raid-status` + `/raid-check` (`⏳ Next refresh in Xm` / `✅ Sync ready`).

### Changed
- `/raid-check raid:all` filter dropdowns are **cross-reactive**: picking a user reshapes raid-filter labels to that user's backlog and vice versa, with a single `computePendingAggregate` walker.
- `/raid-status` + `/raid-check raid:all` char cards **hide ineligible chars** when a raid filter is active.
- Manager crown moved from per-char prefix to roster header (📁 → 👑) to make room for the planned class-icon swap.
- `/raid-status` auto-manage piggyback capped at a 2.5s foreground budget; overflow applies in background.
- Edit flow locked to the raid the leader opened `/raid-check` against (raid select removed; cross-raid edit lives in raid:all mode).
- Difficulty alias `nm` moved Nightmare → Normal. Nightmare keeps `9m` only. **Breaking** for anyone typing `nm` for Nightmare.

### Fixed
- `/raid-check` out-grown chars (e.g. 1732 char who cleared Serca Normal at 1725) no longer leak into lower-mode views as done.
- `/raid-check raid:all` Edit no longer dies on `raidMeta=null` (caught by Codex review of `e15b275`).
- `/raid-check` Edit Complete/Process/Reset no-op'd because `selectedRaid` was the raid portion only, not the combined `${raidKey}_${modeKey}` key.
- `raid-channel-monitor` `ReferenceError: normalizeName is not defined` on every MessageCreate (was masked by silent try/catch).
- Edit-flow user dropdown rendered raw Discord snowflake IDs (`resolveDiscordDisplay` returns a string, not an object).
- `ensureFreshWeek` no longer wipes gate/task timestamps inside the current reset window.
- Auto-sync self-heals diacritic-only roster name mismatches (`Lastdance` → `Lastdancë`).

## 2026-04-23

### Added
- `/raid-check` Mongo prefilter by raid iLvl floor + stale-account carve-out; new indexes on `accounts.characters.itemLevel` and `accounts.lastRefreshedAt`.
- Empty raid-channel messages now post a warning instead of silent-dropping.

### Changed
- Auto-manage sync cooldown raised **5m → 15m** to protect `bible.lostark`.
- Scheduler tick logging distinguishes synced / attempted-only / skipped / failed buckets.

### Fixed
- Auto-manage roster fallback no longer re-fetches the same roster per character in one gather pass.

## 2026-04-22

### Added
- **`/raid-auto-manage` Phase 3**: 24h passive auto-sync scheduler (30-min tick, batch of 3 users, killswitch `AUTO_MANAGE_DAILY_DISABLED`).
- Stuck private-log channel nudge (7-day per-user dedup).
- **`/raid-announce`**: list / enable-disable / redirect per-guild announcement types.

### Fixed
- Codex review rounds 21-27: gather/apply key collisions, parallel gather backpressure, cooldown slot leak on save-fail, scheduler fairness, operator-log outcome honesty.

## 2026-04-21

### Added
- **`/raid-auto-manage` Phase 1 + 2**: `on` / `off` / `sync` / `status`; `/raid-status` piggyback sync for opted-in users.
- Text-channel monitor expansion: multi-char posts, whisper-ack with 5s TTL, per-user 2s cooldown with spam warning.
- Bible private-log detection with an actionable Public Log prompt.

### Fixed
- Codex review rounds 8-20: gate/difficulty edge cases, same-name-char disambiguation across rosters, autocomplete 25-cap overflow, whisper-ack race conditions.

## 2026-04-20

### Added
- Initial commit: bot scaffolding, Mongoose schemas, weekly reset (Wed 17:00 VN), core slash commands (`/add-roster`, `/raid-status`, `/raid-set`, `/raid-check`), `/raid-channel` text monitor, `/raid-help` drill-down dropdown.

### Fixed
- Codex review rounds 1-7: command gating, error UX, permission checks.
