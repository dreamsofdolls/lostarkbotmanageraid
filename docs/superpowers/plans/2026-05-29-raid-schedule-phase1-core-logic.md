# /raid-schedule Phase 1 - Core Logic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, Discord-free foundation for the `/raid-schedule` signup board: the `RaidEvent` Mongoose model plus the service logic for slot/role math, waitlist, item-level eligibility, language-timezone start-time parsing, and auto-clear target selection.

**Architecture:** All logic in this phase is pure functions (no Discord, no live Mongo) under `bot/services/raid/schedule/`, plus one Mongoose schema. Each module has one responsibility and is unit-tested with `node --test`. Phase 2 (command + board + signup handlers + wiring) and Phase 3 (manage/room/help + scheduler auto-lock + auto-clear write + docs) build on top, in their own plans.

**Tech Stack:** Node.js (CommonJS), Mongoose 8, `node:test` + `node:assert/strict`. Reuses existing `models/Class.isSupportClass`, `domain/raid-catalog` (`getGatesForRaid`, `RAID_REQUIREMENTS`), and `utils/raid/schedule/artist-clock.getLangTzOffsetMinutes`.

**Spec:** `docs/superpowers/specs/2026-05-29-raid-schedule-manager-design.md`

**Conventions (this repo):**
- CommonJS `require` / `module.exports`.
- Comment spec: 4-7 line file header `/** */`, JSDoc with `@param`/`@returns` on every export, English comments, `// ─── Section ───` dividers (U+2500) in long files.
- Tests: `node --test`, factory/dependency-injection where Discord objects would be needed (not needed in Phase 1).
- Run `npm test` and confirm green **twice consecutively** before each commit (Traine's standing preference).
- Commit per task. Do **not** push until the final task (these are new files not yet required by `bot.js`, so no runtime impact; one push at phase end avoids redundant Railway deploys).

---

## File Structure

| File | Responsibility |
|---|---|
| `bot/services/raid/schedule/slot-config.js` (create) | Map party size (4/8) -> recommended support/dps slot counts |
| `bot/services/raid/schedule/time-parse.js` (create) | Parse `+Nh`/`+Nm` and lang-tz `HH:MM` start-time input -> absolute UTC `Date` |
| `bot/services/raid/schedule/eligibility.js` (create) | Role derivation, already-cleared check, roster -> eligible-character list with iLvl gate |
| `bot/services/raid/schedule/slots.js` (create) | Assign confirmed/late signups into support/dps slots + waitlist; next-promotion lookup |
| `bot/services/raid/schedule/auto-clear.js` (create) | Select auto-clear write targets (confirmed + late) from an event |
| `bot/models/RaidEvent.js` (create) | Mongoose schema for `raid_events` (event + embedded signups) |
| `test/raid-schedule-slot-config.test.js` (create) | Tests for slot-config |
| `test/raid-schedule-time-parse.test.js` (create) | Tests for time-parse |
| `test/raid-schedule-eligibility.test.js` (create) | Tests for eligibility |
| `test/raid-schedule-slots.test.js` (create) | Tests for slots + waitlist |
| `test/raid-schedule-auto-clear.test.js` (create) | Tests for auto-clear target selection |
| `test/raid-schedule-model.test.js` (create) | Tests for RaidEvent defaults + enums |

---

### Task 1: Slot config (party size -> slot counts)

**Files:**
- Create: `bot/services/raid/schedule/slot-config.js`
- Test: `test/raid-schedule-slot-config.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/raid-schedule-slot-config.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const { slotCountsForSize } = require("../bot/services/raid/schedule/slot-config");

test("slotCountsForSize: 4-man is 1 support + 3 dps", () => {
  assert.deepEqual(slotCountsForSize(4), { supSlots: 1, dpsSlots: 3 });
});

test("slotCountsForSize: 8-man is 2 support + 6 dps", () => {
  assert.deepEqual(slotCountsForSize(8), { supSlots: 2, dpsSlots: 6 });
});

test("slotCountsForSize: rejects unsupported sizes", () => {
  assert.throws(() => slotCountsForSize(6), /unsupported party size/);
  assert.throws(() => slotCountsForSize(0), /unsupported party size/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/raid-schedule-slot-config.test.js`
Expected: FAIL - cannot find module `../bot/services/raid/schedule/slot-config`.

- [ ] **Step 3: Write minimal implementation**

```js
// bot/services/raid/schedule/slot-config.js
/**
 * services/raid/schedule/slot-config.js
 * Recommended Support/DPS slot split per party size. Soft guidance only -
 * the board does not hard-enforce roles, but these counts drive the
 * default comp shape (4-man = 1 sup + 3 dps, 8-man = 2 sup + 6 dps) and
 * the waitlist overflow boundary.
 */

"use strict";

/**
 * Recommended slot counts for a party size.
 * @param {number} size - party size, 4 or 8
 * @returns {{supSlots: number, dpsSlots: number}}
 * @throws {Error} when size is not 4 or 8
 */
function slotCountsForSize(size) {
  if (size === 4) return { supSlots: 1, dpsSlots: 3 };
  if (size === 8) return { supSlots: 2, dpsSlots: 6 };
  throw new Error(`[raid-schedule] unsupported party size: ${size}`);
}

module.exports = { slotCountsForSize };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/raid-schedule-slot-config.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add bot/services/raid/schedule/slot-config.js test/raid-schedule-slot-config.test.js
git commit -m "Add raid-schedule slot-config (party size to slot counts)"
```

---

### Task 2: Start-time parsing (relative + lang-tz HH:MM)

**Files:**
- Create: `bot/services/raid/schedule/time-parse.js`
- Test: `test/raid-schedule-time-parse.test.js`

Reuses `getLangTzOffsetMinutes(lang)` from `utils/raid/schedule/artist-clock`
(vi = 420, jp = 540, en = 0 minutes).

- [ ] **Step 1: Write the failing test**

```js
// test/raid-schedule-time-parse.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseStartTime } = require("../bot/services/raid/schedule/time-parse");

// Fixed anchor: 2026-05-29 05:00:00 UTC (= 12:00 VN, 14:00 JST, 05:00 UTC/en).
const NOW = new Date(Date.UTC(2026, 4, 29, 5, 0, 0));

test("relative +Nh / +Nm is timezone-independent", () => {
  assert.equal(parseStartTime("+2h", "vi", NOW).getTime(), Date.UTC(2026, 4, 29, 7, 0));
  assert.equal(parseStartTime("+90m", "jp", NOW).getTime(), Date.UTC(2026, 4, 29, 6, 30));
});

test("HH:MM resolves in the lead's language timezone", () => {
  // 20:00 VN = 13:00 UTC; 20:00 JST = 11:00 UTC; 20:00 en(UTC) = 20:00 UTC.
  assert.equal(parseStartTime("20:00", "vi", NOW).getTime(), Date.UTC(2026, 4, 29, 13, 0));
  assert.equal(parseStartTime("20:00", "jp", NOW).getTime(), Date.UTC(2026, 4, 29, 11, 0));
  assert.equal(parseStartTime("20:00", "en", NOW).getTime(), Date.UTC(2026, 4, 29, 20, 0));
});

test("HH:MM already past today rolls to the next day", () => {
  const late = new Date(Date.UTC(2026, 4, 29, 13, 30)); // 20:30 VN
  assert.equal(parseStartTime("20:00", "vi", late).getTime(), Date.UTC(2026, 4, 30, 13, 0));
});

test("invalid input returns null", () => {
  assert.equal(parseStartTime("25:00", "vi", NOW), null);
  assert.equal(parseStartTime("20:99", "vi", NOW), null);
  assert.equal(parseStartTime("+0h", "vi", NOW), null);
  assert.equal(parseStartTime("tonight", "vi", NOW), null);
  assert.equal(parseStartTime("", "vi", NOW), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/raid-schedule-time-parse.test.js`
Expected: FAIL - cannot find module `time-parse`.

- [ ] **Step 3: Write minimal implementation**

```js
// bot/services/raid/schedule/time-parse.js
/**
 * services/raid/schedule/time-parse.js
 * Parse a lead's start-time input into an absolute UTC Date. Two forms:
 * relative "+Nh"/"+Nm" (timezone-independent) and absolute "HH:MM"
 * interpreted in the lead's language timezone (see /raid-language ->
 * artist-clock.getLangTzOffsetMinutes), resolving to the next occurrence.
 * Returns null on unparseable input so the caller can show an example.
 * Fixed-offset model (no DST), consistent with artist-clock.
 */

"use strict";

const { getLangTzOffsetMinutes } = require("../../../utils/raid/schedule/artist-clock");

const RELATIVE_RE = /^\+(\d{1,4})(h|m)$/;
const CLOCK_RE = /^(\d{1,2}):(\d{2})$/;

/**
 * Parse a start-time string to an absolute UTC Date.
 * @param {string} input - "+2h" / "+90m" / "20:00"
 * @param {string} lang - lead language code (vi/jp/en) for the HH:MM timezone
 * @param {Date} [now=new Date()] - clock anchor (injectable for tests)
 * @returns {Date|null} absolute instant, or null when unparseable
 */
function parseStartTime(input, lang, now = new Date()) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return null;

  const rel = RELATIVE_RE.exec(raw);
  if (rel) {
    const n = Number(rel[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = rel[2] === "h" ? n * 3600000 : n * 60000;
    return new Date(now.getTime() + ms);
  }

  const clock = CLOCK_RE.exec(raw);
  if (clock) {
    const hh = Number(clock[1]);
    const mm = Number(clock[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    const offsetMs = getLangTzOffsetMinutes(lang) * 60000;
    // Shift `now` into the lead's local wall clock so its UTC fields read as local.
    const localNow = new Date(now.getTime() + offsetMs);
    let targetLocalMs = Date.UTC(
      localNow.getUTCFullYear(),
      localNow.getUTCMonth(),
      localNow.getUTCDate(),
      hh,
      mm,
      0,
      0
    );
    // Same-day slot already passed -> use the next day's occurrence.
    if (targetLocalMs <= localNow.getTime()) targetLocalMs += 24 * 3600000;
    return new Date(targetLocalMs - offsetMs);
  }

  return null;
}

module.exports = { parseStartTime };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/raid-schedule-time-parse.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add bot/services/raid/schedule/time-parse.js test/raid-schedule-time-parse.test.js
git commit -m "Add raid-schedule time-parse (relative + lang-tz HH:MM)"
```

---

### Task 3: Eligibility (role, already-cleared, roster filter)

**Files:**
- Create: `bot/services/raid/schedule/eligibility.js`
- Test: `test/raid-schedule-eligibility.test.js`

Reuses `isSupportClass` (`models/Class`) and `getGatesForRaid` (`domain/raid-catalog`).
`getGatesForRaid("armoche")` returns `["G1", "G2"]`.

- [ ] **Step 1: Write the failing test**

```js
// test/raid-schedule-eligibility.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deriveRole,
  hasClearedRaid,
  listEligibleCharacters,
} = require("../bot/services/raid/schedule/eligibility");

test("deriveRole maps support classes vs dps", () => {
  assert.equal(deriveRole("Bard"), "support");
  assert.equal(deriveRole("Paladin"), "support");
  assert.equal(deriveRole("Berserker"), "dps");
  assert.equal(deriveRole(""), "dps");
});

test("hasClearedRaid is true only when all gates have a completion", () => {
  const cleared = { assignedRaids: { armoche: { G1: { completedDate: 1 }, G2: { completedDate: 2 } } } };
  const partial = { assignedRaids: { armoche: { G1: { completedDate: 1 } } } };
  const none = { assignedRaids: {} };
  assert.equal(hasClearedRaid(cleared, "armoche"), true);
  assert.equal(hasClearedRaid(partial, "armoche"), false);
  assert.equal(hasClearedRaid(none, "armoche"), false);
});

test("listEligibleCharacters flags iLvl gate, role, deficit, cleared", () => {
  const accounts = [
    {
      accountName: "Main",
      characters: [
        { name: "Senko", class: "Bard", itemLevel: 1725, assignedRaids: {} },
        { name: "Morrah", class: "Berserker", itemLevel: 1722,
          assignedRaids: { armoche: { G1: { completedDate: 1 }, G2: { completedDate: 1 } } } },
        { name: "Lowblade", class: "Deathblade", itemLevel: 1715, assignedRaids: {} },
      ],
    },
  ];
  const rows = listEligibleCharacters(accounts, { raidKey: "armoche", minItemLevel: 1720 });
  assert.equal(rows.length, 3);

  const senko = rows.find((r) => r.name === "Senko");
  assert.equal(senko.role, "support");
  assert.equal(senko.eligible, true);
  assert.equal(senko.deficit, 0);
  assert.equal(senko.alreadyCleared, false);

  const morrah = rows.find((r) => r.name === "Morrah");
  assert.equal(morrah.role, "dps");
  assert.equal(morrah.eligible, true);
  assert.equal(morrah.alreadyCleared, true);

  const low = rows.find((r) => r.name === "Lowblade");
  assert.equal(low.eligible, false);
  assert.equal(low.deficit, 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/raid-schedule-eligibility.test.js`
Expected: FAIL - cannot find module `eligibility`.

- [ ] **Step 3: Write minimal implementation**

```js
// bot/services/raid/schedule/eligibility.js
/**
 * services/raid/schedule/eligibility.js
 * Roster-aware eligibility for /raid-schedule signups. Derives a
 * character's role (support vs dps) from its class, checks whether it has
 * already cleared a raid this week (all gates stamped), and flattens a
 * user's accounts into a per-character list with an item-level gate flag
 * + deficit so the signup picker can show eligible chars selectable and
 * ineligible chars greyed with the missing iLvl.
 */

"use strict";

const { isSupportClass } = require("../../../models/Class");
const { getGatesForRaid } = require("../../../domain/raid-catalog");

/**
 * Derive a slot role from a class display name.
 * @param {string} className - e.g. "Bard", "Berserker"
 * @returns {"support"|"dps"}
 */
function deriveRole(className) {
  return isSupportClass(className) ? "support" : "dps";
}

/**
 * Whether a character has cleared every gate of a raid this week. Relies on
 * the existing weekly reset clearing `completedDate`, so a positive stamp
 * on every gate means "cleared this cycle".
 * @param {object} character - roster character sub-document
 * @param {string} raidKey - armoche | kazeros | serca
 * @returns {boolean}
 */
function hasClearedRaid(character, raidKey) {
  const assigned = character?.assignedRaids?.[raidKey];
  if (!assigned) return false;
  return getGatesForRaid(raidKey).every(
    (gate) => Number(assigned?.[gate]?.completedDate) > 0
  );
}

/**
 * Flatten a user's accounts into a per-character eligibility list.
 * @param {Array} accounts - User.accounts[]
 * @param {{raidKey: string, minItemLevel: number}} target - the event's raid + iLvl floor
 * @returns {Array<{accountName: string, name: string, className: string, itemLevel: number, role: "support"|"dps", eligible: boolean, deficit: number, alreadyCleared: boolean}>}
 */
function listEligibleCharacters(accounts, { raidKey, minItemLevel }) {
  const rows = [];
  for (const account of accounts || []) {
    for (const ch of account?.characters || []) {
      const itemLevel = Number(ch?.itemLevel) || 0;
      const eligible = itemLevel >= minItemLevel;
      rows.push({
        accountName: account.accountName,
        name: ch.name,
        className: ch.class,
        itemLevel,
        role: deriveRole(ch.class),
        eligible,
        deficit: eligible ? 0 : minItemLevel - itemLevel,
        alreadyCleared: hasClearedRaid(ch, raidKey),
      });
    }
  }
  return rows;
}

module.exports = { deriveRole, hasClearedRaid, listEligibleCharacters };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/raid-schedule-eligibility.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add bot/services/raid/schedule/eligibility.js test/raid-schedule-eligibility.test.js
git commit -m "Add raid-schedule eligibility (role, cleared, iLvl gate)"
```

---

### Task 4: Slot assignment + waitlist promotion

**Files:**
- Create: `bot/services/raid/schedule/slots.js`
- Test: `test/raid-schedule-slots.test.js`

Slot-occupying statuses are `confirmed` + `late` (per spec - a late player keeps
their slot). Tentative/absent are excluded by the filter and handled by the caller.

- [ ] **Step 1: Write the failing test**

```js
// test/raid-schedule-slots.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const { assignSlots, nextWaitlistPromotion } = require("../bot/services/raid/schedule/slots");

const sigs = [
  { discordId: "a", role: "support", status: "confirmed", joinedAt: 1 },
  { discordId: "b", role: "support", status: "confirmed", joinedAt: 2 },
  { discordId: "c", role: "support", status: "confirmed", joinedAt: 3 }, // overflow (8-man = 2 sup)
  { discordId: "d", role: "dps", status: "late", joinedAt: 4 },          // late still holds a slot
  { discordId: "e", role: "dps", status: "tentative", joinedAt: 5 },     // excluded - no slot
];

test("assignSlots fills by join order, overflow to waitlist, by role", () => {
  const { support, dps, waitlist } = assignSlots(sigs, { supSlots: 2, dpsSlots: 6 });
  assert.deepEqual(support.map((s) => s.discordId), ["a", "b"]);
  assert.deepEqual(dps.map((s) => s.discordId), ["d"]);          // 'e' tentative excluded
  assert.deepEqual(waitlist.map((s) => s.discordId), ["c"]);     // 3rd support overflows
});

test("nextWaitlistPromotion returns the first waitlisted of the freed role", () => {
  // c (support) is waitlisted; freeing a support slot should promote c.
  assert.equal(nextWaitlistPromotion(sigs, { supSlots: 2, dpsSlots: 6 }, "support").discordId, "c");
  // No dps is waitlisted, so a freed dps slot has no promotion.
  assert.equal(nextWaitlistPromotion(sigs, { supSlots: 2, dpsSlots: 6 }, "dps"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/raid-schedule-slots.test.js`
Expected: FAIL - cannot find module `slots`.

- [ ] **Step 3: Write minimal implementation**

```js
// bot/services/raid/schedule/slots.js
/**
 * services/raid/schedule/slots.js
 * Pure slot-assignment for the /raid-schedule board. Given the
 * slot-occupying signups (confirmed + late) and the recommended
 * support/dps counts, partition them into support / dps / waitlist by
 * join order. Overflow within a role spills to the waitlist; promotion
 * looks up the first waitlisted signup of a freed role.
 */

"use strict";

// confirmed + late both hold a slot (a late player is still in the comp).
const SLOT_STATUSES = new Set(["confirmed", "late"]);

/**
 * Partition signups into filled slots + waitlist.
 * @param {Array<{discordId: string, role: "support"|"dps", status: string, joinedAt: number}>} signups
 * @param {{supSlots: number, dpsSlots: number}} counts
 * @returns {{support: Array, dps: Array, waitlist: Array}}
 */
function assignSlots(signups, { supSlots, dpsSlots }) {
  const occupying = (signups || [])
    .filter((s) => SLOT_STATUSES.has(s.status))
    .slice()
    .sort((a, b) => Number(a.joinedAt) - Number(b.joinedAt));

  const support = [];
  const dps = [];
  const waitlist = [];
  for (const s of occupying) {
    if (s.role === "support" && support.length < supSlots) support.push(s);
    else if (s.role === "dps" && dps.length < dpsSlots) dps.push(s);
    else waitlist.push(s);
  }
  return { support, dps, waitlist };
}

/**
 * First waitlisted signup of a given role (the one a freed slot promotes).
 * @param {Array} signups - all signups
 * @param {{supSlots: number, dpsSlots: number}} counts
 * @param {"support"|"dps"} role - the role whose slot just freed
 * @returns {object|null} the promotable signup, or null
 */
function nextWaitlistPromotion(signups, counts, role) {
  const { waitlist } = assignSlots(signups, counts);
  return waitlist.find((s) => s.role === role) || null;
}

module.exports = { assignSlots, nextWaitlistPromotion, SLOT_STATUSES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/raid-schedule-slots.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add bot/services/raid/schedule/slots.js test/raid-schedule-slots.test.js
git commit -m "Add raid-schedule slot assignment + waitlist promotion"
```

---

### Task 5: Auto-clear target selection

**Files:**
- Create: `bot/services/raid/schedule/auto-clear.js`
- Test: `test/raid-schedule-auto-clear.test.js`

Selects which (signup -> own character) clears to write when the lead ends the raid.
Only `confirmed` + `late` are written; tentative/absent/waitlisted are not. The actual
write through the `/raid-set` path is Phase 3 - this module only chooses targets.

- [ ] **Step 1: Write the failing test**

```js
// test/raid-schedule-auto-clear.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const { selectAutoClearTargets } = require("../bot/services/raid/schedule/auto-clear");

test("selectAutoClearTargets returns confirmed + late, with raid gates", () => {
  const event = {
    raidKey: "armoche",
    modeKey: "hard",
    signups: [
      { discordId: "a", accountName: "Main", characterName: "Senko", status: "confirmed" },
      { discordId: "b", accountName: "Alt", characterName: "Latedps", status: "late" },
      { discordId: "c", accountName: "Main", characterName: "Maybe", status: "tentative" },
      { discordId: "d", accountName: "Main", characterName: "Bench", status: "waitlisted" },
    ],
  };
  const targets = selectAutoClearTargets(event);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map((t) => t.characterName), ["Senko", "Latedps"]);
  assert.deepEqual(targets[0], {
    discordId: "a",
    accountName: "Main",
    characterName: "Senko",
    raidKey: "armoche",
    modeKey: "hard",
    gates: ["G1", "G2"],
  });
});

test("selectAutoClearTargets is safe on an empty / malformed event", () => {
  assert.deepEqual(selectAutoClearTargets(null), []);
  assert.deepEqual(selectAutoClearTargets({ raidKey: "armoche" }), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/raid-schedule-auto-clear.test.js`
Expected: FAIL - cannot find module `auto-clear`.

- [ ] **Step 3: Write minimal implementation**

```js
// bot/services/raid/schedule/auto-clear.js
/**
 * services/raid/schedule/auto-clear.js
 * Choose the auto-clear write targets when a /raid-schedule event ends.
 * Each confirmed or late signup -> a clear of (raidKey, modeKey, all
 * gates) on that signup's OWN character (consent = the act of signing up).
 * Pure target selection only; the actual write goes through the /raid-set
 * path in a later phase.
 */

"use strict";

const { getGatesForRaid } = require("../../../domain/raid-catalog");

// Only players who held a slot (confirmed + late) get a clear written.
const CLEAR_STATUSES = new Set(["confirmed", "late"]);

/**
 * Build the list of clear-write targets for a finished event.
 * @param {object} event - RaidEvent doc (needs raidKey, modeKey, signups[])
 * @returns {Array<{discordId: string, accountName: string, characterName: string, raidKey: string, modeKey: string, gates: string[]}>}
 */
function selectAutoClearTargets(event) {
  if (!event || !Array.isArray(event.signups)) return [];
  const gates = getGatesForRaid(event.raidKey);
  return event.signups
    .filter((s) => CLEAR_STATUSES.has(s.status))
    .map((s) => ({
      discordId: s.discordId,
      accountName: s.accountName,
      characterName: s.characterName,
      raidKey: event.raidKey,
      modeKey: event.modeKey,
      gates,
    }));
}

module.exports = { selectAutoClearTargets, CLEAR_STATUSES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/raid-schedule-auto-clear.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add bot/services/raid/schedule/auto-clear.js test/raid-schedule-auto-clear.test.js
git commit -m "Add raid-schedule auto-clear target selection"
```

---

### Task 6: RaidEvent Mongoose model

**Files:**
- Create: `bot/models/RaidEvent.js`
- Test: `test/raid-schedule-model.test.js`

The test instantiates the model in-memory (no DB connection) and reads defaults +
validates enums via `validateSync`, mirroring how the repo tests schemas without Mongo.

- [ ] **Step 1: Write the failing test**

```js
// test/raid-schedule-model.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const RaidEvent = require("../bot/models/RaidEvent");

test("RaidEvent applies lifecycle + policy + auto-lock defaults", () => {
  const ev = new RaidEvent({
    guildId: "g1",
    channelId: "c1",
    messageId: "m1",
    creatorId: "lead1",
    raidKey: "armoche",
    modeKey: "hard",
    minItemLevel: 1720,
    partySize: 8,
    supSlots: 2,
    dpsSlots: 6,
    startAt: new Date(),
  });
  assert.equal(ev.status, "open");
  assert.equal(ev.signupPolicy, "open");
  assert.equal(ev.autoLockAtStart, true);
  assert.equal(ev.roomName, null);
  assert.equal(ev.roomPassword, null);
  assert.deepEqual(ev.signups.toObject?.() ?? ev.signups, []);
});

test("RaidEvent rejects an out-of-enum status", () => {
  const ev = new RaidEvent({
    guildId: "g1", channelId: "c1", messageId: "m1", creatorId: "lead1",
    raidKey: "armoche", modeKey: "hard", minItemLevel: 1720,
    partySize: 8, supSlots: 2, dpsSlots: 6, startAt: new Date(),
    status: "bogus",
  });
  const err = ev.validateSync();
  assert.ok(err && err.errors.status, "expected a validation error on status");
});

test("RaidEvent signup defaults to confirmed with null slot positions", () => {
  const ev = new RaidEvent({
    guildId: "g1", channelId: "c1", messageId: "m1", creatorId: "lead1",
    raidKey: "armoche", modeKey: "hard", minItemLevel: 1720,
    partySize: 8, supSlots: 2, dpsSlots: 6, startAt: new Date(),
    signups: [{
      discordId: "u1", accountName: "Main", characterName: "Senko",
      characterClass: "Bard", characterItemLevel: 1725, role: "support",
    }],
  });
  assert.equal(ev.signups[0].status, "confirmed");
  assert.equal(ev.signups[0].slotIndex, null);
  assert.equal(ev.signups[0].waitlistPos, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/raid-schedule-model.test.js`
Expected: FAIL - cannot find module `../bot/models/RaidEvent`.

- [ ] **Step 3: Write minimal implementation**

```js
// bot/models/RaidEvent.js
/**
 * models/RaidEvent.js
 * One document per /raid-schedule event (collection raid_events). Holds
 * the raid target, slot config, start time, optional room+password, and
 * the embedded signups. Forward-compat enums kept deliberately open:
 * `signupPolicy` and signup `status` reserve values (approval/whitelist,
 * pending/rejected) that v1 never sets but v2 can graft onto without a
 * migration. Invariant: roomPassword is never logged or rendered publicly.
 */

"use strict";

const mongoose = require("mongoose");

const signupSchema = new mongoose.Schema(
  {
    discordId: { type: String, required: true },
    accountName: { type: String, required: true },
    characterName: { type: String, required: true },
    characterClass: { type: String, default: "" },
    characterItemLevel: { type: Number, default: 0 },
    role: { type: String, enum: ["support", "dps"], required: true },
    // v1 sets only confirmed/late/tentative/absent/waitlisted; pending +
    // rejected are reserved for the deferred approval mode.
    status: {
      type: String,
      enum: ["confirmed", "late", "tentative", "absent", "waitlisted", "pending", "rejected"],
      default: "confirmed",
    },
    slotIndex: { type: Number, default: null },
    waitlistPos: { type: Number, default: null },
    alreadyClearedThisWeek: { type: Boolean, default: false },
    joinedAt: { type: Number, default: () => Date.now() },
  },
  { _id: false }
);

const raidEventSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true },
    messageId: { type: String, default: null, index: true },
    creatorId: { type: String, required: true, index: true },
    raidKey: { type: String, required: true },
    modeKey: { type: String, required: true },
    // Snapshot at creation so later catalog edits never retroactively re-gate.
    minItemLevel: { type: Number, required: true },
    partySize: { type: Number, required: true },
    supSlots: { type: Number, required: true },
    dpsSlots: { type: Number, required: true },
    title: { type: String, default: "" },
    // Absolute UTC; input parsed in the lead's language tz (/raid-language).
    startAt: { type: Date, required: true },
    autoLockAtStart: { type: Boolean, default: true },
    roomName: { type: String, default: null },
    roomPassword: { type: String, default: null },
    signupPolicy: { type: String, enum: ["open", "approval", "whitelist"], default: "open" },
    status: {
      type: String,
      enum: ["open", "locked", "cleared", "cancelled"],
      default: "open",
    },
    signups: { type: [signupSchema], default: [] },
    clearedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true, optimisticConcurrency: true }
);

// Find active events quickly (future list / auto-lock scan / cleanup).
raidEventSchema.index({ status: 1 });

module.exports = mongoose.model("RaidEvent", raidEventSchema, "raid_events");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/raid-schedule-model.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add bot/models/RaidEvent.js test/raid-schedule-model.test.js
git commit -m "Add RaidEvent model for /raid-schedule events"
```

---

### Task 7: Full-suite verification + push

**Files:** none (verification only)

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS - the prior green count (471) plus the new Phase 1 tests (16 new
assertions across 6 files), 0 fail.

- [ ] **Step 2: Run the full suite a second time (stability)**

Run: `npm test`
Expected: identical PASS, 0 fail. (Traine's standing rule: green twice in a row.)

- [ ] **Step 3: Update CHANGELOG**

Add a dated entry under the top of `CHANGELOG.md`:

```markdown
## 2026-05-29 (raid-schedule phase 1: core logic)

### Added
- Foundation for the upcoming `/raid-schedule` signup board (no user-facing surface yet): `RaidEvent` model (`raid_events`) plus pure service logic under `bot/services/raid/schedule/` - slot-config (party size -> sup/dps counts), time-parse (relative `+Nh`/`+Nm` and lang-tz `HH:MM` -> absolute UTC), eligibility (role + already-cleared + iLvl gate over a roster), slots (confirmed/late assignment + waitlist + promotion), auto-clear target selection (confirmed + late). Fully unit-tested; not yet wired into any command. Design spec + plan in `docs/superpowers/`.
```

- [ ] **Step 4: Commit + push the phase**

```bash
git add CHANGELOG.md
git commit -m "raid-schedule phase 1: changelog"
git push
```

Expected: push succeeds; Railway redeploys (no behavior change - new modules are not
yet required by `bot.js`).

---

## Self-Review (completed by author)

**Spec coverage (Phase 1 slice):** model (spec §5) -> Task 6; slot/role math + waitlist
(§5.1, §5.2) -> Tasks 1, 4; eligibility/iLvl gate + already-cleared (§3.3, §2) -> Task 3;
lang-tz time parse (§3.1, §11.2) -> Task 2; auto-clear target selection (§5.4) -> Task 5.
Discord surface (command, board, signup picker, manage, room/help, scheduler auto-lock,
the actual clear write, wiring, i18n, docs) is intentionally **Phase 2/3** and not in
this plan.

**Placeholder scan:** none - every code/test step has complete content.

**Type consistency:** `assignSlots`/`nextWaitlistPromotion` signatures match between
Task 4 code and the auto-clear/model usages; `status` values (`confirmed`/`late`/
`tentative`/`absent`/`waitlisted`) are identical across Tasks 4, 5, 6; `role`
(`support`/`dps`) consistent across Tasks 3, 4, 6; `{supSlots, dpsSlots}` shape
consistent across Tasks 1, 4. `selectAutoClearTargets` output shape matches the
`/raid-set` write inputs it will feed in Phase 3 (raidKey, modeKey, gates, character).

**Phasing note:** Phase 2 plan will cover `/raid-schedule create` + board renderer +
signup ephemeral picker + interaction-router wiring (the `[[feedback_raidmanage_command_wiring]]`
checklist) + i18n keys. Phase 3 plan will cover the manage/room/help handlers, the
scheduler auto-lock scan, the auto-clear write through `/raid-set`, and the docs sync.
