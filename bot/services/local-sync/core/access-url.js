"use strict";

const {
  rotateLocalSyncToken,
  extractIdentityFromUser,
} = require("./tokens");

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function publicBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
}

function buildLocalSyncUrl(token, baseUrl = publicBaseUrl()) {
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
  if (!normalizedBaseUrl || !token) return null;
  return `${normalizedBaseUrl}/sync#token=${encodeURIComponent(token)}`;
}

/**
 * Resolve the configured companion URL, issue or reuse its token, and return
 * the private browser link. Keeping these steps together prevents Discord
 * surfaces from drifting on URL normalization, identity, or token scope.
 *
 * `tokenProvider` remains injectable because resume links reuse a stored token
 * while explicit "new link" actions rotate it. Missing PUBLIC_BASE_URL returns
 * null before token work so disabled deployments never write token state.
 */
async function issueLocalSyncAccessUrl(options = {}) {
  const baseUrl = hasOwn(options, "baseUrl")
    ? String(options.baseUrl || "").replace(/\/+$/, "")
    : publicBaseUrl();
  if (!baseUrl) return null;

  const tokenProvider = options.tokenProvider || rotateLocalSyncToken;
  const tokenDeps = {
    UserModel: options.UserModel,
    identity: hasOwn(options, "identity")
      ? options.identity
      : extractIdentityFromUser(options.discordUser),
  };
  if (hasOwn(options, "scope")) tokenDeps.scope = options.scope;
  if (hasOwn(options, "userDoc")) tokenDeps.userDoc = options.userDoc;

  const token = await tokenProvider(options.discordId, options.lang, tokenDeps);
  return buildLocalSyncUrl(token, baseUrl);
}

module.exports = {
  publicBaseUrl,
  buildLocalSyncUrl,
  issueLocalSyncAccessUrl,
};
