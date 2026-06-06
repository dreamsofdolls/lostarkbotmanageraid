"use strict";

const { DEFAULT_LANGUAGE } = require("../../../locales");
const { lookupArray } = require("./locale-arrays");

const CLEANUP_NOTICE_BUCKETS_ORDERED = [
  { key: "empty", label: "Sạch sẵn (0 tin)" },
  { key: "trivial", label: "Nhẹ (1-5 tin)" },
  { key: "normal", label: "Vừa (6-20 tin)" },
  { key: "heavy", label: "Nhiều (21+ tin)" },
];

function cleanupCountBucket(deleted) {
  if (deleted <= 0) return "empty";
  if (deleted <= 5) return "trivial";
  if (deleted <= 20) return "normal";
  return "heavy";
}

function pickFromPool(pool, vars = {}) {
  if (pool.length === 0) return "";
  const picked = pool[Math.floor(Math.random() * pool.length)];
  return picked.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
  );
}

function pickCleanupNoticeContent(deleted, lang = DEFAULT_LANGUAGE) {
  const bucket = cleanupCountBucket(deleted);
  const pool = lookupArray(lang, `announcements.cleanup-volume.${bucket}`);
  return pickFromPool(pool, { N: deleted });
}

function pickBedtimeNoticeContent(lang = DEFAULT_LANGUAGE) {
  const pool = lookupArray(lang, "announcements.artist-bedtime.variants");
  return pickFromPool(pool);
}

function pickWakeupNoticeContent(deleted, lang = DEFAULT_LANGUAGE) {
  const bucket = cleanupCountBucket(deleted);
  const pool = lookupArray(lang, `announcements.artist-wakeup.${bucket}`);
  return pickFromPool(pool, { N: deleted });
}

function buildCleanupNoticePreview() {
  const VARIANT_MAX = 60;
  const lines = ["Random pick mỗi lần fire theo lượng rác:"];
  for (const { key, label } of CLEANUP_NOTICE_BUCKETS_ORDERED) {
    const pool = lookupArray(DEFAULT_LANGUAGE, `announcements.cleanup-volume.${key}`);
    lines.push("");
    lines.push(`**${label}** - ${pool.length} variants:`);
    for (const variant of pool) {
      const shortened =
        variant.length > VARIANT_MAX ? variant.slice(0, VARIANT_MAX) + "..." : variant;
      lines.push(`• ${shortened}`);
    }
  }
  return lines.join("\n");
}

module.exports = {
  cleanupCountBucket,
  pickCleanupNoticeContent,
  pickBedtimeNoticeContent,
  pickWakeupNoticeContent,
  buildCleanupNoticePreview,
};
