const test = require("node:test");
const assert = require("node:assert/strict");

const { TRANSLATIONS, SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } = require("../bot/locales");
const { normalizeLanguage, resolveLocale } = require("../bot/services/i18n");
const { TOKEN_DEFAULT_TTL_SEC } = require("../bot/services/local-sync");

function leafKeys(value, prefix = "", out = []) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      leafKeys(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  out.push(prefix);
  return out;
}

function flattenStrings(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) flattenStrings(child, out);
  }
  return out;
}

test("first-class languages round-trip through normalizeLanguage", () => {
  const codes = SUPPORTED_LANGUAGES.map((entry) => entry.code);
  assert.deepEqual(codes, ["vi", "jp", "en"]);

  for (const code of codes) {
    assert.equal(normalizeLanguage(code), code);
    assert.equal(resolveLocale(code), code);
  }
  assert.equal(normalizeLanguage("fr"), DEFAULT_LANGUAGE);
  assert.equal(resolveLocale("fr"), DEFAULT_LANGUAGE);
});

test("locale packs keep the same leaf-key shape as vi", () => {
  const expected = new Set(leafKeys(TRANSLATIONS.vi));
  for (const [code, tree] of Object.entries(TRANSLATIONS)) {
    const actual = new Set(leafKeys(tree));
    const missing = [...expected].filter((key) => !actual.has(key));
    assert.deepEqual(missing, [], `${code} is missing locale keys`);
  }
});

test("vi raid-check filter dropdowns do not leak English state labels", () => {
  const filter = TRANSLATIONS.vi["raid-check"].filter;
  const copy = Object.values(filter).join("\n").replace(/\{[^}]+\}/g, "");

  assert.doesNotMatch(copy, /\b(?:pending|success|done|filter by|jump to)\b/i);
  assert.equal(filter.statusPending, "Chưa clear");
  assert.equal(filter.statusSuccess, "Đã xong");
  assert.equal(
    filter.rosterState,
    "{name} (Còn {pending} raid)"
  );
  assert.equal(filter.raidSummary, "Raids (Còn {n} raid)");
});

test("vi gold-earner hint uses the current command wording", () => {
  assert.equal(
    TRANSLATIONS.vi["raid-status"].embed.goldEarnerHint,
    "_💰 Bật gold-earner bằng `/raid-gold-earner roster:<name>`._"
  );
});

test("raid-check hidden-data copy and active sync badges are localized without ON/OFF wording", () => {
  const expected = {
    vi: {
      auto: " · 📝 Auto-sync",
      local: " · 🌐 Local-sync",
      hidden: "🗑️ Dữ liệu không hiển thị",
    },
    jp: {
      auto: " · 📝 自動同期",
      local: " · 🌐 ローカル同期",
      hidden: "🗑️ データは表示されません",
    },
    en: {
      auto: " · 📝 Auto-sync",
      local: " · 🌐 Local-sync",
      hidden: "🗑️ Data not displayed",
    },
  };

  for (const [code, values] of Object.entries(expected)) {
    const locale = TRANSLATIONS[code];
    assert.equal(locale["raid-status"].embed.autoSyncOnBadge, values.auto);
    assert.equal(locale["raid-status"].embed.localSyncOnBadge, values.local);
    assert.equal(locale["raid-check"].allMode.hiddenRaidData, values.hidden);
    assert.doesNotMatch(`${values.auto}\n${values.local}`, /BẬT|TẮT|\bON\b|\bOFF\b/);
  }
});

test("Solo Companion launcher copy is complete in all three first-class languages", () => {
  const keys = [
    "soloCompanionButtonLabel",
    "soloCompanionTitle",
    "soloCompanionDescription",
    "soloCompanionOpenButtonLabel",
    "soloCompanionUnavailableTitle",
    "soloCompanionUnavailableDescription",
    "soloCompanionFailedTitle",
    "soloCompanionFailedDescription",
  ];

  for (const code of ["vi", "jp", "en"]) {
    const sync = TRANSLATIONS[code]["raid-status"].sync;
    for (const key of keys) {
      assert.equal(typeof sync[key], "string", `${code} is missing raid-status.sync.${key}`);
      assert.ok(sync[key].trim(), `${code} has an empty raid-status.sync.${key}`);
    }
    assert.match(sync.soloCompanionDescription, /Solo/i);
  }
});

test("Local Sync copy matches the signed-token lifecycle in every language", () => {
  const ttlMinutes = TOKEN_DEFAULT_TTL_SEC / 60;
  assert.equal(ttlMinutes, 30, "copy expectations must be reviewed when the token TTL changes");

  for (const code of ["vi", "jp", "en"]) {
    const locale = TRANSLATIONS[code];
    const statusSync = locale["raid-status"].sync;
    const autoManage = locale["raid-auto-manage"];
    const localOnHelp = flattenStrings(locale).find(
      (text) => text.includes("action:local-on") && text.includes("TTL")
    );

    const ttlCopy = [
      locale["stuck-nudge"].dmDescription,
      autoManage.localEnable.successDescriptionWithLink,
      localOnHelp,
    ];
    for (const text of ttlCopy) {
      assert.equal(typeof text, "string", `${code} is missing Local Sync TTL copy`);
      assert.match(text, new RegExp(String(ttlMinutes)), `${code} Local Sync TTL copy drifted`);
    }
    assert.doesNotMatch(
      localOnHelp,
      /\bDM\b/i,
      `${code} local-on help must describe its private reply instead of a DM`
    );

    assert.match(
      autoManage.redundant.localAlreadyOnDescription,
      /\/raid-status/,
      `${code} already-on guidance must expose the token rotation path`
    );
    assert.match(
      autoManage.localEnable.successDescriptionWithLink,
      /\/raid-status/,
      `${code} expired-link guidance must use /raid-status`
    );
    assert.doesNotMatch(
      autoManage.localEnable.successDescriptionWithLink,
      /action:local-on/,
      `${code} must not send enabled users through the blocked local-on gate`
    );
    assert.match(
      locale["stuck-nudge"].switchedDescription,
      /\/raid-status/,
      `${code} nudge confirmation must expose the Local Sync status view`
    );
    assert.doesNotMatch(
      flattenStrings(locale).join("\n"),
      /\/raid-sync\b/,
      `${code} still points users to the removed /raid-sync command`
    );

    const lifecycleCopy = [
      statusSync.localNewLinkSuccessDescription,
      autoManage.localEnable.successDescription,
      autoManage.localEnable.successDescriptionWithLink,
      autoManage.localDisable.description,
    ].join("\n");
    assert.doesNotMatch(
      lifecycleCopy,
      /Phase 3|still being built|đang xây|構築中|once it's live|khi nó live|ライブになってから/,
      `${code} still describes the live companion as unfinished`
    );
    assert.doesNotMatch(
      statusSync.localNewLinkSuccessDescription,
      /old token stays valid|Token cũ vẫn còn hiệu lực|古いトークン.*有効/,
      `${code} incorrectly says a rotated token remains valid`
    );
  }
});

test("jp/en raid-channel schedule copy matches per-language quiet hours", () => {
  const enText = flattenStrings(TRANSLATIONS.en).join("\n");
  assert.match(enText, /03:00-08:00 UTC/);
  assert.match(enText, /03:00 UTC bedtime/);
  assert.match(enText, /08:00 UTC wakeup/);
  assert.doesNotMatch(enText, /01:00-20:00|20:00-01:00|20:00 UTC bedtime|01:00 UTC wakeup/);

  const jpText = flattenStrings(TRANSLATIONS.jp).join("\n");
  assert.match(jpText, /朝3時/);
  assert.match(jpText, /朝8時/);
  assert.doesNotMatch(jpText, /朝5時|朝10時|翌5時/);
});
