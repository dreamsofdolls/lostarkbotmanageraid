const mongoose = require("mongoose");

// Manager A (in RAID_MANAGER_ID allowlist) can grant grantee B a "share"
// over A's roster data. While the share is active, B's /raid-status,
// /raid-set autocomplete, /raid-task autocomplete, and the text parser in
// the raid channel resolve against (B's own rosters + A's shared rosters).
// A can revoke at any time; revoking deletes the share document and B
// reverts to seeing only their own data on the next command tick.
//
// Granularity is all-or-nothing per (A, B) pair: when A shares with B, B
// sees ALL of A's rosters. Per-roster shares would multiply UX complexity
// without matching the actual use case (raid managers delegating their
// whole bookkeeping to a co-manager / vice-officer).
//
// accessLevel:
//   - 'edit'  default: B can /raid-set, /raid-task, post raid-channel
//             text on A's chars. B still cannot /raid-add-roster, /raid-edit-roster,
//             /raid-remove-roster, or /raid-auto-manage on A's account; those
//             stay owner-exclusive by design.
//   - 'view'  read-only: B sees A's rosters in /raid-status etc. but
//             write paths reject with "View-only share".
//
// When A loses manager status (env RAID_MANAGER_ID change), existing
// shares auto-suspend in code (the access-control helper checks
// isManagerId(ownerDiscordId) before honoring a share). Records stay so
// that re-promoting A back to manager re-activates without B having to
// re-request grants.
//
// When A deletes a roster, this document stays alive but points at no
// data; B's view simply omits the missing roster on the next render. No
// cascade hook needed - if A re-adds rosters later, B sees them again
// automatically through the same share record.
const rosterShareSchema = new mongoose.Schema({
  ownerDiscordId: { type: String, required: true, index: true },
  granteeDiscordId: { type: String, required: true, index: true },
  accessLevel: { type: String, enum: ["view", "edit"], default: "edit" },
  createdAt: { type: Date, default: Date.now },
  // grantedBy stamps the discordId that ran /raid-share grant - same as
  // ownerDiscordId today, but reserved so a future "delegate grant"
  // feature can let a senior manager grant on behalf of A without losing
  // the audit trail.
  grantedBy: { type: String, default: null },
});

// Unique per (owner, grantee) pair. A second `/raid-share grant` for the
// same target overwrites accessLevel via upsert rather than creating
// a duplicate document.
rosterShareSchema.index({ ownerDiscordId: 1, granteeDiscordId: 1 }, { unique: true });

module.exports = mongoose.model("RosterShare", rosterShareSchema, "roster_shares");
