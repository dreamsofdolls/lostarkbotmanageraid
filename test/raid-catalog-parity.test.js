"use strict";

// The raid catalog owns the raid keys and their order. These tests pin the
// places that must follow it: the stored assignedRaids shape, the reset seed
// and the /raid-status display order.

process.env.RAID_MANAGER_ID = "test-manager";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require("discord.js");

const { RAID_REQUIREMENTS } = require("../bot/domain/raid-catalog");
const User = require("../bot/models/user");
const { getStatusRaidsForCharacter } = require("../bot/utils/raid/common/character");
const { createAutoManageResetHandler } = require("../bot/handlers/raid/auto-manage/core/reset");
const { UI } = require("../bot/utils/raid/common/shared");

const CATALOG_KEYS = Object.keys(RAID_REQUIREMENTS);

test("the user schema stores assignedRaids for exactly the catalog raids, in catalog order", () => {
  const characterSchema = User.schema.path("accounts").schema.path("characters").schema;
  const schemaKeys = Object.keys(characterSchema.paths)
    .filter((path) => path.startsWith("assignedRaids."))
    .map((path) => path.slice("assignedRaids.".length));
  assert.deepEqual(schemaKeys, CATALOG_KEYS);
});

test("the auto-manage reset seeds an empty assignedRaids entry per catalog raid on every character", async () => {
  const characters = [
    { assignedRaids: { armoche: { G1: { completedDate: 1 } } } },
    { assignedRaids: {} },
  ];
  const userDoc = { accounts: [{ characters }], save: async () => {} };
  const handler = createAutoManageResetHandler({
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, UI,
    User: { findOne: async () => userDoc },
    saveWithRetry: (operation) => operation(),
    acquireAutoManageSyncSlot: async () => ({ acquired: true }),
    releaseAutoManageSyncSlot: () => {},
  });
  await handler({
    discordId: "owner",
    lang: "en",
    interaction: {
      fetchReply: async () => ({
        awaitMessageComponent: async () => ({
          customId: "auto-manage:reset-confirm",
          deferUpdate: async () => {},
        }),
      }),
    },
    replyAutoEmbed: async () => {},
    editAutoEmbed: async () => {},
    editAutoNotice: () => assert.fail("The reset must not report an error"),
  });

  for (const character of characters) {
    assert.deepEqual(Object.keys(character.assignedRaids), CATALOG_KEYS);
    for (const raidKey of CATALOG_KEYS) assert.deepEqual(character.assignedRaids[raidKey], {});
  }
  for (const raidKey of CATALOG_KEYS) {
    assert.notEqual(characters[0].assignedRaids[raidKey], characters[1].assignedRaids[raidKey]);
  }
});

test("/raid-status lists a character's raids in catalog order", () => {
  // At 1730 Horizon is listed on its hard mode (1720), which sits below
  // Kazeros' hard mode (1730), so the min-item-level tiebreak alone would put
  // Horizon ahead of Kazeros.
  const raidKeys = getStatusRaidsForCharacter({ itemLevel: 1730, assignedRaids: {}, tasks: [] })
    .map((raid) => raid.raidKey);
  assert.equal(raidKeys.length, CATALOG_KEYS.length);
  assert.deepEqual(raidKeys, CATALOG_KEYS.filter((raidKey) => raidKeys.includes(raidKey)));
});
