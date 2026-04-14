import fs from 'node:fs';

export function loadDotEnv(path = '.env') {
  if (!fs.existsSync(path)) return;
  const text = fs.readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

const OAUTH_PROVIDER_RAW = String(process.env.OAUTH_PROVIDER || 'microsoft').toLowerCase().trim();

if (!['microsoft', 'google'].includes(OAUTH_PROVIDER_RAW)) {
  console.error('Invalid OAUTH_PROVIDER. Expected "microsoft" or "google".');
  process.exit(1);
}

const REQUIRED_ENV = OAUTH_PROVIDER_RAW === 'google'
  ? ['GOOGLE_CLIENT_ID']
  : ['MS_CLIENT_ID'];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

export const MCP_USER = process.env.MCP_USER || 'default-user';
export const OAUTH_PROVIDER = OAUTH_PROVIDER_RAW;
export const OAUTH_PROVIDER_LABEL = OAUTH_PROVIDER === 'google' ? 'Google' : 'Microsoft';

export const MS_TENANT_ID = process.env.MS_TENANT_ID || 'common';
export const MS_CLIENT_ID = process.env.MS_CLIENT_ID;
export const MS_SCOPES = process.env.MS_SCOPES || 'openid profile offline_access User.Read';

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
export const GOOGLE_SCOPES = process.env.GOOGLE_SCOPES || 'openid profile email';

export const N8N_DEFAULT_WEBHOOK_URL = process.env.N8N_DEFAULT_WEBHOOK_URL;
export const N8N_MCP_URL = process.env.N8N_MCP;
export const N8N_MCP_AUTH_TOKEN = process.env.N8N_MCP_AUTH_TOKEN;
export const MCP_PORT = Number(process.env.MCP_PORT || 8787);
export const MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL;

export const OAUTH_CLIENT_ID = OAUTH_PROVIDER === 'google' ? GOOGLE_CLIENT_ID : MS_CLIENT_ID;
export const OAUTH_CLIENT_SECRET = OAUTH_PROVIDER === 'google'
  ? process.env.GOOGLE_CLIENT_SECRET
  : process.env.MS_CLIENT_SECRET;
export const OAUTH_SCOPES = OAUTH_PROVIDER === 'google' ? GOOGLE_SCOPES : MS_SCOPES;

export const DEVICE_CODE_URL = `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/devicecode`;
export const TOKEN_URL = OAUTH_PROVIDER === 'google'
  ? 'https://oauth2.googleapis.com/token'
  : `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`;
export const AUTHORIZE_URL = OAUTH_PROVIDER === 'google'
  ? 'https://accounts.google.com/o/oauth2/v2/auth'
  : `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/authorize`;

export function buildPublicUrl(pathname) {
  if (!MCP_PUBLIC_URL) return null;
  return new URL(pathname, MCP_PUBLIC_URL).toString();
}