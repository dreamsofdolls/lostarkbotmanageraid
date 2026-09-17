"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  describeLocalSyncCard,
} = require("../bot/handlers/local-sync/discord-console-card");

const CHANGES = { changes: { chars: 1, raids: 1, gates: 2 } };
const NO_CHANGES = { changes: { chars: 0, raids: 0, gates: 0 } };

function makeJob(overrides = {}) {
  return {
    jobId: "job-1",
    scope: "full",
    status: "pending",
    failureReason: "",
    partyAuthorized: false,
    result: null,
    ...overrides,
  };
}

function describeCard(overrides = {}) {
  return describeLocalSyncCard({
    job: makeJob(),
    state: "pending",
    summary: CHANGES,
    activeScope: "full",
    hasReaderLink: true,
    lang: "vi",
    ...overrides,
  });
}

test("a viewer with no sync mode gets the disabled card, whatever the job says", () => {
  const card = describeCard({ activeScope: null });
  assert.equal(card.kind, "disabled");
  assert.equal(card.colorKey, "muted");
  assert.equal(card.trackerLine, "");
  assert.match(card.sentence, /Local Sync chưa được bật/);
  assert.equal(card.showBody || card.showApplyCancel || card.showExpiry, false);
});

test("no job is the empty card, and step 1 names the control the viewer has", () => {
  const withLink = describeCard({ job: null, state: "missing", summary: null });
  assert.equal(withLink.kind, "empty");
  assert.equal(withLink.colorKey, "neutral");
  assert.equal(withLink.trackerLine, "⏳ **Đọc log** › ⚪ Xem trước › ⚪ Đồng bộ");
  assert.match(withLink.sentence, /\*\*1\.\*\* Bấm \*\*Mở Local Reader\*\*, chọn/);

  const solo = describeCard({
    job: null, state: "missing", summary: null, activeScope: "solo", hasReaderLink: false,
  });
  assert.match(solo.sentence, /\*\*1\.\*\* Bấm \*\*Solo Local Reader\*\* \(link riêng chỉ cậu thấy\), chọn/);
  assert.doesNotMatch(solo.sentence, /\{openReader\}/);

  const unconfigured = describeCard({
    job: null, state: "missing", summary: null, hasReaderLink: false,
  });
  assert.match(unconfigured.sentence, /\*\*1\.\*\* Mở Local Reader, chọn/);
});

test("a pending preview with changes waits for confirmation", () => {
  const card = describeCard();
  assert.equal(card.kind, "pending");
  assert.equal(card.colorKey, "neutral");
  assert.equal(card.trackerLine, "✅ Đọc log › ⏳ **Xem trước** › ⚪ Đồng bộ");
  assert.equal(card.showBody, true);
  assert.equal(card.showApplyCancel, true);
  assert.equal(card.showExpiry, true);
});

test("a pending preview with no gates is nothing new and cannot be synced", () => {
  const card = describeCard({ summary: NO_CHANGES });
  assert.equal(card.kind, "nothing");
  assert.equal(card.colorKey, "neutral");
  assert.equal(card.trackerLine, "✅ Đọc log › ℹ️ **Không có gì mới** › ⚪ Đồng bộ");
  assert.match(card.sentence, /không cần \*\*Đồng bộ\*\*/);
  assert.equal(card.showBody || card.showApplyCancel || card.showExpiry, false);
});

test("an unknown summary is not treated as nothing new", () => {
  const card = describeCard({ summary: null });
  assert.equal(card.kind, "pending");
  assert.equal(card.showBody, true);
});

test("every retryable reason keeps Sync and turns the card yellow", () => {
  const currentStep = {
    sync_busy: "⏳ **Chờ lượt**",
    apply_failed: "⚠️ **Lỗi tạm thời**",
    write_error: "⚠️ **Đồng bộ dở**",
    party_write_error: "⚠️ **Đồng bộ dở**",
  };
  for (const [failureReason, step] of Object.entries(currentStep)) {
    const card = describeCard({ job: makeJob({ failureReason }) });
    assert.equal(card.kind, "retry", failureReason);
    assert.equal(card.colorKey, "progress", failureReason);
    assert.equal(card.trackerLine, `✅ Đọc log › ✅ Xem trước › ${step}`, failureReason);
    assert.equal(card.showApplyCancel, true, failureReason);
    assert.equal(card.showExpiry, true, failureReason);
  }
});

test("a party retry with nothing left in the owner's roster keeps Sync and hides the body", () => {
  const card = describeCard({
    job: makeJob({ failureReason: "party_write_error" }),
    summary: NO_CHANGES,
  });
  assert.equal(card.kind, "retry");
  assert.equal(card.showBody, false);
  assert.equal(card.showApplyCancel, true);
  assert.match(card.sentence, /^Phần của cậu đã ghi xong\. Còn vài roster trong party/);
});

test("a lapsed lease after party authorization is a party retry, not nothing new", () => {
  const card = describeCard({
    job: makeJob({ partyAuthorized: true }),
    summary: NO_CHANGES,
  });
  assert.equal(card.kind, "retry");
  assert.equal(card.showApplyCancel, true);
  assert.match(card.sentence, /roster trong party/);
  assert.match(card.trackerLine, /⚠️ \*\*Đồng bộ dở\*\*$/);
});

test("applying shows the body without Sync or an expiry line", () => {
  const card = describeCard({ job: makeJob({ status: "applying" }), state: "applying" });
  assert.equal(card.kind, "applying");
  assert.equal(card.trackerLine, "✅ Đọc log › ✅ Xem trước › 🔄 **Đang đồng bộ**");
  assert.equal(card.showBody, true);
  assert.equal(card.showApplyCancel, false);
  assert.equal(card.showExpiry, false);
});

test("the applied sentence mentions rejected entries only when there are some", () => {
  const clean = describeCard({
    job: makeJob({ status: "applied", result: { applied: [{}], skipped: [], rejected: [] } }),
    state: "applied",
  });
  assert.equal(clean.kind, "applied");
  assert.equal(clean.colorKey, "success");
  assert.equal(clean.sentence, "Artist đã ghi xong các thay đổi bên dưới.");
  assert.equal(clean.showBody, true);

  const rejected = describeCard({
    job: makeJob({ status: "applied", result: { applied: [{}], skipped: [], rejected: [{}, {}] } }),
    state: "applied",
  });
  assert.match(rejected.sentence, /Có \*\*2\*\* mục trong log không ghi được/);
});

test("closed previews are grey and carry no body, Sync or expiry", () => {
  const currentStep = {
    cancelled: "✖️ **Đã huỷ**",
    superseded: "🔁 **Có bản mới**",
    expired: "⌛ **Hết hạn**",
  };
  for (const [state, step] of Object.entries(currentStep)) {
    const card = describeCard({ state });
    assert.equal(card.kind, state);
    assert.equal(card.colorKey, "muted", state);
    assert.equal(card.trackerLine, `✅ Đọc log › ${step} › ⚪ Đồng bộ`, state);
    assert.equal(card.showBody || card.showApplyCancel || card.showExpiry, false, state);
  }
  assert.match(describeCard({ state: "superseded" }).sentence, /Bấm \*\*Làm mới\*\*/);
});

test("an expired preview names the reader control the card has", () => {
  assert.match(describeCard({ state: "expired" }).sentence, /Cậu mở \*\*Local Reader\*\* rồi gửi/);
  assert.match(
    describeCard({ state: "expired", activeScope: "solo", hasReaderLink: false }).sentence,
    /Cậu bấm \*\*Solo Local Reader\*\* rồi gửi/
  );
  // Full Local Sync without a link means the server has no public URL, so
  // there is no control to point at.
  assert.match(
    describeCard({ state: "expired", hasReaderLink: false }).sentence,
    /Cậu mở Local Reader rồi gửi/
  );
});

test("a mode switch is the only red card, and its sentence follows the reason", () => {
  const localOff = describeCard({
    job: makeJob({ status: "failed", failureReason: "local_sync_disabled" }),
    state: "failed",
    activeScope: "solo",
    hasReaderLink: false,
  });
  assert.equal(localOff.kind, "failed");
  assert.equal(localOff.colorKey, "danger");
  assert.equal(localOff.trackerLine, "✅ Đọc log › ✅ Xem trước › ⚠️ **Không ghi được**");
  assert.match(localOff.sentence, /\*\*Local Sync đã bị tắt\*\*.*bấm \*\*Solo Local Reader\*\*/);
  assert.equal(localOff.showBody, false);

  const bibleOff = describeCard({
    job: makeJob({ scope: "solo", status: "failed", failureReason: "auto_sync_disabled" }),
    state: "failed",
  });
  assert.match(bibleOff.sentence, /\*\*Bible Auto-sync đã bị tắt\*\*.*mở \*\*Local Reader\*\*/);

  const other = describeCard({
    job: makeJob({ status: "failed", failureReason: "something_else" }),
    state: "failed",
  });
  assert.equal(other.sentence, "Artist không thể áp dụng preview này.");
});

test("an unrecognised job status falls back to the missing sentence", () => {
  const card = describeCard({ state: "archived" });
  assert.equal(card.kind, "missing");
  assert.equal(card.colorKey, "neutral");
  assert.equal(card.trackerLine, "");
  assert.equal(card.sentence, "Preview không còn tồn tại.");
  assert.equal(card.showBody, false);
});
