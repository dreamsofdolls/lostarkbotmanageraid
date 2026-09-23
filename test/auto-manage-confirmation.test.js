"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require("discord.js");
const { createAutoManageEnableHandler } = require("../bot/handlers/raid/auto-manage/core/enable");
const { createAutoManageResetHandler } = require("../bot/handlers/raid/auto-manage/core/reset");
const { t } = require("../bot/services/i18n");

for (const action of ["enable", "reset"]) {
  const decisions = action === "enable" ? ["confirm", "cancel", "timeout", "no hidden logs"] : ["confirm", "cancel", "timeout"];
  for (const decision of decisions) {
    test(`${action} ${decision} preserves the owner filter, write decision and final controls`, async () => {
      const edits = [];
      let writes = 0;
      let released = 0;
      let acknowledged = 0;
      const customId = action === "enable" ? `auto-manage:${decision}-on` : `auto-manage:reset-${decision}`;
      const User = { findOne: async () => ({ accounts: [{ characters: [] }], save: async () => { writes += 1; } }) };
      const makeHandler = action === "enable" ? createAutoManageEnableHandler : createAutoManageResetHandler;
      const handler = makeHandler({
        EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType,
        UI: { colors: { success: 0x00ff00, muted: 0x777777 }, icons: { done: "done", reset: "reset", warn: "warn" } },
        User, saveWithRetry: operation => operation(),
        acquireAutoManageSyncSlot: async () => ({ acquired: true }),
        releaseAutoManageSyncSlot: () => { released += 1; },
        ensureFreshWeek: () => {}, weekResetStartMs: () => 123,
        gatherAutoManageLogsForUserDoc: async () => [],
        applyAutoManageCollected: () => ({ perChar: decision === "no hidden logs" ? [] : [{ error: "hidden" }] }),
        isPublicLogDisabledError: error => error === "hidden",
        commitAutoManageOn: async () => { writes += 1; return { report: { appliedTotal: 1 }, userDoc: {} }; },
        buildAutoManageSyncReportEmbed: () => new EmbedBuilder().setDescription("Synced"),
        buildAutoManageHiddenCharsWarningEmbed: () => new EmbedBuilder().setDescription("Hidden logs"),
        stampAutoManageAttempt: async () => {},
      });
      await handler({
        discordId: "owner", lang: "en",
        interaction: {
          deferReply: async () => {},
          fetchReply: async () => ({
            async awaitMessageComponent(options) {
              assert.equal(options.filter({ user: { id: "someone-else" }, customId }), false);
              assert.equal(options.filter({ user: { id: "owner" }, customId: "other:confirm" }), false);
              assert.equal(options.filter({ user: { id: "owner" }, customId }), true);
              assert.equal(options.componentType, ComponentType.Button);
              assert.equal(options.time, 60_000);
              if (decision === "timeout") throw new Error("Collector expired");
              return { customId, deferUpdate: async () => { acknowledged += 1; } };
            },
          }),
        },
        replyAutoEmbed: async () => {},
        editAutoEmbed: async (embed, options) => edits.push({ embed: embed.toJSON(), options }),
        editAutoNotice: () => assert.fail("A normal decision must not report a write error"),
      });
      const proceeds = decision === "confirm" || decision === "no hidden logs";
      assert.equal(writes, proceeds ? 1 : 0);
      assert.equal(released, action === "enable" || decision === "confirm" ? 1 : 0);
      assert.equal(acknowledged, decision === "timeout" || decision === "no hidden logs" ? 0 : 1);
      assert.deepEqual(edits.at(-1).options.components, []);
      if (!proceeds) {
        const titleKey = decision === "timeout" ? "cancelTimeoutTitle" : "cancelTitle";
        assert.equal(edits.at(-1).embed.title, `reset ${t(`raid-auto-manage.${action}.${titleKey}`, "en")}`);
        assert.equal(edits.at(-1).embed.description, t(`raid-auto-manage.${action}.cancelDescription`, "en"));
      }
    });
  }
}

for (const [label, doc] of [["missing user", null], ["empty roster", { accounts: [] }]]) {
  test(`enable with ${label} uses the guarded mode update without gathering logs`, async () => {
    let writes = 0;
    let released = 0;
    let reply;
    const handler = createAutoManageEnableHandler({
      EmbedBuilder, UI: { colors: { success: 0x00ff00 }, icons: { done: "done" } },
      User: {
        findOne: async () => doc,
        findOneAndUpdate: async (filter, update) => {
          assert.deepEqual(filter.localSyncEnabled, { $ne: true });
          assert.equal(update.$set.autoManageEnabled, true);
          writes += 1;
          return { autoManageEnabled: true };
        },
      },
      acquireAutoManageSyncSlot: async () => ({ acquired: true }),
      releaseAutoManageSyncSlot: () => { released += 1; },
      weekResetStartMs: () => 123,
    });
    await handler({
      interaction: { deferReply: async () => {} }, discordId: "owner", lang: "en",
      editAutoEmbed: async embed => { reply = embed.toJSON(); },
    });
    assert.equal(writes, 1);
    assert.equal(released, 1);
    assert.equal(reply.description, t("raid-auto-manage.enable.noRosterDescription", "en"));
  });
}
