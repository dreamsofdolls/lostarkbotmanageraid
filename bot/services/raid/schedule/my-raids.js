/**
 * services/raid/schedule/my-raids.js
 * Pure helpers for the "Raid của tôi" view (a /raid-status dropdown that lists
 * the raid-schedule events a member is in). No I/O - callers pass already
 * fetched RaidEvent docs (lean objects). The Discord render + Mongo query live
 * in handlers/raid-status/my-raids.js; only the shaping/membership logic lives
 * here so it can be unit-tested.
 */

"use strict";

const { assignSlots } = require("./slots");

/**
 * The turns a given member belongs to.
 * @param {Array<{name: string, memberIds: string[]}>} turns
 * @param {string} discordId
 * @returns {Array} the subset of turns whose memberIds include discordId
 */
function turnsForMember(turns, discordId) {
  const id = String(discordId);
  return (Array.isArray(turns) ? turns : []).filter(
    (turn) => Array.isArray(turn.memberIds) && turn.memberIds.some((m) => String(m) === id),
  );
}

/**
 * Shape the events a viewer is signed up for into dropdown-ready rows. Events
 * the viewer has no signup in are dropped, so the result reflects exactly the
 * raids that belong on their "Raid của tôi" list.
 * @param {Array} events - RaidEvent docs (lean) for the guild
 * @param {string} discordId - the viewer
 * @returns {Array<{eventId: string, raidKey: string, modeKey: string, channelId: string, startAt: Date, characterName: string, role: string, turnCount: number}>}
 */
function shapeMyRaidEvents(events, discordId) {
  const id = String(discordId);
  const shaped = [];
  for (const event of events || []) {
    const signup = (event.signups || []).find((s) => String(s.discordId) === id);
    if (!signup) continue;
    shaped.push({
      eventId: String(event._id),
      raidKey: event.raidKey,
      modeKey: event.modeKey,
      channelId: event.channelId,
      startAt: event.startAt,
      characterName: signup.characterName,
      role: signup.role,
      turnCount: turnsForMember(event.turns, id).length,
    });
  }
  return shaped;
}

/**
 * The viewer's personal slice of one event, for the detail embed. inComp is
 * derived (placement is never stored) via assignSlots, so a waitlist overflow
 * or a tentative/absent RSVP reads as not-in-comp (room stays hidden).
 * @param {object} event - a RaidEvent doc
 * @param {string} discordId - the viewer
 * @param {{supSlots: number, dpsSlots: number}} counts
 * @returns {{signup: object|null, inComp: boolean, role: string|null, turns: Array}}
 */
function buildMyRaidDetail(event, discordId, { supSlots, dpsSlots }) {
  const id = String(discordId);
  const signup = (event.signups || []).find((s) => String(s.discordId) === id) || null;
  const slots = assignSlots(event.signups, { supSlots, dpsSlots });
  const inComp = [...slots.support, ...slots.dps].some((s) => String(s.discordId) === id);
  return {
    signup,
    inComp,
    role: signup ? signup.role : null,
    turns: turnsForMember(event.turns, id),
  };
}

module.exports = { turnsForMember, shapeMyRaidEvents, buildMyRaidDetail };
