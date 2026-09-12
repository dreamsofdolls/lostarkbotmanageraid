"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAutoManageApplier } = require("../bot/services/auto-manage/runtime/pipeline/apply");
const { createAutoManageReconciler } = require("../bot/services/auto-manage/runtime/pipeline/reconcile");
const { ensureFreshWeek } = require("../bot/services/raid/schedulers/weekly-reset");
const { weeklyResetStartMs, weeklyResetStartFromKey } = require("../bot/utils/raid/schedule/reset-windows");
const { ensureAssignedRaids, normalizeAssignedRaid, RAID_REQUIREMENT_MAP } = require("../bot/utils/raid/common/character");
const { normalizeName, toModeLabel, getCharacterName, getCharacterClass } = require("../bot/utils/raid/common/shared");
const { getRaidGateForBoss, getGatesForRaid } = require("../bot/domain/raid-catalog");

const { reconcileCharacterFromLogs } = createAutoManageReconciler({
  ensureAssignedRaids, normalizeAssignedRaid, RAID_REQUIREMENT_MAP,
  normalizeName, toModeLabel, getRaidGateForBoss, getGatesForRaid,
});
const { applyAutoManageCollected } = createAutoManageApplier({
  autoManageEntryKey: (account, character) => `${account}:${character}`,
  getCharacterName, getCharacterClass, isPublicLogDisabledError: () => false,
  reconcileCharacterFromLogs,
});

for (const reset of ['2026-09-09T10:00:00Z', '2020-12-30T10:00:00Z', '2021-01-06T10:00:00Z']) {
  test(`a Bible result gathered before ${reset} cannot restore the previous week's gates`, () => {
    const resetMs = Date.parse(reset);
    const before = new Date(resetMs - 1000);
    const character = { name: 'Aki', class: 'Artist', itemLevel: 1750, assignedRaids: {} };
    const user = { accounts: [{ accountName: 'Roster', characters: [character] }] };
    ensureFreshWeek(user, before);
    const gatheredWeekStart = weeklyResetStartMs(before);
    const collected = [{ entryKey: 'Roster:Aki', logs: [
      { boss: 'Abyss Lord Kazeros', difficulty: 'Hard', timestamp: resetMs - 500 },
    ] }];
    ensureFreshWeek(user, new Date(resetMs + 1000));
    const report = applyAutoManageCollected(user, gatheredWeekStart, collected);
    assert.equal(report.appliedTotal, 0);
    assert.ok(!(Number(character.assignedRaids.kazeros?.G1?.completedDate) > 0));

    collected[0].logs.push({ boss: 'Archdemon Kazeros', difficulty: 'Normal', timestamp: resetMs + 500 });
    const current = applyAutoManageCollected(user, gatheredWeekStart, collected);
    assert.equal(current.appliedTotal, 2, 'a current-week G2 clear still proves G1 and G2');
    assert.equal(character.assignedRaids.kazeros.G1.completedDate, resetMs + 500);
    assert.equal(character.assignedRaids.kazeros.G2.completedDate, resetMs + 500);
    assert.equal(character.assignedRaids.kazeros.modeKey, 'normal');
  });
}

test('reset cursors accept real ISO week 53 and reject malformed or impossible keys', () => {
  assert.equal(weeklyResetStartFromKey('2020-W53'), Date.parse('2020-12-30T10:00:00Z'));
  assert.equal(weeklyResetStartFromKey('2021-W01'), Date.parse('2021-01-06T10:00:00Z'));
  for (const key of [undefined, null, '', '2021-W00', '2021-W53', '2021-W54', '2026-09-09', '2026-W1', 'constructor']) {
    assert.equal(weeklyResetStartFromKey(key), null);
  }
});

test('a reset cursor never widens a more recent gather window', () => {
  const resetMs = Date.parse('2026-09-09T10:00:00Z');
  const character = { name: 'Aki', class: 'Artist', itemLevel: 1750, assignedRaids: {} };
  const user = { weeklyResetKey: '2026-W36', accounts: [{ accountName: 'Roster', characters: [character] }] };
  const report = applyAutoManageCollected(user, resetMs, [{ entryKey: 'Roster:Aki', logs: [
    { boss: 'Abyss Lord Kazeros', difficulty: 'Hard', timestamp: resetMs - 1000 },
  ] }]);
  assert.equal(report.appliedTotal, 0);
});
