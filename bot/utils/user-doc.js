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

module.exports = { toPlainUserDoc };
