"use strict";

const COMPANION_SCOPE = Object.freeze({
  full: "full",
  solo: "solo",
});

const SCOPE_NOT_ALLOWED_REASON = "scope_not_allowed";

function normalizeCompanionScope(value, { legacyDefault = true } = {}) {
  if (value === undefined || value === null || value === "") {
    return legacyDefault ? COMPANION_SCOPE.full : null;
  }
  const normalized = String(value).trim().toLowerCase();
  return Object.values(COMPANION_SCOPE).includes(normalized) ? normalized : null;
}

function getTokenCompanionScope(payload) {
  return normalizeCompanionScope(payload?.scope, { legacyDefault: true });
}

function isCompanionScopeEnabledForUser(userDoc, scope) {
  const normalized = normalizeCompanionScope(scope, { legacyDefault: true });
  if (normalized === COMPANION_SCOPE.full) return userDoc?.localSyncEnabled === true;
  if (normalized === COMPANION_SCOPE.solo) return userDoc?.autoManageEnabled === true;
  return false;
}

function isModeAllowedForCompanionScope(scope, modeKey) {
  const normalized = normalizeCompanionScope(scope, { legacyDefault: true });
  if (normalized === COMPANION_SCOPE.full) return true;
  return normalized === COMPANION_SCOPE.solo && modeKey === "solo";
}

function resolveRequiredCompanionScope({ requiredCompanionScope = null, requireLocalSyncEnabled = false } = {}) {
  if (requiredCompanionScope !== null && requiredCompanionScope !== undefined) {
    return normalizeCompanionScope(requiredCompanionScope, { legacyDefault: false });
  }
  return requireLocalSyncEnabled ? COMPANION_SCOPE.full : null;
}

function buildCompanionStateFilter(discordId, scope) {
  const normalized = normalizeCompanionScope(scope, { legacyDefault: true });
  if (normalized === COMPANION_SCOPE.solo) {
    return { discordId, autoManageEnabled: true };
  }
  return { discordId, localSyncEnabled: true };
}

module.exports = {
  COMPANION_SCOPE,
  SCOPE_NOT_ALLOWED_REASON,
  normalizeCompanionScope,
  getTokenCompanionScope,
  isCompanionScopeEnabledForUser,
  isModeAllowedForCompanionScope,
  resolveRequiredCompanionScope,
  buildCompanionStateFilter,
};
