"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder, MessageFlags } = require("discord.js");

const { createRaidSetCommand } = require("../bot/handlers/raid/set");
const shared = require("../bot/utils/raid/common/shared");
const characters = require("../bot/utils/raid/common/character");
const catalog = require("../bot/domain/raid-catalog");
const { ensureFreshWeek, getTargetResetKey } = require("../bot/services/raid/schedulers/weekly-reset");
const { applyLocalSyncDeltas } = require("../bot/services/local-sync/core/apply/apply");

// Local Sync filters clears against the week its apply started in. When the
// read and save land after the weekly reset, an old-week clear must not be
// stamped into the new week.
const RESET = Date.parse("2026-10-14T10:00:00Z");

async function applyAcrossReset(t, { batch }) {
  t.mock.timers.enable({ apis: ["Date"], now: RESET - 1000 });
  const user = {
    discordId: "owner",
    localSyncEnabled: true,
    weeklyResetKey: getTargetResetKey(new Date()),
    accounts: [{
      accountName: "Roster",
      characters: [{ id: "c1", name: "Bardmain", class: "Bard", itemLevel: 1750, assignedRaids: {}, tasks: [] }],
    }],
  };
  let saves = 0;
  user.save = async () => { saves += 1; };
  user.markModified = () => {};
  // The fresh read happens after the reset boundary.
  const User = { findOne: async () => { t.mock.timers.setTime(RESET + 1000); return user; } };
  const writer = createRaidSetCommand({
    EmbedBuilder, MessageFlags, User,
    UI: shared.UI, normalizeName: shared.normalizeName, getCharacterName: shared.getCharacterName,
    getCharacterClass: shared.getCharacterClass, toModeLabel: shared.toModeLabel,
    createCharacterId: characters.createCharacterId, ensureAssignedRaids: characters.ensureAssignedRaids,
    normalizeAssignedRaid: characters.normalizeAssignedRaid, getGateKeys: characters.getGateKeys,
    RAID_REQUIREMENT_MAP: characters.RAID_REQUIREMENT_MAP,
    getRaidRequirementList: catalog.getRaidRequirementList, getGatesForRaid: catalog.getGatesForRaid,
    loadUserForAutocomplete: async () => null, saveWithRetry: async (operation) => operation(), ensureFreshWeek,
  });
  const summary = await applyLocalSyncDeltas("owner", [{
    boss: "Abyss Lord Kazeros", difficulty: "Hard", charName: "Bardmain", cleared: true, lastClearMs: RESET - 500,
  }], {
    userDoc: user,
    requireLocalSyncEnabled: true,
    getRaidRequirementMap: catalog.getRaidRequirementMap,
    applyRaidSetForDiscordId: writer.applyRaidSetForDiscordId,
    applyRaidSetBatchForDiscordId: batch ? writer.applyRaidSetBatchForDiscordId : null,
  });
  return { summary, user, saves };
}

for (const batch of [true, false]) {
  test(`a Local Sync ${batch ? "batch" : "single"} write that lands after the weekly reset drops the old-week clear`, async (t) => {
    const { summary, user, saves } = await applyAcrossReset(t, { batch });
    assert.equal(summary.applied.length, 0);
    assert.deepEqual(summary.rejected.map((entry) => entry.reason), ["outside_current_week"]);
    assert.equal(saves, 0);
    assert.equal(user.accounts[0].characters[0].assignedRaids.kazeros?.G1?.completedDate, undefined);
  });
}
