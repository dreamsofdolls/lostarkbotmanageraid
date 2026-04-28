# Changelog

Dates use the local calendar of the commit. Structure loosely follows [Keep a Changelog](https://keepachangelog.com/).

This file now favors high-signal, user-visible changes and major backend fixes. Deep implementation notes should live in commit messages or test files instead of bloating the changelog.

## 2026-04-27

### Added
- `/raid-task` side-task tracker is now a full feature set: `add`, `remove`, `clear`, `action:all`, daily/weekly cycle support, and direct toggle from `/raid-status`.
- `/raid-status` Task view now supports bulk toggle by shared task name across a whole roster and shows a placeholder card for future roster-wide shared tasks.
- `/raid-check raid:all` now has a Manager-only Task view button so Managers can inspect a member's side-task progress without leaving the flow.
- `/raid-announce` gained Wednesday maintenance reminders with separate early-warning and countdown variants.
- Welcome pin got a clearer onboarding block for new members.

### Changed
- `/raid-check` is now a single entry point with no `raid` option. Cross-raid overview is the sole landing page; per-raid focus is reached via the inline raid-filter dropdown inside the embed. The legacy per-raid command path (~750 lines of render code + open-time bible piggyback) was deleted alongside its test scaffolding because the inline filter offered the same UX without doubling command surface. Edit/Sync button flows survive untouched - they still call `computeRaidCheckSnapshot(raidMeta)` per-button-click for context.
- Task view (`/raid-status` and `/raid-check`) per-task lines now mirror the Raid view's `[icon] [name] · [info]` format, appending `· daily` / `· weekly` to each task line. Decimal item-level precision is preserved in the char header (no more `1734.17` → `1734` truncation).
- Task view char headers bind the `name · itemLevel` separator with non-breaking spaces (` · `) so Discord can no longer wrap the iLvl onto a second line in narrow inline-field columns. Cleanest fix without padding the embed body or trimming decimals.
- `/raid-check raid:all` Task view now renders class icons in char headers (matching `/raid-status` Task view). The earlier empty-fallback was unintentional inconsistency, not a deliberate Manager-side simplification.
- `CHANGELOG` and help surfaces were rewritten to be more user-first: less internal jargon, more direct usage guidance.
- `/raid-help` was reworked around onboarding and practical command usage instead of Mongo / factory / routing details.
- `/raid-task` merged the old `add` and `add-all` split into one `add action:<single|all>` flow.
- `/raid-task` now requires `roster` across task flows so character autocomplete can scope correctly and avoid the Discord 25-choice cap.
- `/raid-status` pagination session was extended from 3 minutes to 5 minutes for parity with `/raid-check`.
- `/raid-status` and `/raid-check` now render freshness / sync readiness with Discord native relative timestamps instead of static text snapshots.
- `/raid-status` and `/raid-check` share task-card and progress-line helpers, reducing layout drift between the two surfaces.
- `/raid-announce`, `/raid-channel`, `/raid-auto-manage`, `/raid-check`, `/raid-status`, and related command replies were swept onto notice-embed UX instead of plain text.
- `/raid-check raid:all` Task view now shows a short read-only header + auto-reset note so the embed expands to a comfortable width instead of squeezing inline char cards into a narrow column.

### Fixed
- `/raid-help language:en` no longer leaks Vietnamese bullets after the round-31 rewrite.
- Newly added side tasks no longer get reset incorrectly inside the same daily/weekly cycle.
- Task toggle UI no longer silently drops tasks when an account has more than 25 total tasks; filtering is now per character.
- StringSelectMenu task/class icons no longer render as raw emoji markup in dropdown labels.
- Real-time countdown wording no longer produces awkward lines like `Next sync 16 seconds ago`; copy now uses neutral phrasing such as `Sync ready`.
- `/raid-channel` welcome embed no longer trips Discord's 1024-character field cap after adding maintenance copy.
- `/raid-status` and `/raid-check` now surface explicit sync outcomes instead of silently re-rendering after a click.
- `/raid-check` Manager Task view intentionally includes `sideTasks` in projection now that monitoring is a supported capability.
- `/edit-roster` Confirm no longer wipes a kept character's `/raid-task` side-task entries; the shared char-record builder now copies `sideTasks` alongside `tasks`.
- `/edit-roster` no longer silently deletes saved characters beyond the 20-character picker cap on legacy rosters; off-window chars stay untouched and the picker shows a dedicated warning.
- `/raid-status` side-task toggle now binds to the captured roster name instead of the page index, so a concurrent `/remove-roster` mid-session can no longer redirect the toggle into a different roster.
- Welcome pin emoji no longer goes dead after each bot restart; the emoji bootstrap now dedups duplicate-basename asset files (preferring `.png`) instead of alternately deleting + reuploading the same persona's emoji and churning its ID. Removed `assets/artist-icons/{shy.webp,neutral.webp,note.jpg}` that were colliding with their `.png` siblings on `path.parse(filename).name`.

### Security
- Bot refuses to start when `NODE_TLS_REJECT_UNAUTHORIZED=0` is set in the environment. The variable disables Node's HTTPS certificate validation for every outbound call (Discord, MongoDB, lostark.bible) and exposes the deployment to MITM; the startup guard turns it into a deploy-time failure instead of a silent runtime hazard. `.env.example` documents the prohibition.
- `/raid-channel config` and `/raid-announce` now do a runtime `ManageGuild` permission check inside the handler. `setDefaultMemberPermissions(ManageGuild)` on the slash schema is a Discord-side render hint only; if registration ever drifts (e.g. a failed `deploy-commands.js` mid-update), Discord still routes invocations to the handler. The runtime backstop guarantees only members with Manage Server can mutate channel / announcement config.
- `/raid-check raid:all` Mongo projection drops `bibleSerial`, `bibleCid`, and `bibleRid`. They were unused in this surface (only `/raid-auto-manage` consumes them); removing them keeps Manager-side reads minimal under data-minimization principles.

### Refactor
- Extracted `buildAccountTaskFields()` into `src/raid/task-view.js` so `/raid-status` and `/raid-check` share the same task-card renderer and totals math.
- Extracted `pack2Columns()` and `formatProgressTotals()` into `src/raid/shared.js` to keep embed layout and footer icon ordering consistent across views.
- Added regression coverage around task reset seeding, per-character task filtering, shared task rendering, and maintenance reminder copy.

### Tests
- Test suite continued expanding across roster flows, task flows, status/check rendering, help copy, channel welcome embeds, and maintenance reminders.

## 2026-04-25

### Added
- `/raid-status` now surfaces the piggyback bible-sync outcome each time the user opens it.
- `/raid-check` user filters and `/raid-status` raid filters gained support/DPS breakdown hints.
- `data/Class.js` gained `SUPPORT_CLASS_NAMES` and `isSupportClass()`.

### Changed
- Major refactor split `commands/raid-check.js` into focused modules under `commands/raid-check/`.
- `raid-command.js` was split further into raid-domain modules for character, scheduling, and query concerns.
- Source tree cleanup renamed and reorganized database, model, and data directories.

### Fixed
- `/raid-check raid:all` no longer shows conflicting Hard/Nightmare progress cards for the same weekly-locked raid slot.

## 2026-04-24

### Added
- `/raid-check raid:all` overview mode: cross-user, cross-roster synthetic view with Edit support.
- `/raid-status` got a raid filter dropdown scoped to the caller's roster.
- `/raid-check` gained the Manager-only Edit button flow, reusing the core `/raid-set` write path.
- Raid Manager privilege tier was formalized off `RAID_MANAGER_ID`, including crown markers and faster auto-manage cooldown.
- Quiet hours (03:00-08:00 VN) were added for Artist persona messaging.
- `character.publicLogDisabled` schema flag was introduced.
- Freshness countdown lines landed in `/raid-status` and `/raid-check`.

### Changed
- `/raid-check raid:all` filter dropdowns became cross-reactive so user and raid filters reshape each other.
- Filtered views now hide ineligible characters when a raid filter is active.
- Manager crown moved from per-character labeling to the roster header.
- `/raid-status` auto-manage piggyback got a 2.5-second foreground budget with background completion fallback.
- Difficulty shorthand `nm` was remapped from Nightmare to Normal; Nightmare keeps `9m`.

### Fixed
- Over-geared characters no longer leak lower-difficulty completion into filtered views.
- `/raid-check raid:all` Edit no longer crashes on `raidMeta=null`.
- Edit Complete/Process/Reset paths now bind correctly to the combined `${raidKey}_${modeKey}` key.
- `raid-channel-monitor` no longer throws `normalizeName is not defined`.
- Edit-flow user dropdown no longer renders raw Discord IDs.
- `ensureFreshWeek` no longer wipes timestamps inside the current reset window.
- Auto-sync now self-heals diacritic-only roster-name mismatches.

## 2026-04-23

### Added
- `/raid-check` now prefilters Mongo by raid item-level floor and stale-account carve-out.
- New indexes were added for `accounts.characters.itemLevel` and `accounts.lastRefreshedAt`.
- Empty raid-channel messages now produce a warning instead of silently dropping.

### Changed
- Auto-manage sync cooldown increased from 5 minutes to 15 minutes to protect `bible.lostark`.
- Scheduler logging now distinguishes synced, attempted-only, skipped, and failed buckets.

### Fixed
- Auto-manage roster fallback no longer re-fetches the same roster repeatedly in one gather pass.

## 2026-04-22

### Added
- `/raid-auto-manage` Phase 3: 24-hour passive auto-sync scheduler with a 30-minute tick and `AUTO_MANAGE_DAILY_DISABLED` kill switch.
- Stuck private-log channel nudge with 7-day per-user dedup.
- `/raid-announce` base feature: per-guild announcement listing, enable/disable, and redirect support.

### Fixed
- Codex review rounds 21-27 closed issues around gather/apply key collisions, parallel gather backpressure, cooldown slot leaks, scheduler fairness, and operator-log accuracy.

## 2026-04-21

### Added
- `/raid-auto-manage` Phase 1 + 2: `on`, `off`, `sync`, `status`, plus `/raid-status` piggyback sync for opted-in users.
- Text-channel monitor expanded to support multi-character posts, whisper-ack cleanup flow, and per-user cooldown.
- Bible private-log detection now prompts users with actionable guidance.

### Fixed
- Codex review rounds 8-20 closed edge cases around gates, difficulties, same-name characters across rosters, autocomplete overflow, and whisper-ack race conditions.

## 2026-04-20

### Added
- Initial bot release: Discord bot scaffold, Mongoose schemas, weekly reset handling (Wed 17:00 VN), core slash commands (`/add-roster`, `/raid-status`, `/raid-set`, `/raid-check`), raid-channel text monitor, and `/raid-help`.

### Fixed
- Codex review rounds 1-7 closed early issues around command gating, error UX, and permission checks.
