/**
 * services/raid/schedule/signup-state.js
 * Pure signup-list mutations for the /raid-schedule board. Each function
 * takes the current signups array (+ payload) and returns a NEW array,
 * leaving slot-vs-waitlist placement to slots.assignSlots at render time
 * (no stored slot index). v1 model: every signup carries a character
 * (chosen via the Tham gia picker), so RSVP states flip the status of an
 * EXISTING signup - a player must join before marking late/tentative/
 * absent. Re-joining with a different character preserves the original
 * joinedAt so queue position is not lost.
 */

"use strict";

const { deriveRole } = require("./eligibility");

const RSVP_STATUSES = new Set(["late", "tentative", "absent"]);

/**
 * Add or replace the caller's signup as a confirmed pick. Re-joining
 * keeps the original joinedAt (queue position) while swapping character.
 * @param {Array} signups - current signups
 * @param {{discordId: string, accountName: string, characterName: string, characterClass: string, characterItemLevel: number}} payload
 * @param {number} [now=Date.now()] - clock (injectable for tests)
 * @returns {Array} new signups array
 */
function applyJoin(signups, payload, now = Date.now()) {
  const list = Array.isArray(signups) ? signups : [];
  const existing = list.find((s) => s.discordId === payload.discordId);
  const joinedAt = existing ? existing.joinedAt : now;
  const next = list.filter((s) => s.discordId !== payload.discordId);
  next.push({
    discordId: payload.discordId,
    accountName: payload.accountName,
    characterName: payload.characterName,
    characterClass: payload.characterClass,
    characterItemLevel: payload.characterItemLevel,
    role: deriveRole(payload.characterClass),
    status: "confirmed",
    joinedAt,
  });
  return next;
}

/**
 * Flip an existing signup's RSVP status. `late` keeps the slot (flag
 * only); `tentative`/`absent` vacate it (they drop out of the comp,
 * which may free a slot for a waitlist promotion). No-op when the caller
 * has not joined yet.
 * @param {Array} signups
 * @param {string} discordId
 * @param {"late"|"tentative"|"absent"} status
 * @returns {{signups: Array, ok: boolean, reason?: string}}
 */
function applyRsvp(signups, discordId, status) {
  if (!RSVP_STATUSES.has(status)) {
    throw new Error(`[raid-schedule] invalid RSVP status: ${status}`);
  }
  const list = Array.isArray(signups) ? signups : [];
  if (!list.some((s) => s.discordId === discordId)) {
    return { signups: list, ok: false, reason: "not-joined" };
  }
  const next = list.map((s) => (s.discordId === discordId ? { ...s, status } : s));
  return { signups: next, ok: true };
}

/**
 * Remove the caller's signup entirely.
 * @param {Array} signups
 * @param {string} discordId
 * @returns {{signups: Array, ok: boolean}} ok=false when nothing was removed
 */
function applyLeave(signups, discordId) {
  const list = Array.isArray(signups) ? signups : [];
  const ok = list.some((s) => s.discordId === discordId);
  return { signups: list.filter((s) => s.discordId !== discordId), ok };
}

module.exports = { applyJoin, applyRsvp, applyLeave, RSVP_STATUSES };
