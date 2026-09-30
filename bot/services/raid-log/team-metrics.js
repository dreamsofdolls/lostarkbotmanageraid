"use strict";

/**
 * bot/services/raid-log/team-metrics.js
 * Reads a log's per-player figures once, when the capture first opens it:
 * the Damage overview in both percentile modes and public encounter data
 * for support bD%. Missing data keeps bD% null; the page
 * always ends on the team overview in Bracketed mode.
 */

const { isSupportClass } = require("../../models/Class");
const { readPartyMetrics } = require("./metrics");
const { readSupportShares } = require("./encounter-metrics");
const { setNormalized } = require("./page-controls");

/**
 * @param {object} page Playwright page on the team Damage overview
 * @param {object[]} players baseline players ({ id, party, row, label, className })
 * @param {{ logId: string, summary: string, log: object }} options
 * @returns {Promise<object[]>} players with badges, figures and buffedShare
 */
async function collectTeamMetrics(page, players, options) {
  if (!players.length) return players;
  const hasNormalized = await setNormalized(page, false);
  const bracketed = await page.evaluate(readPartyMetrics);
  let normalized = [];
  if (hasNormalized) {
    await setNormalized(page, true);
    normalized = await page.evaluate(readPartyMetrics);
    await setNormalized(page, false);
  }
  const rows = new Map(bracketed.map(row => [row.id, row]));
  const normalizedBadges = new Map(normalized.map(row => [row.id, row.badges]));
  const shares = players.some(player => isSupportClass(player.className))
    ? await readSupportShares(page, { ...options, players }) : new Map();
  return players.map(player => {
    const row = rows.get(player.id);
    // Figures belong to a slot only while Bible still shows the same name there.
    if (!row || row.label !== player.label) return { ...player, badges: { bracketed: [], normalized: [] }, buffedShare: null };
    const { dps, ndps, contribution, damageShare, stagger, counters } = row;
    return { ...player, dps, ndps, contribution, damageShare, stagger, counters,
      badges: { bracketed: row.badges, normalized: normalizedBadges.get(player.id) ?? [] }, buffedShare: shares.get(player.id) ?? null };
  });
}

module.exports = { collectTeamMetrics };
