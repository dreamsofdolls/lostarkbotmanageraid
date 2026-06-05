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

function filterLogsForCharacter(logs, expectedName, normalizeName) {
  const expected = normalizeName(expectedName);
  if (!expected || !Array.isArray(logs) || logs.length === 0) {
    return { logs: Array.isArray(logs) ? logs : [], mismatchedNames: [], hadNamedLogs: false };
  }
  const namedLogs = logs.filter((log) => normalizeName(log?.name));
  if (namedLogs.length === 0) {
    return { logs, mismatchedNames: [], hadNamedLogs: false };
  }
  const filtered = namedLogs.filter((log) => normalizeName(log?.name) === expected);
  const mismatchedNames = [
    ...new Set(
      namedLogs
        .map((log) => log?.name)
        .filter((name) => normalizeName(name) !== expected)
    ),
  ];
  return { logs: filtered, mismatchedNames, hadNamedLogs: true };
}

module.exports = {
  filterLogsForCharacter,
  mapWithConcurrency,
};
