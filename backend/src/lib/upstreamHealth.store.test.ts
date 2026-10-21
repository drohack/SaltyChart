/**
 * The health record against a REAL SQLite file, because the bug these pin lived
 * in the storage round trip, where the pure transition tests cannot see it.
 *
 * On 2026-10-21 AniList switched its API off and the owner got "AniList is not
 * responding" twice in the same minute, worded differently. One probe had
 * recorded its failure twice (once in `fetchAniListPage`, once in the probe
 * runner), and both read-modify-writes of the one `upstreamHealth` row read
 * the record before either saved - so both saw "not mailed yet" and both
 * mailed. The same race silently dropped a count each time, and lets the
 * three concurrent pages of a season load mail three times.
 *
 * Each test file runs in its own process under `node --test`, so pointing
 * DATABASE_URL at a throwaway file here cannot reach the real database. It is
 * set before `../db` is required, because Prisma reads it once at load.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UpstreamRecord } from './upstreamHealth';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saltychart-health-'));
process.env.DATABASE_URL = 'file:' + path.join(dir, 'health.db').replace(/\\/g, '/');

/* eslint-disable @typescript-eslint/no-var-requires */
const prisma = require('../db').default;
let health: typeof import('./upstreamHealth');
let probes: typeof import('./upstreamProbes');
let axios: typeof import('axios').default;
/* eslint-enable @typescript-eslint/no-var-requires */

before(async () => {
  // The same DDL `ensureDatabaseSchema()` runs in production.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AppConfig" (
      "key"   TEXT NOT NULL PRIMARY KEY,
      "value" TEXT NOT NULL
    );
  `);
  // Alerts off, so a crossing stops at the settings check instead of looking
  // up an owner in a User table this file never creates. The crossing is
  // still decided, and still logged - which is what the tests count.
  await prisma.appConfig.create({
    data: { key: 'alertSettings', value: JSON.stringify({ masterEnabled: false }) },
  });
  health = require('./upstreamHealth');
  probes = require('./upstreamProbes');
  axios = require('axios').default;
});

after(async () => {
  // `announce` runs unawaited; let it finish reading the settings before the
  // file goes away.
  await new Promise((r) => setTimeout(r, 200));
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function seed(map: Record<string, Partial<UpstreamRecord>>): Promise<void> {
  const full = Object.fromEntries(
    Object.entries(map).map(([k, v]) => [k, { ...health.EMPTY_RECORD, ...v }]),
  );
  const value = JSON.stringify(full);
  await prisma.appConfig.upsert({
    where: { key: health.UPSTREAM_HEALTH_KEY },
    update: { value },
    create: { key: health.UPSTREAM_HEALTH_KEY, value },
  });
}

/** Run `fn` and return every `console.error` line it produced. */
async function errorLines(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

const HOURS_AGO = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

test('two failures recorded at the same moment mail once, and both are counted', async () => {
  const spec = health.upstreamById('anilist')!;
  // One failure short of the threshold, and failing long past the window, so
  // the next failure is the crossing - and so is the one beside it, if each
  // reads the record before the other has saved.
  await seed({
    anilist: {
      consecutiveFailures: spec.brokenAfter - 1,
      failCount: spec.brokenAfter - 1,
      failingSince: HOURS_AGO,
      lastFailAt: HOURS_AGO,
    },
  });
  const lines = await errorLines(() => Promise.all([
    health.recordUpstream('anilist', false, { reason: 'AniList answered 403', status: 403 }),
    health.recordUpstream('anilist', false, { reason: 'AniList answered 403', status: 403 }),
  ]));
  assert.equal(lines.filter((l) => l.includes('LOOKS DOWN')).length, 1,
    'two failures arriving together must announce the outage once, not once each');
  const rec = (await health.readAll()).anilist;
  assert.equal(rec.failCount, spec.brokenAfter + 1,
    'a concurrent failure was lost - the health writes overlapped');
});

test("a write for one service never erases another's", async () => {
  // Every service lives in ONE AppConfig row, so an overlap between two
  // different services is the same lost update in a quieter form.
  await seed({});
  await Promise.all([
    health.recordUpstream('skyhook', false, { reason: 'x', status: 500 }),
    health.recordUpstream('tmdb', false, { reason: 'y', status: 500 }),
  ]);
  const map = await health.readAll();
  assert.ok(map.skyhook && map.tmdb,
    "concurrent writes for two services kept only one - the other's record was overwritten");
});

test('the AniList probe leaves the recording to the probe runner', async () => {
  // The runner records every probe's result once (`runDueProbes`). The AniList
  // probe goes through `fetchAniListPage`, which records viewer traffic - so
  // unless the probe tells it not to, every probe counts twice. The 403 body is
  // the one AniList actually sent on 2026-10-21.
  await seed({});
  const saved = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => ({
    data: {
      errors: [{
        message: 'The AniList API has been temporarily disabled due to severe stability issues.',
        status: 403,
        locations: [{ line: 1, column: 1 }],
      }],
      data: null,
    },
    status: 403,
    statusText: 'Forbidden',
    headers: {},
    config,
  });
  let res;
  try {
    res = await probes.PROBES.anilist();
  } finally {
    axios.defaults.adapter = saved;
  }
  assert.equal(res.ok, false);
  assert.equal(res.status, 403, 'the probe result must carry the status, so the mail can name it');
  await new Promise((r) => setTimeout(r, 100)); // an unawaited record, if one was made
  assert.equal((await health.readAll()).anilist, undefined,
    "the probe's own fetch recorded the failure - the runner records it again, so each probe counts twice");
});
