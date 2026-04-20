# Changelog

All notable changes to this project will be documented in this file. Dates use the local calendar of the commit.

## 2026-04-20

### Added

- Initial bot scaffold: Discord.js v14 client, Mongoose connection, Railway deployment files (`Dockerfile`, `railway.toml`, `.dockerignore`).
- `/add-roster name total?` — sync character roster from `lostark.bible/character/NA/<name>/roster` and persist the top-N characters (default 6, max 6) ranked by combat score.
- `/raid-status` — per-account per-character raid progress view with gate-level granularity (`✅` for full completion, `G1`/`G1/G2` for partial, `❓` for pending).
- `/raid-set character raid status gate?` — mark a raid `complete`/`reset` for a character; optional `gate` (`G1`, `G2`, `G3`) targets a single gate instead of the whole raid.
- `/raid-check raid` — Raid Leader only. Scans every stored character above a raid's minimum item level that has not completed the selected difficulty. Output is auto-paginated into chunks ≤ 1900 chars.
- Three raids with per-mode item level gates: Act 4 (`armoche`) Normal 1700 / Hard 1720, Kazeros Normal 1710 / Hard 1730, Serca Normal 1710 / Hard 1730 / Nightmare 1740.
- Serca dual-mode display: at item level 1740+, `/raid-status` surfaces both Serca Hard and Nightmare as selectable options (Hard alone remains eligible from 1730 via the generic branch).
- Weekly reset job (`src/weekly-reset.js`): 30-minute interval tick that clears gate `completedDate` and task completion counters on Wednesday 06:00 (server local time), idempotent per-user via `weeklyResetKey` (ISO week string).
- 30+ Lost Ark class mappings from `lostark.bible` internal class IDs to display names (`src/models/Class.js`), with title-case fallback for unknown IDs.
- MongoDB DNS fallback in `db.js`: on Atlas SRV `ECONNREFUSED`, automatically retries `mongoose.connect` with configurable DNS servers (default `8.8.8.8,1.1.1.1`).
- `/deploy-commands` hardening: auto-extracts Client ID from a full OAuth2 URL if the user accidentally pastes one into `CLIENT_ID`.
- `/raid-help` — bilingual (EN + VN) help command (originally registered as `/laraidhelp`, renamed before public release). Shows an overview embed listing all four raid commands, plus a dropdown to drill into per-command detail (options, example, notes). Reply is ephemeral so the help doesn't spam the channel.

### Changed

- Raid data model grouped into `armoche` / `kazeros` / `serca`, each exposing a `modes` map with `minItemLevel` per difficulty. Replaces the earlier flat raid list.
- Character data shape migrated to `{id, name, class, itemLevel, combatScore, isGoldEarner, assignedRaids, tasks}`. Per-raid progress now lives inside `assignedRaids.<raidKey>` as a `strict: false` sub-document allowing arbitrary gate keys (`G1`, `G2`, `G3`...).
- Slash command naming and options normalized for consistency (`/add-roster`, `/raid-status`, `/raid-set`, `/raid-check`).
- `/raid-check` completion semantics: now evaluates both difficulty match **and** full-gate completion, not just raid-level boolean.
- `/raid-status` rendering updated with the `✅` / `G1/G2` / `❓` / no-eligible-raids states described above.
- Weekly reset now clears per-gate `completedDate` instead of a raid-level boolean, matching the gate-based progress model.
- UI redesign for `/raid-status` and `/raid-set`:
  - Introduced a module-level `UI` constants block for the bot's color palette (`success` / `progress` / `neutral` / `danger` / `muted`) and status icons (`done` / `partial` / `pending` / `reset` / `lock` / `warn`) so embed styling is centralized.
  - `/raid-status` embed color is now dynamic: green when every eligible raid is done, yellow when anything is in progress, blurple when nothing has started yet.
  - Each raid line in `/raid-status` now renders as `{icon} {raid name} · {done}/{total}` — replacing the previous `{raid name} G1/G2` / `✅` / `❓` formats — so users can see both total gate count and current progress at a glance.
  - `/raid-status` groups characters under `📁 {accountName}` headers and each character line leads with `**name** · class · iLvl` for quick context.
  - `/raid-set` response replaced its plain-text string with a mini embed (Character / Raid / Gates fields) and uses green for `complete` vs muted grey for `reset`.
- Error fallback in `src/bot.js` restored full Vietnamese diacritics ("Có lỗi xảy ra khi xử lý lệnh. Vui lòng thử lại." instead of the accent-stripped form).
- **[Defensive] `deploy-commands.js` now explicitly exits with code 0 after a successful registration.** The discord.js REST client keeps a keep-alive HTTP agent alive internally, so natural event-loop drain never happens after `rest.put(...)` completes. Without an explicit `process.exit(0)` the script hangs forever when run non-interactively (e.g. as a `docker exec` one-off or in a chained startup command). Now exits cleanly. `src/deploy-commands.js`.
- **`/raid-status` pagination buttons reskinned to match the `/list` pattern.** Dropped the disabled middle page-counter button and replaced the emoji-only arrow buttons with text-labelled Secondary-style buttons: `◀ Previous` and `Next ▶`. The page indicator still shows in the embed title (`Page N/M`), so no information is lost; the pagination row just reads cleaner. `src/raid-command.js` (buildStatusPaginationRow).
- **[BUG FIX] Legacy Serca G3 gate data no longer inflates the total-gate count.** `normalizeAssignedRaid()` now filters stored gate keys against the raid's current official gate list (`getGatesForRaid(raidKey)`). Data persisted before the Serca-3-to-2-gate metadata correction kept `assignedRaids.serca.G3` around, so `/raid-status` and the `/raid-set` raid autocomplete both displayed Serca entries as `0/3` instead of `0/2`. Normalizing reads filters G3 out of every downstream computation (display counts, `isAssignedRaidCompleted`, progress totals), and callers that reassign `character.assignedRaids = <normalized>` let the DB self-heal on the next write. `src/raid-command.js` (normalizeAssignedRaid).
- **`/raid-status` character card header dropped class name.** Field name shrunk from `{name} · {class} · {iLvl}` to `{name} · {iLvl}`, reducing card width and making the 2-per-row layout less cramped. `/raid-check` was already class-free and stayed unchanged. `src/raid-command.js` (buildCharacterField).
- **`/raid-status` per-page layout now spaces character pairs with a thin row break.** Added a Zero-Width-Space inline:false divider between every pair of inline character fields so rows no longer feel glued together. `src/raid-command.js` (buildAccountPageEmbed).
- **`/raid-status` rewritten as per-account paginated session, 2 characters per row.**
  - Each saved roster (account) becomes its own page. Navigate with `◀️ / ▶️` buttons; the middle button is a disabled page indicator `(N/M)`.
  - Characters lay out **2 per row** — achieved with an invisible Zero-Width-Space spacer field in the 3rd inline column, forcing the row to wrap after 2 character cards.
  - Page title dynamically reflects that account's aggregate progress (`🟢/🟡/⚪ 📁 {accountName} · Page N/M`), colored green/yellow/blurple accordingly.
  - Description carries per-account progress plus a global summary line across all accounts when more than one page exists.
  - Session timeout = **2 minutes**. Only the invoking user can click the buttons; other users get an ephemeral `🔒 Chỉ người chạy /raid-status...` rejection.
  - On expiry the buttons are disabled and the footer changes to `⏱️ Session đã hết hạn (120s) · Dùng /raid-status để xem lại`.
  - Single-account rosters skip the buttons entirely — direct embed reply, no pagination noise.
  - Multi-embed split code removed since per-page content stays well under Discord limits (max 6 chars × 3 fields = 18 fields per page).
  `src/raid-command.js` (handleStatusCommand, new helpers `buildAccountPageEmbed`, `buildCharacterField`, `buildStatusPaginationRow`).
- **`/raid-status` now lays characters out horizontally, 3 per row on desktop.** Replaced the single-field-per-account stacked list with one *inline* embed field per character. Discord auto-arranges up to three inline fields per row, so a 6-character roster fits in 2 rows instead of scrolling for 6 text blocks. Each character card is `{name} · {class} · {iLvl}` as field name with the raid progress list (`🟢 / 🟡 / ⚪ · done/total`) as the value. The `📁 {accountName}` header stays as a non-inline divider so multi-account rosters keep their grouping. Multi-embed pagination + 1024-char value truncation still applied. `src/raid-command.js` (handleStatusCommand).
- **Corrected Serca gate count from 3 to 2.** `RAID_REQUIREMENTS.serca.gates` now matches the actual in-game layout (`["G1", "G2"]`). Serca-related status counts and `/raid-set` gate validation follow automatically through `getGatesForRaid()`. `src/models/Raid.js`.
- **`/raid-set` `raid` option is now an autocomplete field that filters by the selected character's eligibility AND shows live progress per raid.** When a `character` is already typed or selected:
  - Only raids the character is eligible for (item-level gate passed) are offered.
  - Each suggestion prefixes the raid with a status icon and fraction: `🟢 Act 4 Hard · 2/2`, `🟡 Kazeros Hard · 1/2`, `⚪ Serca Nightmare · 0/2`.
  - Results are ordered pending → partial → done so "work to do" surfaces first.
  - If no character is selected yet, the dropdown falls back to the full raid list with min-item-level tags (`Serca Hard · 1730+`). `src/raid-command.js` (`autocompleteRaidSetRaid`, `findCharacterInUser` helper, dispatcher in `handleRaidSetAutocomplete`).
- **[BUG FIX] `/raid-set` completions no longer vanish when weekly reset fires shortly afterward.** Previously, `/raid-set` (and `/add-roster` when refreshing) wrote `assignedRaids.<raid>.<gate>.completedDate` but did not update `user.weeklyResetKey`, so the very next weekly-reset tick — which runs every 30 minutes and resets any user whose key lags `getTargetResetKey()` — would clear the just-set completion because the user still looked stale. A new `ensureFreshWeek(user)` helper (exported from `src/weekly-reset.js`) now runs at the start of every write path's `saveWithRetry` closure: if the user's `weeklyResetKey` lags the current target, it clears all characters' gate completions and task counters and bumps the key before the write proceeds, so the write is always on a fresh-week baseline and the reset job skips the user on its next tick. Idempotent no-op when already fresh. `src/weekly-reset.js` (new `ensureFreshWeek`), `src/raid-command.js` (handleAddRosterCommand + handleRaidSetCommand retry bodies).
- Changed the "done" status icon from `✅` (green check) to `🟢` (green circle) so it sits visually beside `🟡 partial` and `⚪ pending` as a matched circle set. Because `UI.icons.done` is the single source, this propagates to `/raid-status` (title icon, footer legend, per-raid lines), `/raid-set` success embed, `/raid-check` empty-state embed, and `/raid-help` detail notes in one change.
- `/raid-set` `character` option now autocompletes from the caller's saved roster. Handler `handleRaidSetAutocomplete` is wired into `InteractionCreate` (via `interaction.isAutocomplete()`) and surfaces up to 25 results as `{name} · {class} · {iLvl}`, deduped across accounts, sorted by item level desc. Needle match is substring (case-insensitive), so users can type any part of the character name. `src/raid-command.js`, `src/bot.js`.
- Fixed the discord.js v14 deprecation warning "Supplying `ephemeral` for interaction response options is deprecated. Utilize flags instead." Every `{ ephemeral: true }` across the bot was replaced with `{ flags: MessageFlags.Ephemeral }` (13 call sites total, plus the shared error fallback in `src/bot.js`). Functional behavior is unchanged — only the flag encoding differs. `src/raid-command.js`, `src/bot.js`.
- Silenced the `Could not parse CSS stylesheet` noise that jsdom emits when loading the lostark.bible roster page. Introduced a module-level `VirtualConsole` that swallows that specific `jsdomError` while still surfacing anything else; passed to `new JSDOM(html, { virtualConsole })` in `fetchRosterCharacters`. Scraping output is unchanged; the log is now clean. `src/raid-command.js`.
- Follow-up fixes from the Codex re-review of `517cd00`:
  - **[MEDIUM] `/add-roster` refresh now primarily matches the seed name before falling back to character overlap.** A re-registered roster whose stored top-N no longer overlaps the freshly fetched top-N (churn, gear reorganization, name changes) would have been pushed as a second duplicate account under the post-fix logic. The matcher now checks `normalizeName(accountName) === seed` first, then any stored character name equalling the seed, then the original overlap heuristic. `src/raid-command.js` (handleAddRosterCommand retry body).
  - **[MEDIUM] `/raid-set` now validates `gate` against the raid's actual gate list.** The slash command still exposes G1/G2/G3 for every raid, but the handler now rejects (with an ephemeral `⚠️` message listing valid gates) before mutating when the submitted `targetGate` is not in `getGatesForRaid(raidKey)`. Prevents synthesizing a phantom `G3` on two-gate raids. `src/raid-command.js` (handleRaidSetCommand validation block).
  - **[LOW] Weekly reset `modifiedCount` no longer over-reports.** The retry callback now returns a boolean indicating whether a save actually happened; `modifiedCount` increments only on `true`, so a stale user already refreshed by another worker between the initial scan and the per-user retry no longer inflates the log line. `src/weekly-reset.js` (resetWeekly loop).
- Slash command raid-choice labels changed from `Act 4 Normal (>= 1700)` to `Act 4 Normal · 1700+`. The `·` middle dot separator and `+` suffix are shorter, easier to scan in the Discord dropdown, and drop the awkward `(>=` glyph. Touches `getRaidRequirementChoices()` in `src/models/Raid.js`.
- UI polish sweep across all commands (consistency pass):
  - `/add-roster` success embed: title now `📥 Roster Synced` with a source footer, color switched from magic hex `0x57f287` to `UI.colors.success`, character-list header renamed to `Characters (N)` for symmetry with other commands.
  - Added `UI.icons.info` (`ℹ️`) and `UI.icons.roster` (`📥`) to the centralized icon set.
  - All plain-text error / info interaction responses now lead with a status icon (`⚠️` for validation errors, `ℹ️` for "no roster yet", `🔒` for role gates) and carry full Vietnamese diacritics. Covers: `/add-roster` fetch failure + empty-roster, `/raid-check` + `/raid-set` invalid raid option, `/raid-set` invalid status, `/raid-set` character-not-found, `/raid-status` + `/raid-set` no-roster-yet.
- `/raid-check` upgraded from plain-text chunks to a proper embed:
  - Dynamic color by difficulty: red for Nightmare, yellow for Hard, blurple for Normal.
  - Results grouped by Discord user (most pending characters first, characters sorted by item level within each user).
  - Multi-embed pagination when results exceed 25 fields or 5500 chars total — first via `editReply`, subsequent via ephemeral `followUp`.
  - Empty state (everyone has completed the raid) now renders a green success embed instead of a plain sentence.
  - Role-gate rejection (`Chỉ Raid Leader mới được dùng /raid-check`) restored full Vietnamese diacritics.
- `getStatusRaidsForCharacter` now also exposes `allGateKeys` (derived from the character's stored `assignedRaids` sub-document) so the UI layer can render an accurate `done/total` ratio instead of guessing gate totals.

### Fixed

- Option-name mismatches between slash command definitions and handler code.
- Command routing and interaction handling for renamed commands.
- `/add-roster` combat-score parsing and sorting when values contain `~`, `,`, or other non-numeric symbols (now stripped before `parseFloat`).
- `/raid-check` item-level filter: characters with missing or non-numeric `itemLevel` were slipping past the minimum-item-level gate because `Number(undefined) < n` evaluates to `false` (`NaN` comparisons are always `false`). The filter now coerces via `Number() || 0` before comparison. (commit `dfb19e9`)
- Added a clarifying comment on the `1740+` Serca branch in `/raid-status` documenting why item level 1740+ surfaces Hard **and** Nightmare as dual options (Hard alone remains eligible from 1730 via the generic branch). (commit `dfb19e9`)

### Bug fixes (Codex review)

- **[HIGH] Fixed lost-update races in `/add-roster`:** both first-time setup (concurrent requests observing an empty user) and subsequent refreshes could clobber each other or trip `E11000` on the `discordId` unique index. Switched to `saveWithRetry()` which re-fetches + reapplies the mutation on `VersionError` or duplicate-key, and enabled Mongoose optimistic concurrency on the `User` schema (`optimisticConcurrency: true` replaced the previous `versionKey: false`). `src/raid-command.js` (handleAddRosterCommand), `src/schema/user.js`.
- **[HIGH] Fixed lost-update races in `/raid-set`:** two `/raid-set` commands on different characters of the same user could overwrite each other since the handler saved the entire `User` document. Now wrapped in `saveWithRetry()` so the mutation is reapplied on a fresh document if another command commits in between. `src/raid-command.js` (handleRaidSetCommand).
- **[HIGH] Weekly reset no longer overwrites live command writes.** The reset job now fetches a minimal list of stale user IDs, then for each user re-fetches + mutates + saves inside `saveWithRetry()`. If a user's document is modified by `/raid-set` between the fetch and the save, the reset retries on the fresh doc instead of silently rewriting it. `src/weekly-reset.js`.
- **[HIGH] Weekly reset now catches up if the process was offline across the Wednesday 06:00 UTC window.** Replaced the hard "skip unless Wednesday morning" guard with a `getTargetResetKey()` comparison — any user whose `weeklyResetKey` lags the current target (last reset moment that has passed, in UTC) gets reset on the next tick regardless of what day the bot wakes up. `src/weekly-reset.js`.
- **[HIGH] Weekly reset timing is now entirely UTC-based.** The prior code mixed local-time trigger (`getDay()` / `getHours()`) with UTC week-key computation, so the same bot on two hosts would reset at two different real-world instants. `isWednesdayMorning()` was replaced by `getTargetResetKey()` which uses `getUTCDay()` / `getUTCHours()` consistently with `getWeekKey()`. `src/weekly-reset.js`.
- **[MEDIUM] `/add-roster` now refreshes an existing roster instead of rejecting it.** Removed the pre-fetch duplicate guard that rejected any seed name matching an existing account or character — the later merge path already handled the refresh correctly. `src/raid-command.js` (handleAddRosterCommand).
- **[MEDIUM] Per-raid gate metadata.** `RAID_REQUIREMENTS` now exposes `gates` per raid (Act 4 / Kazeros = `G1, G2`, Serca = `G1, G2, G3`) via a `getGatesForRaid(raidKey)` helper. Every hardcoded `["G1", "G2"]` fallback was replaced so Serca now tracks three gates end-to-end (legacy migration, `normalizeAssignedRaid`, `formatRaidStatusLine`, and `/raid-set` default-init). `src/models/Raid.js`, `src/raid-command.js`.
- **[MEDIUM] `/raid-status` no longer fails when the total embed would exceed Discord's 6000-character limit.** The handler now builds one base embed and pushes additional `(continued)` embeds whenever the next account field would push total size past 5500 chars or field count past 25. The first embed is sent via `reply`; the rest as `followUp`. `src/raid-command.js` (handleStatusCommand).
- **[LOW] Roster class-name scraper tolerates optional whitespace and escaped characters.** The `name:"...",class:"..."` regex is now `/name:\s*"((?:[^"\\]|\\.)*)"\s*,\s*class:\s*"((?:[^"\\]|\\.)*)"/g` with a small `unescapeJsonLike` post-processor, so `name:\"Foo\\\"Bar\",class:\"bard\"` and minor upstream formatting changes no longer silently degrade class names to `Unknown`. `src/raid-command.js` (extractRosterClassMapFromHtml).

### Deployment

- Slash commands registered per-guild via `applicationGuildCommands` (not global) after each schema change.
- `src/deploy-commands.js` validates that `CLIENT_ID` and `GUILD_ID` are 17-20 digit Discord snowflakes before issuing the REST put, and reports a clear error on `404` pointing at likely misconfigurations (wrong client id, bot not in guild).

### Known Limitations

- Server local time drives weekly reset timing. Railway containers default to UTC → Wed 06:00 UTC.
- `/raid-check` role gate is exact-match on role name `raid leader` (case-insensitive).
- Two legacy files from the bot template are not imported by the current bot and can be removed: `config.js` and `src/models/GuildConfig.js` (both reference LoaLogs-specific features absent here — officer approvers, Gemini, ScraperAPI, `/lasetup`, `/laremote`, blacklist scope).
