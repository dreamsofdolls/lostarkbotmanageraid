# /raid-schedule - Raid signup board + team-comp manager

- **Date:** 2026-05-29
- **Status:** Spec approved (Traine, 2026-05-29); ready for implementation plan
- **Project:** LostArk_RaidManage
- **Working name:** `raid-schedule-manager` (shortened to `/raid-schedule` for typing - confirm in review)

---

## 1. Summary

A Raid-Helper-style signup board for Lost Ark raids, but roster-aware: because the
bot already knows every registered player's characters + item levels (via
`/raid-add-roster`), signups draw from the player's own roster and auto-validate
against the raid's minimum item level. A lead/manager posts an event for a specific
raid+mode; players sign up with an eligible character into soft Support/DPS slots;
overflow goes to a waitlist with auto-promote; an in-game room name + password is
delivered privately to comp members; and when the lead ends the raid, the clear is
written back into each signup's own `/raid-status`.

Time is a label + Discord-native countdown, not a calendar system.

---

## 2. Goals / Non-goals

### v1 in scope

| Area | Behavior |
|---|---|
| **Core board** | Lead posts an event (raid, mode, size 4/8, start time, title). Single channel message that re-renders on every change. |
| **Roster-gated signup** | Player picks a character from their registered roster; only chars with `itemLevel >= raid minItemLevel` are selectable. No registered roster char that qualifies = signup blocked with a clear reason. |
| **Soft role slots** | Recommended Support/DPS split shown (4-man: 1 sup + 3 dps; 8-man: 2 sup + 6 dps). Role is a tag derived from class via `isSupportClass`; **not hard-enforced** - lead rebalances. |
| **Lock / kick** | Lead can lock the board (stop new signups) / unlock, and kick a signup. |
| **Countdown** | Lead sets a start time (parsed in the lead's **language timezone**, see `/raid-language`); board shows a Discord-native relative timestamp that auto-localizes to each viewer's own region. |
| **Auto-lock (lead's choice)** | At creation the lead chooses auto-lock (board locks itself when `startAt` is reached) **or** manual-only lock. Auto-lock runs off an existing scheduler tick. |
| **Lifecycle** | `open -> locked -> cleared` (success) **or** `open/locked -> cancelled` (fell through). |
| **Waitlist + auto-promote** | When the comp is full, further confirmed signups go to a waitlist; when a slot frees, position #1 of the matching role auto-promotes **and is pinged**. |
| **RSVP states** | `Tham gia` (confirmed) **and** `Trễ` (late) hold a slot; `Có thể` (tentative) / `Vắng` (absent) do not and show in a "Phản hồi" zone. `Trễ` is a flag on an already-held slot (you must have joined first) so a late player still counts for auto-clear; `Có thể`/`Vắng` vacate a held slot. |
| **Auto-write clear** | On `Kết thúc`, the cleared raid is written into `/raid-status` for **each signup's own character** (consent = the act of signing up with your own char). |
| **Room + password** | Room name public on the board; password revealed only to comp members via an ephemeral `🔑` button. Lead sets/edits via a modal. |
| **Just-in-time help** | A `❓ Hướng dẫn` button opens an ephemeral guide that reads this event's real data (raid, iLvl) and renders in the clicker's language. |
| **Cancel path** | Lead cancels an event (distinct from clear): board flips to "Đã huỷ", **no** auto-clear is written, signups are pinged. |
| **Reschedule + slot move** | Lead edits the start time (modal, countdown updates) and drags a signup between slots, via the `⚙️ Quản lý` menu. |
| **Already-cleared warning** | At signup, if the chosen character has already cleared this raid this week (per `/raid-status` data), show a soft `⚠️` warning (does not block). |

### Out of scope (deferred, with forward-compat hooks noted in §6)

approval queue · Discord-role restriction · per-event iLvl floor/ceiling override ·
reminder ping before start · recurring events · time poll · co-lead delegation ·
comp text export · `/raid-auction` integration after clear · multi-character signup
for multi-account players.

### Defaults locked

- **One signup per Discord user per event.** A user brings one character to one raid
  (LA rule). Re-running `Tham gia` or changing character updates the existing signup.
  Multi-account players bringing 2 chars = deferred edge case.
- **Waitlist members do not see the room password** until promoted to a real slot.

---

## 3. User-facing behavior

### 3.1 Command

`/raid-schedule create` (subcommand chosen over a flat command so `list` / `cancel`
subcommands can be added later without a breaking change). Options:

| Option | Type | Notes |
|---|---|---|
| `raid` | choice (required) | Act 4 / Kazeros / Serca (from `RAID_REQUIREMENTS`) |
| `mode` | choice (required) | Normal / Hard / Nightmare (valid set depends on raid; validated server-side) |
| `size` | choice (required) | 4 or 8 |
| `when` | string (required) | Start time. Accepts `HH:MM` **or** relative `+Nh` / `+Nm`. `HH:MM` is interpreted in the **lead's language timezone** (`/raid-language`: vi -> VN/UTC+7, jp -> JST/UTC+9, en -> UTC) via `artist-clock.getLangTzOffsetMinutes`, then stored as an absolute UTC instant. Relative offsets are tz-independent. Ambiguous / unparseable input rejected with an example. |
| `auto_lock` | boolean (optional) | If true, the board auto-locks when the start time is reached. Default true. Toggleable later via `⚙️ Quản lý`. |
| `title` | string (optional) | Free label, e.g. "Roll-call raid tối nay". Defaults to "{Raid} {Mode}". |

Only `RAID_MANAGER_ID` allowlist users (`isManagerId`) may create events. The creator
becomes the event's lead.

### 3.2 The board (single channel message)

Color stripe by state (open = blurple, locked/room = amber accents, cleared = green,
cancelled = grey/red). Anatomy:

```
⚔️ {Title}
📦 {Raid} · ⚙️ {Mode} · 🎚️ iLvl ≥ {min}
🕐 Bắt đầu: <t:unix:R> (<t:unix:f>)
👤 Lead: @creator
🚪 Phòng: {roomName | "lead sẽ đặt trước giờ"} · 🔑 mật khẩu: bấm nút (chỉ comp)
🟢 Comp: {n}/{size} · ⏳ {w} hàng chờ

🛡️ Support {s}/{supSlots}        ⚔️ DPS {d}/{dpsSlots}
  1 🎵 Name 1725                   1 🗡️ Name 1731
  2 ＋ còn trống                    ... (numbered slots, class emoji, iLvl)

⏳ Hàng chờ {w}
  #1 🌊 Name 1723  ...

📋 Phản hồi
  🕐 Trễ n · names   🤔 Có thể n · names   ❌ Vắng n · names

[footer] ● {STATUS} · {hint} · ID {short}
```

Buttons (3 action rows, within Discord's 5-buttons-per-row / 5-rows-per-message limit):

- **Row 1 - status (everyone):** `✅ Tham gia` · `🕐 Trễ` · `🤔 Có thể` · `❌ Vắng`
  (pressing `Vắng` while in a slot removes you from the comp).
- **Row 2 - utility (everyone):** `🔑 Phòng & mật khẩu` · `❓ Hướng dẫn`
- **Row 3 - lead/manager only:** `🔒 Khoá` (toggles to `🔓 Mở lại`) · `🏁 Kết thúc` · `⚙️ Quản lý`

When `locked`: status buttons disabled. When `cleared`/`cancelled`: all interactive
buttons removed (board frozen).

### 3.3 Signup flow

1. Player clicks `✅ Tham gia`.
2. Bot replies **ephemerally** with a select-menu of that player's roster characters
   where `itemLevel >= event.minItemLevel`. Ineligible chars are shown disabled with
   the deficit ("✗ thiếu 5"). If the player has no qualifying char (or no registered
   roster), the ephemeral explains why and links `/raid-add-roster`.
3. Player picks a character. Role (`support`/`dps`) is derived from class.
   - If a matching-role slot is open -> placed in comp.
   - If the comp (or that role group) is full -> placed on the **waitlist**.
   - If the character already cleared this raid this week -> a soft `⚠️` note is shown
     in the ephemeral confirmation (does not block).
4. Board message re-renders.

`Có thể` / `Vắng` set the signup `status` without a character picker and do not occupy
a slot; a user holding a slot who presses one of these **vacates** it (may trigger a
waitlist promote). `Trễ` marks an already-held slot as "will be late" - it keeps the
slot (so the player still counts for auto-clear) and is only offered to someone already
in the comp. Slot-occupying statuses are therefore `confirmed` + `late`.

### 3.4 Room + password

- Lead opens `⚙️ Quản lý -> Đặt phòng`: a modal with two text inputs (room name
  required, password optional). Editable any time (room is usually created near raid
  time).
- `🔑 Phòng & mật khẩu` (everyone): ephemeral. If the clicker holds a confirmed slot,
  shows room name + password. Otherwise: "cần ở trong comp" (waitlist included).
- Password is **never** rendered in the public board and **never logged**.

### 3.5 Lock / end / cancel

- `🔒 Khoá`: status -> `locked`, signup buttons disabled. `🔓 Mở lại` reverts.
- **Auto-lock:** if `autoLockAtStart` is true, a scheduler tick flips `open -> locked`
  when `startAt` passes (same effect as the lead pressing `🔒`). Manual lock/unlock
  still works regardless; auto-lock only fires once, on the first tick past `startAt`.
- `🏁 Kết thúc`: status -> `cleared`. Auto-write clear (see §5.4), freeze board, remove
  buttons, show duration + "đã ghi clear cho N char".
- `⚙️ Quản lý -> Huỷ`: status -> `cancelled`. **No** clear written. Board flips to "Đã
  huỷ", buttons removed, signups pinged that the raid fell through.

### 3.6 `⚙️ Quản lý` menu (lead only, ephemeral)

A small ephemeral control panel: `Đặt phòng` (modal) · `Sửa giờ` (modal, countdown
updates) · `Tự khoá: bật/tắt` (toggle `autoLockAtStart`) · `Kick` (select a signup to
remove) · `Đổi/dời slot` (move a signup between Support/DPS or reorder) · `Huỷ event`.

---

## 4. Architecture & components

New, isolated where possible; reuse existing primitives heavily.

| Layer | File (new unless noted) | Responsibility |
|---|---|---|
| Model | `bot/models/RaidEvent.js` | Mongoose schema + indexes (see §5) |
| Command def | `bot/handlers/commands/definitions.js` (edit) | `/raid-schedule create` slash definition (vi/jp localized) |
| Dispatch | `bot/commands.js` (edit) | Wire handler into the dispatch map + factory |
| Router allowlist | `bot/app/interaction-router-registry.js` (edit) | Add `"raid-schedule"` to `RAID_COMMAND_NAMES` **and** a `buttonRoutes` prefix entry (see §8 wiring checklist - this is the known gotcha) |
| Handler | `bot/handlers/raid/schedule/index.js` | Command entry + interaction routing for this feature's components |
| Handler (board) | `bot/handlers/raid/schedule/board.js` | Build/re-render the event embed + button rows for a given state |
| Handler (signup) | `bot/handlers/raid/schedule/signup.js` | Character picker, slot placement, waitlist, RSVP transitions, promote |
| Handler (manage) | `bot/handlers/raid/schedule/manage.js` | Lead controls: lock, cancel, kick, slot-move, room modal, reschedule modal |
| Handler (room/help) | `bot/handlers/raid/schedule/room.js`, `help.js` | Ephemeral password reveal (gated) + just-in-time guide |
| Service | `bot/services/raid/schedule/` | Pure logic: slot assignment, waitlist promotion, eligibility, time parsing (lang-tz aware), auto-clear write |
| Scheduler hook | `bot/services/raid/schedulers.js` (edit) | Each tick, scan `status:"open", autoLockAtStart:true, startAt <= now` -> lock + re-render board. Reuses the existing tick cadence (no new timer). |
| i18n | `bot/locales/{vi,en,jp}.js` (edit) | `raid-schedule.*` keys (parity test must stay green) |
| Help/docs | `bot/handlers/meta/help.js` + README (edit) | New `/raid-schedule` help section |

### Reuse map (≈70% of the primitives already exist)

- `isManagerId` / `getPrimaryManagerId` (`services/access/manager.js`) - lead gate.
- `RAID_REQUIREMENTS` + `getRaidRequirementList/Map` (`domain/raid-catalog.js`) -
  raid/mode choices + `minItemLevel`.
- `isSupportClass` + `getClassEmoji` (`models/Class.js`) - role derivation + slot icons.
- Roster lookup across the player's accounts (`services/access/access-control.js`
  `getAccessibleAccounts`, or a direct `User.findOne`) for the eligible-char list.
- The `/raid-set` write path (`handlers/raid/set.js` / `services/...`) - reused by the
  auto-clear step so writes go through the same auth + retry semantics.
- `saveWithRetry` (`models/user.js`) - optimistic-concurrency-safe writes.
- Interaction-router prefix routing (`buttonRoutes`, `selectRoutes`) - component wiring.
- i18n `t` + `getUserLanguage` + viewer-language rule for ephemeral/DM content
  (`[[feedback_i18n_viewer_language]]`).
- `artist-clock.getLangTzOffsetMinutes` (`utils/raid/schedule/artist-clock.js`) -
  interpret the lead's `HH:MM` input in their language timezone before storing UTC.
- Discord-native `<t:unix:R>`/`<t:unix:f>` timestamps - countdown for free,
  auto-localized to each viewer's region (handles the per-region time display).
- Existing scheduler tick (`services/raid/schedulers.js`) - host the auto-lock scan;
  no new timer needed.

---

## 5. Data model

Collection `raid_events`. One document per event.

```js
RaidEvent {
  guildId: String,        // indexed
  channelId: String,
  messageId: String,      // the board message, for edits; indexed
  creatorId: String,      // lead; indexed
  raidKey: String,        // armoche | kazeros | serca
  modeKey: String,        // normal | hard | nightmare
  minItemLevel: Number,   // snapshot at creation (catalog changes don't retroactively re-gate)
  partySize: Number,      // 4 | 8
  supSlots: Number,       // recommended support count (soft)
  dpsSlots: Number,       // recommended dps count (soft)
  title: String,
  startAt: Date,            // absolute UTC; input parsed in the lead's language tz (/raid-language)
  autoLockAtStart: Boolean, // default true; a scheduler tick locks the board at startAt
  roomName: String,       // default null; public on board
  roomPassword: String,   // default null; NEVER logged / never in public render

  // --- forward-compat enums (v1 uses one value; schema doesn't lock out v2) ---
  signupPolicy: String,   // enum ["open"] now; ["approval","whitelist"] later. default "open"
  status: String,         // enum ["open","locked","cleared","cancelled"]. default "open"

  signups: [Signup],
  clearedAt: Date,        // default null
  cancelledAt: Date,      // default null
  // timestamps: true (createdAt / updatedAt)
}

Signup {                  // _id: false
  discordId: String,            // unique within signups[] (one per user)
  accountName: String,          // which roster the char is from
  characterName: String,
  characterClass: String,
  characterItemLevel: Number,   // snapshot at signup
  role: String,                 // enum ["support","dps"], derived from class
  status: String,               // enum ["confirmed","late","tentative","absent","waitlisted"]
                                //   default "confirmed"; forward-compat: "pending","rejected"
  slotIndex: Number,            // position in its role group; null for waitlist/late/tentative/absent
  waitlistPos: Number,          // order in waitlist; null otherwise
  alreadyClearedThisWeek: Boolean, // computed at signup for the ⚠️ note
  joinedAt: Date,
}
```

Indexes: `{ guildId: 1 }`, `{ messageId: 1 }` (resolve board on interaction),
`{ creatorId: 1 }`, `{ status: 1 }` (find active events for future `list`/cleanup).

**Interaction custom IDs** carry the event id so handlers resolve the doc directly:
`rse:<action>:<eventId>` (e.g. `rse:join:<id>`, `rse:rsvp_late:<id>`, `rse:room:<id>`,
`rse:lock:<id>`, `rse:manage:<id>`, `rse:help:<id>`). Router matches the `rse:` prefix.

### 5.1 Slot assignment

`supSlots`/`dpsSlots` default by size (4 -> 1/3, 8 -> 2/6) but are stored so a future
"custom comp" can vary them. Soft enforcement: a confirmed signup whose role group is
full becomes `waitlisted` rather than being rejected; the lead can rebalance via
slot-move.

### 5.2 Waitlist auto-promote

When a confirmed slot frees (leave / kick / RSVP change), the earliest `waitlisted`
signup **of the matching role** is promoted to `confirmed` + assigned the open slot,
and **pinged in the channel** (`<@id>` in message `content`, not just embed, per
`[[feedback_discord_embed_mentions]]`). If no matching-role waitlister exists, the slot
stays open.

### 5.3 Status transitions (signup)

`confirmed <-> waitlisted` (capacity-driven), and any -> `late`/`tentative`/`absent`
(user choice). `absent` while holding a slot vacates it (-> promote check). Leaving
entirely removes the signup doc entry.

### 5.4 Auto-write clear (consent = signup)

On `Kết thúc`: for each signup with `status === "confirmed"`, write a clear of
`(raidKey, modeKey, all gates)` into that signup's **own** `/raid-status`, routed
through the existing `/raid-set` write path so auth + `saveWithRetry` semantics are
shared. Rationale: signing up with your own character is the authorization, mirroring
the existing "`registeredBy` = the act of registering is the authorization" pattern.
Signups in `late` also count as present (they cleared); `tentative`/`absent`/`waitlisted`
are **not** written. Failures per-character are non-fatal and reported in the cleared
summary.

---

## 6. Forward-compatibility

The deferred features map onto hooks placed in v1 so they graft without migration:

- **Approval queue / whitelist:** `event.signupPolicy` enum + signup `status`
  (`pending`/`rejected` reserved). v1 only ever sets `open` / `confirmed`.
- **Role/iLvl restriction:** `minItemLevel` is already a per-event snapshot field; a
  future `maxItemLevel` + `allowedRoleId` are additive.
- **Reminder ping / recurring:** `startAt` is a real timestamp; a scheduler tick could
  scan `status: "open"` events. No v1 ticking, but the field shape supports it.
- **Co-lead:** reuse the existing `RosterShare`-style grant pattern; event could gain a
  `coLeads: [String]` later.

---

## 7. Edge cases & error handling

- **No qualifying character / no roster:** signup ephemeral explains + links
  `/raid-add-roster`. Never a hard error.
- **Stale iLvl:** signup validates against the cached roster iLvl at signup time
  (snapshot in `characterItemLevel`). v1 does not re-validate at lock; noted as a
  potential v2 refinement.
- **Board message deleted:** interactions resolve the event by id from the customId;
  if the message is gone, reply ephemerally that the board was removed.
- **Concurrent signups (race):** all mutations go through `saveWithRetry`
  (optimistic-concurrency); re-render reads fresh state.
- **Lead loses manager status:** lead-only buttons re-check `isManagerId` at click time
  and reject if revoked (mirrors `RosterShare` auto-suspend behavior).
- **Password safety:** never logged, never in public embed; only in the gated ephemeral.
- **Discord component limits:** 3 rows / max 4 buttons per row used - within limits.

---

## 8. Wiring checklist (the known gotcha)

Per `[[feedback_raidmanage_command_wiring]]`, a new slash command needs BOTH:

1. The dispatch map in `bot/commands.js` (command name -> handler).
2. `"raid-schedule"` added to `RAID_COMMAND_NAMES` in
   `bot/app/interaction-router-registry.js` (the allowlist), **plus** a `buttonRoutes`
   (and `selectRoutes` for the picker / `Quản lý` select) entry with the `rse:` prefix.

Missing the allowlist = the command registers but silently does nothing. The existing
parity test ("interaction router allowlist includes every registered slash command")
will catch a missing allowlist entry; add component-route coverage too.

Also sync all three surfaces in the same commit (`[[feedback_sync_help_docs]]`):
`HELP_SECTIONS` (`handlers/meta/help.js`) + README + any pinned welcome embed.

---

## 9. i18n

All user-facing strings under the `raid-schedule.*` namespace in `vi` / `en` / `jp`
(parity test must stay green). Ephemeral + DM/ping content renders in the **clicker's**
language, not the creator's (`[[feedback_i18n_viewer_language]]`). Code comments +
console logs stay English (`[[feedback_comments_in_english]]`); no em-dash in any
user-facing string (`[[feedback_no_emdash]]`); no `*italic*` stage directions
(`[[feedback_no_stage_directions]]`); Artist voice, VN-first, emoji restraint.

---

## 10. Testing strategy

- **Service unit tests** (pure, no Discord): slot assignment (4 and 8 size), waitlist
  promote (matching-role only), eligibility gating (iLvl floor, support/dps split),
  time parser (per-language tz: vi/jp/en `HH:MM` -> correct UTC instant; `+Nh`/`+Nm`;
  reject ambiguous), RSVP transitions vacating slots, auto-clear target selection
  (confirmed + late only).
- **Lifecycle tests:** open -> locked -> cleared writes clears; open -> cancelled writes
  none; promote pings only on real promote; auto-lock scan flips only
  `autoLockAtStart:true` events whose `startAt` has passed, and only once.
- **Wiring guard:** extend the router-allowlist parity test to assert `raid-schedule`
  + its component prefixes are routed.
- **i18n parity:** `raid-schedule.*` keys present in all three packs.
- Run the full suite twice consecutively for stability before each commit (Traine's
  standing preference: tests must pass across repeated runs, not just once).

---

## 11. Resolved decisions (Traine, 2026-05-29 review)

1. **Command name:** `/raid-schedule` (shortened from `raid-schedule-manager`). ✅
2. **`when` input + timezone:** `HH:MM` interpreted in the **lead's language timezone**
   (`/raid-language` -> `artist-clock.getLangTzOffsetMinutes`: vi UTC+7, jp UTC+9, en
   UTC), stored as absolute UTC. Display via Discord-native timestamp so each viewer
   sees their own region's time. Relative `+Nh`/`+Nm` also accepted (tz-independent).
3. **Auto-lock:** lead's choice per event - an `auto_lock` creation option (default
   true) + a `⚙️ Quản lý -> Tự khoá` toggle. When on, a scheduler tick locks the board
   at `startAt`. Manual lock/unlock always available too.
4. **Empty slots:** show "còn trống" placeholders so the comp shape is visible. ✅
5. **Cleared board:** keep the full frozen comp as a record. ✅
