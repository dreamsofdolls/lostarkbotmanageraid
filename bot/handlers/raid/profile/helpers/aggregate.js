"use strict";

function charWeight(character) {
  const logs = Number(character?.stats?.encounters) || 0;
  if (logs >= 20) return 1;
  if (logs >= 5) return 0.8;
  if (logs > 0) return 0.5;
  return 0;
}

function weightedAverage(chars, pick) {
  let total = 0;
  let weightTotal = 0;
  for (const character of chars) {
    const w = charWeight(character);
    const value = Number(pick(character));
    if (!w || !Number.isFinite(value)) continue;
    total += value * w;
    weightTotal += w;
  }
  return weightTotal > 0 ? total / weightTotal : 0;
}

function flattenCharacters(entries) {
  const chars = [];
  for (const entry of entries || []) {
    for (const character of entry.characters || []) {
      chars.push({ ...character, _profileEntry: entry });
    }
  }
  return chars;
}

function aggregateCharacters(chars) {
  const list = Array.isArray(chars) ? chars : [];
  const dpsChars = list.filter((c) => c.role !== "support");
  const supportChars = list.filter((c) => c.role === "support");
  const scoredLogs = list.reduce((sum, c) => sum + (Number(c?.stats?.encounters) || 0), 0);
  const logs = list.reduce((sum, c) => sum + (Number(c?.stats?.allEncounterCount) || Number(c?.stats?.encounters) || 0), 0);
  const lastFightStart = Math.max(0, ...list.map((c) => Number(c?.stats?.lastFightStart) || 0));
  return {
    charCount: list.length,
    logs,
    scoredLogs,
    lastFightStart,
    overall: weightedAverage(list, (c) => c?.scores?.overall),
    mvp: weightedAverage(list, (c) => c?.scores?.mvp),
    dpsOverall: weightedAverage(dpsChars, (c) => c?.scores?.overall),
    supportOverall: weightedAverage(supportChars, (c) => c?.scores?.overall),
    dpsCount: dpsChars.length,
    supportCount: supportChars.length,
  };
}

function pickTopChar(chars, scoreKey = "overall") {
  return [...(chars || [])]
    .filter((c) => Number(c?.scores?.[scoreKey]) > 0)
    .sort((a, b) => Number(b.scores[scoreKey]) - Number(a.scores[scoreKey]))[0] || null;
}

function getEntryLabel(entry) {
  if (entry.isOwn) return entry.accountName;
  return `${entry.ownerLabel || entry.ownerDiscordId} / ${entry.accountName}`;
}

module.exports = {
  aggregateCharacters,
  flattenCharacters,
  getEntryLabel,
  pickTopChar,
};
