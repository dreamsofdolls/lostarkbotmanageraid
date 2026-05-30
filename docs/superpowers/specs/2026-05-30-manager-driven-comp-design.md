# Manager-driven comp + "Raid của tôi" - Design

Date: 2026-05-30
Feature area: `/raid-schedule-preview` + `/raid-status`
Status: approved (design + HTML mockup signed off by Traine)
Mockup: `docs/superpowers/mockups/manager-driven-comp.html`

## Goal

Let a lead/Raid Manager build a raid comp directly (add specific people), not only
wait for self-service signups, and give every member a personal place to see which
raids they are in plus their turn/room. The board is currently self-service only:
each player clicks Tham gia and picks from their OWN roster; the lead can only Kick,
arrange turns, and run room/time/lock/end/cancel. A manager cannot place others, and
a member who was added has no glanceable "what am I in" view.

## Locked decisions

1. **Scope = additive (1B), not replace.** Keep the public Tham gia button. ADD a
   manager "add member" path. Manager-add works even when the board is Locked, so
   `Lock + manager-add` gives a fully manager-controlled mode on demand without
   removing self-service for open raids.
2. **Roster source = the target user's registered roster** (self-registered or
   manager-registered via `/raid-add-roster target:`). No free-typed character names:
   the iLvl eligibility gate and the End-time auto-clear write both need real roster
   data (discordId + accountName + characterName).
3. **Consent = manager-added members are normal event signups.** They follow the
   same Support/DPS capacity and waitlist rules as self-joined members. If their
   role has a free slot they are comp members and can be auto-cleared on End; if
   the role is full they waitlist until a slot opens. Auto-clear logic stays
   uniform: only actual comp slot-holders are credited.
4. **`show` is unchanged** - it stays the public, whole-comp turn plan. The personal
   "my raids" surface is separate (see Phase 2), because the two have different
   audiences (everyone vs one person) and overloading `show` would confuse.
5. **"Raid của tôi" lives in `/raid-status`** as a third dropdown beside the existing
   "Tiến độ raid" and "Tất cả raids", and is **guild-wide** (lists active events in
   any channel of the guild that the session opener is in).
6. **Teammate rendering reuses the `show` member-line format** (class icon + character
   name + role chip), 2-column compact (inline fields). The @mention is dropped in the
   personal view so lines fit a half-width inline column; `show` keeps mentions.
7. **No schema change.** Reuse the existing `signups[]` and `turns[]`. Room stays
   event-level (one room/event), not per-turn.

## Phase 1 - Manager-add (the "write" half)

UI lives in the lead Manage menu. New button **➕ Thêm người** on the people row,
beside 🧩 Phân turn and 👋 Kick (Success/green = add, mirroring Danger/red Kick).

Flow:
1. `rse:adduser:<eventId>` - the button shows an ephemeral message with a native
   Discord **User Select** ("Chọn người để thêm...").
2. On user pick, look up that user's roster (`User.findOne({discordId: target})`),
   compute eligible characters via the existing `listEligibleCharacters` +
   `findOwnEligibleRows` logic, and render a **character Select**
   (`rse:addpick:<targetId>:<eventId>`) with the class-icon options (same picker
   style as Tham gia, via `classEmojiOption`).
3. On character pick, write the signup on the target's behalf by reusing `applyJoin`
   (preserving the one-signup-per-user invariant), save, re-render the board, and
   **publicly ping** the added user (`<@target>` in message content, not embed, per
   the existing promote/cancel ping pattern) so they get a real notification.

Guards / edges:
- Lead-gated (`isLeadActionAllowed`); allowed when status is open OR locked
  (manager-add bypasses lock). Blocked when cleared/cancelled.
- Target has no roster / no eligible character / is a bot -> gentle notice instead of
  an empty list.
- Target already signed up -> `applyJoin` swaps their character (lets the manager fix
  someone's char too).
- Placement follows the same derived slot math as Join. Manager-add does not silently
  bump another member; if the matching role is full, the added member lands on the
  waitlist and the ping/confirmation says so.
- Kicking a slot-holder still auto-promotes waitlist (unchanged); adding does not need
  promotion logic (it just fills/overflows like a normal join).

Routing: `rse:adduser` + `rse:addpick` both fall under the existing `rse:` button and
select prefixes (no interaction-router-registry change). Add `UserSelectMenuBuilder`
to the command factory deps.

## Phase 2 - "Raid của tôi" (the "read" half)

A third dropdown in the `/raid-status` view, beside the two existing ones. It lists
the active raid-schedule events (status open/locked) in the guild that the session
opener is signed up for. v1 intentionally follows the literal "my raids" meaning:
if a manager is paging through someone else's shared roster, the dropdown still shows
the manager's own scheduled events.

- Dropdown label shows a count, e.g. "🗓️ Raid của tôi (2)". The dropdown is omitted
  entirely when the user is in zero active events (no empty/dead component).
- Each option: `{raid} {mode} · {character} ({role})` with a description line
  `#{channel} · khởi {rel} · turn {list or "chưa xếp"}`. Option value = event id.
- Selecting an option opens an ephemeral, personalized detail embed:
  - Header: raid + mode + countdown + channel.
  - "Vai của bạn": character, iLvl, role chip, status.
  - "Phòng": room name + password, ONLY if the user is in the comp (reuse the
    existing comp-gate `isCompMember`); hidden otherwise.
  - "Turn của bạn": the turns the user belongs to, rendered with the `show`
    member-line format (icon + char + chip), 2-column inline, the user's own line
    marked. If the user is in the comp but in no turn yet: "Lead chưa xếp turn cho
    bạn, hiện bạn ở {Support/DPS/hàng chờ}".

Cross-module note: `/raid-status` will query the raid-schedule `RaidEvent` model.
Keep the query in a small dedicated helper so the dependency is explicit and testable.

## Pure logic to extract (TDD targets)

- `turnsForMember(turns, discordId) -> filtered turns[]` - the turns containing the
  user, for the personal detail view. Pure, unit-tested.
- `listActiveEventsForUser(events, discordId) -> [...]` (or a thin query wrapper +
  pure filter/shape function) - the events a user is in, shaped for the dropdown.
  Pure shaping is unit-tested; the Mongo query is a thin wrapper.
- Reuse existing pure functions unchanged: `applyJoin`, `assignSlots`,
  `detectPromotion`, `resolveTurnMembers`, `listEligibleCharacters`.

## i18n

New keys under `raid-schedule.*` (manager-add: btn.addMember, addMember.* picker
title/intro/placeholder, notice.added*/addNoRoster*/addNoEligible*/addBotTarget*) and
under `raid-status.*` (the new dropdown label/placeholder + detail-embed labels).
vi/en/jp parity maintained; the parity test must stay green. User-facing strings in
Artist voice, no em-dash.

## Out of scope (YAGNI for now)

- A cross-channel standalone "my raids" slash command (the /raid-status dropdown
  covers the need; revisit only if asked).
- Per-turn rooms (room stays event-level).
- Free-typed / off-roster characters in manager-add.
- A separate "don't auto-clear added members" flag (added members use the same
  comp-slot auto-clear rule as everyone else).

## Testing

- New unit tests (node:test) for `turnsForMember` and the event-list shaping helper,
  TDD (red first).
- Existing 514-test suite must stay green across two runs.
- require-smoke the schedule handler + raid-status view after wiring.
- Live Discord behavior (User Select, ping, dropdown) is smoke-tested by Traine after
  each phase deploys.

## Rollout

Two commits / phases so each half is shippable and smoke-testable on its own:
- Phase 1: manager-add + ping.
- Phase 2: "Raid của tôi" dropdown + detail view in /raid-status.
Sync /raid-help + README in the same commit as the behavior change (all surfaces).
