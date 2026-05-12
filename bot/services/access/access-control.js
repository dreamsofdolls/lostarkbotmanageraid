const RosterShare = require("../../models/RosterShare");
const User = require("../../models/user");
const { isManagerId } = require("./manager");

// Build the "accessible accounts" set for a viewer. The set is the
// union of:
//   - viewer's own accounts (always full edit access)
//   - accounts owned by other Discord users who have an active
//     RosterShare with viewer as grantee, AND whose ownerDiscordId is
//     still in RAID_MANAGER_ID (env-driven manager allowlist)
//
// Ownership stays canonical: a shared account is a *view* into the
// owner's User document, not a copy. Updates against shared accounts
// flow back to the owner's User doc so /raid-set, /raid-task, text
// parser writes mutate one source of truth.
//
// When the owner is no longer in RAID_MANAGER_ID (env removed), the
// share auto-suspends here without needing a DB cleanup pass: the
// share document stays, the helper just filters it out. Re-adding the
// owner to the env restores the share automatically.
//
// Shape returned per element:
//   {
//     ownerDiscordId,       // string
//     ownerLabel,           // friendly name for UI ("@Alice")
//     accountName,          // string
//     account,              // Mongoose account subdoc
//     accessLevel,          // 'edit' | 'view'
//     isOwn,                // bool
//   }
async function getAccessibleAccounts(viewerDiscordId, { models = {}, helpers = {}, includeOwn = true } = {}) {
  const ResolvedUser = models.User || User;
  const ResolvedShare = models.RosterShare || RosterShare;
  const resolvedIsManagerId = helpers.isManagerId || isManagerId;
  const accessible = [];

  if (!viewerDiscordId) return accessible;

  if (includeOwn) {
    const ownDoc = await ResolvedUser.findOne({ discordId: viewerDiscordId });
    if (ownDoc && Array.isArray(ownDoc.accounts)) {
      for (const account of ownDoc.accounts) {
        accessible.push({
          ownerDiscordId: viewerDiscordId,
          ownerLabel: pickDisplayLabel(ownDoc),
          accountName: account.accountName,
          account,
          accessLevel: "edit",
          isOwn: true,
        });
      }
    }
  }

  const shares = await ResolvedShare.find({ granteeDiscordId: viewerDiscordId }).lean();
  if (!shares || shares.length === 0) return accessible;

  const liveShares = shares.filter((share) => resolvedIsManagerId(share.ownerDiscordId));
  if (liveShares.length === 0) return accessible;

  const ownerDocs = await ResolvedUser.find({
    discordId: { $in: liveShares.map((s) => s.ownerDiscordId) },
  });

  for (const ownerDoc of ownerDocs) {
    const share = liveShares.find((s) => s.ownerDiscordId === ownerDoc.discordId);
    if (!share) continue;
    if (!Array.isArray(ownerDoc.accounts)) continue;
    for (const account of ownerDoc.accounts) {
      accessible.push({
        ownerDiscordId: ownerDoc.discordId,
        ownerLabel: pickDisplayLabel(ownerDoc),
        accountName: account.accountName,
        account,
        accessLevel: share.accessLevel || "edit",
        isOwn: false,
      });
    }
  }

  return accessible;
}

// Light-weight "can viewer write?" check used at the top of write
// handlers (/raid-set, /raid-task add, etc.) before we even autocomplete
// the next field. Saves a Mongo round trip on every interaction by
// short-circuiting on viewer === owner (the common case).
async function canEditAccount(viewerDiscordId, ownerDiscordId, { models = {}, helpers = {} } = {}) {
  if (!viewerDiscordId || !ownerDiscordId) return false;
  if (viewerDiscordId === ownerDiscordId) return true;

  const resolvedIsManagerId = helpers.isManagerId || isManagerId;
  if (!resolvedIsManagerId(ownerDiscordId)) return false;

  const ResolvedShare = models.RosterShare || RosterShare;
  const share = await ResolvedShare.findOne({
    ownerDiscordId,
    granteeDiscordId: viewerDiscordId,
    accessLevel: "edit",
  }).lean();
  return !!share;
}

// Lookup helper: given a viewer + a character name (case-insensitive),
// return the (ownerDoc, account, character) trio if the char exists in
// any accessible account. Used by text parser + /raid-set when the
// caller has a name but doesn't know which roster it belongs to.
async function findAccessibleCharacter(viewerDiscordId, charName, options = {}) {
  if (!viewerDiscordId || !charName) return null;
  const target = String(charName).trim().toLowerCase();
  if (!target) return null;

  const accessible = await getAccessibleAccounts(viewerDiscordId, options);
  for (const entry of accessible) {
    const chars = Array.isArray(entry.account?.characters) ? entry.account.characters : [];
    for (const character of chars) {
      const candidates = [character.charName, character.name, character.displayName]
        .filter(Boolean)
        .map((s) => String(s).toLowerCase());
      if (candidates.includes(target)) {
        return { ...entry, character };
      }
    }
  }
  return null;
}

function pickDisplayLabel(userDoc) {
  if (!userDoc) return "";
  return (
    userDoc.discordDisplayName ||
    userDoc.discordGlobalName ||
    userDoc.discordUsername ||
    userDoc.discordId ||
    ""
  );
}

module.exports = {
  getAccessibleAccounts,
  canEditAccount,
  findAccessibleCharacter,
  pickDisplayLabel,
};
