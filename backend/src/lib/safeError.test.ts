import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeErrorText } from './safeError';

test('safeErrorText never prints an axios config or its headers', () => {
  const err: any = new Error('timeout of 8000ms exceeded');
  err.code = 'ECONNABORTED';
  err.config = { headers: { Authorization: 'MediaBrowser Token="s3cret"' } };
  err.response = { status: 504, config: err.config };
  const text = safeErrorText(err);
  assert.ok(!text.includes('s3cret'), 'the API key must never reach a log line');
  assert.ok(text.includes('ECONNABORTED') && text.includes('HTTP 504'), 'code and status survive');
  assert.ok(text.includes('timeout of 8000ms exceeded'), 'the message survives');
  assert.ok(/safeError\.test/.test(text), 'the stack frames survive, so a crash is still debuggable');
});

test('safeErrorText handles non-Error throws', () => {
  assert.equal(safeErrorText('boom'), 'boom');
  assert.equal(safeErrorText(undefined), 'undefined');
  assert.ok(!safeErrorText({ config: { headers: { 'X-Api-Key': 'k3y' } } }).includes('k3y'));
});
