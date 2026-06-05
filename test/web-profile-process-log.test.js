const test = require("node:test");
const assert = require("node:assert/strict");

function makeContainer() {
  return {
    hidden: true,
    innerHTML: "",
  };
}

test("profile process log updates rolling copy progress in place", async () => {
  const { createProfileProcessLogRenderer } = await import("../web/js/profile/profile-process-log.js");
  const container = makeContainer();
  const renderer = createProfileProcessLogRenderer({
    container,
    now: () => new Date("2026-06-05T16:00:00Z"),
  });

  renderer.render("info", "Creating a stable encounters.db snapshot before profile scan...");
  renderer.render("info", "Copying encounters.db snapshot... 10.0% / ~4.5 GB");
  renderer.render("info", "Copying encounters.db snapshot... 20.0% / ~4.5 GB");

  const entries = renderer.getEntries();
  assert.equal(entries.length, 2);
  assert.equal(entries[1].message, "Copying encounters.db snapshot... 20.0% / ~4.5 GB");
  assert.match(container.innerHTML, /process-panel/);
  assert.equal(container.hidden, false);
});

test("profile process log updates scan heartbeat in place and appends final state", async () => {
  const { createProfileProcessLogRenderer } = await import("../web/js/profile/profile-process-log.js");
  const container = makeContainer();
  const renderer = createProfileProcessLogRenderer({ container });

  renderer.render("info", "Scanning profile logs...");
  renderer.render("info", "Scanning encounters.db (~4.5 GB)... 1s");
  renderer.render("info", "Scanning encounters.db (~4.5 GB)... 2s");
  renderer.render("ok", "Profile auto-synced 120 raid log(s) across 19 character(s).");

  const entries = renderer.getEntries();
  assert.equal(entries.length, 3);
  assert.equal(entries[1].message, "Scanning encounters.db (~4.5 GB)... 2s");
  assert.equal(entries[2].kind, "ok");
  assert.match(container.innerHTML, /status-ok/);
});

test("profile process log updates upload heartbeat in place", async () => {
  const { createProfileProcessLogRenderer } = await import("../web/js/profile/profile-process-log.js");
  const container = makeContainer();
  const renderer = createProfileProcessLogRenderer({ container });

  renderer.render("info", "Đang gửi snapshot lên server... JSON 2.50 MB.");
  renderer.render("info", "Đang chờ server ghi raid-profile vào MongoDB... 1s");
  renderer.render("info", "Đang chờ server ghi raid-profile vào MongoDB... 2s");
  renderer.render("info", "MongoDB ghi xong: snapshot chính + 120 encounter summary (10 mới, 110 cập nhật).");

  const entries = renderer.getEntries();
  assert.equal(entries.length, 3);
  assert.equal(entries[1].message, "Đang chờ server ghi raid-profile vào MongoDB... 2s");
});

test("profile process log reset hides and clears the container", async () => {
  const { createProfileProcessLogRenderer } = await import("../web/js/profile/profile-process-log.js");
  const container = makeContainer();
  const renderer = createProfileProcessLogRenderer({ container });

  renderer.render("err", "<failed>");
  renderer.render(null, "");

  assert.deepEqual(renderer.getEntries(), []);
  assert.equal(container.hidden, true);
  assert.equal(container.innerHTML, "");
});
