import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { InvalidGrantError, MethodNotAllowedError } from '../src/errors/AppError.js';
import { respondWithError } from '../src/errors/respondWithError.js';
import { collectBody, collectRawBody, sendJson } from '../src/utils/http.js';

function createMockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(value) {
      this.body = value;
    }
  };
}

test('collectBody parses JSON body', async () => {
  const req = Readable.from(['{"hello":"world"}']);
  req.setEncoding('utf8');
  const parsed = await collectBody(req);
  assert.deepEqual(parsed, { hello: 'world' });
});

test('collectRawBody returns raw text', async () => {
  const req = Readable.from(['grant_type=refresh_token']);
  req.setEncoding('utf8');
  const raw = await collectRawBody(req);
  assert.equal(raw, 'grant_type=refresh_token');
});

test('sendJson sets headers and serialized response', () => {
  const res = createMockRes();
  sendJson(res, 201, { ok: true });

  assert.equal(res.statusCode, 201);
  assert.equal(res.headers['Content-Type'], 'application/json');
  assert.equal(res.body, JSON.stringify({ ok: true }));
});

test('respondWithError maps oauth error format', () => {
  const res = createMockRes();
  respondWithError(res, new InvalidGrantError('Bad token'), 'oauth');

  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'invalid_grant',
    error_description: 'Bad token'
  });
});

test('respondWithError maps mcp error format', () => {
  const res = createMockRes();
  respondWithError(res, new MethodNotAllowedError('No GET'), 'mcp');

  assert.equal(res.statusCode, 405);
  assert.deepEqual(JSON.parse(res.body), {
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: 'No GET'
    },
    id: null
  });
});
