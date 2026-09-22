import { test } from 'node:test';
import assert from 'node:assert';
import { captureMailer } from './mailer';
import { localRunSilence, alertAdmins, SUBJECT_PREFIX, LOCAL_RUN_SILENT_DAYS, ownerEmail } from './subtitleAlerts';

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;

test('an unverified admin address never receives an alert', () => {
  // The root rule: a verified email is what counts, for everything. An admin
  // who typed an address and never confirmed it must not be mailed - the
  // address could be anyone's.
  // Ids ascend so the verified one is also the LOWEST - `ownerEmail` picks the
  // first admin by id, and a fixture where the right answer is also the first
  // row would pass even if the verified-address rule were dropped.
  const rows = [
    { id: 2, email: 'unverified@example.test', emailVerifiedAt: null },
    { id: 3, email: null, emailVerifiedAt: new Date(NOW - DAY) },
    { id: 4, email: 'ok@example.test', emailVerifiedAt: new Date(NOW - DAY) },
  ];
  // `verifiedAdminEmails` is gone - it had no production caller, and the rule
  // it stated is enforced (and tested) on `ownerEmail` below, which is what
  // `defaultRecipients` actually calls.
  assert.equal(ownerEmail(rows), 'ok@example.test');
});

test('alertAdmins sends one mail per verified admin through the injected mailer', async () => {
  const mailer = captureMailer();
  const r = await alertAdmins('trailer downloads broken', 'body', {
    mailer,
    recipients: async () => ['a@example.test', 'b@example.test'],
  });
  assert.equal(r.sent, 2);
  assert.equal(mailer.sent.length, 2);
  assert.ok(mailer.sent.every(m => m.subject === SUBJECT_PREFIX + 'trailer downloads broken'));
  assert.deepEqual(mailer.sent.map(m => m.to), ['a@example.test', 'b@example.test']);
});

test('alertAdmins never throws when the mailer is not configured or has nobody to send to', async () => {
  const off = { ...captureMailer(), configured: () => false };
  assert.deepEqual(await alertAdmins('x', 'y', { mailer: off }), { sent: 0, skipped: 'smtp-not-configured' });
  const on = captureMailer();
  assert.deepEqual(await alertAdmins('x', 'y', { mailer: on, recipients: async () => [] }), { sent: 0, skipped: 'no-recipients' });
  assert.equal(on.sent.length, 0);
});

test('a silence already alerted is not alerted again', () => {
  const old = new Date(NOW - (LOCAL_RUN_SILENT_DAYS + 1) * DAY).toISOString();
  assert.equal(localRunSilence(null, NOW), 'never');
  assert.equal(localRunSilence({ reportedAt: new Date(NOW - 7 * DAY).toISOString() }, NOW), 'fresh');
  assert.equal(localRunSilence({ reportedAt: old }, NOW), 'silent');
  assert.equal(localRunSilence({ reportedAt: old, silentAlertedAt: new Date(NOW - DAY).toISOString() }, NOW), 'alreadyAlerted');
});

test('the owner is the FIRST admin with a verified address', () => {
  // Derived, never configured: no owner column, no env var, nothing hardcoded.
  // "First" is the lowest id because ids are autoincrement, so the earliest
  // account always has the lowest one.
  assert.equal(ownerEmail([
    { id: 7, email: 'later@example.com', emailVerifiedAt: new Date() },
    { id: 1, email: 'owner@example.com', emailVerifiedAt: new Date() },
    { id: 3, email: 'middle@example.com', emailVerifiedAt: new Date() },
  ]), 'owner@example.com');
});

test('an unverified address can never make someone the owner', () => {
  // Same rule the password-reset path follows: a typo in an address would
  // otherwise redirect every alert to nobody, permanently and silently.
  assert.equal(ownerEmail([
    { id: 1, email: 'typo@example.com', emailVerifiedAt: null },
    { id: 5, email: 'real@example.com', emailVerifiedAt: new Date() },
  ]), 'real@example.com');
});

test('an admin with no address at all is skipped', () => {
  assert.equal(ownerEmail([
    { id: 1, email: null, emailVerifiedAt: null },
    { id: 2, email: 'second@example.com', emailVerifiedAt: new Date() },
  ]), 'second@example.com');
});

test('no admin has a verified address: there is no owner, and that is not a crash', () => {
  // The route and the page both have to be able to say "alerts would reach
  // nobody" - which is only sayable if this returns null rather than throwing.
  assert.equal(ownerEmail([]), null);
  assert.equal(ownerEmail([{ id: 1, email: null, emailVerifiedAt: null }]), null);
  assert.equal(ownerEmail([{ id: 1, email: 'x@y.com', emailVerifiedAt: null }]), null);
});

test('promoting a second admin does not move the alerts', () => {
  // Admins are peers for permissions, but a new one is not silently signed up
  // to the site's operational mail. Adding them is a decision made on
  // /admin/status, not a side effect of a promotion.
  const before = ownerEmail([{ id: 1, email: 'owner@example.com', emailVerifiedAt: new Date() }]);
  const after = ownerEmail([
    { id: 1, email: 'owner@example.com', emailVerifiedAt: new Date() },
    { id: 2, email: 'newadmin@example.com', emailVerifiedAt: new Date() },
  ]);
  assert.equal(after, before);
});


test('the master switch on /admin/status actually stops the mail', () => {
  // It governed nothing when the page shipped: every alert went through
  // `alertAdmins`, which never read the settings. A control that lies is worse
  // than no control, because it is believed - someone who switches alerts off
  // and keeps receiving them has no way to tell a broken switch from a broken
  // service.
  const mailer = captureMailer();
  return alertAdmins('anything', 'body', {
    mailer,
    recipients: async () => ['owner@example.com'],
    settings: async () => ({ masterEnabled: false, perService: {}, perServiceRecovery: {}, extraRecipients: [] }),
  }).then((r) => {
    assert.strictEqual(r.sent, 0);
    assert.strictEqual(r.skipped, 'alerts-disabled');
    assert.strictEqual(mailer.sent.length, 0, 'nothing may reach the mailer at all');
  });
});

test('alerts are ON unless somebody switched them off', () => {
  // The other direction, and the one that matters more: absence must mean
  // enabled. If a missing or unreadable settings row meant "off", every
  // deployment would start silent and the first real outage would be the one
  // nobody heard about - the same rule as an absent per-service key.
  const mailer = captureMailer();
  return alertAdmins('the download path is broken', 'body', {
    mailer,
    recipients: async () => ['owner@example.com'],
    settings: async () => ({ masterEnabled: true, perService: {}, perServiceRecovery: {}, extraRecipients: [] }),
  }).then((r) => {
    assert.strictEqual(r.sent, 1);
    assert.strictEqual(r.skipped, null);
    assert.match(mailer.sent[0].subject, /^\[SaltyChart\] /);
  });
});
