import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function runConfigWithEnv(env) {
  return spawnSync(
    process.execPath,
    ['-e', "import('./src/config.js').then(() => { console.log('OK'); })"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env
      },
      encoding: 'utf8'
    }
  );
}

test('config accepts google provider when GOOGLE_CLIENT_ID is set', () => {
  const res = runConfigWithEnv({
    OAUTH_PROVIDER: 'google',
    GOOGLE_CLIENT_ID: 'google-client-id',
    MS_CLIENT_ID: ''
  });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /OK/);
});

test('config fails for google provider without GOOGLE_CLIENT_ID', () => {
  const res = runConfigWithEnv({
    OAUTH_PROVIDER: 'google',
    GOOGLE_CLIENT_ID: '',
    MS_CLIENT_ID: ''
  });

  assert.notEqual(res.status, 0);
  assert.match(`${res.stderr}${res.stdout}`, /Missing required environment variable: GOOGLE_CLIENT_ID/);
});

test('config fails for invalid OAUTH_PROVIDER value', () => {
  const res = runConfigWithEnv({
    OAUTH_PROVIDER: 'github',
    MS_CLIENT_ID: 'test-client'
  });

  assert.notEqual(res.status, 0);
  assert.match(`${res.stderr}${res.stdout}`, /Invalid OAUTH_PROVIDER/);
});
