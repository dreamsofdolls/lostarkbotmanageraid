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
- `/laraidhelp` — bilingual (EN + VN) help command. Shows an overview embed listing all four raid commands, plus a dropdown to drill into per-command detail (options, example, notes). Reply is ephemeral so the help doesn't spam the channel.

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
- `getStatusRaidsForCharacter` now also exposes `allGateKeys` (derived from the character's stored `assignedRaids` sub-document) so the UI layer can render an accurate `done/total` ratio instead of guessing gate totals.

### Fixed

- Option-name mismatches between slash command definitions and handler code.
- Command routing and interaction handling for renamed commands.
- `/add-roster` combat-score parsing and sorting when values contain `~`, `,`, or other non-numeric symbols (now stripped before `parseFloat`).
- `/raid-check` item-level filter: characters with missing or non-numeric `itemLevel` were slipping past the minimum-item-level gate because `Number(undefined) < n` evaluates to `false` (`NaN` comparisons are always `false`). The filter now coerces via `Number() || 0` before comparison. (commit `dfb19e9`)
- Added a clarifying comment on the `1740+` Serca branch in `/raid-status` documenting why item level 1740+ surfaces Hard **and** Nightmare as dual options (Hard alone remains eligible from 1730 via the generic branch). (commit `dfb19e9`)

### Deployment

- Slash commands registered per-guild via `applicationGuildCommands` (not global) after each schema change.
- `src/deploy-commands.js` validates that `CLIENT_ID` and `GUILD_ID` are 17-20 digit Discord snowflakes before issuing the REST put, and reports a clear error on `404` pointing at likely misconfigurations (wrong client id, bot not in guild).

### Known Limitations

- Server local time drives weekly reset timing. Railway containers default to UTC → Wed 06:00 UTC.
- `/raid-check` role gate is exact-match on role name `raid leader` (case-insensitive).
- Two legacy files from the bot template are not imported by the current bot and can be removed: `config.js` and `src/models/GuildConfig.js` (both reference LoaLogs-specific features absent here — officer approvers, Gemini, ScraperAPI, `/lasetup`, `/laremote`, blacklist scope).
