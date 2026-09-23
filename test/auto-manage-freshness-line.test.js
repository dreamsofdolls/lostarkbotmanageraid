"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { UI, formatAutoManageFreshnessLine } = require("../bot/utils/raid/common/shared");
const { t } = require("../bot/services/i18n");

const lastSynced = `${UI.icons.reset} ${t("raid-status.freshness.lastSynced", "en")} <t:1700000000:R>`;

test("the freshness line says sync is ready once the cooldown has passed", () => {
  assert.equal(
    formatAutoManageFreshnessLine({ lastSyncAt: 1_700_000_000_000, readyAt: 0 }, UI, "en"),
    `${lastSynced} · ✅ ${t("raid-status.freshness.syncReadyNow", "en")}`,
  );
});

test("the freshness line shows when the next sync opens", () => {
  assert.equal(
    formatAutoManageFreshnessLine({ lastSyncAt: 1_700_000_000_000, readyAt: 1_700_000_600_000 }, UI, "en"),
    `${lastSynced} · ⏳ ${t("raid-status.freshness.syncReady", "en")} <t:1700000600:R>`,
  );
});

test("a user who never synced reads as never synced", () => {
  assert.equal(
    formatAutoManageFreshnessLine({ lastSyncAt: 0, readyAt: 0 }, UI, "en"),
    `${UI.icons.reset} ${t("raid-status.freshness.neverSynced", "en")} · ✅ ${t("raid-status.freshness.syncReadyNow", "en")}`,
  );
});
