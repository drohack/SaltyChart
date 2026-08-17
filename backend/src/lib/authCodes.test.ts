import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetPathFor,
  mayResetOpenly,
  generateCode,
  hashCode,
  verifyCodeHash,
  expiryFrom,
  codeState,
  mayIssueCode,
  maskEmail,
  looksLikeEmail,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  MAX_CODES_PER_HOUR,
  type StoredCode,
} from './authCodes';

// The assertion messages here are written as stories on purpose: they become
// the `expect` substrings mutation_audit.py matches on, so a vague one makes
// the audit row grade the wrong failure.

const NOW = new Date('2026-08-16T12:00:00Z');

function stored(over: Partial<StoredCode> = {}): StoredCode {
  return {
    expiresAt: new Date(NOW.getTime() + CODE_TTL_MS),
    attempts: 0,
    consumedAt: null,
    createdAt: NOW,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Which reset path an account gets
// ---------------------------------------------------------------------------

test('an ordinary account with no email keeps the open reset', () => {
  assert.equal(
    resetPathFor({ isAdmin: false, emailVerifiedAt: null }),
    'open',
    'a plain account with no email lost the open reset - normal accounts are ' +
      'meant to stay frictionless and this is the whole non-admin experience'
  );
});

test('a verified email switches any account to the coded path', () => {
  assert.equal(
    resetPathFor({ isAdmin: false, emailVerifiedAt: NOW }),
    'code',
    'a non-admin with a verified email was still offered the open reset - ' +
      'opting in by adding an address is what protects a normal account'
  );
});

test('an admin with no address is a dead end, not an open reset', () => {
  assert.equal(
    resetPathFor({ isAdmin: true, emailVerifiedAt: null }),
    'adminNoAddress',
    'an admin with no verified email fell back to the OPEN reset - that is ' +
      'the takeover hole this feature exists to close, and it would stay open ' +
      'until someone remembered to configure an address'
  );
});

test('a verified address outranks the admin flag', () => {
  assert.equal(
    resetPathFor({ isAdmin: true, emailVerifiedAt: NOW }),
    'code',
    'an admin with a verified email got a special path instead of the ordinary ' +
      'coded one - the branch must key on the address, not the role, or the ' +
      'reset page becomes a directory of who the admins are'
  );
});

test('only the open path may use the unauthenticated reset endpoint', () => {
  assert.equal(
    mayResetOpenly({ isAdmin: false, emailVerifiedAt: null }),
    true,
    'mayResetOpenly refused a plain account, which breaks normal password resets'
  );
  assert.equal(
    mayResetOpenly({ isAdmin: true, emailVerifiedAt: null }),
    false,
    'mayResetOpenly allowed an ADMIN through the unauthenticated reset - anyone ' +
      'on the internet could take the admin account and exfiltrate the Jellyfin key'
  );
  assert.equal(
    mayResetOpenly({ isAdmin: false, emailVerifiedAt: NOW }),
    false,
    'mayResetOpenly allowed a protected account through the open reset, so ' +
      'adding an email bought no protection at all'
  );
});

// ---------------------------------------------------------------------------
// Code generation and hashing
// ---------------------------------------------------------------------------

test('a generated code is always exactly six digits', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateCode();
    assert.match(
      code,
      /^\d{6}$/,
      `generateCode produced ${code!}, which is not six digits - a variable-length ` +
        'code breaks the input field and hints at the value'
    );
  }
});

test('the code space includes values below 100000', () => {
  // 1000 draws: if the range were shifted to 100000..999999 to avoid leading
  // zeros, this would fail every time rather than flakily. Losing that tenth of
  // the space weakens the code for no gain, since padStart keeps the length.
  const draws = Array.from({ length: 1000 }, () => Number(generateCode()));
  assert.ok(
    draws.some((n) => n < 100_000),
    'no generated code fell below 100000 across 1000 draws - the range has been ' +
      'shifted and a tenth of the keyspace silently thrown away'
  );
});

test('codes differ from one another', () => {
  const seen = new Set(Array.from({ length: 100 }, generateCode));
  assert.ok(
    seen.size > 90,
    `only ${seen.size} distinct codes in 100 draws - generation is not random ` +
      'enough to be unguessable from a previous code'
  );
});

test('a code verifies against its own hash and nothing else', async () => {
  const code = generateCode();
  const hash = await hashCode(code);
  assert.notEqual(
    hash,
    code,
    'hashCode returned the code itself - a leaked database would hand over live codes'
  );
  assert.equal(
    await verifyCodeHash(code, hash),
    true,
    'a freshly hashed code failed to verify against its own hash, so no reset could complete'
  );
  assert.equal(
    await verifyCodeHash('000000', await hashCode('999999')),
    false,
    'verifyCodeHash accepted the wrong code, which makes the code check decorative'
  );
});

test('the stored hash is bcrypt, not a fast digest', async () => {
  const hash = await hashCode('123456');
  assert.match(
    hash,
    /^\$2[aby]\$\d{2}\$/,
    `stored hash ${hash} is not a bcrypt hash - a six-digit code behind a fast ` +
      'digest is brute-forced through its whole keyspace in about a second'
  );
});

// ---------------------------------------------------------------------------
// Expiry, attempts, and issue rate
// ---------------------------------------------------------------------------

test('expiry is ten minutes from issue', () => {
  assert.equal(
    expiryFrom(NOW).getTime() - NOW.getTime(),
    10 * 60 * 1000,
    'the code lifetime is no longer ten minutes'
  );
});

test('a fresh unused code is live', () => {
  assert.equal(codeState(stored(), NOW), 'live', 'a brand new code was not usable');
});

test('a code is dead the instant it expires, not a moment later', () => {
  const expiresAt = new Date(NOW.getTime() + CODE_TTL_MS);
  assert.equal(
    codeState(stored({ expiresAt }), new Date(expiresAt.getTime() - 1)),
    'live',
    'a code expired one millisecond early'
  );
  assert.equal(
    codeState(stored({ expiresAt }), expiresAt),
    'expired',
    'an expired code was still accepted - the expiry check is off by one at the ' +
      'boundary, or is not being applied at all'
  );
  assert.equal(
    codeState(stored({ expiresAt }), new Date(expiresAt.getTime() + 60_000)),
    'expired',
    'a code a minute past its expiry was still accepted, so codes never expire'
  );
});

test('a consumed code cannot be reused', () => {
  assert.equal(
    codeState(stored({ consumedAt: NOW }), NOW),
    'consumed',
    'an already-used code was accepted a second time, so a code seen once works forever'
  );
});

test('the attempt cap kills the code', () => {
  assert.equal(
    codeState(stored({ attempts: MAX_ATTEMPTS - 1 }), NOW),
    'live',
    'the code died one guess early, locking people out before the cap'
  );
  assert.equal(
    codeState(stored({ attempts: MAX_ATTEMPTS }), NOW),
    'exhausted',
    'a code past the wrong-guess cap was still accepted - without this cap a ' +
      'six-digit code is brute-forced against a single issued code'
  );
});

test('consumed outranks expired, so the reason given is the true one', () => {
  const long_gone = new Date(NOW.getTime() - CODE_TTL_MS);
  assert.equal(
    codeState(stored({ expiresAt: long_gone, consumedAt: long_gone }), NOW),
    'consumed',
    'a used-and-expired code reported as merely expired, which sends someone ' +
      'round the loop for a fresh code when reuse was the real problem'
  );
});

test('three codes an hour, and consuming one buys no allowance', () => {
  const recent = (n: number, over: Partial<StoredCode> = {}) =>
    Array.from({ length: n }, () => stored({ createdAt: NOW, ...over }));

  assert.equal(
    mayIssueCode(recent(MAX_CODES_PER_HOUR - 1), NOW),
    true,
    'a code was refused while still under the hourly cap'
  );
  assert.equal(
    mayIssueCode(recent(MAX_CODES_PER_HOUR), NOW),
    false,
    'codes were issued past the hourly cap, so the attempt budget above it is ' +
      'unbounded and the six-digit space becomes reachable'
  );
  assert.equal(
    mayIssueCode(recent(MAX_CODES_PER_HOUR, { consumedAt: NOW }), NOW),
    false,
    'consuming codes reset the hourly allowance - using each code once then ' +
      'asking for another bypasses the cap entirely'
  );
});

test('codes older than an hour stop counting', () => {
  const old = stored({ createdAt: new Date(NOW.getTime() - 60 * 60 * 1000 - 1) });
  assert.equal(
    mayIssueCode(Array.from({ length: 10 }, () => old), NOW),
    true,
    'codes from over an hour ago still counted against the cap, so one bad ' +
      'afternoon locks the account out of resets for good'
  );
});

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

test('a masked address identifies the inbox without giving it away', () => {
  assert.equal(maskEmail('grayson@example.com'), 'g*****n@example.com');
  assert.equal(
    maskEmail('ab@example.com'),
    '**@example.com',
    'a two-letter local part was shown in full, which is the whole address'
  );
  assert.equal(maskEmail('nonsense'), '***', 'a malformed address leaked through the mask');
});

test('obvious non-addresses are rejected before a code is sent', () => {
  for (const good of ['a@b.co', 'grayson.malinowski@waterfield.com']) {
    assert.ok(looksLikeEmail(good), `${good} was rejected but is a usable address`);
  }
  for (const bad of ['', 'nonsense', 'a@b', 'a b@c.com', 'two@at@signs.com']) {
    assert.equal(
      looksLikeEmail(bad),
      false,
      `${bad!} was accepted as an address - a code sent nowhere locks the ` +
        'account into a protected path with no way to complete it'
    );
  }
});
