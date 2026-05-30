# "Raid của tôi" (Phase 2) Implementation Plan

> **For agentic workers:** Implemented inline by hand (Traine prefers it - see feedback_implement_by_hand). TDD for the pure helpers; render/query layers verified by require-smoke + full suite + Discord smoke-test. Checkbox steps for tracking.

**Goal:** Give a member a personal "Raid của tôi" dropdown inside `/raid-status` that lists the active `/raid-schedule-preview` events (guild-wide) they are signed up for (self-join or manager-added); selecting one shows their role, the room (if in comp), and their turn(s) + teammates.

**Architecture:** `/raid-status` already runs a `createMessageComponentCollector` on its reply with a `rows` array from `buildComponents()`. Add one more dropdown row + one collector branch. The dropdown is NOT edit-driven (it does not re-render the roster embed); its branch defers ephemerally and posts a personal detail embed, like the existing sync branch. Pure shaping + the viewer's-turns filter live in a tested schedule service; the Mongo query + the Discord render live in a raid-status UI module. `show` is untouched.

**Scope decision (v1):** "Raid của tôi" = the events of the **session opener** (`interaction.user.id`). If a manager is viewing another user's roster, the dropdown still reflects the clicker (literal meaning of "my raids"); refine to displayed-owner later only if asked.

**Tech Stack:** discord.js v14 (StringSelectMenuBuilder), Mongoose (RaidEvent), node:test. Spec: `docs/superpowers/specs/2026-05-30-manager-driven-comp-design.md` (Phase 2 section). Reuses schedule pure helpers `resolveTurnMembers` (turns.js), `assignSlots` (slots.js), `getClassEmoji` (models/Class.js).

---

## File Structure

- **Create** `bot/services/raid/schedule/my-raids.js` - pure logic: `turnsForMember(turns, discordId)`, `shapeMyRaidEvents(events, discordId)`, `buildMyRaidDetail(event, discordId, counts)`. No I/O. Unit-tested.
- **Create** `test/raid-schedule-my-raids.test.js` - tests for the three pure functions (TDD).
- **Create** `bot/handlers/raid-status/my-raids.js` - render + query: `findActiveEventsForUser({RaidEvent, guildId, discordId})` (thin Mongo wrapper), `buildMyRaidsRow({...})` (the dropdown, mirrors raid-filter.js), `buildMyRaidDetailEmbed(event, discordId, {EmbedBuilder, UI, lang})` (the ephemeral detail). Imports the pure helpers + `resolveTurnMembers` + `getClassEmoji`.
- **Modify** `bot/handlers/raid-status/index.js` - query events upfront; push the dropdown row in `buildComponents`; add the `status-myraids:select` collector branch (deferReply ephemeral -> editReply detail).
- **Modify** `bot/locales/{vi,en,jp}.js` - `raid-status.myRaids.*` keys (parity).
- **Modify** README + raid-help (`/raid-status` section) + CHANGELOG.

custom-id scheme: `status-myraids:select` (matches the `status-...:...` convention of the other raid-status dropdowns). Option value = event `_id` string.

---

## Task 1: Pure logic + tests (TDD)

**Files:** Create `bot/services/raid/schedule/my-raids.js` + `test/raid-schedule-my-raids.test.js`.

Functions:
- `turnsForMember(turns, discordId)` -> array of `{name, memberIds}` turns whose `memberIds` includes `discordId` (string-compared). Returns `[]` for missing/empty.
- `shapeMyRaidEvents(events, discordId)` -> for each event where the viewer has a signup, return `{ eventId, raidKey, modeKey, channelId, startAt, characterName, role, turnCount }` (turnCount = number of turns the viewer is in). Drops events where the viewer has no signup. Pure (events are plain objects/lean docs).
- `buildMyRaidDetail(event, discordId, { supSlots, dpsSlots })` -> `{ signup, inComp, role, turns }` where `signup` is the viewer's signup record (or null), `inComp` = whether assignSlots places them in support/dps, `role` = signup.role, `turns` = turnsForMember(event.turns, discordId). Uses `assignSlots` to compute inComp.

TDD steps:
- [ ] Write `test/raid-schedule-my-raids.test.js` with cases: turnsForMember filters by membership + dedups missing; shapeMyRaidEvents includes only events the viewer is in + counts their turns; buildMyRaidDetail flags inComp true for a slot-holder and false for waitlist/absent, returns the viewer's turns. Use the same signup/turn fixture shape as `raid-schedule-board.test.js`.
- [ ] Run `node --test test/raid-schedule-my-raids.test.js` - verify FAIL (module missing).
- [ ] Implement `my-raids.js` (import `assignSlots` from `./slots`).
- [ ] Run the test - verify PASS.
- [ ] Run full suite - 515+ green.
- [ ] Commit: `git commit -m "raid-schedule: pure my-raids helpers (turnsForMember, shapeMyRaidEvents, buildMyRaidDetail)"`

## Task 2: raid-status UI module (query + dropdown + detail embed)

**Files:** Create `bot/handlers/raid-status/my-raids.js`.

- `findActiveEventsForUser({ RaidEvent, guildId, discordId })` -> `await RaidEvent.find({ guildId, status: { $in: ["open", "locked"] }, "signups.discordId": discordId }).sort({ startAt: 1 }).lean()`. Returns [] on error (try/catch, warn).
- `buildMyRaidsRow({ ActionRowBuilder, StringSelectMenuBuilder, truncateText, shapedEvents, getRaidModeLabel, disabled, lang })` -> an ActionRow with a StringSelectMenu customId `status-myraids:select`, placeholder `t("raid-status.myRaids.placeholder", lang)`, one option per shaped event: label `{raid mode} - {character}` (localized via getRaidModeLabel), description `#channel-ish + startAt relative + turnCount`, value = eventId, emoji 🗓️. Cap 25.
- `buildMyRaidDetailEmbed(event, discordId, { EmbedBuilder, UI, lang })` -> uses `buildMyRaidDetail` + `resolveTurnMembers` + `getClassEmoji`: title `🗓️ {raid mode} - Raid của bạn`; description with countdown (`<t:..:R>`) + channel mention; field "Vai của bạn" (character, iLvl, role chip, status); field "Phòng" only if inComp (room + password); one inline field per turn rendered `{classEmoji} {char} · {SUP|DPS}` (no @mention, 2-column compact, the viewer's own line marked); if inComp but no turns: a "chưa xếp turn, bạn đang ở {role}" line.

Verified by require-smoke (no unit test for the render layer, consistent with buildRaidFilterRow).
- [ ] Implement the module.
- [ ] `node -e "require('./bot/handlers/raid-status/my-raids.js')"` - smoke.
- [ ] Commit: `git commit -m "raid-status: my-raids UI module (query + dropdown row + detail embed)"`

## Task 3: Integrate into /raid-status collector

**Files:** Modify `bot/handlers/raid-status/index.js`.

- [ ] Near the top of the reply flow (where `accounts` / userDoc are ready, before `buildComponents`), query once: `const myRaidEvents = await findActiveEventsForUser({ RaidEvent, guildId: interaction.guildId, discordId: interaction.user.id });` then `const myRaidsShaped = shapeMyRaidEvents(myRaidEvents, interaction.user.id);` (guard: RaidEvent model must be in scope - check imports; add `const RaidEvent = require("../../models/RaidEvent")` if absent).
- [ ] In `buildComponents`, after the raid-filter row push, add: `if (myRaidsShaped.length > 0 && rows.length < 5) rows.push(buildMyRaidsRow({...}))`. (Discord cap = 5 rows; the row is omitted if the message is already full or the user is in zero events.)
- [ ] In `collector.on("collect")`, add a branch `else if (id === "status-myraids:select")`: `const eventId = component.values?.[0]; await component.deferReply({ flags: ephemeralFlag }); const ev = await RaidEvent.findById(eventId).catch(() => null); if (!ev) { editReply a "không tìm thấy" notice; return; } await component.editReply({ embeds: [buildMyRaidDetailEmbed(ev, component.user.id, { EmbedBuilder, UI, lang })] }); return;`. Do NOT add `status-myraids:select` to `editDrivenComponentIds` (it must not deferUpdate / re-render the roster).
- [ ] Confirm the row-count guard: count existing rows the status reply can emit (pagination, view-toggle, task rows, raid-filter) and ensure adding one more stays <= 5 in the worst case; if a config can already hit 5, the `rows.length < 5` guard drops my-raids gracefully (acceptable - rare, and `show`/the schedule board still cover it).
- [ ] require-smoke + full suite green.
- [ ] Commit: `git commit -m "raid-status: wire Raid cua toi dropdown + ephemeral detail into the collector"`

## Task 4: i18n + docs + verify + push

- [ ] Add `raid-status.myRaids.{placeholder, optionLabel, optionDesc, detailTitle, roleField, roomField, turnsField, noTurns, notFound, ...}` to vi/en/jp (parity). Artist voice, no em-dash.
- [ ] raid-help `/raid-status` section: add a line about the new dropdown (3 locales). README: note the dropdown. CHANGELOG: dated entry.
- [ ] Full suite x2 green + require-smoke whole surface (`require('./bot/commands.js')`).
- [ ] Commit docs, then `git push origin main`.
- [ ] Hand to Traine for Discord smoke-test: `/raid-status` -> "🗓️ Raid của tôi" dropdown -> pick an event -> verify the detail shows role + room (only if in comp) + their turns with teammates; verify it does NOT disturb the roster embed; verify the dropdown is absent when the user is in zero events.

---

## Self-review vs spec (Phase 2)
- Dropdown in /raid-status, guild-wide, lists events the user is in: Task 2 (`findActiveEventsForUser`) + Task 3. ✓
- Detail shows role + room (comp-gated) + their turns + teammates, show member-line format, 2-column: Task 2 (`buildMyRaidDetailEmbed`). ✓
- `show` unchanged: not touched. ✓
- Dropdown omitted at zero events: Task 3 guard. ✓
- Cross-module query in a dedicated helper: `findActiveEventsForUser`. ✓
- Reuse resolveTurnMembers/assignSlots/getClassEmoji, no new schema: Tasks 1-2. ✓
- TDD for pure logic: Task 1. ✓
