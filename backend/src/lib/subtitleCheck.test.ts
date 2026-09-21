import { test } from 'node:test';
import assert from 'node:assert';
import { checkVerdict } from './subtitleCheck';

test('a null verdict from a failed check is not written as no-CC', () => {
  // The bug this guards: `null !== undefined` is true, so the old gate wrote a
  // failed check as 0 with a fresh lastEnCheckAt - a week-long false negative
  // that sent a video WITH English captions down the download path.
  assert.equal(checkVerdict({ hasEnglish: null, checkError: 'IpBlocked' }), null);
});

test('a daemon error shape writes nothing', () => {
  assert.equal(checkVerdict({ error: 'timeout' }), null);
  assert.equal(checkVerdict(undefined), null);
  assert.equal(checkVerdict(null), null);
  assert.equal(checkVerdict({}), null);
});

test('a definitive no writes 0', () => {
  assert.equal(checkVerdict({ hasEnglish: false }), 0);
});

test('a definitive yes writes 1', () => {
  assert.equal(checkVerdict({ hasEnglish: true }), 1);
});
