import fetch from 'node-fetch';
import { OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_SCOPES, TOKEN_URL } from '../config.js';
import { nowMs, sha256Base64Url } from '../utils/crypto.js';
import { authStore } from './storeFactory.js';

export function parseBearerToken(req) {
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== 'string') return null;
  const [scheme, token] = auth.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null;
  return token;
}

export function parseBasicAuthClient(req) {
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== 'string') return null;
  const [scheme, encoded] = auth.split(' ');
  if (!scheme || !encoded || scheme.toLowerCase() !== 'basic') return null;
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    const clientId = decoded.slice(0, idx);
    const clientSecret = decoded.slice(idx + 1);
    return { clientId, clientSecret };
  } catch {
    return null;
  }
}

export function hasValidAccessToken(tokens) {
  if (!tokens?.access_token || !tokens?.expires_at) return false;
  return tokens.expires_at - 60_000 > nowMs();
}

export async function refreshAccessToken(userId) {
  const existing = authStore.getUserTokens(userId);
  if (!existing?.refresh_token) return null;

  const body = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: existing.refresh_token,
    scope: OAUTH_SCOPES
  });

  if (OAUTH_CLIENT_SECRET) {
    body.set('client_secret', OAUTH_CLIENT_SECRET);
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const json = await res.json();
  if (!res.ok) {
    return null;
  }

  const merged = {
    ...existing,
    ...json,
    refresh_token: json.refresh_token || existing.refresh_token,
    expires_at: nowMs() + Number(json.expires_in || 3600) * 1000
  };

  authStore.setUserTokens(userId, merged);
  return merged;
}

export async function ensureUsableToken(userId) {
  const existing = authStore.getUserTokens(userId);
  if (hasValidAccessToken(existing)) return existing;
  return refreshAccessToken(userId);
}

export function verifyPkce(codeVerifier, codeChallenge) {
  return Boolean(codeVerifier) && sha256Base64Url(codeVerifier) === codeChallenge;
}

export function logAuthEvent(event, details = {}) {
  const safeDetails = { ...details };
  if (safeDetails.code) safeDetails.code = '[redacted]';
  if (safeDetails.code_verifier) safeDetails.code_verifier = '[redacted]';
  if (safeDetails.access_token) safeDetails.access_token = '[redacted]';
  if (safeDetails.refresh_token) safeDetails.refresh_token = '[redacted]';
  console.log(`[oauth] ${event}`, safeDetails);
}