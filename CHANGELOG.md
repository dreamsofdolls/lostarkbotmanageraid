# Changelog

Dates use the local calendar of the commit. Format follows [Keep a Changelog](https://keepachangelog.com/).

## 2026-04-27

### Added (`/raid-announce` maintenance reminders: nhắc trước bảo trì Wed 14:00 VN)
- **2 announcement types mới**: `maintenance-early` (3 mốc T-3h / T-2h / T-1h, ping `@here` ở T-3h và T-1h) + `maintenance-countdown` (4 mốc T-15m / T-10m / T-5m / T-1m, không ping). Cả 2 channel-overridable, default ON, bật/tắt độc lập qua `/raid-announce action:on|off`.
- **21 variants Artist voice** (3 variants/mốc) random pick mỗi lần fire. Early reminders liệt kê checklist (`shop solo` / `event` / `paradise` / `key hell`), countdown đếm ngược dồn dập, T-1m chốt "thoát game thôi". Vietnamese-first, term game LA giữ.
- **`startMaintenanceScheduler` 1-min tick** trong `src/services/raid-schedulers.js`. In-flight guard + atomic CAS dedup claim (parity với `startAutoManageDailyScheduler`). Eligibility filter `$or` 3 channel paths nên guild đã set override qua `/raid-announce action:set-channel` mà chưa setup monitor channel vẫn fire đúng. Non-Wed ticks early-exit trước Mongo query.
- **Live preview** qua `/raid-announce type:maintenance-... action:show` - admin thấy đủ 21 variants + lịch fire kế tiếp trước khi enable, parity với `hourly-cleanup` pool preview.

### Changed (`/raid-help` + welcome pin reflect 9 announcement types)
- HELP section `/raid-announce`: 7 → 9 types (4 channel-overridable, 5 channel-bound). Thêm bullet maintenance schedule + TTL + ping policy. Welcome pin embed của `/raid-channel` cũng có dòng mới mô tả nhịp nhắc bảo trì.

### Changed (`/raid-announce` replies thành notice embed Artist voice)
- 12 plain-text replies trong `/raid-announce` (action validation, toggle on/off, set-channel, clear-channel) chuyển sang `buildNoticeEmbed` với type-coded color (success/info/warn/lock) + title + description Artist voice. Parity với `/add-roster`, `/edit-roster`, `/raid-set`, `/remove-roster`. Dead fallthrough branch cuối handler bị xóa (action validation đầu handler đã reject hết).
- 3 success replies (toggle on/off, set-channel, clear-channel) thêm **bold key: value** layout (`Loại` / `Trạng thái mới` hoặc `Channel mới` / `Tác động`) trong description, parity style với `/raid-set` Reset embed, scan-friendly hơn prose blob single line.

### Changed (sweep còn lại: convert mọi plain `interaction.reply({content})` sang notice embed)
- 32 plain-text replies trong `/raid-channel` (11), `/raid-auto-manage` (10), `/raid-check` (5 + button + sync stats), `/raid-check raid:all` (3), `/raid-check Edit` (2), `/raid-status` (5) chuyển sang `buildNoticeEmbed` với type-coded color + title + Artist-voice description. Sync result của `/raid-check Sync` đặc biệt: dùng structured **bold key: value** layout (Synced / Attempted-only / Skipped / Failed / Chars có update / DM sent) parity với `/raid-set` style.
- Latent runtime bug fix: `raid-check/all-mode.js` dùng `UI.icons.lock`/`UI.icons.info` mà `UI` không có trong factory deps. Path không reachable thường (rare admin reject) nên chưa bao giờ crash. Fix: thêm `EmbedBuilder` vào deps + import `buildNoticeEmbed` ở module top, refactor 3 reject paths sang notice embed.

### Added (`/raid-check` + `/raid-status` roster header: badge `📝 Auto-sync OFF` cho user chưa opt-in)
- Header section của mỗi roster trong `/raid-check` (raid filter), `/raid-check raid:all`, và `/raid-status` thêm suffix `· 📝 Auto-sync OFF` khi `userMeta.autoManageEnabled === false`. Silent khi opted-in (freshness line dưới đã có "Last synced X ago"). Manager scan list pending phân biệt ngay 3 state: opt-in + đã sync (timestamp), opt-in + chưa sync ("Never synced"), chưa opt-in (badge OFF). Trước đó case 3 silent giống case 2 nên ambiguity. Dùng strict `=== false` trong shared builder để legacy doc thiếu flag không false-positive.

### Changed (`/raid-check` button row: conditional Sync + Edit theo filter state)
- Sync và Edit buttons giờ chỉ render trong view "All users" (filter mặc định). Khi user filter narrow xuống 1 user cụ thể, cả 2 button bị remove khỏi row, chỉ giữ pagination. Lý do: cả 2 action thuộc bulk scope (Sync sync mọi opted-in user, Edit cascade pick user/char bất kỳ) - mâu thuẫn với intent "tôi đang focus 1 user" của filter.
- Sync button thêm điều kiện `optedInPendingCount > 0` mới render, parity với `/raid-status` (Sync ẩn hoàn toàn khi owner chưa opt-in). Trước đó button hiện nhưng disabled với label `"Sync (no opted-in users)"` đọc như visual noise; giờ ẩn luôn, manager fall back sang Edit cascade nếu cần update progress thủ công.

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

### Added (`/add-roster target:` flow now DMs the target user with full details)
- When a Raid Manager adds a roster on behalf of someone (`target:` option), Artist now sends the target user a private DM with the saved-embed + a friendly Manager-attribution intro + next-step hints (`/raid-status`, `/edit-roster`, `/raid-help`). Channel embed stays intact as audit proof + fallback when DMs are blocked.
- DM delivery status surfaces in the channel embed itself: "📩 Artist đã DM riêng cho <@target>" on success, "⚠️ Không DM được... Channel ping ở trên là backup" when target has DMs disabled (Discord 50007), or a generic "DM fail" line for other API errors. Manager sees at a glance whether their target got a private notice.

### Added (pinned welcome embed: "Member mới? Bắt đầu ở đây" onboarding field)
- Pinned welcome embed in `raid-channel-monitor.js` gets a new first field laying out the 3-step roster onboarding path: `/add-roster` (initial picker), `/edit-roster` (manage saved chars), `/raid-status` + `/raid-help` (view + docs). Newcomer scanning the pin top-down now sees the workflow before the post-format docs. Description trimmed to remove the now-duplicate `/add-roster` mention.
- Existing guilds need `/raid-channel config action:rebuild` to swap the old pinned welcome for the new shape; new channels post the updated embed automatically.

### Changed (5 success embeds: drop cold field tables, add Artist voice descriptions)
- **`/raid-set` Raid Reset / Raid Completed / Gate Completed** result embed: was just title + 3 inline fields (Character / Raid / Gates) reading like a database log row. Now title + Artist-voice description with statusType-specific phrasing — "Raid done luôn nha~ Artist mark cả X done cho Y rồi", "Gate clear xong nha~ ... còn gate khác cứ post tiếp", "Đã reset sạch... cậu có thể đánh dấu lại từ đầu khi clear xong". Mode-switch footer also rewritten to VN ("Mode đổi sang ... tiến độ mode cũ bị xoá").
- **`/raid-set` alreadyComplete / alreadyReset** notices: kept the Artist-voice description (already friendly), dropped the redundant cold field table that repeated the same Character / Raid / Gate facts. Single voice surface, no tabular duplicate.
- **`/remove-roster` Roster Removed / Character Removed** notices: were title + cold field table with no description. Now title + Artist-voice description that states what happened + a recovery hint ("Muốn add lại thì chạy `/add-roster`...", "Roster giờ trống — `/remove-roster` để xoá hẳn account, hoặc `/edit-roster` để add lại"). Reseed footer translated to VN.
- One test in `remove-roster.test.js` updated: `replyArg.embeds[0].fields[].value` → `embeds[0].description` since the field table moved into the description sentence.

### Changed (notice embeds + Artist voice across user-facing rejections)
- All warning / info / lock / error rejection paths in `/add-roster`, `/edit-roster`, `/raid-set`, `/remove-roster` swapped from plain `interaction.reply({ content: "⚠️ ..." })` to color-coded notice embeds with title + description in Artist persona voice. Prior plain-text replies blended into channel chrome and read flat; the new format gives each rejection a clear visual identity (yellow=warn, blue=info, red=lock/error, gray=expired) and Artist's friendly first-person framing ("Artist không tìm thấy...", "Cậu chưa toggle char nào...", "Toggle off bớt vài char rồi Confirm lại nhé~").
- New `buildNoticeEmbed(EmbedBuilder, { type, title, description })` helper in `src/raid/shared.js` so future call sites land on a consistent notice shape (color + icon + title + description) instead of recreating the embed scaffolding inline.
- Error embeds (persist failures) now ping the **primary Raid Manager** by `<@id>` mention instead of saying "ping admin" generically. Resolved at factory boot time via new `getPrimaryManagerId()` helper in `services/manager.js` (returns first entry of `RAID_MANAGER_ID` env, falls back to plain "admin" text when no manager configured).

### Changed (picker color scheme — distinguish action row from toggle row)
- `/add-roster` + `/edit-roster` Confirm button: `Success (green)` → `Primary (blue)`. Cancel button: `Secondary (gray)` → `Danger (red)`. Per-char toggle buttons keep their `Success/Secondary` palette. Without this split the Confirm button was visually identical to a selected char toggle and Cancel identical to an unselected one — the action row blended into the toggle grid. Now the action row is the only blue/red pair on the message, scannable at a glance.

### Added
- **`/raid-help language:`** option (`Tiếng Việt` / `English`, default `vi`). Each embed now renders ONE language only instead of stacking EN + VN side-by-side. Notes pre-tagged with `EN: ` or `VN: ` filter to the chosen language; un-tagged technical bullets (cap, code refs, etc.) survive both. Lang baked into the dropdown customId so detail-embed selections after the slash command keep the chosen language. Test coverage: 8 new tests covering language selection, prefix-strip filtering, and the per-language "No options" / "Không có options" labels.

### Changed
- **`/add-roster` + `/edit-roster` picker UI** swapped from `StringSelectMenu` to per-char toggle buttons. The dropdown was visually noisy when default-selected (each char appearing as a wrapping pill chip in the open-state) and duplicated the embed's `✅`/`⬜` markers. Toggle buttons keep selection state in one place (button label + green/gray style), 1 click per char to flip, no menu open required. Layout: 4 rows of up to 5 char buttons + 1 row of Confirm/Cancel (Discord 5-row hard cap).
- `MAX_CHARACTERS_PER_ACCOUNT` lowered **25 → 20** to match the new picker capacity (Discord 5-row component limit). LA in-game roster max is ~18 chars so still has headroom.
- **`/edit-roster` is now ephemeral** (caller-only visibility). The picker, diff outcome, bible-error states, and final saved-embed all stay private to the caller — no channel noise, no leaking roster composition to bystanders. Component interactions still work identically on ephemeral messages so the 5-min session contract is unchanged. `/add-roster` stays public on purpose so members can see new rosters being onboarded.

### Fixed
- **`/raid-set` status autocomplete returned empty for DONE raids when user had typed needle text**. The DONE-raid path collapses choices to a single "Reset" option, but the helper then ran `applyFilter(choices)` against whatever the user typed in the status field. If they had typed "complete" or "process" against a different raid before switching to a DONE one, "Reset" wouldn't match the needle → autocomplete returned `[]` → Discord rendered an empty/loading dropdown the user couldn't escape. Fix: when the raid is fully complete, surface the Reset choice unconditionally (skip the needle filter) since it's the only valid action.
- **whisper-ack copy was misleading about DM timing**. Old text "Chờ Artist 5 giây gửi kết quả qua DM cho cậu nhé..." read as if the DM was still pending — the DM has actually been sent BEFORE the whisper hits the channel; the 5-second delay is purely the cleanup window so the user has time to see the ack before both messages vanish. Reworded to "Artist DM kết quả cho cậu rồi nha~ Channel sẽ tự dọn cả 2 tin nhắn sau 5 giây..." (past-tense DM, explicit cleanup framing). Synced `raid/announcements.js` previewContent so `/raid-announce type:whisper-ack action:show` reflects the new copy.
- **`raid-channel-monitor` double-replied to a single raid clear post**. Defense-in-depth: added per-process message-id dedup Set with 60s TTL inside `handleRaidChannelMessage` — second handler call for the same `message.id` short-circuits before any side effects (channel.send, DM, delete, persistent hint write). Catches Discord gateway anomalies + future internal listener-double-registration bugs. Does NOT defend against dual-instance Railway deploys (each container has its own Set); that case needs an ops fix (single-replica + stop-old-before-start-new strategy) — `console.warn` on dedup hit so the issue is observable in logs either way.
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
