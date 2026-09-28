"use strict";

/**
 * bot/services/raid-log/team-metrics.js
 * Reads a log's per-player figures once, when the capture first opens it:
 * the Damage overview in both percentile modes, then each support's detail
 * view for bD%. A support whose detail view fails keeps bD% null; the page
 * always ends on the team overview in Bracketed mode.
 */

const { isSupportClass } = require("../../models/Class");
const { readPartyMetrics, readSupportShare } = require("./metrics");
const { selectPlayer } = require("./detail");
const { setNormalized, returnToOverview, bibleButton, OVERVIEW_BUTTON } = require("./page-controls");

// Opening a support takes a second or two; with less time than this left the
// card goes without bD% rather than risking the capture's deadline.
const SUPPORT_READ_RESERVE_MS = 5_000;

/**
 * @param {object} page Playwright page on the team Damage overview
 * @param {object[]} players baseline players ({ id, party, row, label, className })
 * @param {{ deadline: number, now?: () => number, log: object, openPlayer?: Function, supportShares?: boolean }} options
 *   `openPlayer` is `selectPlayer`; tests pass a fake. `supportShares: false`
 *   skips the supports' detail views, leaving bD% null
 * @returns {Promise<object[]>} players with badges, figures and buffedShare
 */
async function collectTeamMetrics(page, players, {
  deadline, now = Date.now, log, openPlayer = selectPlayer, supportShares = true,
}) {
  if (!players.length) return players;
  await setNormalized(page, false);
  const bracketed = await page.evaluate(readPartyMetrics);
  await setNormalized(page, true);
  const normalized = await page.evaluate(readPartyMetrics);
  await setNormalized(page, false);
  const rows = new Map(bracketed.map(row => [row.id, row]));
  const normalizedBadges = new Map(normalized.map(row => [row.id, row.badges]));
  const merged = players.map(player => {
    const row = rows.get(player.id);
    // Figures belong to a slot only while Bible still shows the same name there.
    if (!row || row.label !== player.label) return { ...player, badges: { bracketed: [], normalized: [] }, buffedShare: null };
    const { dps, ndps, contribution, damageShare, stagger, counters } = row;
    return { ...player, dps, ndps, contribution, damageShare, stagger, counters,
      badges: { bracketed: row.badges, normalized: normalizedBadges.get(player.id) ?? [] }, buffedShare: null };
  });
  for (const player of supportShares ? merged.filter(entry => isSupportClass(entry.className)) : []) {
    if (deadline - now() < SUPPORT_READ_RESERVE_MS) break;
    try {
      if (await openPlayer(page, player)) player.buffedShare = await page.evaluate(readSupportShare);
    } catch (error) {
      log.warn(`[raid-log] support share unavailable player=${player.id}: ${error.message}`);
    }
    if (await bibleButton(page, OVERVIEW_BUTTON).count()) await returnToOverview(page);
  }
  return merged;
}

module.exports = { collectTeamMetrics };
