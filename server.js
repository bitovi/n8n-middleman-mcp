import fs from 'node:fs';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fetch from 'node-fetch';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

function loadDotEnv(path = '.env') {
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

const REQUIRED_ENV = ['MS_CLIENT_ID'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const MCP_USER = process.env.MCP_USER || 'default-user';
const MS_TENANT_ID = process.env.MS_TENANT_ID || 'common';
const MS_CLIENT_ID = process.env.MS_CLIENT_ID;
const MS_SCOPES = process.env.MS_SCOPES || 'openid profile offline_access User.Read';
const N8N_DEFAULT_WEBHOOK_URL = process.env.N8N_DEFAULT_WEBHOOK_URL;
const N8N_MCP_URL = process.env.N8N_MCP;
const N8N_MCP_AUTH_TOKEN = process.env.N8N_MCP_AUTH_TOKEN;
const MCP_PORT = Number(process.env.MCP_PORT || 8787);
const MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL;

const DEVICE_CODE_URL = `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/devicecode`;
const TOKEN_URL = `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`;
const AUTHORIZE_URL = `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/authorize`;

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

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const WORKFLOW_DISCOVERY_CACHE_TTL_MS = 60 * 1000;

let n8nMcpClient = null;
let n8nMcpTransport = null;
let n8nWorkflowCache = {
  expires_at: 0,
  workflows: []
};

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomToken(size = 32) {
  return base64UrlEncode(randomBytes(size));
}

function sha256Base64Url(input) {
  return base64UrlEncode(createHash('sha256').update(input).digest());
}

function parseBearerToken(req) {
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== 'string') return null;
  const [scheme, token] = auth.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null;
  return token;
}

function parseBasicAuthClient(req) {
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

function buildPublicUrl(pathname) {
  if (!MCP_PUBLIC_URL) return null;
  return new URL(pathname, MCP_PUBLIC_URL).toString();
}

function cleanupExpiredAuthArtifacts() {
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

function nowMs() {
  return Date.now();
}

function hasValidAccessToken(tokens) {
  if (!tokens?.access_token || !tokens?.expires_at) return false;
  return tokens.expires_at - 60_000 > nowMs();
}

async function refreshAccessToken(userId) {
  const existing = tokenStore.get(userId);
  if (!existing?.refresh_token) return null;

  const body = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: existing.refresh_token,
    scope: MS_SCOPES
  });

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
    expires_at: nowMs() + (Number(json.expires_in || 3600) * 1000)
  };

  tokenStore.set(userId, merged);
  return merged;
}

async function ensureUsableToken(userId) {
  const existing = tokenStore.get(userId);
  if (hasValidAccessToken(existing)) return existing;
  return refreshAccessToken(userId);
}

async function ensureN8nMcpClient() {
  if (n8nMcpClient && n8nMcpTransport) return n8nMcpClient;
  if (!N8N_MCP_URL) {
    throw new Error('N8N_MCP environment variable is not configured.');
  }

  const requestInit = N8N_MCP_AUTH_TOKEN
    ? {
        headers: {
          Authorization: `Bearer ${N8N_MCP_AUTH_TOKEN}`
        }
      }
    : undefined;

  const client = new Client({ name: 'n8n-middleman-upstream-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(N8N_MCP_URL), { requestInit });

  transport.onclose = () => {
    n8nMcpClient = null;
    n8nMcpTransport = null;
  };

  await client.connect(transport);
  n8nMcpClient = client;
  n8nMcpTransport = transport;
  return client;
}

function extractToolPayload(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }

  if (Array.isArray(result?.content)) {
    const textPart = result.content.find((item) => item?.type === 'text' && typeof item.text === 'string');
    if (textPart?.text) {
      try {
        return JSON.parse(textPart.text);
      } catch {
        return null;
      }
    }
  }

  return null;
}

async function callN8nMcpTool(name, args = {}) {
  const client = await ensureN8nMcpClient();
  return client.callTool({ name, arguments: args });
}

function slugifyName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function parseWorkflowDescription(rawDescription) {
  const fullText = String(rawDescription || '').replace(/\r\n/g, '\n');
  const lines = fullText.split('\n');
  const summary = (lines[0] || '').trim();
  const metadataText = lines.slice(1).join('\n').trim();

  /** @type {Record<string, string>} */
  const inputHints = {};
  let returnImmediately = false;

  if (metadataText) {
    try {
      const parsed = JSON.parse(metadataText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const parsedVars = parsed.vars && typeof parsed.vars === 'object' && !Array.isArray(parsed.vars)
          ? parsed.vars
          : parsed;

        for (const [key, value] of Object.entries(parsedVars)) {
          if (key === 'return_immediately') continue;
          if (!key) continue;
          inputHints[key] = typeof value === 'string' ? value : String(value);
        }

        const returnImmediatelyValue = parsed.return_immediately;
        if (typeof returnImmediatelyValue === 'boolean') {
          returnImmediately = returnImmediatelyValue;
        } else if (typeof returnImmediatelyValue === 'string') {
          returnImmediately = returnImmediatelyValue.toLowerCase().trim() === 'true';
        }
      }
    } catch {
      // Ignore invalid JSON and fall back to generic input handling.
    }
  }

  return {
    summary,
    inputHints,
    returnImmediately
  };
}

function inferWorkflowInputType(triggerInfo) {
  const info = String(triggerInfo || '').toLowerCase();
  if (info.includes('webhook')) return 'webhook';
  if (info.includes('form')) return 'form';
  return 'chat';
}

function normalizeWorkflowInputType(value, fallbackType) {
  const normalized = typeof value === 'string' ? value.toLowerCase().trim() : '';
  if (normalized === 'chat' || normalized === 'form' || normalized === 'webhook') {
    return normalized;
  }
  return fallbackType;
}

function buildWorkflowInputsWithAccessToken(inputs, accessToken, triggerInfo, hasInputHints = false) {
  const inferredType = inferWorkflowInputType(triggerInfo);

  // When we expose per-field tool args from description JSON, those args should map
  // directly to the workflow payload body/data for the inferred trigger type.
  if (hasInputHints) {
    const hintedValues = inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? inputs : {};
    if (inferredType === 'webhook') {
      return {
        type: 'webhook',
        webhookData: {
          method: 'POST',
          body: {
            ...hintedValues,
            access_token: accessToken
          }
        }
      };
    }

    if (inferredType === 'form') {
      return {
        type: 'form',
        formData: {
          ...hintedValues,
          access_token: accessToken
        }
      };
    }

    if (typeof hintedValues.chatInput === 'string') {
      return {
        type: 'chat',
        chatInput: hintedValues.chatInput
      };
    }

    return undefined;
  }

  if (inputs === undefined) {
    return undefined;
  }

  if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
    const safeType = normalizeWorkflowInputType(inputs.type, inferredType);

    if (safeType === 'webhook') {
      const webhookData = inputs.webhookData && typeof inputs.webhookData === 'object'
        ? inputs.webhookData
        : {};
      const body = webhookData.body && typeof webhookData.body === 'object'
        ? webhookData.body
        : {};
      return {
        type: 'webhook',
        webhookData: {
          method: webhookData.method || 'POST',
          ...(webhookData.query ? { query: webhookData.query } : {}),
          ...(webhookData.headers ? { headers: webhookData.headers } : {}),
          body: {
            ...body,
            access_token: accessToken
          }
        }
      };
    }

    if (safeType === 'form') {
      const formData = inputs.formData && typeof inputs.formData === 'object'
        ? inputs.formData
        : {};
      return {
        type: 'form',
        formData: {
          ...formData,
          access_token: accessToken
        }
      };
    }

    return {
      type: 'chat',
      chatInput: typeof inputs.chatInput === 'string' ? inputs.chatInput : ''
    };
  }

  return undefined;
}

async function discoverWorkflowsFromN8n() {
  const now = nowMs();
  if (n8nWorkflowCache.expires_at > now && n8nWorkflowCache.workflows.length > 0) {
    return n8nWorkflowCache.workflows;
  }

  const searchResult = await callN8nMcpTool('search_workflows', { limit: 200 });
  const searchPayload = extractToolPayload(searchResult);
  const workflows = Array.isArray(searchPayload?.data) ? searchPayload.data : [];

  const withDetails = await Promise.all(
    workflows.map(async (workflow) => {
      try {
        const detailResult = await callN8nMcpTool('get_workflow_details', {
          workflowId: workflow.id
        });
        const detailPayload = extractToolPayload(detailResult);
        return {
          id: workflow.id,
          name: workflow.name || detailPayload?.workflow?.name || `workflow_${workflow.id}`,
          description:
            detailPayload?.workflow?.description ||
            workflow.description ||
            `n8n workflow ${workflow.id}`,
          triggerInfo: detailPayload?.triggerInfo || ''
        };
      } catch (error) {
        return {
          id: workflow.id,
          name: workflow.name || `workflow_${workflow.id}`,
          description: workflow.description || `n8n workflow ${workflow.id}`,
          triggerInfo: `Unable to fetch trigger details: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    })
  );

  n8nWorkflowCache = {
    expires_at: now + WORKFLOW_DISCOVERY_CACHE_TTL_MS,
    workflows: withDetails
  };

  return withDetails;
}

async function createServer() {
  const server = new McpServer(
    {
      name: 'n8n-middleman-ms-connector',
      version: '2.1.0'
    },
    {
      capabilities: {
        tools: { listChanged: true },
        logging: {}
      }
    }
  );

  if (N8N_MCP_URL) {
    try {
      const workflows = await discoverWorkflowsFromN8n();
      const usedNames = new Set();

      for (const workflow of workflows) {
        const baseName = slugifyName(workflow.name) || 'workflow';
        let toolName = `n8n_workflow_${baseName}_${String(workflow.id).slice(0, 8)}`;
        let dedupe = 1;
        while (usedNames.has(toolName)) {
          dedupe += 1;
          toolName = `n8n_workflow_${baseName}_${String(workflow.id).slice(0, 8)}_${dedupe}`;
        }
        usedNames.add(toolName);

        const parsedDescription = parseWorkflowDescription(workflow.description);
        const hasInputHints = Object.keys(parsedDescription.inputHints).length > 0;

        const inputSchema = hasInputHints
          ? Object.fromEntries(
              Object.entries(parsedDescription.inputHints).map(([key, hint]) => [
                key,
                z.any().optional().describe(hint)
              ])
            )
          : {
              inputs: z
                .any()
                .optional()
                .describe('Optional complete n8n execute_workflow.inputs object. For description-based args, this connector maps values into webhookData/formData automatically.')
            };

        const toolDescriptionParts = [
          `Execute n8n workflow "${workflow.name}" (id: ${workflow.id}).`,
          parsedDescription.summary,
          parsedDescription.returnImmediately
            ? 'Configured to return immediately without waiting for workflow completion.'
            : 'Configured to wait for workflow completion before returning.',
          workflow.triggerInfo ? `Trigger info: ${workflow.triggerInfo}` : ''
        ].filter(Boolean);

        server.registerTool(
          toolName,
          {
            description: toolDescriptionParts.join(' ').trim(),
            inputSchema
          },
          async (args) => {
            try {
              const userTokens = await ensureUsableToken(MCP_USER);
              if (!userTokens?.access_token) {
                throw new Error('No valid Microsoft access token available. Re-authenticate and try again.');
              }

              const workflowInputs = hasInputHints
                ? (args && typeof args === 'object' ? args : undefined)
                : args?.inputs;

              const executeWorkflowArgs = {
                workflowId: workflow.id,
                ...(buildWorkflowInputsWithAccessToken(workflowInputs, userTokens.access_token, workflow.triggerInfo, hasInputHints)
                  ? {
                      inputs: buildWorkflowInputsWithAccessToken(
                        workflowInputs,
                        userTokens.access_token,
                        workflow.triggerInfo,
                        hasInputHints
                      )
                    }
                  : {})
              };

              if (parsedDescription.returnImmediately) {
                callN8nMcpTool('execute_workflow', executeWorkflowArgs).catch((error) => {
                  console.error(
                    `[n8n-mcp] Async execution failed for workflow ${workflow.id}:`,
                    error instanceof Error ? error.message : error
                  );
                });

                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          workflowId: workflow.id,
                          workflowName: workflow.name,
                          accepted: true,
                          message: 'Workflow execution started and is running asynchronously.'
                        },
                        null,
                        2
                      )
                    }
                  ]
                };
              }

              const result = await callN8nMcpTool('execute_workflow', executeWorkflowArgs);
              const payload = extractToolPayload(result);
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      {
                        workflowId: workflow.id,
                        workflowName: workflow.name,
                        result: payload || result
                      },
                      null,
                      2
                    )
                  }
                ]
              };
            } catch (error) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: `Failed to execute workflow ${workflow.id}: ${error instanceof Error ? error.message : String(error)}`
                  }
                ]
              };
            }
          }
        );
      }
    } catch (error) {
      console.error('[n8n-mcp] Failed to discover workflows for dynamic tool registration:',
        error instanceof Error ? error.message : error
      );
    }
  }

  return server;
}

const sessions = new Map();

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10 * 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function collectRawBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, last-event-id');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.end(body);
}

function sendText(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(payload);
}

function sendRedirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.end();
}

function logAuthEvent(event, details = {}) {
  const safeDetails = { ...details };
  if (safeDetails.code) safeDetails.code = '[redacted]';
  if (safeDetails.code_verifier) safeDetails.code_verifier = '[redacted]';
  if (safeDetails.access_token) safeDetails.access_token = '[redacted]';
  if (safeDetails.refresh_token) safeDetails.refresh_token = '[redacted]';
  console.log(`[oauth] ${event}`, safeDetails);
}

function logRequestEvent(req, pathname, extra = {}) {
  console.log('[http]', {
    method: req.method,
    pathname,
    hasAuthorization: typeof req.headers.authorization === 'string',
    hasSessionId: typeof req.headers['mcp-session-id'] === 'string',
    ...extra
  });
}

function isMcpEndpointPath(pathname) {
  return pathname === '/mcp' || pathname === '/';
}

const httpServer = http.createServer(async (req, res) => {
  cleanupExpiredAuthArtifacts();

  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;
  logRequestEvent(req, pathname);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, last-event-id');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/.well-known/oauth-authorization-server') {
    if (!MCP_PUBLIC_URL) {
      sendJson(res, 500, { error: 'MCP_PUBLIC_URL must be configured for OAuth discovery.' });
      return;
    }

    sendJson(res, 200, {
      issuer: MCP_PUBLIC_URL,
      authorization_endpoint: buildPublicUrl('/authorize'),
      token_endpoint: buildPublicUrl('/token'),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: ['claudeai']
    });
    return;
  }

  if (req.method === 'GET' && (pathname === '/.well-known/oauth-protected-resource' || pathname === '/.well-known/oauth-protected-resource/mcp')) {
    if (!MCP_PUBLIC_URL) {
      sendJson(res, 500, { error: 'MCP_PUBLIC_URL must be configured for OAuth discovery.' });
      return;
    }

    sendJson(res, 200, {
      resource: buildPublicUrl('/mcp'),
      authorization_servers: [MCP_PUBLIC_URL],
      scopes_supported: ['claudeai'],
      bearer_methods_supported: ['header']
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/authorize') {
    if (!MCP_PUBLIC_URL) {
      sendText(res, 500, 'MCP_PUBLIC_URL must be set to your public ngrok URL.');
      return;
    }

    const responseType = requestUrl.searchParams.get('response_type');
    const clientId = requestUrl.searchParams.get('client_id');
    const redirectUri = requestUrl.searchParams.get('redirect_uri');
    const state = requestUrl.searchParams.get('state');
    const scope = requestUrl.searchParams.get('scope') || 'claudeai';
    const codeChallenge = requestUrl.searchParams.get('code_challenge');
    const codeChallengeMethod = requestUrl.searchParams.get('code_challenge_method') || 'S256';

    if (!responseType || responseType !== 'code' || !clientId || !redirectUri || !state || !codeChallenge) {
      logAuthEvent('authorize.invalid_request', { responseType, clientId, redirectUri, statePresent: !!state, hasCodeChallenge: !!codeChallenge });
      sendText(res, 400, 'Invalid authorize request. Missing required OAuth parameters.');
      return;
    }

    if (codeChallengeMethod !== 'S256') {
      logAuthEvent('authorize.unsupported_challenge_method', { codeChallengeMethod });
      sendText(res, 400, 'Unsupported code_challenge_method. Only S256 is supported.');
      return;
    }

    const localState = randomToken(24);
    pendingClaudeAuth.set(localState, {
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      scope,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      created_at: nowMs()
    });

    logAuthEvent('authorize.accepted', {
      clientId,
      redirectUri,
      scope,
      codeChallengeMethod
    });

    const msRedirectUri = buildPublicUrl('/oauth/callback');
    const authUrl = new URL(AUTHORIZE_URL);
    authUrl.searchParams.set('client_id', MS_CLIENT_ID);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', msRedirectUri);
    authUrl.searchParams.set('response_mode', 'query');
    authUrl.searchParams.set('scope', MS_SCOPES);
    authUrl.searchParams.set('state', localState);

    sendRedirect(res, authUrl.toString());
    return;
  }

  if (req.method === 'GET' && pathname === '/oauth/callback') {
    if (!MCP_PUBLIC_URL) {
      sendText(res, 500, 'MCP_PUBLIC_URL must be configured.');
      return;
    }

    const code = requestUrl.searchParams.get('code');
    const state = requestUrl.searchParams.get('state');
    const error = requestUrl.searchParams.get('error');
    const errorDescription = requestUrl.searchParams.get('error_description');

    if (error) {
      logAuthEvent('oauth_callback.microsoft_error', { error, errorDescription });
      sendText(res, 400, `Microsoft authorization failed: ${error} ${errorDescription || ''}`.trim());
      return;
    }

    if (!code || !state) {
      logAuthEvent('oauth_callback.missing_code_or_state', { hasCode: !!code, hasState: !!state });
      sendText(res, 400, 'Missing code or state from Microsoft callback.');
      return;
    }

    const pending = pendingClaudeAuth.get(state);
    if (!pending) {
      logAuthEvent('oauth_callback.invalid_state');
      sendText(res, 400, 'Authorization session expired or invalid state.');
      return;
    }

    pendingClaudeAuth.delete(state);

    const msRedirectUri = buildPublicUrl('/oauth/callback');
    const tokenBody = new URLSearchParams({
      client_id: MS_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: msRedirectUri,
      scope: MS_SCOPES
    });

    if (process.env.MS_CLIENT_SECRET) {
      tokenBody.set('client_secret', process.env.MS_CLIENT_SECRET);
    }

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody
    });
    const tokenJson = await tokenRes.json();

    if (!tokenRes.ok || !tokenJson.access_token) {
      logAuthEvent('oauth_callback.microsoft_token_exchange_failed', {
        status: tokenRes.status,
        error: tokenJson?.error,
        error_description: tokenJson?.error_description
      });
      sendText(res, 400, `Microsoft token exchange failed: ${JSON.stringify(tokenJson)}`);
      return;
    }

    const msTokens = {
      ...tokenJson,
      expires_at: nowMs() + Number(tokenJson.expires_in || 3600) * 1000
    };

    tokenStore.set(MCP_USER, msTokens);

    const claudeAuthCode = randomToken(24);
    const mcpAccessToken = randomToken(32);
    const refreshToken = randomToken(32);

    issuedAuthCodes.set(claudeAuthCode, {
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      scope: pending.scope,
      code_challenge: pending.code_challenge,
      code_challenge_method: pending.code_challenge_method,
      mcp_access_token: mcpAccessToken,
      refresh_token: refreshToken,
      expires_at: nowMs() + AUTH_CODE_TTL_MS,
      used: false
    });

    issuedRefreshTokens.set(refreshToken, {
      client_id: pending.client_id,
      scope: pending.scope,
      mcp_access_token: mcpAccessToken,
      expires_at: nowMs() + 30 * 24 * 60 * 60 * 1000
    });

    const callbackUrl = new URL(pending.redirect_uri);
    callbackUrl.searchParams.set('code', claudeAuthCode);
    callbackUrl.searchParams.set('state', pending.state);

    logAuthEvent('oauth_callback.redirecting_to_claude', {
      clientId: pending.client_id,
      redirectUri: pending.redirect_uri,
      scope: pending.scope
    });

    sendRedirect(res, callbackUrl.toString());
    return;
  }

  if (req.method === 'POST' && pathname === '/token') {
    const rawBody = await collectRawBody(req);
    const params = new URLSearchParams(rawBody);
    const grantType = params.get('grant_type');
    const basicClient = parseBasicAuthClient(req);
    const clientId = params.get('client_id') || basicClient?.clientId || null;

    if (!grantType) {
      sendJson(res, 400, { error: 'invalid_request', error_description: 'grant_type is required' });
      return;
    }

    if (grantType === 'authorization_code') {
      const code = params.get('code');
      const redirectUri = params.get('redirect_uri');
      const codeVerifier = params.get('code_verifier');

      const stored = code ? issuedAuthCodes.get(code) : null;
      if (!stored || stored.used || stored.expires_at <= nowMs()) {
        logAuthEvent('token.invalid_or_expired_code', {
          hasCode: !!code,
          found: !!stored,
          used: stored?.used,
          expired: stored ? stored.expires_at <= nowMs() : undefined
        });
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
        return;
      }

      if (!codeVerifier || sha256Base64Url(codeVerifier) !== stored.code_challenge) {
        logAuthEvent('token.pkce_verification_failed', {
          clientId,
          redirectUri,
          hasCodeVerifier: !!codeVerifier
        });
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }

      stored.used = true;

      logAuthEvent('token.authorization_code_exchanged', {
        clientId,
        redirectUri,
        scope: stored.scope
      });

      sendJson(res, 200, {
        access_token: stored.mcp_access_token,
        token_type: 'bearer',
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: stored.refresh_token,
        scope: stored.scope
      });
      return;
    }

    if (grantType === 'refresh_token') {
      const refreshToken = params.get('refresh_token');
      const stored = refreshToken ? issuedRefreshTokens.get(refreshToken) : null;

      if (!stored || stored.expires_at <= nowMs()) {
        logAuthEvent('token.invalid_or_expired_refresh_token', {
          found: !!stored,
          expired: stored ? stored.expires_at <= nowMs() : undefined
        });
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'Invalid or expired refresh token' });
        return;
      }

      const nextAccessToken = randomToken(32);
      stored.mcp_access_token = nextAccessToken;

      logAuthEvent('token.refresh_token_exchanged', {
        clientId,
        scope: stored.scope
      });

      sendJson(res, 200, {
        access_token: nextAccessToken,
        token_type: 'bearer',
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: refreshToken,
        scope: stored.scope
      });
      return;
    }

    sendJson(res, 400, { error: 'unsupported_grant_type' });
    return;
  }

  if (!isMcpEndpointPath(pathname)) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const bearerToken = parseBearerToken(req);
  if (!bearerToken) {
    const authServerMetadata = buildPublicUrl('/.well-known/oauth-authorization-server');
    const resourceMetadata = buildPublicUrl('/.well-known/oauth-protected-resource/mcp');
    if (authServerMetadata && resourceMetadata) {
      logAuthEvent('mcp.missing_bearer_token', {
        hasAuthorizationHeader: typeof req.headers.authorization === 'string',
        method: req.method
      });
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', `Bearer realm="mcp", authorization_uri="${buildPublicUrl('/authorize')}", token_uri="${buildPublicUrl('/token')}", resource_metadata="${resourceMetadata}", authorization_server="${MCP_PUBLIC_URL}"`);
      sendJson(res, 401, {
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Missing bearer token. Complete OAuth authorization first.' },
        id: null
      });
      return;
    }
  }

  const sessionId = req.headers['mcp-session-id'];

  try {
    if (req.method === 'POST') {
      const parsedBody = await collectBody(req);

      let entry = sessionId ? sessions.get(sessionId) : null;

      if (!entry) {
        if (!isInitializeRequest(parsedBody)) {
          sendJson(res, 400, {
            jsonrpc: '2.0',
            error: { code: -32000, message: 'No valid session. Initialize first.' },
            id: null
          });
          return;
        }

        const mcpServer = await createServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, mcpServer });
          }
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) sessions.delete(sid);
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      await entry.transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const entry = sessionId ? sessions.get(sessionId) : null;
      if (!entry) {
        if (req.method === 'GET') {
          // Streamable HTTP servers may choose not to support standalone SSE streams.
          // Returning 405 tells clients to proceed without SSE fallback.
          sendJson(res, 405, {
            jsonrpc: '2.0',
            error: { code: -32000, message: 'GET stream not supported without active session' },
            id: null
          });
          return;
        }

        sendJson(res, 400, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Invalid or missing session ID' },
          id: null
        });
        return;
      }

      await entry.transport.handleRequest(req, res);
      return;
    }

    sendJson(res, 405, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed' },
      id: null
    });
  } catch (error) {
    sendJson(res, 500, {
      jsonrpc: '2.0',
      error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' },
      id: null
    });
  }
});

httpServer.listen(MCP_PORT, () => {
  console.log(`External MCP connector listening at http://localhost:${MCP_PORT}/mcp`);
});
