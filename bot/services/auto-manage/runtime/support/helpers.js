"use strict";

async function mapWithConcurrency(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];

  const results = new Array(list.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), list.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < list.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(list[index], index);
      }
    })
  );

  return results;
}

/**
 * Select named logs in one pass; wholly unnamed legacy responses pass through.
 * @param {Array} logs Raw Bible log rows.
 * @param {string} expectedName Character requested by the caller.
 * @param {Function} normalizeName Pure character-name normalizer.
 * @returns {{logs: Array, mismatchedNames: Array, hadNamedLogs: boolean}}
 */
function filterLogsForCharacter(logs, expectedName, normalizeName) {
  const expected = normalizeName(expectedName);
  if (!expected || !Array.isArray(logs) || logs.length === 0) {
    return { logs: Array.isArray(logs) ? logs : [], mismatchedNames: [], hadNamedLogs: false };
  }
  const filtered = [];
  const mismatchedNames = new Set();
  let hadNamedLogs = false;
  logs.forEach((log) => {
    const name = log?.name;
    const normalized = normalizeName(name);
    if (!normalized) return;
    hadNamedLogs = true;
    if (normalized === expected) filtered.push(log);
    else mismatchedNames.add(name);
  });
  if (!hadNamedLogs) {
    return { logs, mismatchedNames: [], hadNamedLogs: false };
  }
  return { logs: filtered, mismatchedNames: [...mismatchedNames], hadNamedLogs };
}

module.exports = {
  filterLogsForCharacter,
  mapWithConcurrency,
};
