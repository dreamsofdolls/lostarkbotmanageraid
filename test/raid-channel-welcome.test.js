// Regression: welcome embed must not exceed Discord's 1024-char-per-field
// cap. Live deploy on 2026-04-27 hit `s.string().lengthLessThanOrEqual()`
// at addFields() because the maintenance bullet pushed the
// "📣 Artist sẽ tự nói" field over 1024 chars. After the per-guild i18n
// migration the welcome strings live in the locale tree, so the test now
// reads from each locale and validates every locale stays under cap.

const test = require("node:test");
const assert = require("node:assert/strict");

const { TRANSLATIONS } = require("../bot/locales");

function extractWelcomeFieldLengths(localeTree) {
  // Mirror buildRaidChannelWelcomeEmbed's field order. Each entry is a
  // (nameKey, valueKey) pair in the welcome.* namespace; values may be a
  // string OR a string[] which the consumer joins with "\n".
  const fieldKeys = [
    ["onboardingName", "onboardingValue"],
    ["examplesName", "examplesValue"],
    ["aliasesName", "aliasesValue"],
    ["notesName", "notesValue"],
    ["voiceName", "voiceValue"],
    ["maintenanceName", "maintenanceValue"],
    ["autoManageName", "autoManageValue"],
    ["sideTasksName", "sideTasksValue"],
    ["goldName", "goldValue"],
    ["crownName", "crownValue"],
    ["iconName", "iconValue"],
  ];
  const welcome = localeTree.welcome || {};
  const out = [];
  for (const [nameKey, valueKey] of fieldKeys) {
    const nameRaw = welcome[nameKey];
    const valueRaw = welcome[valueKey];
    if (typeof nameRaw !== "string") continue;
    const value = Array.isArray(valueRaw) ? valueRaw.join("\n") : valueRaw;
    if (typeof value !== "string") continue;
    out.push({ name: nameRaw, length: value.length });
  }
  return out;
}

for (const localeCode of Object.keys(TRANSLATIONS)) {
  test(`REGRESSION: welcome embed (${localeCode}): every field value <= 1024 chars (Discord cap)`, () => {
    const fields = extractWelcomeFieldLengths(TRANSLATIONS[localeCode]);
    assert.ok(fields.length > 0, `expected to extract at least one field for ${localeCode}`);
    for (const f of fields) {
      assert.ok(
        f.length <= 1024,
        `[${localeCode}] field "${f.name}" is ${f.length} chars (cap 1024). Split into multiple fields if it grows past the limit.`
      );
    }
  });

  test(`welcome embed (${localeCode}): total field-value length leaves headroom under 6000-char embed cap`, () => {
    const fields = extractWelcomeFieldLengths(TRANSLATIONS[localeCode]);
    const totalValueChars = fields.reduce((sum, f) => sum + f.length, 0);
    const totalNameChars = fields.reduce((sum, f) => sum + f.name.length, 0);
    // Discord's hard cap is 6000 across title + description + every field
    // name/value combined. Title/description add ~400 chars. Stay under 5500
    // total to keep room for the icon emoji prefixes that resolve at runtime.
    assert.ok(
      totalValueChars + totalNameChars < 5500,
      `[${localeCode}] welcome embed total ${totalValueChars + totalNameChars} chars - approaching Discord 6000 cap`
    );
  });
}
