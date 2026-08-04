import prisma from '../db';
import type { Api } from '@jellyfin/sdk/lib/api';
import { getItemsApi } from '@jellyfin/sdk/lib/utils/api/items-api';
import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ItemFields } from '@jellyfin/sdk/lib/generated-client/models/item-fields';
import { jellyfinErrorInfo } from './jellyfinApi';

// ── Films ───────────────────────────────────────────────────────────────────
//
// Deliberately an id INDEX, not a second matchable corpus. Films are only ever
// looked up by TMDB id — every film we resolve has one, from the community map
// or from our own lookup — so titles are never compared and `OriginalTitle` is
// never needed. That also sidesteps the whole class of error this exists to
// stop: a film has no business being fuzzy-matched at all.
//
// Why it exists: `getSeriesLibrary` fetches `IncludeItemTypes=Series`, so a
// film's id could never match anything and the lookup fell through to
// title-matching against TV series. Measured over 8 seasons that produced 26
// category errors — "The Last Blossom" -> *House*, "ChaO" -> *ChäoS;Head*,
// "Demon Slayer: Infinity Castle" -> the television show — against exactly 1
// case where the fall-through found something the air date accepted. It also
// left 7 films we actually own unreachable.

const FILM_INDEX_KEY = 'jellyfinFilmIndex';
const FILM_TTL_MS = 6 * 60 * 60 * 1000; // films are added far less often than episodes

export interface FilmEntry {
  itemId: string;
  title: string;
  /** Display only; absent on rows persisted before it existed. */
  year?: number | null;
}

let _films: { byTmdb: Record<string, FilmEntry>; expires: number } | null = null;
let _filmsInFlight: Promise<Record<string, FilmEntry>> | null = null;
let _restore: Promise<void> | null = null;

async function fetchFilmIndex(api: Api): Promise<Record<string, FilmEntry>> {
  const { data } = await getItemsApi(api).getItems(
    {
      includeItemTypes: [BaseItemKind.Movie],
      recursive: true,
      fields: [ItemFields.ProviderIds],
      enableImages: false,
    },
    { timeout: 120_000 }
  );
  const out: Record<string, FilmEntry> = {};
  for (const it of data.Items ?? []) {
    if (!it.Id || !it.Name) continue;
    const tmdb = it.ProviderIds?.Tmdb ?? it.ProviderIds?.tmdb;
    if (tmdb == null) continue;
    out[String(tmdb)] = {
      itemId: String(it.Id),
      title: String(it.Name),
      year: typeof it.ProductionYear === 'number' ? it.ProductionYear : null,
    };
  }
  return out;
}

async function loadPersisted(): Promise<string | null> {
  const row = await prisma.appConfig.findUnique({ where: { key: FILM_INDEX_KEY } });
  return row?.value ?? null;
}

async function savePersisted(value: string): Promise<void> {
  await prisma.appConfig.upsert({
    where: { key: FILM_INDEX_KEY },
    update: { value },
    create: { key: FILM_INDEX_KEY, value },
  });
}

let _fetch = fetchFilmIndex;
let _load = loadPersisted;
let _save = savePersisted;

/** Read the persisted copy at most once per process, coalesced. */
function restoreOnce(): Promise<void> {
  if (!_restore) {
    _restore = (async () => {
      try {
        const raw = await _load();
        if (raw && !_films) {
          _films = { byTmdb: JSON.parse(raw), expires: 0 };
        }
      } catch {
        /* a missing or malformed row just means a cold fetch */
      }
    })();
  }
  return _restore;
}

/**
 * Check-and-set with NOTHING awaited between — that ordering is the entire
 * guard. The first shape checked `_filmsInFlight`, then awaited the persisted
 * read, then assigned it: two callers racing through the cold path both passed
 * the check and each started its own ~6,600-item fetch. `getSeriesLibraryFresh`
 * only ever avoided this by keeping its check and set adjacent.
 */
function startRefresh(api: Api): Promise<Record<string, FilmEntry>> {
  if (!_filmsInFlight) {
    _filmsInFlight = (async () => {
      try {
        const byTmdb = await _fetch(api);
        _films = { byTmdb, expires: Date.now() + FILM_TTL_MS };
        await _save(JSON.stringify(byTmdb));
        console.log(`[jellyfin] film index: ${Object.keys(byTmdb).length} films with a TMDB id`);
        return byTmdb;
      } catch (err: any) {
        console.warn('[jellyfin] film index refresh failed:', jellyfinErrorInfo(err));
        // Degraded, not broken: an old copy still answers, and no copy at all just
        // means films report as not held — which is what happened before this
        // existed.
        return _films?.byTmdb ?? {};
      } finally {
        _filmsInFlight = null;
      }
    })();
  }
  return _filmsInFlight;
}

/**
 * TMDB film id → the item in the library, cached and persisted.
 *
 * Persisted for the same reason as the series library: the load it avoids is
 * *caused* by restarts, so an in-memory-only copy is empty exactly when it is
 * needed. Serves stale while refreshing behind, like everything else here.
 */
export async function getFilmIndex(api: Api): Promise<Record<string, FilmEntry>> {
  if (_films && _films.expires > Date.now()) return _films.byTmdb;
  if (!_films) await restoreOnce();
  if (_films && _films.expires > Date.now()) return _films.byTmdb;

  const refresh = startRefresh(api);
  // Stale-while-revalidate: an expired copy is served immediately.
  if (_films && Object.keys(_films.byTmdb).length) return _films.byTmdb;
  return refresh;
}

/**
 * Test seam: replace the Jellyfin fetch and the persistence, and reset all
 * module state. The coalescing behaviour is about *when* the in-flight promise
 * is assigned relative to the awaits around it — pure timing logic worth
 * testing without a server or a database.
 */
export function __setFilmIndexForTest(opts: {
  fetch?: typeof fetchFilmIndex;
  load?: typeof loadPersisted;
  save?: typeof savePersisted;
}): void {
  _films = null;
  _filmsInFlight = null;
  _restore = null;
  _fetch = opts.fetch ?? fetchFilmIndex;
  _load = opts.load ?? loadPersisted;
  _save = opts.save ?? savePersisted;
}
