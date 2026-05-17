# Changelog

Dates use the local calendar of the commit. Structure loosely follows [Keep a Changelog](https://keepachangelog.com/).

This file now favors high-signal, user-visible changes and major backend fixes. Deep implementation notes should live in commit messages or test files instead of bloating the changelog.

## 2026-05-17 (Raid status canvas card · /raid-bg)

### Added
- **`/raid-bg` command (set / view / remove)** lets each user upload a personal background pool that becomes the full-bleed art behind their `/raid-status` raid card. `set image:<file> [image_2] [image_3] [image_4] [mode]` accepts up to the user's current visible roster count, capped at 4 images. Each upload can be up to 8 MB at any dimension ≥ 800x600 in PNG / JPG / WEBP. The bot downscales (cap 1920 long-axis) + JPEG-encodes with a quality stepdown ladder (85 → 75 → 65, last-resort 70 %-scale + q60) so each stored image stays under 2 MB regardless of source. `mode:even` round-robins images across rosters; `mode:random` shuffles that roster map when saving.
- **Canvas-rendered raid card on `/raid-status`** for users who have uploaded a background. 1200x720 PNG attachment with the user's image cover-fit behind semi-transparent rgba dark 82% overlay panels (Arknights Endfield "profile card" aesthetic). Header carries the raid headline + roster name + cleared/total badge, per-character rows show class icon (from `assets/class-icons/<classId>.png`) + name + ilvl + per-raid completion dots + right-side progress bar. The existing text embed still renders below the canvas with all the multi-raid detail / side tasks / gold rollup intact · canvas is the visual splash above, embed is the read-the-data view below. Per-invocation cache keyed by page index keeps pagination clicks instant after the first visit.
- New `userbackgrounds` Mongo collection (`bot/models/userBackground.js`) holds resized JPEG bytes as BSON Binary, indexed by `discordId`, plus roster→image assignments. Lives separately from the `users` collection so the multi-MB Binary payload never bloats the User doc that every other command reads. In-memory LRU cache (`bot/services/raid-card/bg-loader.js`, 40-entry cap) absorbs repeat-render hits during pagination + filter clicks without re-fetching from Mongo every time.
- New dependency: `@napi-rs/canvas` (pure-Node native binary, no cairo system libs · deploys clean on Railway). Used for the raid-card render AND the upload-side resize pipeline.

### Behavior
- Opt-in feature with zero admin setup. Users who haven't run `/raid-bg set` see no change to `/raid-status` whatsoever · existing text embed, existing components, existing pagination. Canvas rendering only activates after a user uploads a background.
- Shared roster views resolve the background by viewer, not roster owner, so a grantee sees their own `/raid-bg` pool on both personal and shared roster pages.
- No rehost channel, no env var, no `/raid-channel config action:set-bg-channel` step · the bot is the storage backend end-to-end. Upload-and-go.
- Canvas render failures (decode error, missing class icon) fall through silently to embed-only · `/raid-status` never goes down because of a transient render hiccup.
- i18n covered across vi (default) + jp + en, all in Artist voice. `/raid-help` gets a `/raid-bg` section in each locale.

## 2026-05-14 (Cumulative gate sync)

### Fixed
- Auto-manage bible sync now applies cumulative gate completion: if a later gate such as Act 4 G2 is logged but the earlier gate log is missing/corrupt, the earlier gate is filled as completed too. Added a local-sync batch regression to keep the same G2-implies-G1 behavior locked.

## 2026-05-10 (Preview stats redesign: raid-count math + per-char rows + auth pill)

### Changed
- **Completion math switched from gates to raids** to match `summarizeRaidProgress` in `bot/utils/raid/character.js` (used by `/raid-status`). A raid counts as "cleared" when all its gates have `completedDate > 0`. Field rename in response: `completion.totalGates → totalRaids`. Locale strings updated to display "X/Y raid (50%)" instead of "X/Y (50%)".
- **Pending list redesigned as per-char rows** (was per (char, raid) flat list). Each row shows `<strong>{charName}</strong> {ilvl}` on the left + raid status pills on the right (one per configured raid: 🟢 done / 🟡 partial / ⚪ pending, with mode label). Field rename: `pendingPostSync → charsAfterSync`. Done chars skip the list so it stays focused on remaining work.
- **Auth status redesigned as two pills** - profile pill (status dot + avatar + "Linked as" + name) + timer pill (clock + countdown). Status dot replaces the all-text green from v1 so the user's name reads first. Timer pill flips to amber when remaining < 60s (post-sync shrink visual cue). Avatar placeholder (initial-letter) when token has username but no avatar URL.
- 3 new preview-summary tests cover: gate-difficulty resolver, cross-mode delta projection, fully-cleared raid stays out of charsAfterSync.

## 2026-05-10 (Preview stats panel + token TTL 30→15 min)

### Added
- **Pre-sync stats panel** under the week range subline: gold delta, last sync (relative time + mode label), week completion projection (X/Y → Z%), and pending-gates collapsible. New `POST /api/local-sync/preview-summary` endpoint accepts the same `{ deltas }` payload as `/api/raid-sync` and returns the four projections; server is single source of truth for gold rates (reuses `getGoldForGate` from `bot/models/Raid.js`).
- `bot/services/local-sync/preview-summary-endpoint.js` (new): bucketize deltas → walk roster → compute per-char gold (gated on `isGoldEarner`) + total gates / cleared / projected per char's currently-configured raids (where `assignedRaids[raidKey].difficulty` is set) + pending list. Auth chain mirrors sync-endpoint (Bearer JWT, `isCurrentStoredToken`).
- Web `fetchPreviewSummary(deltas)` fires after `lastDeltas` settles (post-render so the diff cards land first); `renderPreviewStats` writes the panel HTML. Failure silent - panel just stays hidden.
- 17 new locale keys (vi/jp/en) for stats labels + relative-time variants (s/min/h/d).

### Changed
- **Token TTL 30 min → 15 min** (`DEFAULT_TTL_SEC` in `bot/services/local-sync/tokens.js`). Tighter anti-replay window without rushing the user. Locale strings (3 langs) + 5 code-comment references updated to match.

## 2026-05-10 (Privacy: hide Discord ID, JP "Web Companion" full localize)

### Changed
- **Auth chip swaps Discord snowflake for avatar + display name.** `mintToken` now accepts an optional `profile` (`{ username, avatarUrl }`) baked into the JWT payload. `extractProfileFromUser(user)` reads `globalName` (preferred) → `username` and `displayAvatarURL({size:64, extension:"webp"})` from a discord.js User object. `discordId` stays in the payload for backend auth but is NEVER rendered to the DOM.
- 3 callers updated: `raid-auto-manage` local-on, `raid-status` resume + new-link buttons, `stuck-nudge-button` switch-to-local. Each passes `extractProfileFromUser(interaction.user)` (or `component.user` / `interaction.user` for click handlers) into the token mint so the right person's profile lands in the URL.
- Web `renderAuthStatus()` renders `<img class="auth-avatar" src="..."> Linked as <strong>{name}</strong> · token valid for ~N min`. Anonymous fallback ("Linked") for stale pre-profile tokens still on disk.
- Locale keys `identity.linked` reworded (drop "Discord user"), new `identity.linkedAnonymous` for the no-profile fallback. vi/jp/en synced.
- **JP "Web Companion" → "ウェブコンパニオン"** across all bot-side locale strings (button labels, DM descriptions, success embeds, help notes, welcome embed, `localOnLabel`). Particle spacing fixed (`を/が/で/サイト` attach without space).
- 391/391 tests pass.

## 2026-05-10 (Web companion week range, token shrink-on-sync, doc sync)

### Added
- **Week range subline** under the preview h2: shows `DD/MM → DD/MM` of the current LA raid cycle (Wed 10:00 UTC anchor). `getCurrentRaidWeek()` returns inclusive Wed→Tue range, formatted via `Intl.DateTimeFormat` so each locale renders its own date convention. Reset moment is locale-natural (VI "Thứ Tư 17h giờ VN", JP "毎週水曜 19時 日本時間", EN "Wed 10:00 UTC").
- **Real-time token countdown** in auth status (1Hz `setInterval`). Refactored auth render into `authState` + `renderAuthStatus()`; flips from "~N min" to "~N sec" under 60s so the post-sync shrink shows a live ticker.
- **Token TTL shrink on successful sync.** `bot/services/local-sync/sync-endpoint.js` sets `lastLocalSyncTokenExpAt = now+60s` when `applied.length > 0` and returns `newExpSec` in the response. Web mirrors it into `authState.expSec` so the countdown jumps immediately. Nothing-to-sync (all skipped/rejected) does NOT shrink so users can retry with a different file.

### Changed
- **Tightened `.char-raid-row` whitespace** (gap 10→6, modes 16→10, mode-block 6→4, raid-name 70→60px, mode-label 80→64px) - frees ~38px horizontally so future G3 raids fit without truncating gate badges. Mode labels keep full content (Normal/Hard/Nightmare) - this is a pure CSS tightening, no abbreviation.
- **JP "Web companion" → "ウェブコンパニオン"** in subtitle. VI/EN keep the English term (LA community familiarity).

### Docs (raid-help + welcome embed + README synced for prior local-sync + reset features)
- `bot/handlers/raid-help.js` SECTION_META: added `action:local-on`, `action:local-off`, `action:reset` to the raid-auto-manage option list. vi/jp/en got 3 new `optionDescriptions` + notes rewritten (8 → 11 bullets) covering bible vs local-sync mutex, reset 2-step confirm, token shrink-on-success.
- Welcome embed `autoManageValue` (vi/jp/en): 2 lines → 3 lines splitting bible (Public Log) vs local-sync (private + manual file drop) and mentioning `action:reset` for clean re-sync.
- README.md Features bullet + commands table row reflect the 7-action surface (on/off/sync/status/local-on/local-off/reset) with mutex + reset confirm callouts.
- 391/391 tests pass.

## 2026-05-10 (Web companion i18n - vi/jp/en across all surfaces)

### Added (web companion respects user's /raid-language preference)
- **Why:** every Discord-side surface renders in the viewer's lang per the `feedback_i18n_viewer_language` rule, but the web companion was hardcoded EN. JP/VN users opening the link saw English headers/buttons/messages even though they'd set Artist to their native lang.
- `bot/services/local-sync/tokens.js` `mintToken(discordId, ttlSec, lang?)` now optionally encodes `lang` in the JWT payload. Web reads it on page load and applies via `setActiveLang` before rendering. Token TTL = 30 min so language stays fresh per session.
- `bot/handlers/raid-auto-manage.js` `local-on` success embed + `bot/handlers/raid-status.js` Sync button + `bot/handlers/stuck-nudge-button.js` DM link all pass user's resolved lang into `mintToken`. Stuck-nudge uses clicker's lang (clicker === target by that point per the auth check).
- `web/locales.js` (new) - vi/jp/en string dicts (~50 keys × 3 langs). Same nested-object shape as bot-side locales.
- `web/i18n.js` (new) - `t(key, vars)`, `setActiveLang/getActiveLang`, `getRaidLabel/getModeLabel`, `applyDomTranslations()` to walk `data-i18n` attributes at boot. Missing keys console-warn once and surface the raw key (no silent empty strings).
- `web/index.html` static text wrapped in `data-i18n` attributes; JS swaps at boot before painting.
- `web/app.js` rewritten - every inline English string moved to `t()` calls. Token decode now feeds `setActiveLang` first thing so the auth-status message renders in the right lang. Raid + mode labels in the per-raid tables resolve via `getRaidLabel(raidKey)` / `getModeLabel(modeKey)` so JP user sees "アクト4 ハード", VN user sees "Act 4 Hard" (gamer loanwords), EN user sees "Act 4 Hard".
- Boss names stay English across all locales (LOA Logs writes them verbatim to encounters.db; not translating proper nouns the game itself doesn't translate).
- Schema debug line stays English (dev-facing, not user-facing).
- Smoke-tested all 6 web modules serve via the HTTP server: index.html, app.js, i18n.js, locales.js, preview-utils.js, file-vfs.js. Locale lookup verified across vi/jp/en for 9 representative keys.
- 375/375 tests pass (no test changes; this is web-only + token-payload extension).

## 2026-05-10 (Web companion preview redesign - per-raid tables)

### Changed (web companion preview groups by raid+mode instead of flat row list)
- **Why:** flat preview table showed each (char, boss, difficulty) row separately - 60+ rows for a roster with ~9 chars and 3 active raids was hard to scan. User couldn't tell at a glance which raid each char actually cleared because raw boss names ("Archdemon Kazeros", "Brelshaza, Ember in the Ashes") don't match the bot's raid card vocabulary.
- New `web/preview-utils.js` mirrors the bot-side boss->raid mapping + bucketize logic (`BOSS_TO_RAID_GATE`, `bucketize`, `groupByRaid`, `findUnmappedBosses`). Stays in sync with `bot/models/Raid.js` + `bot/services/local-sync/apply.js`.
- `web/app.js` `runPreviewQuery` now renders **one table per (raid, mode)** with the raid card mental model: heading shows raid label + mode + char count, table shows char + cumulative gates ("G1+G2") + latest clear timestamp. Matches what `/raid-status` will show after sync, no shape drift.
- Failed encounters (cleared=0) and unmapped bosses (Guardian / Chaos / non-Legion content) move to `<details>` collapsibles at the bottom, hidden by default. Main preview stays focused on "what will sync".
- New CSS classes `.raid-group` + `.footer-details` for the per-raid card + collapsible footer.
- Server-side sync stays authoritative - web preview can be wrong without causing data corruption (server re-maps + filters), but visually they match.
- Smoke-tested with screenshot data: 9 chars + 3 raids collapse from 60+ flat rows to 3 raid tables (Kazeros Normal, Act 4 Hard, Kazeros Hard).
- 372/372 tests pass.

## 2026-05-10 (Phase 6 - stuck-nudge "Switch to Local Sync")

### Added (local-sync rollout COMPLETE - Phase 6 of 6)
- Stuck-private-log nudge embed now ships with a **"🌐 Switch to Local Sync"** button. Auto-manage daily scheduler keeps posting the nudge when bible detects every char as private; clicking the button atomically flips the user's mode (bible OFF + local ON via `setLocalSyncEnabled(force:true)`) and DMs them a personalized companion link.
- `bot/handlers/stuck-nudge-button.js` (new) - click handler. customId `stuck-nudge:switch-to-local:<targetDiscordId>`, verifies clicker.id === target before flipping (random members can't opt someone else into local). Updates the channel embed in-place to "Switched" state + removes the button so subsequent viewers don't see a stale CTA.
- `bot/services/raid-schedulers.js` `postChannelAnnouncement` extended with optional `components` arg (back-compat: existing callers pass nothing). `nudgeStuckPrivateLogUser` now attaches the button row.
- `bot.js` interaction router gets `{ prefix: "stuck-nudge:", handle: handleStuckNudgeButton }`.
- `bot/commands.js` instantiates `createStuckNudgeButtonHandler` + exports the handler.
- 12 new locale keys (vi/jp/en): `announcements.stuck-nudge.{body,switchButtonLabel}` updated copy mentioning the new option, plus a top-level `stuck-nudge.*` namespace for the click handler embeds (notForYou, flipFail, switched, DM).
- 370/370 tests pass.

### Local-sync rollout summary
All 6 phases shipped (5711423, 6f54178, 5355dce, 4e6a642, 9d6f78d, 946f0ca, plus this commit). Users now have a complete browser-companion sync path that bypasses the public-log requirement entirely. Mutex enforced at 3 layers (Mongo write, handler pre-check, CAS filter). Streaming SQLite handles multi-GB encounters.db files. UI surfaces (/raid-status Sync button, /raid-check Manager view, stuck-nudge embed) all adapt to the active sync mode.

## 2026-05-10 (Phase 5 - UI button-flip)

### Changed (/raid-status + /raid-check adapt to local-sync mode)
- `/raid-status` Sync button now swaps based on user's sync mode:
  - **bible mode** (existing): Primary button "Sync ngay" / "Sync (Xm)" with cooldown countdown, customId `status:sync`.
  - **local mode** (new): Link button "🌐 Open Web Companion" pointing at `${PUBLIC_BASE_URL}/sync?token=<jwt>` (token freshly minted at render). Click opens browser; web companion auto-loads with the user's identity.
  - **off**: button hidden (existing behavior).
  - Mutex enforcement: `showSync = autoManageEnabled || localSyncEnabled` so either mode shows a button. Both-on never happens (Phase 1 mutex), but local takes precedence in `buildSyncButton` if it ever did.
- `bot/handlers/raid-status/sync.js` `buildStatusUserMeta` now exposes `localSyncEnabled` + `lastLocalSyncAt` so the view layer can branch without re-fetching.
- `/raid-check` Manager view (`raid-check/all-mode.js`):
  - "Bật auto-sync hộ" button **hidden** when target user has `localSyncEnabled: true`. Manager cannot bind a browser FSA permission for someone else; surfacing the button would be a no-op at best, mutex violation at worst.
  - "Tắt auto-sync hộ" also hidden in local mode (Manager isn't who flipped the local flag, shouldn't be the one flipping it back either).
  - Edit Progress + view-toggle buttons stay (Manager spot-check still works).
- `tryEnableAutoManage` server-side mutex: filter now requires `localSyncEnabled !== true`. Race condition safe - if a user opts into local between embed render and Manager click, the CAS misses and a new "local-locked" outcome surfaces a clear notice instead of silently writing.
- 6 new locale keys (vi/jp/en): `raid-status.sync.localOpenButtonLabel`, `raid-auto-manage.enableButton.localLocked{Title,Description}`, `raid-auto-manage.enableSelf.localLocked{Title,Description}`.
- 370/370 tests pass.

## 2026-05-10 (Phase 4.5 - streaming SQLite)

### Changed (web companion swaps sql.js -> wa-sqlite for multi-GB file support)
- **Why:** Real-world LOA Logs `encounters.db` files run 1-4+ GB after months of meter data. sql.js requires the full file as a single Uint8Array passed to its constructor; Chrome caps ArrayBuffer around 2 GB practical. 4 GB files failed with `NotReadableError` mid-read. la-utils inspection (slice patterns + IndexedDB FileSystemHandle storage) confirmed the fix is streaming SQLite via custom VFS.
- New `web/file-vfs.js` - a read-only async VFS for wa-sqlite that streams from `File.slice()`. SQLite only fetches the B-tree pages it actually needs (tens of MB even for 4 GB files). Refuses writes (read-only by design).
- `web/app.js` rewritten to use wa-sqlite (asyncify build) loaded lazily from jsdelivr: `wa-sqlite-async.mjs` + `src/sqlite-api.js` + the custom file-vfs. Lazy ESM imports keep page-load light when no file is dropped.
- Schema detection via `PRAGMA table_info(encounter)` - adapts column names to whichever LOA Logs version wrote the file. Handles `current_boss_name` vs `current_boss`, `last_combat_packet` vs `fight_start`, `local_player` vs `local_player_name`. Surfaces a clear error listing actual columns when nothing matches.
- Removed `<script src=".../sql-wasm.js">` from `index.html`; wa-sqlite loads via dynamic import in `app.js` instead.
- Smoke-tested static serving: `/sync`, `/sync/app.js`, `/sync/file-vfs.js`, `/sync/styles.css` all 200.
- 370/370 tests pass (no test changes; this is purely web-side).

## 2026-05-10 (Phase 4 - real sync wired)

### Added (local-sync Phase 4 - POST /api/raid-sync wired end-to-end)
- New `bot/services/local-sync/apply.js` - maps web companion deltas (`{ boss, difficulty, cleared, charName, lastClearMs }`) → `applyRaidSetForDiscordId` calls. Reuses `getRaidGateForBoss` from `bot/models/Raid.js` (the existing bible-side boss→raid table). Cumulative gate expansion (G2 cleared writes [G1, G2]) + char+raid+mode bucketing so 8 raw clears → 1 write per char. Returns structured summary with 4 buckets: `applied / skipped / unmapped / rejected`.
- New `bot/services/local-sync/sync-endpoint.js` - factory that builds the `POST /api/raid-sync` handler. Auth chain: Bearer token (or `?token=` fallback) → JWT verify → state check (`localSyncEnabled === true`, stale-POST guard returning 409) → apply → stamp `lastLocalSyncAt`. CORS preflight handled. 256 KB body cap. JSON-only.
- `bot.js` wires the endpoint into the HTTP server's apiHandlers map at boot. Reuses the existing `User` Mongo model and the new `applyRaidSetForDiscordId` thunk export from `bot/commands.js`.
- `bot/commands.js` exposes `applyRaidSetForDiscordId` as a thunk (let-binding wrapper) so external consumers can take a stable reference at module-load time even though the binding is filled lazily during command-factory init.
- Web companion (`web/app.js` + `web/index.html`) now actually POSTs. Preview table shows char column, "Sync now" button enables when there's data, success embed shows applied/skipped/unmapped/rejected with per-row reasons. Failed encounters stay in the preview but are NOT POSTed (only `cleared=1` rows go on the wire).
- 17 new tests in `test/local-sync-apply.test.js` cover difficulty normalization, target resolution (known boss / unknown / fallback), bucketing (dedup, cumulative gate, case-insensitive char match), and the apply pipeline 6-way outcome dispatch (applied / skipped / unmapped / rejected with 4 reason variants).
- Smoke-tested end-to-end: valid POST returns 200 with structured summary, missing token → 401 "missing token", forged token → 401 "token signature".
- 370/370 tests pass (was 353, +17 apply tests).

## 2026-05-10 (Phase 3 - web companion shipped)

### Added (local-sync Phase 3 - web companion + HTTP server)
- New HTTP server at `bot/services/local-sync/http-server.js` using Node's built-in `http` module (no Express dependency). Listens on `process.env.PORT || 3000`, binds 0.0.0.0 for Railway. Routes: `GET /` and `GET /health` return 200 OK (Railway probe), `GET /sync/*` serves static files from the new `web/` folder, anything else 404. Path traversal sandboxed - resolved paths must stay inside `webDir`.
- `web/index.html` + `web/app.js` + `web/styles.css` - vanilla web companion. Parses the `?token=` query, decodes the HMAC payload to display "Linked as Discord user X · valid for ~N min", offers drag-and-drop OR `showOpenFilePicker` for `encounters.db`, loads sql.js WASM from cdnjs, queries last-7-day encounters grouped by boss + difficulty + cleared, renders a preview table. **Phase 3 is dry-run only** - no POST yet (Phase 4 wires that).
- `bot/services/local-sync/tokens.js` - HMAC-SHA256 short-lived tokens (default 30 min TTL) using Node's built-in `crypto`. No `jsonwebtoken` dependency. Constant-time signature compare. 10 new tests cover roundtrip, custom TTL, sub-minute clamp, malformed/forged/payload-tamper/expired rejects, and missing-secret throw.
- `/raid-auto-manage action:local-on` success embed now mints a token + builds `${PUBLIC_BASE_URL}/sync?token=<jwt>` and adds an "Open Web Companion" link button when `PUBLIC_BASE_URL` and `LOCAL_SYNC_TOKEN_SECRET` env vars are set. Falls back to the existing no-link copy when env is unset (degraded mode - flag still flips, just no companion link).
- `bot.js` boots the HTTP server alongside the Discord client. Skippable via `LOCAL_SYNC_HTTP_DISABLED=true` for degraded deploys.
- 6 new locale keys (`localEnable.successDescriptionWithLink` + `localEnable.openButtonLabel` per vi/jp/en).
- 353/353 tests pass (was 343, +10 token tests).

### New env vars (set in Railway before redeploy)
- `LOCAL_SYNC_TOKEN_SECRET` - HMAC key for the web-companion link tokens. Required (>= 16 chars). Mint throws if missing/short.
- `PUBLIC_BASE_URL` - public-facing URL of the Railway deploy, e.g. `https://lostarkbotmanageraid.up.railway.app`. Required for the local-on success embed to include the link button.
- `LOCAL_SYNC_HTTP_DISABLED` (optional) - set to "true" to skip the HTTP server entirely (degraded deploy mode).

## 2026-05-09 (later 13)

### Added (local-sync Phase 2 - /raid-auto-manage extends with local-on / local-off)
- `/raid-auto-manage` autocomplete now offers 2 new actions: `local-on` (opt-in to local-sync mode) and `local-off` (disable). Filter logic reads BOTH `autoManageEnabled` and `localSyncEnabled` so the dropdown hides redundant + mutex-blocked options (e.g. `local-on` is hidden when bible is already on, since the strict-mode mutex would reject it anyway).
- `local-on` calls `setLocalSyncEnabled(force:false)` from the new local-sync service module. On mutex conflict (bible auto-sync is on), surfaces a "tắt bible trước" notice with the exact action to run. Success embed explicitly states the web companion site is still being built (Phase 3) so the user knows to expect a follow-up DM.
- `local-off` clears localSyncEnabled + localSyncLinkedAt. Note in the disable embed reminds the user that browser FSA permission must be cleared from the web tab manually (the bot can't reach into the browser).
- The existing `on` (bible-enable) path now pre-rejects when `localSyncEnabled` is true - cheaper than letting the probe fire HTTP requests then unwinding.
- `status` action embed restructured to a 2-row layout: bible mode (Opt-in / Last success / Last attempt - existing fields, now labeled "Bible · …") + local mode (Opt-in / Last sync, with empty 3rd field for row break). One Mongo read via `getSyncStatus`.
- 22 new locale keys across vi/jp/en covering the new mutex notices, redundant rejects, success/disable embeds, status row, and autocomplete labels. JP gets full Senko-flavor (ですわ / ～♪).
- `/raid-auto-manage action` description in definitions.js updated to reflect the 6 actions (was 4).
- 343/343 tests still pass (no new tests this commit; mutex helper already covered in Phase 1).
- **No-op until Phase 3**: opting in via `local-on` flips the flag but the web companion link doesn't exist yet; user has to wait. Phase 3 ships the link.

## 2026-05-09 (later 12)

### Added (local-sync foundation - Phase 1 of 6)
- New `bot/services/local-sync/` module with mutex-enforced state helpers for the upcoming local-sync mode (browser companion reads `encounters.db` via FSA API + sql.js, POSTs deltas to bot). Pattern inspired by la-utils.vercel.app.
- `User.localSyncEnabled` / `lastLocalSyncAt` / `localSyncLinkedAt` schema fields. Mutex with the existing `autoManageEnabled` (bible auto-sync) is enforced at the Mongo write layer via conditional findOneAndUpdate so two concurrent flips can't both succeed.
- 4 helpers: `setLocalSyncEnabled` (with optional `force` flag for the stuck-private-log "Switch to local sync" CTA), `setBibleAutoSyncEnabled` (mirror with `stampLastAttempt` for the daily-tick race-guard), `getSyncStatus` (read-only snapshot of both modes' freshness), `recordLocalSyncSuccess` (called when web companion POST lands).
- 16 new tests in `test/local-sync-state.test.js` cover both happy paths, conflict-probe disambiguation (no_user vs conflict), force-mode atomic dual-flip semantics, stale-POST guard, and the missing-UserModel defensive throw.
- 343/343 tests pass (was 327).
- No UI / handler changes yet - Phase 2 wires `/raid-auto-manage` actions `local-on` / `local-off` over these primitives.

## 2026-05-09 (later 11)

### Changed (text-parser hints + stuck-nudge follow "ping target's lang" rule)
- `bot/services/raid-channel-monitor.js` `handleRaidChannelMessage` swapped `guildLang` for `authorLang` (resolved from `message.author.id`) across all 14 user-directed t() call sites: parse-error hints (multi-gate / multi-raid / multi-difficulty / invalid-combo / invalid-gate / no-roster / errorNotFound / errorIneligible / errorSystem / errorPartialNote / errorRetryNote), the public `whisperAck`, and the public `dmFallback`. All of these auto-ping or explicitly mention the poster, so the audience-of-one is them. Other channel members are now an incidental audience.
- `postSpamWarning` and `postEmptyContentWarning` now resolve the addressee's per-user lang internally instead of reading the guild's broadcast lang. Reply auto-mention pulls the addressee's eye, so they're the reader.
- Welcome embed (`postRaidChannelWelcome`) stays on `guildLang` - that's a true channel-wide broadcast with no specific user pinged.
- `bot/services/raid-schedulers.js` `nudgeStuckPrivateLogUser` now resolves the target user's lang via `getUserLanguage(discordId, ...)` instead of the host guild's broadcast lang. The body has a `<@discordId>` mention, so it's user-addressed.
- Pattern matches the `add-roster.js:897-907` precedent ("Channel ping content uses the TARGET's lang") - same rule applied consistently across the codebase.
- 327/327 tests pass.

## 2026-05-09 (later 10)

### Fixed (Side tasks view JP/EN locale leak)
- `bot/utils/raid/task-view.js` per-character body now reads `Daily` / `Weekly` section headers and the `(no tasks)` placeholder from a new `task-view.{dailyHeader,weeklyHeader,emptyCell}` namespace. JP viewers see "デイリー" / "ウィークリー" / "(タスクなし)", EN sees the English forms; VN keeps "Daily" / "Weekly" as gamer loanwords for parity with the existing footer keys.
- `bot/utils/raid/shared-tasks.js` `getSharedTaskDisplay` now threads `lang` into `formatSharedResetLabel` for the non-scheduled branch (lines 466-468). Previously it dropped the arg, so daily/weekly shared tasks rendered "Mỗi ngày" / "Mỗi tuần" even when the viewer was on JP/EN. Daily tasks like "Stronghold Plants" now render as "毎日" in JP, "Daily" in EN.
- Threaded `lang` into all 3 `buildAccountTaskFields` callers (raid-status/task-ui, raid-check/all-mode, raid-check/task-view-ui). Helper defaults to `vi` for callers that haven't migrated yet.
- Note: Discord client renders `<t:N:R>` ("in an hour") and `<t:N:f>` ("May 9, 2026 10:00 PM") in the viewer's Discord locale, not the bot's app-level lang. Those are not bot-controlled.
- 327/327 tests pass.

## 2026-05-09 (later 9)

### Changed (`/raid-channel config action:set-language` reveals current language)
- Running `set-language` without picking a `language:` value no longer warns - it now renders a neutral info embed showing the guild's active broadcast language ("Ngôn ngữ broadcast hiện tại: 🇻🇳 Tiếng Việt") plus the cú pháp đổi. Admin probe-and-change in one knob, không cần nhớ riêng `action:show`.
- Added `raid-channel-language.currentTitle` / `currentDescription` to vi/jp/en, dropped the dead `missingTitle` / `missingDescription` keys (no other call sites). JP and EN got native copies in the same Senko/professional tone as the surrounding `raid-channel-language.*` block.
- 327/327 tests pass.

## 2026-05-09 (later 8)

### Changed (`/raid-status` JP coverage complete)
- `raid-status/task-ui.js` Side-tasks view now reads every user-visible string from the new `raid-status.taskView.*` keys. Empty-state description, main description, shared-task header, view toggle (📋 Tiến độ raid / 📝 Side tasks), char filter dropdown ("🌐 Tất cả character · X/Y", placeholder, descriptions), bulk/single toggle placeholders, "no task yet" placeholders, and footer counters (`{n}/{total} task chung · daily · weekly · Page X/Y`) all flow through `t()`. JP gets full Senko-flavored copies (デイリー / ウィークリー / 共通タスク with ですわ / ～♪ tone).
- `raid-status.js` Sync button + sync notice/followup blocks migrated to `raid-status.sync.*`. Covers the dynamic button label (`Sync ngay` / `Sync (X)` cooldown form), the "session-locked" lock notice, the "Cậu chưa bật auto-sync" gate, the cooldown notice, and the 3 followup outcome embeds (applied / synced-no-new / failed) with the success / neutral / failed-trouble titles.
- `createRaidStatusTaskUi` now takes `lang` via deps; raid-status.js threads the viewer's resolved language down into the factory at command entry time.

### Notes
- 320/320 tests pass.
- /raid-status is now fully JP-aware end-to-end (main view + raid filter dropdown + Side tasks view + Sync button + every notice/followup). JP viewers see consistent Artist voice across the entire surface.
- Remaining surfaces still hardcoded VN that JP viewers will see in VN: `/raid-set` confirmations, `/raid-task` replies, `/raid-share` (deferred per active bug-fix), `/add-roster` / `/edit-roster` / `/remove-roster` pickers, `/raid-channel`, `/raid-announce`, `/raid-auto-manage`, `/raid-check`. These are independent slash commands - migrate one per follow-up commit.

## 2026-05-09 (later 7)

### Changed (`/raid-status` raid-filter dropdown locale-aware)
- `raid-status/raid-filter.js` reads its strings (placeholder, "All raids", per-raid `pending · 🛡️ ⚔️` suffix) from the new `raid-status.filter.*` locale namespace. VN viewers see "Tất cả raids ({n} chưa clear)", JP viewers see "すべてのレイド (未完了 {n} 件)". Closes the gap surfaced by Traine on the live VN view where the dropdown still showed "All raids (33 total pending)" while the surrounding embed had migrated.
- Each per-raid entry's label now resolves through `getRaidModeLabel(raidKey, modeKey, lang)` so JP users see "アクト4 ノーマル" / "セルカ ハード" in the dropdown instead of the canonical English `raid.raidName`. Internal sort key remains canonical English so the order stays stable across locale switches.

### Notes
- 320/320 tests pass.
- Still pending for /raid-status JP coverage: `raid-status/task-ui.js` (Side tasks view labels), `raid-status/sync.js` (Sync button copy), `raid-status/task-actions.js` (toggle reply messages). Those are hardcoded VN today so JP viewers see VN there.

## 2026-05-09 (later 6)

### Added (i18n infrastructure + JP locale + /raid-language)
- New `bot/locales/{vi,jp,en}.js` packs + `bot/locales/index.js` registry. Vi (default) and JP are first-class locales offered in `/raid-language`; EN is a partial pack used only by the `/raid-help language:en` slash override. Per-locale files (instead of a single dictionary) so adding a language is one new file with no edits to existing packs.
- `bot/services/i18n.js`: `t(key, lang, vars)` resolver with dot-notation lookup, array-aware `{var}` interpolation, vi fallback for missing keys, and an in-process `getUserLanguage(discordId)` cache invalidated on `setUserLanguage`. `User.language` field added (default `"vi"` so legacy users see no change).
- New `/raid-language` slash command - ephemeral picker dropdown (🇻🇳 Tiếng Việt · 🇯🇵 日本語) that persists on the User doc and renders confirmation in the freshly-picked language. Wired through `definitions.js`, `commands.js` dispatcher, and `bot.js` select route (`raid-language:select`).

### Changed (`/raid-help` refactor)
- `bot/handlers/raid-help.js` now holds only language-neutral metadata (`SECTION_ORDER`, `SECTION_META` with icons + option keys + required flags). All labels, shorts, examples, notes, and option descriptions moved to `raid-help.sections.<key>.*` keys in each locale pack so adding KR/CN later means dropping `kr.js` and updating no handler. JP voice for help text is intentionally cuter (です/ますわ/～♪) per Senko-chan flavor brief.
- `definitions.js` adds `日本語` to the `/raid-help language:` choice list. Slash option still wins as a per-call override; otherwise the viewer's stored `/raid-language` preference selects the locale.

### Added (`/raid-status` JP coverage - view layer)
- `bot/utils/raid/labels.js` introduces `getRaidLabel`, `getModeLabel`, `getRaidModeLabel` for render-time raid name resolution. Models stay canonical EN; locale lookup happens at format time. JP picks katakana renditions: アクト4 / カゼロス / セルカ + ノーマル / ハード / ナイトメア.
- `formatRaidStatusLine(raid, lang)` is now lang-aware (back-compat: omitting `lang` falls back to `raid.raidName`). `/raid-status` view (`view.js`) threads `lang` through `buildAccountPageEmbed` / `buildAccountFreshnessLine` / `buildStatusFooterText` / `buildPiggybackOutcomeLine` and reads every user-visible string (freshness lines, gold rollup, no-roster notice, side badges, page footer) via `t(...)`.
- `/raid-check`'s shared use of `buildAccountPageEmbed` continues to work without lang and renders in vi (the existing default). Migrating raid-check + raid-set autocomplete + raid-filter dropdown to JP is staged for a follow-up commit.

### Notes
- 319/319 tests pass.
- `/raid-share` is intentionally not migrated yet - the handler is in active bug-fix; locale keys (`share.*`) are pre-added in vi.js / jp.js so the migration is a one-shot edit when the bug-fix lands.

## 2026-05-09 (later 5)

### Fixed
- `/raid-status` now rebuilds the full own+shared roster list after Sync and Task-view toggles. Before this, a viewer who had incoming `/raid-share` access could lose shared roster pages from the active embed after any path reloaded only their own `User` doc.
- `/raid-task` share-aware autocomplete now resolves the picked shared roster before listing characters, removable side tasks, roster-level shared tasks, and shared preset status. Same-named own rosters keep precedence over shared rosters so a user cannot accidentally write into a manager's roster when their own roster has the same name.

## 2026-05-09 (later 4)

### Added (roster-share Phase 2e: side-task toggle on shared pages)
- `/raid-status` side-task toggles (bulk row, single row, shared-task row) now route the write to the share owner's `User` doc when the current page is a shared roster. The select handler reads `accounts[currentPage]?._sharedFrom` (set by `buildMergedAccounts` in Phase 2a) and passes the resolved discordId into `toggleSharedTask` / `toggleBulkSideTask` / `toggleSingleSideTask`. When the share is view-level the toggle is silently no-op'd with an audit log line so the embed redraws unchanged - rejecting with an embed mid-`StringSelectInteraction` would clobber the dropdown.
- Audit log emits `[raid-status side-task toggle] share-write executor=B owner=A kind=<single|bulk|shared>` for every write that crosses owners, and `view-only share rejected` for blocked clicks. Direct toggles on B's own pages stay silent (no audit log) so the channel-monitor stays quiet on the common case.

### Notes
- 316/316 tests pass.
- This commit closes out the Phase 2 family. /raid-share grant + revoke + list, plus all main read+write flows (/raid-status render + Sync hide + side-task toggle, /raid-set autocomplete + slash + button, /raid-task autocomplete + every subcommand, raid-channel text parser) now respect the share grant. Manager A who runs `/raid-share grant target:B permission:edit` lets B run effectively all of A's day-to-day raid bookkeeping without any further plumbing.

## 2026-05-09 (later 3)

### Added (roster-share Phase 2d: zero-own viewer)
- `/raid-status` no longer hits the "Cậu chưa có roster nào" gate when the caller has zero own rosters but at least one incoming `/raid-share grant`. The early-exit now consults `getAccessibleAccounts(discordId)` and only bails when there are neither own accounts nor any active share. For the share-only path the refresh-userDoc dance (`loadStatusUserDoc`) is skipped because there's no own roster to refresh; a minimal stub doc keeps downstream readers (`buildStatusUserMeta`, raid-filter aggregate, etc.) from NPE-ing on missing fields.
- The second defensive gate after the refresh step is now share-aware: it only bails when the merged accounts array would still be empty, so a viewer who only ever had shared rosters lands on the rendered embed instead of the "no roster" notice.

### Notes
- 316/316 tests pass.
- Side-task toggling on `/raid-status` shared pages (`raid-status/task-actions.js`) is the last remaining piece of the Phase 2 family. Its code path is independent of the slash-command surface integrated in Phase 2c, so it ships as a follow-up.

## 2026-05-09 (later 2)

### Added (roster-share Phase 2c: /raid-task integration)
- `/raid-task` now spans rosters shared to the executor via `/raid-share grant`. New `resolveTaskWriteTarget(executorId, rosterName)` helper (inside `createRaidTaskCommand`) consults `getAccessibleAccounts` to detect whether a target roster is shared; on hit it returns the owner's `discordId` so the existing saveWithRetry closures naturally load and mutate the right `User` doc.
- All 7 write handlers wired through the helper: `handleAddSingle`, `handleAddAll`, `handleSharedAdd` (only when targeting a single roster, not when `applyAllRosters: true`), `handleSharedRemove`, `handleRemove`, `handleClear`, and `handleClearConfirmButton`. Each handler short-circuits with a centralized `buildViewOnlyShareEmbed` rejection embed when the share is `view`-level so a view-only viewer never reaches saveWithRetry. Audit logs emit `[raid-task] share-write executor=B owner=A cmd=<sub> roster=X` (and `share-preview` for the read-then-confirm flow `handleClear` opens).
- `/raid-task` `roster` autocomplete now appends rosters shared to the executor with `👥 Name · N chars · M task · shared by Alice` (and `· 👁️ view` for view-level shares so the executor sees they cannot edit even if the roster is pickable). Owner's own rosters keep the existing `📁` icon.
- `handleSharedAdd` keeps `applyAllRosters: true` scoped to the executor's OWN rosters only. Share grants are guest passes, not full ownership; bulk-applying a shared task across someone else's rosters would overstep the share contract.

### Notes
- 316/316 tests pass.
- Side-task toggling on `/raid-status` shared pages (Phase 2d) is still pending: it lives in `raid-status/task-actions.js` and uses a different code path than the slash command surface integrated here.
- Zero-own viewer support (also Phase 2d) still defers; B with `accounts.length === 0` but incoming shares still hits the "Cậu chưa có roster nào" gate. Fix needs synthesized stub seedDoc + skip refresh-userDoc steps.

## 2026-05-09 (later)

### Changed
- Hide the `🔄 Sync ngay` button on `/raid-status` shared pages. The sync action runs against the viewer's own `lastAutoManageAttemptAt` record - firing it while paginated to Manager A's shared roster would refresh B's accounts but not A's, which is confusing. Owner A still gets the button on their own `/raid-status`. UX: only B's own pages show Sync, so the button's behavior matches its label.

## 2026-05-09

### Added (roster-share Phase 2b: /raid-set + text parser write paths)
- `/raid-set` autocomplete (`roster` field) now lists rosters shared to the executor via `/raid-share grant` alongside their own + helper-registered rosters. Shared entries render with `👥 RosterName · N chars · shared by Alice` (and `· 👁️ view` for view-level shares so the executor sees they cannot edit even if the roster is pickable). `resolveRosterOwner` gained a third tier (after own + helper-registered) that consults `getAccessibleAccounts` to find shared rosters by name and returns the owner's User doc + `viaShare: true` marker so existing executor-not-owner branches inherit naturally.
- `applyRaidSetForDiscordId` auth check (the `executorId !== discordId` branch) now accepts share-edit access: an executor authorized via `/raid-share grant target:executor permission:edit` passes the gate even though `account.registeredBy !== executor`. View-level shares are filtered out by `canEditAccount` so a view-only viewer can never write through this path. Helper-Manager flow (`registeredBy === executor`) keeps the same precedence so existing helper-add behavior is unchanged.
- Raid-channel text parser (e.g. posting `Brel Hard Char1`) now resolves the char name across the message author's accessible pool via `findAccessibleCharacter`. When the char belongs to a shared roster (Manager A's roster shared to author B), the write is routed to A's User doc with executorId stamped to B; `applyRaidSetForDiscordId` then takes the share-edit branch. When the char is in B's own roster, behavior is identical to before. Audit log emits `[raid-channel] share-write executor=B owner=A char=X raid=Y` so post-hoc tracing works.

### Notes
- 316/316 tests pass.
- Side-task flow (`/raid-task`) is Phase 2c: ~10 distinct `User.findOne({ discordId })` call sites across add / remove / clear / shared-add / shared-remove subcommands, each with different semantics. Splitting Phase 2c into a dedicated commit keeps the side-task refactor reviewable in isolation. For now, `/raid-task` write paths are still scoped to the executor's own User doc; B cannot toggle/add side tasks on A's shared chars yet.
- Polish remaining (`Phase 2d` style): hide Sync button on shared `/raid-status` pages; allow viewers with zero own rosters to see shared-only views (currently gated by the `accounts.length === 0` early-exit).

## 2026-05-05 (later 2)

### Added
- `/raid-status` now renders shared rosters alongside the caller's own. After loading the caller's `User` doc, the handler calls `getAccessibleAccounts(viewerDiscordId)` and merges every roster owned by a Manager A who has run `/raid-share grant target:B` against B (the caller). Shared accounts are converted to plain objects and tagged with `_sharedFrom` so the view can badge them without leaking foreign Mongoose subdocs into save paths.
- View badge: shared pages render with a 👥 header icon (instead of 👑/📁) and a `· 👥 Shared by Alice (edit)` suffix on the page title. The auto-sync state badge and the `Last synced / Sync ready` freshness lines are suppressed on shared pages because those values belong to owner A's settings, not the viewer's. `Last updated` stays because it reads from the account subdoc itself (which travels with the share).

### Notes
- 316/316 tests pass (no regressions; existing freshness / page-render tests still cover own-roster paths).
- B with **zero own rosters** still hits the "Cậu chưa có roster nào" early-exit. The merge happens after B's own `User` doc is loaded so the gate stays the same shape as before; supporting "B has only shared rosters" needs a small early-exit refactor and is deferred to a follow-up.
- Sync button on a shared page still operates on the viewer's own discordId (B's accounts only), so clicking Sync while paginated to A's shared roster will refresh B's stuff but not A's. That's the safer default - B should not trigger sync-cooldown stamps on A's auto-manage record. A polish pass can hide the Sync button on shared pages later.
- **Write paths still pending (Phase 2b):** `/raid-set`, `/raid-task`, and the raid-channel text parser still scope writes by the caller's own `User` doc. So even though B sees A's rosters in `/raid-status`, B cannot yet update A's progress through those flows. The grant's `accessLevel: 'edit'` records the intent; activating it requires plumbing `getAccessibleAccounts` + `canEditAccount` into ~5 sub-handlers in `raid-set.js`, the text parser, and `/raid-task`. Splitting that work into a dedicated commit keeps the write-path refactor reviewable in isolation.

## 2026-05-05 (later)

### Added
- `/raid-share` command (Manager-only): `grant target:@B [permission:edit|view]`, `revoke target:@B`, `list [direction:both|in|out]`. Manager A can share roster access with grantee B; share is all-or-nothing per (A, B) pair (B sees ALL of A's rosters when share is active). Default permission `edit` (B can update progress); A can downgrade with `permission:view` for read-only. Re-running grant on same target overwrites the access level rather than creating a duplicate document. Auto-suspends when A is no longer in `RAID_MANAGER_ID` (existing share records stay; helper filters them out).
- `bot/models/RosterShare.js` Mongoose schema for the `roster_shares` collection. Unique index on `(ownerDiscordId, granteeDiscordId)` so upsert-style grants work.
- `bot/services/access-control.js` exposes `getAccessibleAccounts(viewerDiscordId)`, `canEditAccount(viewerDiscordId, ownerDiscordId)`, `findAccessibleCharacter(viewerDiscordId, charName)`. DI-friendly (accepts injected `User`, `RosterShare`, `isManagerId` so tests don't need a real Mongo).

### Notes
- 316/316 tests pass (9 new access-control tests covering own-only, shared-merge, view-vs-edit, manager-suspension, char lookup paths).
- **This commit ships the share *mechanism* (grant + revoke + list + DB record + access-control helper) but does NOT yet wire shared rosters into `/raid-status`, `/raid-set`, `/raid-task`, or the raid-channel text parser.** A grant currently records intent without changing what B sees in those flows. The next commit (planned) will swap the `userDoc.accounts`-centric loops in `handleStatusCommand` and `/raid-set` autocomplete to consume `getAccessibleAccounts(viewerDiscordId)` instead, plus expand the text parser's char-name lookup to span the same accessible pool.
- Splitting mechanism vs activation lets the command surface go through review while integration is tested in isolation in the follow-up. Existing flows are completely unchanged in this commit; production behavior pre-grant is identical to today.

## 2026-05-05

### Changed
- Manager privilege: roster refresh cooldown drops from **2 hours to 10 minutes** for users in `RAID_MANAGER_ID`. Mirrors the existing manager privilege on `/raid-auto-manage` sync (15s vs 10m). Regular users keep the conservative 2-hour spacing so we don't hammer lostark.bible during long browse sessions.
- `/raid-status` freshness line (`Last updated <t:R> · Refresh ready <t:R>`) now uses the per-viewer cooldown when computing the next-eligible time. A manager viewing their own /raid-status sees Refresh ready in ~10m, a regular user still sees ~2h. Wording unchanged.
- `/raid-check` user query (which is restricted to managers by design) widens its stale-roster cutoff from 2h to 10m at the query layer. More recently-stale rosters now surface as candidates so the lazy-refresh path can pull fresh iLvl before scanning, matching the same cooldown the manager would hit on their own /raid-status.
- New `getRosterRefreshCooldownMs(discordId)` helper in `services/manager.js` is the single source of truth for the per-user value. Wired through `commands.js` -> `handlers/raid-status.js` -> `view.js` deps so the freshness line and the next-eligible <t:R> computation read from one place. `roster-refresh.js` `isAccountRefreshStale` / `hasStaleAccountRefreshes` / `formatRosterRefreshCooldownRemaining` accept an optional `cooldownMs` arg; default unchanged so non-viewer call sites stay on the conservative 2h.

### Tests
- 307/307 tests pass. Updated the `raid-check user query filters by raid floor while preserving stale refresh candidates` assertion to reference the new `MANAGER_ROSTER_REFRESH_COOLDOWN_MS` constant exposed via `__test`.

## 2026-05-07

### Changed
- Chaos Gate and Field Boss shared-task presets now use the fixed `UTC-4` schedule instead of Pacific time. A source slot like Thu 11:00 UTC-4 now displays as Thu 22:00 VN, not Fri 01:00 VN.
- Updated `/raid-help`, `/raid-status` Task view copy, and README schedule wording from NA West/PT to UTC-4.

### Tests
- Updated scheduled shared-task tests to pin the new UTC-4 slot keys and VN dropdown time.

## 2026-05-06

### Changed
- `/raid-status` and `/raid-check raid:all` now render Serca like the other weekly-lockout raids: a 1740+ character shows one Serca line, defaulting to Serca Nightmare until the character actually clears/marks a lower mode. A Serca Hard or Serca Normal clear now replaces the Nightmare line instead of appearing beside it.
- Task view character headers now stay raid-view-like and compact (`name · iLvl` with a non-breaking separator). CP is intentionally omitted from Task view so checklist cards stay focused and do not wrap inside Discord's narrow inline columns.
- Scheduled shared-task rows now avoid repeating the same timestamp twice. Task view keeps Discord's relative + local absolute timestamp, while the compact VN time stays in dropdown labels.

### Tests
- Added a regression test covering Serca 1740+ status display for default Nightmare, cleared Hard, and cleared Normal.
- Added Task view coverage for compact `name · iLvl` headers.
- Updated scheduled shared-task display tests to pin the shorter timestamp format.

## 2026-05-05

### Added
- Weekly gold tracking on `/raid-status`. Gold-earner character cards now append a `💰 earned / total G` line (unbound) computed from the per-(raid, mode, gate) gold table newly seeded into `RAID_REQUIREMENTS`. Per-account rollup goes in the description; cross-account rollup tails the existing `🌐 All accounts` line when paginating across rosters.
- New `/raid-gold-earner roster:<name>` slash command. Opens an ephemeral picker (5-min session) to flip `character.isGoldEarner` per character, hard-capped at 6 ticks per Lost Ark's gold-earner-per-account-per-week rule. Pre-checks the top 6 by iLvl on first open for legacy data (every char `false` from the pre-default-true world) so legacy users can confirm in one click.
- `getGoldForGate(raidKey, modeKey, gate)` and `getGoldForRaid(raidKey, modeKey)` exports on `bot/models/Raid.js`. `bot/utils/raid/character.js` exports `computeRaidGold`, `summarizeCharacterGold`, `summarizeAccountGold`, `summarizeGlobalGold`. `bot/utils/raid/shared.js` exports `formatGold` (locale-comma + `G` suffix).
- `getStatusRaidsForCharacter` now decorates every raid entry with `earnedGold` + `totalGold` so downstream surfaces don't recompute the gate-by-gate sum.

### Changed
- Schema default for `characterSchema.isGoldEarner` flipped from `false` to `true`. `buildCharacterRecord` mirrors the flip via `source?.isGoldEarner !== false` so missing/undefined fields opt in by default while explicit `false` (set via `/raid-gold-earner`) is preserved verbatim. Net effect: chars added through `/add-roster` after this release are gold-earners until the user explicitly unticks them.
- Gold-earner chars now carry a `· 💰` suffix in the `/raid-status` per-char header (right after the iLvl). The previous body line `💰 _Not gold-earner_` for non-earners was removed - the absence of the header marker is now the sole "not gold-earner" signal, freeing one line of body space per non-earner card. Existing body line for earners (`💰 earned / total G`) is unchanged.
- Per-account rollup line added to description: `💰 Earned this week: **X** / **Y**`. Suppressed when no gold-earner exists in the account so the line never reads `0G / 0G`. Account pages also surface a one-liner discoverability tip pointing at `/raid-gold-earner` when the account has at least one character.

### Tests
- 14 new gold tests in `test/raid-status.test.js` plus 13 new tests in `test/raid-gold-earner.test.js` cover the gold helpers, raid entry decoration, per-char + per-account + cross-account rendering, picker session state (pre-check fallback, cap-6 toggle rejection, ownership guard, stale-session UX, off-window-preserve on confirm). Full suite 287 → 303 passing.

### Docs
- README features list + commands table mention `/raid-gold-earner`. `/raid-help` adds a `💰 raid-gold-earner` section and updates the `raid-status` notes for the new header marker + dropped non-earner body line. Pinned welcome embed gold field rewrites to point users at the picker command.

## 2026-05-02

### Added
- `accountSchema.registeredBy` (`String`, default `null`): stamped with the helper Manager's discordId when `/add-roster target:U` runs, left null on self-add. Drives `/raid-set` authorization: a Manager who registered a roster on someone else's behalf keeps editing rights on that roster without re-checking the live `RAID_MANAGER_ID` allowlist. Backed by a partial multikey index `registered_by_scan` (filter: `registeredBy: $type "string"`) so cross-user autocomplete scans only the helper-Manager rows.
- `/raid-set` autocomplete now lists helper-added rosters alongside own rosters, marked `👥 <accountName> · giúp <ownerLabel>` (vs `📁` for own). Picking a helper roster routes character / raid / status autocomplete to the registered user's doc and routes the `applyRaidSetForDiscordId` write to that doc as well. Reply embed prepends a hint line confirming whose roster the write landed on.

### Changed
- `/add-roster` `persistSelectedRoster` stamps `registeredBy = session.callerId` only on a brand-new account when `actingForOther` is true. Existing accounts preserve their stamp on merge so a different Manager re-running `/add-roster` cannot silently take over the helper slot.

### Tests
- Added 7 `resolveRosterOwner` tests in `test/raid-set.test.js` (own match, helper match, own-wins-on-tie, miss, ambiguous cross-user collision, empty-input short-circuit, end-to-end helper-flow write isolation) and 3 `persistSelectedRoster` tests in `test/add-roster.test.js` (stamp-on-actingForOther, no-stamp-on-self-add, preserve-on-merge). Full suite 262 -> 272 passing, no regressions.

### Docs
- README `/raid-set` row + `raid-help` notes block document the helper-Manager flow and the `👥` autocomplete marker.

## 2026-04-30

### Changed
- `getSharedTaskDisplay` returns Vietnamese status labels (`Đang mở`, `Mở Mon 11:00 AM PT`, `Mỗi ngày`, `Mỗi tuần`) instead of mixing raw `daily`/`weekly`/`scheduled` keywords with `next ...` English prefixes. Status now reads as one consistent line in `/raid-status` Task view, the shared-task toggle dropdown, and `/raid-task shared-remove` autocomplete.
- `/raid-task shared-add` reply, cap-reached, and duplicate notices now use `formatSharedResetDetail()` so the cycle is rendered as `Daily (reset 17:00 VN)` / `Weekly (reset 17:00 VN thứ 4)` / `Theo lịch NA West (Pacific)` instead of interpolating the raw schema keyword. Copy also restored to Artist voice (`tớ`/`Artist`, `nha~` particle).
- `/raid-status` Task view empty state now lists both side-task and task chung commands with the correct required fields (`action:single roster:<roster>`) and both caps (3+5 per char vs 5+5+5 per roster), and notes Chaos Gate / Field Boss follow NA West (Pacific) windows.
- `/raid-status` Task view footer label changed from `shared` to `task chung` for consistency with the section header.

### Docs
- README `/raid-task` row + headline feature bullet now mention `shared-add` / `shared-remove`, `all_rosters:true`, `expires_at`, and the NA West scheduled presets.

## 2026-04-27

### Added
- `/raid-task` side-task tracker is now a full feature set: `add`, `remove`, `clear`, `action:all`, daily/weekly cycle support, and direct toggle from `/raid-status`.
- `/raid-status` Task view now supports bulk toggle by shared task name across a whole roster and shows a placeholder card for future roster-wide shared tasks.
- `/raid-check raid:all` now has a Manager-only Task view button so Managers can inspect a member's side-task progress without leaving the flow.
- `/raid-announce` gained Wednesday maintenance reminders with separate early-warning and countdown variants.
- Welcome pin got a clearer onboarding block for new members.

### Changed
- `/raid-check` is now a single entry point with no `raid` option. Cross-raid overview is the sole landing page; per-raid focus is reached via the inline raid-filter dropdown inside the embed. The legacy per-raid command path (~750 lines of render code + open-time bible piggyback) was deleted alongside its test scaffolding because the inline filter offered the same UX without doubling command surface. Edit/Sync button flows survive untouched - they still call `computeRaidCheckSnapshot(raidMeta)` per-button-click for context.

### Refactor
- Cleaned up the dead deps left behind by the per-raid `/raid-check` cull: `formatShortRelative`, `waitWithBudget`, `buildAccountFreshnessLine`, `pickProgressIcon`, and `getAutoManageCooldownMs` were no longer referenced in `raid-check.js` after the per-raid render path was deleted, so they were dropped from both the `createRaidCheckCommand({...})` call site in `raid-command.js` and the inner factory destructure. `getRaidRequirementChoices()` (sole consumer was the now-removed `RAID_CHECK_CHOICES`) was deleted from `data/Raid.js`. Stale `/raid-check raid:all` comments across `all-mode.js`, `raid-status.js`, and `task-view.js` were updated to plain `/raid-check`.
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
- `/raid-status`, `/raid-check`, and the bible-refresh path now auto-upgrade a character's stored raid difficulty when its iLvl crosses into a higher tier (e.g. Act 4 Normal -> Hard at 1720, Serca Hard -> Nightmare at 1740). Previously the stored mode from a prior `/add-roster` stuck even after iLvl bumps because `normalizeAssignedRaid` preferred the stored G1 difficulty over the best-eligible fallback. The fix only auto-promotes (never auto-demotes), so deliberate over-tier stamps and in-progress weekly completions keep their stored mode until reset.
- Welcome pin emoji no longer goes dead after each bot restart; the emoji bootstrap now dedups duplicate-basename asset files (preferring `.png`) instead of alternately deleting + reuploading the same persona's emoji and churning its ID. Removed `assets/artist-icons/{shy.webp,neutral.webp,note.jpg}` that were colliding with their `.png` siblings on `path.parse(filename).name`.

### Security
- Bot refuses to start when `NODE_TLS_REJECT_UNAUTHORIZED=0` is set in the environment. The variable disables Node's HTTPS certificate validation for every outbound call (Discord, MongoDB, lostark.bible) and exposes the deployment to MITM; the startup guard turns it into a deploy-time failure instead of a silent runtime hazard. `.env.example` documents the prohibition.
- `/raid-channel config` and `/raid-announce` now do a runtime `ManageGuild` permission check inside the handler. `setDefaultMemberPermissions(ManageGuild)` on the slash schema is a Discord-side render hint only; if registration ever drifts (e.g. a failed `deploy-commands.js` mid-update), Discord still routes invocations to the handler. The runtime backstop guarantees only members with Manage Server can mutate channel / announcement config.
- `/raid-check raid:all` Mongo projection drops `bibleSerial`, `bibleCid`, and `bibleRid`. They were unused in this surface (only `/raid-auto-manage` consumes them); removing them keeps Manager-side reads minimal under data-minimization principles.

### Refactor
- Extracted `buildAccountTaskFields()` into `bot/utils/raid/task-view.js` so `/raid-status` and `/raid-check` share the same task-card renderer and totals math.
- Extracted `pack2Columns()` and `formatProgressTotals()` into `bot/utils/raid/shared.js` to keep embed layout and footer icon ordering consistent across views.
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
