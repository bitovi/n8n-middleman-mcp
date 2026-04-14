import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWorkflowInputsWithAccessToken,
  normalizeWorkflowInputType,
  parseWorkflowDescription,
  slugifyName
} from '../src/n8n/workflows.js';

test('slugifyName normalizes and trims values', () => {
  assert.equal(slugifyName('Hello World!'), 'hello_world');
  assert.equal(slugifyName('___Already__Slug__'), 'already_slug');
});

test('parseWorkflowDescription parses summary, vars, and return_immediately', () => {
  const parsed = parseWorkflowDescription(`My summary\n{"vars":{"startDate":"ISO start"},"return_immediately":true}`);

  assert.equal(parsed.summary, 'My summary');
  assert.deepEqual(parsed.inputHints, { startDate: 'ISO start' });
  assert.equal(parsed.returnImmediately, true);
});

test('parseWorkflowDescription tolerates invalid metadata JSON', () => {
  const parsed = parseWorkflowDescription('Summary\n{not-json');
  assert.equal(parsed.summary, 'Summary');
  assert.deepEqual(parsed.inputHints, {});
  assert.equal(parsed.returnImmediately, false);
});

test('normalizeWorkflowInputType falls back when invalid', () => {
  assert.equal(normalizeWorkflowInputType('Webhook', 'chat'), 'webhook');
  assert.equal(normalizeWorkflowInputType('weird', 'form'), 'form');
});

test('buildWorkflowInputsWithAccessToken builds hinted webhook payload with token injection', () => {
  const result = buildWorkflowInputsWithAccessToken(
    { projectId: 123 },
    'access-token',
    'google',
    'Webhook trigger',
    true
  );

  assert.deepEqual(result, {
    type: 'webhook',
    webhookData: {
      method: 'POST',
      body: {
        projectId: 123,
        access_token: 'access-token',
        provider: 'google'
      }
    }
  });
});

test('buildWorkflowInputsWithAccessToken handles explicit form inputs without hints', () => {
  const result = buildWorkflowInputsWithAccessToken(
    { type: 'form', formData: { a: 1 } },
    'token-2',
    'microsoft',
    'Form trigger',
    false
  );

  assert.deepEqual(result, {
    type: 'form',
    formData: {
      a: 1,
      access_token: 'token-2',
      provider: 'microsoft'
    }
  });
});
