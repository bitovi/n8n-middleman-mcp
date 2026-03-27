import { nowMs } from '../utils/crypto.js';

// TODO: Replace these in-memory Maps with a persistent DB-backed store (e.g., Redis/Postgres)
// so auth artifacts survive server restarts and can be shared across instances.
/** @type {Map<string, any>} */
export const tokenStore = new Map();
/** @type {Map<string, any>} */
export const pendingDeviceFlow = new Map();
/** @type {Map<string, any>} */
export const pendingClaudeAuth = new Map();
/** @type {Map<string, any>} */
export const issuedAuthCodes = new Map();
/** @type {Map<string, any>} */
export const issuedRefreshTokens = new Map();

export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

export function cleanupExpiredAuthArtifacts() {
  const now = nowMs();
  for (const [code, data] of issuedAuthCodes.entries()) {
    if (data.expires_at <= now || data.used) {
      issuedAuthCodes.delete(code);
    }
  }
  for (const [token, data] of issuedRefreshTokens.entries()) {
    if (data.expires_at && data.expires_at <= now) {
      issuedRefreshTokens.delete(token);
    }
  }
}