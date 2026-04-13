import { nowMs } from '../../utils/crypto.js';

/**
 * In-memory auth store adapter.
 * Replace with Redis/Postgres-backed adapter for multi-instance durability.
 */
export function createInMemoryAuthStore() {
  /** @type {Map<string, any>} */
  const tokenStore = new Map();
  /** @type {Map<string, any>} */
  const pendingDeviceFlow = new Map();
  /** @type {Map<string, any>} */
  const pendingClaudeAuth = new Map();
  /** @type {Map<string, any>} */
  const issuedAuthCodes = new Map();
  /** @type {Map<string, any>} */
  const issuedRefreshTokens = new Map();

  return {
    getUserTokens(userId) {
      return tokenStore.get(userId) || null;
    },
    setUserTokens(userId, tokens) {
      tokenStore.set(userId, tokens);
    },

    getPendingDeviceFlow(key) {
      return pendingDeviceFlow.get(key) || null;
    },
    setPendingDeviceFlow(key, value) {
      pendingDeviceFlow.set(key, value);
    },
    deletePendingDeviceFlow(key) {
      pendingDeviceFlow.delete(key);
    },

    getPendingClaudeAuth(state) {
      return pendingClaudeAuth.get(state) || null;
    },
    setPendingClaudeAuth(state, payload) {
      pendingClaudeAuth.set(state, payload);
    },
    deletePendingClaudeAuth(state) {
      pendingClaudeAuth.delete(state);
    },

    getAuthCode(code) {
      return issuedAuthCodes.get(code) || null;
    },
    setAuthCode(code, payload) {
      issuedAuthCodes.set(code, payload);
    },
    markAuthCodeUsed(code) {
      const stored = issuedAuthCodes.get(code);
      if (!stored) return;
      issuedAuthCodes.set(code, { ...stored, used: true });
    },
    deleteAuthCode(code) {
      issuedAuthCodes.delete(code);
    },

    getRefreshToken(token) {
      return issuedRefreshTokens.get(token) || null;
    },
    setRefreshToken(token, payload) {
      issuedRefreshTokens.set(token, payload);
    },
    updateRefreshToken(token, updates) {
      const stored = issuedRefreshTokens.get(token);
      if (!stored) return;
      issuedRefreshTokens.set(token, { ...stored, ...updates });
    },
    deleteRefreshToken(token) {
      issuedRefreshTokens.delete(token);
    },

    cleanupExpiredAuthArtifacts() {
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
  };
}
