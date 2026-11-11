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

/**
 * Whether a user record holds at least one roster.
 * @param {object|null|undefined} userDoc Mongoose document, plain record or nothing.
 * @returns {boolean} True when `accounts` is a non-empty array.
 */
function hasRosterAccounts(userDoc) {
  return Array.isArray(userDoc?.accounts) && userDoc.accounts.length > 0;
}

module.exports = { toPlainUserDoc, findAccountByName, hasRosterAccounts };
