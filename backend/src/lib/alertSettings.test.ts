import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ALERT_SETTINGS,
  alertsEnabledFor,
  looksLikeEmail,
  resolveRecipients,
  sanitizeSettings,
  type AlertSettings,
} from './alertSettings';

const base = (over: Partial<AlertSettings> = {}): AlertSettings => ({
  ...DEFAULT_ALERT_SETTINGS,
  perService: {},
  extraRecipients: [],
  ...over,
});

test('a service nobody has configured still alerts', () => {
  // The load-bearing default. If absence meant "off", every service added to
  // the registry later would arrive silent - which is the failure this whole
  // feature exists to end, reintroduced through the settings file.
  assert.equal(alertsEnabledFor(base(), 'brand-new-service', 'down'), true);
});

test('turning a service off silences only that service', () => {
  const s = base({ perService: { skyhook: false } });
  assert.equal(alertsEnabledFor(s, 'skyhook', 'down'), false);
  assert.equal(alertsEnabledFor(s, 'jellyfin', 'down'), true);
});

test('the master switch silences everything', () => {
  const s = base({ masterEnabled: false, perService: { skyhook: true } });
  assert.equal(alertsEnabledFor(s, 'skyhook', 'down'), false);
  assert.equal(alertsEnabledFor(s, 'jellyfin', 'down'), false);
});

test('an admin who is also an extra recipient gets one copy, not two', () => {
  const to = resolveRecipients(
    base({ extraRecipients: ['Owner@Example.com', 'ops@example.com'] }),
    ['owner@example.com'],
  );
  assert.deepEqual(to, ['owner@example.com', 'ops@example.com']);
});

test('recipients keep the admins even with no extras', () => {
  assert.deepEqual(resolveRecipients(base(), ['a@b.com']), ['a@b.com']);
  assert.deepEqual(resolveRecipients(base(), []), [], 'no admins and no extras is nobody, not a crash');
});

test('sanitize drops junk rather than storing it', () => {
  // This is written from a browser and read on a timer, so the reader must
  // never meet a shape it did not expect.
  const s = sanitizeSettings({
    masterEnabled: 'yes',
    perService: { a: false, b: true, c: 'nonsense' },
    extraRecipients: ['good@example.com', 'not-an-email', 42, 'good@example.com', ' spaced@example.com '],
  });
  assert.equal(s.masterEnabled, true, 'anything but an explicit false stays on');
  assert.deepEqual(s.perService, { a: false }, 'only explicit off is stored');
  assert.deepEqual(s.extraRecipients, ['good@example.com', 'spaced@example.com']);
});

test('sanitize survives rubbish input entirely', () => {
  for (const junk of [null, undefined, 42, 'string', [], { perService: 7, extraRecipients: 'no' }]) {
    const s = sanitizeSettings(junk);
    assert.equal(s.masterEnabled, true);
    assert.deepEqual(s.perService, {});
    assert.deepEqual(s.extraRecipients, []);
  }
});

test('storing "true" is deliberately not persisted', () => {
  // Writing today's default into the row would pin it: if the default ever
  // changes, every previously-saved row would silently keep the old answer.
  const s = sanitizeSettings({ perService: { skyhook: true } });
  assert.deepEqual(s.perService, {});
  assert.equal(alertsEnabledFor(s, 'skyhook', 'down'), true);
});

test('the extra-recipient list is bounded', () => {
  const many = Array.from({ length: 50 }, (_, i) => `user${i}@example.com`);
  assert.ok(sanitizeSettings({ extraRecipients: many }).extraRecipients.length <= 20);
});

test('looksLikeEmail is loose but not useless', () => {
  assert.equal(looksLikeEmail('a@b.co'), true);
  assert.equal(looksLikeEmail('no-at-sign'), false);
  assert.equal(looksLikeEmail('two@at@signs.com'), false);
  assert.equal(looksLikeEmail('trailing@'), false);
  assert.equal(looksLikeEmail('spaces in@example.com'), false);
  assert.equal(looksLikeEmail('nodot@example'), false);
  assert.equal(looksLikeEmail(''), false);
});

// ---------------------------------------------------------------------------
// Recovery alerts are their own switch, and default OFF.
//
// The opposite default to `perService`, deliberately. That rule exists so a
// dependency added next year cannot break silently - a real cost. Missing a
// recovery notice has no such cost: you find out it is fine the next time you
// look. Eight of the nine registered services describe their own outage as
// some version of "the cache keeps serving", so nothing is waiting on the news,
// and mail that tells the reader what they already know is exactly what trains
// them to ignore the sender - the failure this feature exists to avoid, one
// step round.
// ---------------------------------------------------------------------------

test('recovery alerts are off until someone asks for them', () => {
  assert.equal(alertsEnabledFor(base(), 'animeIdMap', 'recovered'), false,
    'an unconfigured service must not announce that it recovered');
  assert.equal(alertsEnabledFor(base(), 'animeIdMap', 'down'), true,
    'the outage default is untouched - absence still means it can tell you it broke');
});

test('recovery can be switched on per service', () => {
  const s = base({ perServiceRecovery: { jellyfin: true } });
  assert.equal(alertsEnabledFor(s, 'jellyfin', 'recovered'), true);
  assert.equal(alertsEnabledFor(s, 'animeIdMap', 'recovered'), false,
    'turning one service on must not turn the rest on');
});

test('a service whose outage alerts are off never announces a recovery either', () => {
  // `downAlertedAt` is stamped when the streak crosses, whether or not the mail
  // actually went out - so without this the two switches combine into "working
  // again" for an outage nobody was ever told about, which is worse than both.
  const s = base({ perService: { skyhook: false }, perServiceRecovery: { skyhook: true } });
  assert.equal(alertsEnabledFor(s, 'skyhook', 'recovered'), false,
    'you cannot be told it is fixed when you were never told it broke');
});

test('the master switch silences recovery too', () => {
  const s = base({ masterEnabled: false, perServiceRecovery: { jellyfin: true } });
  assert.equal(alertsEnabledFor(s, 'jellyfin', 'recovered'), false);
});

test('only an explicit recovery opt-in is stored', () => {
  // Mirror of the `perService` rule and for the same reason: persisting the
  // default pins today's answer over tomorrow's.
  const s = sanitizeSettings({ perServiceRecovery: { a: true, b: false, c: 'yes', d: 1 } });
  assert.deepEqual(s.perServiceRecovery, { a: true },
    'only a literal true is an opt-in; everything else is the default');
});

test('recovery settings survive rubbish input', () => {
  assert.deepEqual(sanitizeSettings({ perServiceRecovery: 7 }).perServiceRecovery, {});
  assert.deepEqual(sanitizeSettings({}).perServiceRecovery, {});
  assert.deepEqual(sanitizeSettings(null).perServiceRecovery, {});
});
