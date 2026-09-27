"use strict";

/**
 * bot/services/raid-log/highlights.js
 * Picks the players the /raid-log card names: MVP DMG, the best dealer
 * score, MVP Counter, MVP Radiant Sup and the two support scores. Each rule
 * falls through its tie-breaks and finally keeps table order.
 */

const { isSupportClass } = require("../../models/Class");

/**
 * Highest value first; a missing value sorts after any value. Array#sort is
 * stable, so a full tie keeps the table order the players came in.
 * @param {object[]} players
 * @param {Array<(player: object) => (number|null|undefined)>} criteria
 * @returns {object|null}
 */
function pickBest(players, criteria) {
  const compare = (a, b) => {
    for (const figure of criteria) {
      const left = figure(a) ?? null;
      const right = figure(b) ?? null;
      if (left === right) continue;
      if (left === null) return 1;
      if (right === null) return -1;
      return right - left;
    }
    return 0;
  };
  return [...players].sort(compare)[0] || null;
}

/**
 * @param {object[]} [players] team figures in table order
 * @param {boolean} [bracketed] which badge set is showing
 * @returns {{ damage: object|null, dealerScore: object|null, counter: object|null,
 *   support: object|null, supportContribution: object|null, supportUptime: object|null }}
 */
function pickHighlights(players = [], bracketed = true) {
  const badges = player => player.badges[bracketed ? "bracketed" : "normalized"];
  const dealers = players.filter(player => !isSupportClass(player.className));
  const supports = players.filter(player => isSupportClass(player.className));
  const mostCounters = Math.max(0, ...players.map(player => player.counters ?? 0));

  const damage = pickBest(dealers, [p => p.damageShare, p => p.dps]);
  const dealerScore = pickBest(dealers, [p => badges(p)[0], p => p.ndps]);
  const counter = mostCounters > 0 ? pickBest(players, [p => p.counters, p => p.stagger, p => p.damageShare]) : null;
  const support = pickBest(supports, [p => p.buffedShare, p => p.contribution]);
  // A support's badges read "rContribution, Buff Performance" (Bible's tooltip order).
  const supportContribution = pickBest(supports, [p => badges(p)[0], p => p.contribution]);
  const supportUptime = pickBest(supports, [p => badges(p)[1], p => p.buffedShare]);

  return {
    damage: damage && { player: damage, share: damage.damageShare ?? null },
    dealerScore: dealerScore && { player: dealerScore, badge: badges(dealerScore)[0] ?? null, ndps: dealerScore.ndps ?? null },
    counter: counter && {
      player: counter, counters: counter.counters, stagger: counter.stagger ?? null,
      tied: players.filter(player => player.counters === mostCounters).length > 1,
    },
    support: support && { player: support, share: support.buffedShare ?? null },
    supportContribution: supportContribution && {
      player: supportContribution, badge: badges(supportContribution)[0] ?? null, contribution: supportContribution.contribution ?? null,
    },
    supportUptime: supportUptime && { player: supportUptime, badge: badges(supportUptime)[1] ?? null },
  };
}

module.exports = { pickHighlights };
