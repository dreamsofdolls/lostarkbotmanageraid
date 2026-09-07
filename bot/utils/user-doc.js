"use strict";

/**
 * Unwrap a Mongoose user document without cloning an already-lean snapshot.
 * @param {object|null} userDoc Mongoose document or plain user record.
 * @returns {object|null} Plain record, retaining reference identity for lean input.
 */
function toPlainUserDoc(userDoc) {
  if (!userDoc) return null;
  return typeof userDoc.toObject === "function" ? userDoc.toObject() : userDoc;
}

/**
 * Find a roster in a user document using the caller's name normalization policy.
 * @returns {object|null} The original account object, or null when absent.
 */
function findAccountByName(userDoc, accountName, normalizeName) {
  const target = normalizeName(accountName);
  if (!target || !Array.isArray(userDoc?.accounts)) return null;
  return userDoc.accounts.find((account) => normalizeName(account?.accountName) === target) || null;
}

module.exports = { toPlainUserDoc, findAccountByName };
