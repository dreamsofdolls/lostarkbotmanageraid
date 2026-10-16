"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { saveWithRetry } = require("../bot/models/user");
const { clearUserLanguageCache, t } = require("../bot/services/i18n");
const { createRaidTaskNoticeHelpers } = require("../bot/handlers/raid/task/notices");
const { createRaidTaskRemoveActionHandlers } = require("../bot/handlers/raid/task/remove-actions");
const { createRaidTaskSharedActionHandlers } = require("../bot/handlers/raid/task/shared-actions");
const { createClearConfirmHandler } = require("../bot/handlers/raid/task/clear/confirm");
const { createClearPreviewHandler } = require("../bot/handlers/raid/task/clear/preview");

for (const kind of ["single", "shared"]) {
  for (const scenario of ["success", "missing target", "missing task", "save retry", "removed during retry"]) {
    test(`${kind} task removal handles ${scenario} without changing other tasks`, async () => {
      clearUserLanguageCache();
      const notices = [];
      const documents = [];
      let saves = 0;
      const retries = scenario.includes("retry");
      const deps = {
        User: {
          findOne(query, projection) {
            if (projection) return { lean: async () => ({ language: "en" }) };
            assert.equal(query.discordId, "owner");
            const tasks = () => [{ taskId: "target", name: "Daily" }, { taskId: "keep", name: "Keep" }];
            const doc = {
              accounts: [{ accountName: "Main", characters: [{ name: "Alpha", sideTasks: tasks() }], sharedTasks: tasks() }],
              async save() {
                saves += 1;
                if (retries && saves === 1) throw Object.assign(new Error("conflict"), { name: "VersionError" });
              },
            };
            if (scenario === "missing target") doc.accounts = [];
            const account = doc.accounts[0];
            if (account && (scenario === "missing task" || (scenario === "removed during retry" && documents.length))) {
              (kind === "shared" ? account.sharedTasks : account.characters[0].sideTasks).shift();
            }
            documents.push(doc);
            return Promise.resolve(doc);
          },
        },
        saveWithRetry,
        resolveTaskWriteTarget: async () => ({ discordId: "owner", viaShare: true, canEdit: true }),
        replyViewOnlyShareNotice: () => assert.fail("The granted share must stay editable"),
        replyShareRefusalNotice: () => assert.fail("The granted share must stay editable"),
        replyTaskNotice: async (_interaction, notice) => notices.push(notice),
      };
      const handler = kind === "shared"
        ? createRaidTaskSharedActionHandlers(deps).handleSharedRemove
        : createRaidTaskRemoveActionHandlers(deps).handleRemove;
      await handler({
        user: { id: "viewer" },
        options: { getString: key => ({ roster: "Main", character: "Alpha", task: "target" })[key] },
      });
      const removed = scenario === "success" || scenario === "save retry";
      assert.equal(saves, scenario === "save retry" ? 2 : removed || scenario === "removed during retry" ? 1 : 0);
      assert.equal(notices.length, 1);
      assert.equal(notices[0].type, removed ? "success" : "warn");
      if (removed) assert.match(notices[0].description, /Daily/);
      const account = documents.at(-1).accounts[0];
      if (account) {
        const changed = kind === "shared" ? account.sharedTasks : account.characters[0].sideTasks;
        const untouched = kind === "shared" ? account.characters[0].sideTasks : account.sharedTasks;
        assert.deepEqual(changed.map(task => task.taskId), ["keep"]);
        assert.deepEqual(untouched.map(task => task.taskId), ["target", "keep"]);
      }
      clearUserLanguageCache();
    });
  }
}

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
      replyShareRefusalNotice: async () => { denied += 1; },
      editShareRefusalNotice: async () => { denied += 1; },
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

class NoticeEmbed {
  setColor() { return this; }
  setTitle(title) { this.title = title; return this; }
  setDescription(description) { this.description = description; return this; }
}

for (const kind of ["single", "shared", "clear"]) {
  for (const [scenario, current, listedShares, noticeKeys] of [
    ["revoked", { discordId: "viewer", viaShare: false }, [], "raid-task.shareRevoked"],
    [
      "downgraded to view",
      { discordId: "owner", viaShare: true, canEdit: false, ownerLabel: "Owner" },
      [{ ownerDiscordId: "owner" }],
      "raid-task.shareViewOnly",
    ],
  ]) {
    test(`${kind} task deletion tells a share that is ${scenario} during a save retry from the other refusal`, async () => {
      clearUserLanguageCache();
      const sent = [];
      const lookups = [];
      let saves = 0;
      const helpers = createRaidTaskNoticeHelpers({
        EmbedBuilder: NoticeEmbed,
        getAccessibleAccounts: async (viewerId, options) => {
          lookups.push([viewerId, options]);
          return listedShares;
        },
      });
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
          ? current
          : { discordId: "owner", viaShare: true, canEdit: true, ownerLabel: "Owner" },
        ...helpers,
      };
      const interaction = {
        user: { id: "viewer" },
        deferUpdate: async () => {},
        reply: async payload => { sent.push(payload.embeds[0]); },
        editReply: async payload => { sent.push(payload.embeds[0]); },
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
      assert.deepEqual(lookups, [["viewer", { includeOwn: false }]]);
      assert.equal(sent.length, 1);
      assert.ok(sent[0].title.includes(t(`${noticeKeys}.title`, "en")), sent[0].title);
      assert.equal(sent[0].description, t(`${noticeKeys}.description`, "en", { owner: "Owner" }));
      clearUserLanguageCache();
    });
  }
}

for (const kind of ["single", "shared", "clear", "clear preview"]) {
  test(`${kind} task command answers a view-only share at the first resolve without the share lookup`, async () => {
    clearUserLanguageCache();
    const sent = [];
    let lookups = 0;
    const helpers = createRaidTaskNoticeHelpers({
      EmbedBuilder: NoticeEmbed,
      getAccessibleAccounts: async () => {
        lookups += 1;
        return [];
      },
    });
    const deps = {
      User: {
        findOne(_query, projection) {
          if (projection) return { lean: async () => ({ language: "en" }) };
          return assert.fail("A view-only share must not load the owner's document");
        },
      },
      saveWithRetry,
      resolveTaskWriteTarget: async () => ({ discordId: "owner", viaShare: true, canEdit: false, ownerLabel: "Owner" }),
      ...helpers,
    };
    const interaction = {
      user: { id: "viewer" },
      deferReply: async () => {},
      deferUpdate: async () => {},
      reply: async payload => { sent.push(payload.embeds[0]); },
      editReply: async payload => { sent.push(payload.embeds[0]); },
      options: { getString: key => ({ roster: "Main", character: "Alpha", task: "task" })[key] },
    };
    if (kind === "clear") {
      await createClearConfirmHandler(deps)(interaction, { hasRoster: true, rosterName: "Main", characterName: "Alpha" });
    } else if (kind === "clear preview") {
      await createClearPreviewHandler(deps)(interaction);
    } else if (kind === "shared") {
      await createRaidTaskSharedActionHandlers(deps).handleSharedRemove(interaction);
    } else {
      await createRaidTaskRemoveActionHandlers(deps).handleRemove(interaction);
    }

    assert.equal(lookups, 0);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].title.includes(t("raid-task.shareViewOnly.title", "en")), sent[0].title);
    assert.equal(sent[0].description, t("raid-task.shareViewOnly.description", "en", { owner: "Owner" }));
    clearUserLanguageCache();
  });
}
