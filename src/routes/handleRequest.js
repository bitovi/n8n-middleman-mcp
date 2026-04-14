import { randomUUID } from 'node:crypto';
import fetch from 'node-fetch';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ACCESS_TOKEN_TTL_MS, AUTH_CODE_TTL_MS, REFRESH_TOKEN_TTL_MS } from '../auth/constants.js';
import { authStore } from '../auth/storeFactory.js';
import { logAuthEvent, parseBasicAuthClient, parseBearerToken, verifyPkce } from '../auth/oauth.js';
import {
  AUTHORIZE_URL,
  MCP_USER,
  MCP_PUBLIC_URL,
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_PROVIDER,
  OAUTH_PROVIDER_LABEL,
  OAUTH_SCOPES,
  TOKEN_URL,
  buildPublicUrl
} from '../config.js';
import {
  InvalidGrantError,
  InvalidRequestError,
  MethodNotAllowedError,
  NotFoundError,
  UnauthorizedError,
  UnsupportedGrantTypeError
} from '../errors/AppError.js';
import { respondWithError } from '../errors/respondWithError.js';
import { createServer } from '../mcp/createServer.js';
import { sessionStore } from '../mcp/sessionStoreFactory.js';
import { nowMs, randomToken } from '../utils/crypto.js';
import { collectBody, collectRawBody, sendJson, sendRedirect, sendText } from '../utils/http.js';

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

export async function handleRequest(req, res) {
  authStore.cleanupExpiredAuthArtifacts();

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
    authStore.setPendingClaudeAuth(localState, {
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

    const oauthRedirectUri = buildPublicUrl('/oauth/callback');
    const authUrl = new URL(AUTHORIZE_URL);
    authUrl.searchParams.set('client_id', OAUTH_CLIENT_ID);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', oauthRedirectUri);
    authUrl.searchParams.set('response_mode', 'query');
    authUrl.searchParams.set('scope', OAUTH_SCOPES);
    authUrl.searchParams.set('state', localState);

    if (OAUTH_PROVIDER === 'google') {
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');
    }

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
      sendText(res, 400, `${OAUTH_PROVIDER_LABEL} authorization failed: ${error} ${errorDescription || ''}`.trim());
      return;
    }

    if (!code || !state) {
      logAuthEvent('oauth_callback.missing_code_or_state', { hasCode: !!code, hasState: !!state });
      sendText(res, 400, `Missing code or state from ${OAUTH_PROVIDER_LABEL} callback.`);
      return;
    }

    const pending = authStore.getPendingClaudeAuth(state);
    if (!pending) {
      logAuthEvent('oauth_callback.invalid_state');
      sendText(res, 400, 'Authorization session expired or invalid state.');
      return;
    }

    authStore.deletePendingClaudeAuth(state);

    const oauthRedirectUri = buildPublicUrl('/oauth/callback');
    const tokenBody = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: oauthRedirectUri,
      scope: OAUTH_SCOPES
    });

    if (OAUTH_CLIENT_SECRET) {
      tokenBody.set('client_secret', OAUTH_CLIENT_SECRET);
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
      sendText(res, 400, `${OAUTH_PROVIDER_LABEL} token exchange failed: ${JSON.stringify(tokenJson)}`);
      return;
    }

    const msTokens = {
      ...tokenJson,
      expires_at: nowMs() + Number(tokenJson.expires_in || 3600) * 1000
    };

    authStore.setUserTokens(MCP_USER, msTokens);

    const claudeAuthCode = randomToken(24);
    const mcpAccessToken = randomToken(32);
    const refreshToken = randomToken(32);

    authStore.setAuthCode(claudeAuthCode, {
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

    authStore.setRefreshToken(refreshToken, {
      client_id: pending.client_id,
      scope: pending.scope,
      mcp_access_token: mcpAccessToken,
      expires_at: nowMs() + REFRESH_TOKEN_TTL_MS
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
    try {
      const rawBody = await collectRawBody(req);
      const params = new URLSearchParams(rawBody);
      const grantType = params.get('grant_type');
      const basicClient = parseBasicAuthClient(req);
      const clientId = params.get('client_id') || basicClient?.clientId || null;

      if (!grantType) {
        throw new InvalidRequestError('grant_type is required');
      }

      if (grantType === 'authorization_code') {
        const code = params.get('code');
        const redirectUri = params.get('redirect_uri');
        const codeVerifier = params.get('code_verifier');

        const stored = code ? authStore.getAuthCode(code) : null;
        if (!stored || stored.used || stored.expires_at <= nowMs()) {
          logAuthEvent('token.invalid_or_expired_code', {
            hasCode: !!code,
            found: !!stored,
            used: stored?.used,
            expired: stored ? stored.expires_at <= nowMs() : undefined
          });
          throw new InvalidGrantError('Invalid or expired authorization code');
        }

        if (!verifyPkce(codeVerifier, stored.code_challenge)) {
          logAuthEvent('token.pkce_verification_failed', {
            clientId,
            redirectUri,
            hasCodeVerifier: !!codeVerifier
          });
          throw new InvalidGrantError('PKCE verification failed');
        }

        authStore.markAuthCodeUsed(code);

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
        const stored = refreshToken ? authStore.getRefreshToken(refreshToken) : null;

        if (!stored || stored.expires_at <= nowMs()) {
          logAuthEvent('token.invalid_or_expired_refresh_token', {
            found: !!stored,
            expired: stored ? stored.expires_at <= nowMs() : undefined
          });
          throw new InvalidGrantError('Invalid or expired refresh token');
        }

        const nextAccessToken = randomToken(32);
        authStore.updateRefreshToken(refreshToken, { mcp_access_token: nextAccessToken });

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

      throw new UnsupportedGrantTypeError('unsupported_grant_type');
    } catch (error) {
      respondWithError(res, error, 'oauth');
    }
    return;
  }

  if (!isMcpEndpointPath(pathname)) {
    respondWithError(res, new NotFoundError('Not found'));
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
      respondWithError(
        res,
        new UnauthorizedError('Missing bearer token. Complete OAuth authorization first.', {
          headers: {
            'WWW-Authenticate': `Bearer realm="mcp", authorization_uri="${buildPublicUrl('/authorize')}", token_uri="${buildPublicUrl('/token')}", resource_metadata="${resourceMetadata}", authorization_server="${MCP_PUBLIC_URL}"`
          }
        }),
        'mcp'
      );
      return;
    }
  }

  const sessionId = req.headers['mcp-session-id'];

  try {
    if (req.method === 'POST') {
      const parsedBody = await collectBody(req);

      const entry = sessionStore.getSession(sessionId);

      if (!entry) {
        if (!isInitializeRequest(parsedBody)) {
          throw new InvalidRequestError('No valid session. Initialize first.');
          return;
        }

        const mcpServer = await createServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessionStore.setSession(sid, { transport, mcpServer });
          }
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) sessionStore.deleteSession(sid);
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      await entry.transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const entry = sessionStore.getSession(sessionId);
      if (!entry) {
        if (req.method === 'GET') {
          throw new MethodNotAllowedError('GET stream not supported without active session');
          return;
        }

        throw new InvalidRequestError('Invalid or missing session ID');
        return;
      }

      await entry.transport.handleRequest(req, res);
      return;
    }

    throw new MethodNotAllowedError('Method not allowed');
  } catch (error) {
    respondWithError(res, error, 'mcp');
  }
}