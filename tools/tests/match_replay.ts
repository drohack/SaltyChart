// ---------------------------------------------------------------------------
// Offline replay of the matcher over a frozen corpus.
//
// Runs the SHIPPING `matchSeries` — not a reimplementation — over eight seasons
// of real AniList entries against a snapshot of the real library, and compares
// every verdict to a committed baseline. Seconds, no network, deterministic, so
// it can gate every push where the live corpus check (7 minutes, ~440 Jellyfin
// lookups) cannot.
//
// It measures **matcher logic**, not current holdings. When the library changes
// the fixture ages; that is expected and does not make the test wrong. Rebuild
// deliberately with build_match_fixtures.py + `--write`, and read the diff.
//
//   npx ts-node --transpile-only tools/tests/match_replay.ts          # check
//   npx ts-node --transpile-only tools/tests/match_replay.ts --write  # re-baseline
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { matchSeries, MatchableSeries } from '../../backend/src/lib/animeMatch';

const DIR = join(__dirname, 'fixtures', 'match_corpus');
const read = (f: string) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));

/**
 * Pairs the matcher must never produce.
 *
 * Every one was produced against the live library before the negative-evidence
 * rule, and every one is a *different work* matched onto its franchise parent.
 * They are listed by name so a regression says which invariant broke rather than
 * just moving a count — a diff of "234 → 236 matched" tells you nothing about
 * whether the two extras are the Pokémon bug coming back.
 *
 * Note these are NOT distinguishable by shape: "BLEACH: Thousand-Year Blood War"
 * is a correct match of exactly the same form. Only the id separates them.
 */
const KNOWN_BAD: { entry: string; mustNotMatch: string }[] = [
  { entry: 'Pokémon Concierge', mustNotMatch: 'Pokémon' },
  { entry: 'Gun Gale Online', mustNotMatch: 'Sword Art Online' },
  { entry: 'Four Knights of the Apocalypse', mustNotMatch: 'The Seven Deadly Sins' },
  { entry: 'Nanoha EXCEEDS', mustNotMatch: 'Magical Girl Lyrical Nanoha' },
  { entry: 'Requiem for Vengeance', mustNotMatch: 'Mobile Suit Gundam' },
  { entry: 'TRIGUN STARGAZE', mustNotMatch: 'Trigun' },
  { entry: 'DARK MOON', mustNotMatch: 'Dark' },
  { entry: 'Ginpachi', mustNotMatch: 'Gintama' },
  { entry: 'AQUARION: Myth of Emotions', mustNotMatch: 'Aquarion' },
  { entry: 'Kyoto Disturbance', mustNotMatch: 'Rurouni Kenshin' },
  { entry: 'The Villager of Level 999', mustNotMatch: 'The Village' },
  { entry: 'My Gift Lvl 9999', mustNotMatch: 'My 600-lb Life' },
];

interface Entry {
  id: number;
  season: string;
  format: string | null;
  titles: string[];
}
type Verdict = { lib: string | null; c: 'id' | 'title' | null; tier?: number };

const library: MatchableSeries[] = read('library.json');
const entries: Entry[] = read('entries.json');
const ids: Record<string, { tvdb?: string | null; tmdb?: string | null }> = read('ids.json');

const results: Record<string, Verdict> = {};
for (const e of entries) {
  const id = ids[String(e.id)] ?? {};
  // The TMDB value carries its namespace (`tv:123` / `movie:456`) because TMDB
  // numbers films and shows independently. Only a `tv` id can mean anything
  // against a list of series.
  const tmdbRaw = id.tmdb ?? null;
  const tmdbId = tmdbRaw && tmdbRaw.startsWith('tv:') ? tmdbRaw.slice(3) : null;
  const hit = matchSeries({ tvdbId: id.tvdb ?? null, tmdbId, titles: e.titles }, library);
  results[String(e.id)] = hit
    ? { lib: hit.series.title, c: hit.confidence, ...(hit.tier != null ? { tier: hit.tier } : {}) }
    : { lib: null, c: null };
}

const summary = {
  entries: entries.length,
  id: Object.values(results).filter((r) => r.c === 'id').length,
  title: Object.values(results).filter((r) => r.c === 'title').length,
  none: Object.values(results).filter((r) => r.c === null).length,
};

// ── the named invariants ────────────────────────────────────────────────────
const violations: string[] = [];
const inert: string[] = [];
for (const bad of KNOWN_BAD) {
  const subjects = entries.filter((e) => e.titles.some((t) => t.includes(bad.entry)));
  // An assertion whose subject isn't in the corpus asserts nothing, and reads as
  // a pass forever. That is the same failure mode as a mutation row whose anchor
  // has moved: green, and guarding nothing. Fail loudly instead — either the
  // fixture no longer contains the case or the entry string has drifted.
  if (!subjects.length) {
    inert.push(`"${bad.entry}" matches no corpus entry — this assertion is inert`);
    continue;
  }
  for (const e of subjects) {
    if (results[String(e.id)]?.lib === bad.mustNotMatch) {
      violations.push(
        `"${e.titles[0]}" matched "${bad.mustNotMatch}" — the franchise-sibling ` +
          `false positive is back (${e.season})`
      );
    }
  }
}
if (inert.length) {
  for (const i of inert) console.log(`[replay] FAIL — ${i}`);
}

if (process.argv.includes('--write')) {
  writeFileSync(join(DIR, 'baseline.json'), JSON.stringify({ summary, results }, null, 0) + '\n');
  console.log(`[replay] baseline written: ${JSON.stringify(summary)}`);
  if (violations.length) {
    // Refuse to bake a known-bad pair into the baseline — that is exactly how a
    // regression becomes "expected".
    for (const v of violations) console.log(`[replay] REFUSING: ${v}`);
    process.exit(1);
  }
  process.exit(0);
}

let baseline: { summary: any; results: Record<string, Verdict> };
try {
  baseline = read('baseline.json');
} catch {
  console.log('[replay] FAIL — no baseline.json; run with --write after reviewing the fixtures');
  process.exit(1);
}

const changed: string[] = [];
for (const e of entries) {
  const a = baseline.results[String(e.id)];
  const b = results[String(e.id)];
  if (!a) {
    changed.push(`+ ${e.titles[0]} (${e.season}) is not in the baseline`);
    continue;
  }
  if (a.lib !== b.lib || a.c !== b.c || (a.tier ?? null) !== (b.tier ?? null)) {
    changed.push(
      `~ ${e.titles[0]} (${e.season}): ${a.c ?? 'none'}/${a.lib ?? '-'} → ${b.c ?? 'none'}/${b.lib ?? '-'}`
    );
  }
}

console.log(
  `[replay] ${summary.entries} entries | id ${summary.id} | title ${summary.title} | none ${summary.none}`
);
if (violations.length) {
  for (const v of violations) console.log(`[replay] FAIL — ${v}`);
}
if (changed.length) {
  console.log(`[replay] ${changed.length} verdict(s) differ from the baseline:`);
  for (const c of changed.slice(0, 30)) console.log(`   ${c}`);
  if (changed.length > 30) console.log(`   … and ${changed.length - 30} more`);
}
if (violations.length || changed.length || inert.length) {
  console.log('[replay] FAIL — matcher behaviour changed. If intended, re-baseline with --write.');
  process.exit(1);
}
console.log('[replay] PASS — every verdict matches the baseline');
