"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { saveWithRetry } = require("../bot/models/user");
const { clearUserLanguageCache } = require("../bot/services/i18n");
const { createRaidTaskRemoveActionHandlers } = require("../bot/handlers/raid/task/remove-actions");
const { createRaidTaskSharedActionHandlers } = require("../bot/handlers/raid/task/shared-actions");
const { createClearConfirmHandler } = require("../bot/handlers/raid/task/clear/confirm");

for (const kind of ["single", "shared", "clear"]) {
  test(`${kind} task deletion stops when the share disappears during a save retry`, async () => {
    clearUserLanguageCache();
    const notices = [];
    let saves = 0;
    let denied = 0;
    const deps = {
      User: {
        findOne(_query, projection) {
          if (projection) return { lean: async () => ({ language: "en" }) };
          return Promise.resolve({
            accounts: [{ accountName: "Main", characters: [{ name: "Alpha", sideTasks: [{ taskId: "task", name: "Daily", reset: "daily" }] }], sharedTasks: [{ taskId: "task", name: "Daily" }] }],
            async save() {
              saves += 1;
              if (saves === 1) throw Object.assign(new Error("conflict"), { name: "VersionError" });
            },
          });
        },
      },
      saveWithRetry,
      resolveTaskWriteTarget: async () => saves
        ? { discordId: "viewer", viaShare: false }
        : { discordId: "owner", viaShare: true, canEdit: true, ownerLabel: "Owner" },
      replyViewOnlyShareNotice: async () => { denied += 1; },
      viewOnlyShareNotice: () => { denied += 1; return { type: "error" }; },
      replyTaskNotice: async (_interaction, notice) => notices.push(notice),
      editTaskNotice: async (_interaction, notice) => notices.push(notice),
    };
    const interaction = {
      user: { id: "viewer" }, deferUpdate: async () => {},
      options: { getString: key => ({ roster: "Main", character: "Alpha", task: "task" })[key] },
    };
    if (kind === "clear") {
      await createClearConfirmHandler(deps)(interaction, { hasRoster: true, rosterName: "Main", characterName: "Alpha" });
    } else if (kind === "shared") {
      await createRaidTaskSharedActionHandlers(deps).handleSharedRemove(interaction);
    } else {
      await createRaidTaskRemoveActionHandlers(deps).handleRemove(interaction);
    }
    assert.equal(saves, 1);
    assert.equal(denied, 1);
    assert.ok(notices.every(notice => notice.type !== "success"));
    clearUserLanguageCache();
  });
}
