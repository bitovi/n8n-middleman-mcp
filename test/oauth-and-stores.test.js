import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasValidAccessToken,
  parseBasicAuthClient,
  parseBearerToken,
  verifyPkce
} from '../src/auth/oauth.js';
import { createInMemoryAuthStore } from '../src/auth/storeAdapters/inMemoryAuthStore.js';
import { createInMemorySessionStore } from '../src/mcp/storeAdapters/inMemorySessionStore.js';
import { sha256Base64Url } from '../src/utils/crypto.js';

test('parseBearerToken extracts bearer token', () => {
  const req = { headers: { authorization: 'Bearer abc123' } };
  assert.equal(parseBearerToken(req), 'abc123');
});

test('parseBasicAuthClient parses basic auth credentials', () => {
  const encoded = Buffer.from('my-client:my-secret').toString('base64');
  const req = { headers: { authorization: `Basic ${encoded}` } };
  assert.deepEqual(parseBasicAuthClient(req), { clientId: 'my-client', clientSecret: 'my-secret' });
});

test('verifyPkce validates verifier/challenge pair', () => {
  const verifier = 'my-verifier';
  const challenge = sha256Base64Url(verifier);
  assert.equal(verifyPkce(verifier, challenge), true);
  assert.equal(verifyPkce('wrong', challenge), false);
});

test('hasValidAccessToken checks expiry with safety buffer', () => {
  const valid = { access_token: 'a', expires_at: Date.now() + 5 * 60 * 1000 };
  const expiredish = { access_token: 'a', expires_at: Date.now() + 10 * 1000 };

  assert.equal(hasValidAccessToken(valid), true);
  assert.equal(hasValidAccessToken(expiredish), false);
});

test('in-memory auth store supports code/token lifecycle', () => {
  const store = createInMemoryAuthStore();

  store.setUserTokens('u1', { access_token: 'x' });
  assert.deepEqual(store.getUserTokens('u1'), { access_token: 'x' });

  store.setAuthCode('code1', { used: false, expires_at: Date.now() + 1000 });
  store.markAuthCodeUsed('code1');
  assert.equal(store.getAuthCode('code1').used, true);

  store.setRefreshToken('r1', { expires_at: Date.now() + 1000, mcp_access_token: 'old' });
  store.updateRefreshToken('r1', { mcp_access_token: 'new' });
  assert.equal(store.getRefreshToken('r1').mcp_access_token, 'new');
});

test('in-memory session store supports set/get/delete', () => {
  const store = createInMemorySessionStore();
  store.setSession('s1', { value: 1 });
  assert.deepEqual(store.getSession('s1'), { value: 1 });
  store.deleteSession('s1');
  assert.equal(store.getSession('s1'), null);
});
