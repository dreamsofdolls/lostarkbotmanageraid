"use strict";

function getAutoManageEntries(report) {
  return Array.isArray(report?.perChar) ? report.perChar : [];
}

function isSuccessfulAutoManageEntry(entry) {
  return !!entry && !entry.error;
}

function hasSuccessfulAutoManageReport(report) {
  return getAutoManageEntries(report).some(isSuccessfulAutoManageEntry);
}

function getAppliedAutoManageEntries(report) {
  return getAutoManageEntries(report).filter(
    (entry) => Array.isArray(entry?.applied) && entry.applied.length > 0
  );
}

function hasAppliedAutoManageDelta(report) {
  return getAppliedAutoManageEntries(report).length > 0;
}

function countAppliedAutoManageGates(report) {
  return getAppliedAutoManageEntries(report).reduce(
    (sum, entry) => sum + entry.applied.length,
    0
  );
}

function stampAutoManageAttemptFromReport(doc, report, now = Date.now()) {
  if (!doc) return false;
  doc.lastAutoManageAttemptAt = now;
  if (!hasSuccessfulAutoManageReport(report)) return false;
  doc.lastAutoManageSyncAt = now;
  return true;
}

function toPlainUserDoc(userDoc) {
  if (!userDoc) return null;
  return typeof userDoc.toObject === "function" ? userDoc.toObject() : userDoc;
}

module.exports = {
  getAutoManageEntries,
  isSuccessfulAutoManageEntry,
  hasSuccessfulAutoManageReport,
  getAppliedAutoManageEntries,
  hasAppliedAutoManageDelta,
  countAppliedAutoManageGates,
  stampAutoManageAttemptFromReport,
  toPlainUserDoc,
};
