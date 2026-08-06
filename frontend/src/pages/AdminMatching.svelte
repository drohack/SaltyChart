<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { authToken } from '../stores/auth';
  import { isAdmin } from '../stores/jellyfin';
  import { apiJson, QUICK, SEASON, ApiError } from '../lib/remote';
  import AdminTabs from '../components/AdminTabs.svelte';

  /**
   * Review and correct how AniList entries resolve to the library.
   *
   * Exists because identity is a permanent fact that we were re-deriving —
   * and re-breaking — on every cache expiry. A wrong match is now a row you fix
   * once rather than a threshold someone re-tunes.
   *
   * The default queue ("Needs attention") is what a human can settle:
   *
   *  - a **title-only** match, which resolved but has no id to verify it;
   *  - a suggestion from our own remote lookup that no air date could confirm;
   *  - any row where the lookup returned **more than one plausible answer**,
   *    even if the air-date gate accepted one — that is precisely where a
   *    picker earns its keep.
   *
   * Resolver **accepts decided on title text or release year alone** are
   * trusted but unverified — they live behind the "+ resolver accepts" filter,
   * listed after the queue, because the admin treats them as correct and only
   * needs them *reachable* (a wrong exact-title collision used to be permanent
   * and invisible; low-priority-but-visible is the fix, not a demand for
   * review).
   *
   * Everything else is left alone: a community-map id is exact, and an entry
   * whose known id the library lacks is reported missing rather than guessed at.
   * Nothing here is a *gate* — resolver ids are positive-only and already in
   * use, marked unverified. This is a cleanup list, not a queue that blocks.
   *
   * UI contract:
   *
   *  - Three-mode filter: "Needs attention" (the work queue above),
   *    "+ unverified auto-matches" (adds the title-text accepts after the
   *    queue), "Everything". Air-date and premiere-date accepts skip even the
   *    middle view — a date-verified match needs nobody.
   *  - The per-row state column answers "is it matched, how well, is it not,
   *    why not" as a colored verdict over a terse reason DERIVED FROM THE
   *    STORED ACCEPTANCE RUNG, so the column can never contradict what
   *    verified the match — a date-verified auto-match reads green like a map
   *    id; a title-text accept stays blue-unverified. A highlighted
   *    "N possible matches" line appears when the picker has alternatives.
   *  - The user-facing word is auto-match / auto-search, never "resolver".
   *  - The Sonarr-import-style match control: the button shows what the row
   *    currently resolves to; its dropdown searches by name (Jellyfin remote
   *    providers, prefilled and searched immediately) or resolves a pasted
   *    tvdb:/tmdb: id through the library + community-map cross-walk, listing
   *    stored candidates first, each tagged in-library/film/series. Picking
   *    FILLS, NEVER SAVES; a changed selection shows "Confirm saves this as a
   *    manual correction" with a reset, and Confirm is the act of agreement.
   *  - A changed Confirm writes source:'manual'; an untouched one preserves
   *    the resolver's provenance. The discriminator is selection-vs-baseline —
   *    made explicit after a prefill-comparison version relabelled every
   *    id-bearing confirm as manual (the boxes are prefilled with the stored
   *    ids, so "typed" must mean "changed").
   */

  const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'] as const;
  const now = new Date();
  let season: string = SEASONS[Math.floor(now.getMonth() / 3)];
  let year = now.getFullYear();

  type Row = {
    mediaId: number;
    title: string;
    cover?: string;
    format?: string;
    libraryTitle?: string;
    matchedBy?: string;
    titleTier?: number;
    available: boolean;
    tvdbId?: string | null;
    tmdbId?: string | null;
    tmdbKind?: string | null;
    source?: string;
    /** Display year for the row's own identity, from the library when held. */
    year?: number | null;
    confirmed?: boolean;
    rejected?: boolean;
    /** The resolver found something but wasn't confident — ids are a suggestion. */
    pending?: boolean;
    /** What the resolver matched against, so the suggestion can be judged here. */
    matchedTitle?: string | null;
    /** Every option the lookup returned, best-first. */
    candidates?: Choice[] | null;
    /**
     * How this row resolves against the library, from the backend's shared
     * classifier — the season tiles count these, and the sweep tallies the
     * same values across every cached season.
     */
    tier?: 'id' | 'title' | 'notHeld' | 'noMatch' | null;
    /** The entry's own premiere, so an unverified reason can name the gap. */
    startDateMs?: number | null;
    /**
     * Where an unmatched row stands with the auto-search: never searched,
     * cooling down until nextRetryAt, or retired (aired >2 y ago). null on
     * settled rows — there is nothing to retry.
     */
    retry?: {
      state: 'eligible' | 'cooldown' | 'retired';
      lastLookupAt: number | null;
      nextRetryAt: number | null;
    } | null;
    /** How this id was arrived at, verbatim from the resolver. */
    note?: string | null;
  };

  type Choice = {
    tvdbId: string | null;
    tmdbId: string | null;
    tmdbKind: 'tv' | 'movie' | null;
    matchedTitle: string;
    exact: boolean;
    year: number | null;
  };

  let rows: Row[] = [];
  let status: 'idle' | 'loading' | 'ok' | 'failed' = 'idle';
  let error = '';
  let saving = new Set<number>();
  /** What the list shows — the queue/accepts split is in the header's UI contract. */
  let filterMode: 'attention' | 'attention+accepts' | 'all' = 'attention';
  /**
   * The Sonarr-style lookup: one field per row takes a name, `tvdb:12345`, or
   * `tmdb:12345`. Typing a name searches Jellyfin's remote providers; pasting
   * an id resolves it through the library + community-map cross-walk. Picking
   * a result FILLS `chosen` and previews it — nothing is written until
   * Confirm, which stays the act of agreement. This replaced raw id boxes,
   * where the human keyed a number blind into a control that couldn't say
   * what it pointed at.
   */
  type LookupResult = {
    title: string | null;
    year: number | null;
    tvdbId: string | null;
    tmdbId: string | null;
    tmdbKind: 'tv' | 'movie' | null;
    image: string | null;
    library: { title: string } | null;
  };
  let lookupResults: Record<number, LookupResult[]> = {};
  let lookupBusy: Record<number, boolean> = {};
  let lookupError: Record<number, string> = {};
  /**
   * The match control's model, Sonarr-import style: `baseline` is what the row
   * currently resolves to (pre-populated), `selected` is what the control
   * shows. Equal ids => Confirm is a sign-off that preserves the resolver's
   * provenance; different => Confirm writes a manual correction.
   */
  let selected: Record<number, LookupResult | null> = {};
  let baseline: Record<number, LookupResult | null> = {};
  /** Which row's dropdown is open, if any. */
  let openFor: number | null = null;
  let searchText: Record<number, string> = {};
  let lookupTimers: Record<number, ReturnType<typeof setTimeout>> = {};
  let lookupReqIds: Record<number, number> = {};

  function sameIdentity(a: LookupResult | null, b: LookupResult | null): boolean {
    return (a?.tvdbId ?? null) === (b?.tvdbId ?? null) &&
           (a?.tmdbId ?? null) === (b?.tmdbId ?? null) &&
           (a?.tmdbKind ?? null) === (b?.tmdbKind ?? null);
  }

  /** "Ranma ½ (2024)" + 2024 must not render "(2024) (2024)" — TVDB titles
   *  embed the disambiguation year that we'd otherwise append. */
  function withYear(title: string | null | undefined, year: number | null | undefined): string {
    const t = title ?? '';
    if (year == null || t.endsWith(`(${year})`)) return t;
    return `${t} (${year})`;
  }

  function openPicker(r: Row) {
    openFor = r.mediaId;
    // Prefill with the entry's own title and search right away, like Sonarr's
    // import dropdown — the common case should show options without typing.
    // AniList titles sometimes carry a "(2026)" disambiguator, which TMDB's
    // search takes literally and finds nothing for — strip it.
    if (searchText[r.mediaId] == null) {
      const term = r.title.replace(/\s*\(\d{4}\)\s*$/, '');
      searchText[r.mediaId] = term;
      void runLookup(r.mediaId, term);
    }
  }

  function closePicker() {
    openFor = null;
  }

  function resetPick(mediaId: number) {
    selected[mediaId] = baseline[mediaId] ?? null;
  }

  /**
   * What the dropdown offers: the resolver's stored candidates first (they are
   * the suggestions the admin liked having), then live search results, deduped
   * by identity. `results` is a parameter so the template call re-runs when
   * the lookup lands.
   */
  function optionsFor(r: Row, results: LookupResult[]): Array<LookupResult & { suggested?: boolean }> {
    const key = (o: { tvdbId: string | null; tmdbId: string | null; tmdbKind: string | null }) =>
      o.tmdbId ? `${o.tmdbKind}:${o.tmdbId}` : `tvdb:${o.tvdbId}`;
    const byKey = new Map<string, LookupResult & { suggested?: boolean }>();
    const out: Array<LookupResult & { suggested?: boolean }> = [];
    for (const c of r.candidates ?? []) {
      if (!c.tvdbId && !c.tmdbId) continue;
      const o = {
        title: c.matchedTitle || null, year: c.year ?? null,
        tvdbId: c.tvdbId, tmdbId: c.tmdbId, tmdbKind: c.tmdbKind,
        image: (c as any).image ?? null, library: null as { title: string } | null,
        suggested: true,
      };
      if (byKey.has(key(o))) continue;
      byKey.set(key(o), o);
      out.push(o);
    }
    for (const o of results) {
      if (!o.tvdbId && !o.tmdbId) continue;
      const prior = byKey.get(key(o));
      if (prior) {
        // The stored candidate and the live result are the same identity —
        // MERGE, don't drop: candidates stored before the sweep learned to
        // keep years/posters have neither, and the live result has both. The
        // first version kept the poorer of the two.
        prior.year = prior.year ?? o.year;
        prior.image = prior.image ?? o.image;
        prior.library = prior.library ?? o.library;
        prior.title = prior.title ?? o.title;
        continue;
      }
      byKey.set(key(o), o);
      out.push(o);
    }
    return out;
  }

  function queueLookup(mediaId: number) {
    if (lookupTimers[mediaId]) clearTimeout(lookupTimers[mediaId]);
    lookupError[mediaId] = '';
    const term = (searchText[mediaId] ?? '').trim();
    if (!term) {
      lookupResults[mediaId] = [];
      return;
    }
    lookupTimers[mediaId] = setTimeout(() => void runLookup(mediaId, term), 500);
  }

  async function runLookup(mediaId: number, term: string) {
    // Request-id staleness guard, same reason as createRemote's: a slow
    // response for an earlier term must not overwrite a newer one's results.
    const reqId = (lookupReqIds[mediaId] = (lookupReqIds[mediaId] ?? 0) + 1);
    lookupBusy[mediaId] = true;
    try {
      const data = await apiJson<{ results: LookupResult[] }>(
        `/api/jellyfin/identity/lookup?term=${encodeURIComponent(term)}&anilistId=${mediaId}`,
        { headers: auth() },
        // A remote provider search sits behind this — QUICK's 15s is too tight.
        { label: 'admin/identity-lookup', timeoutMs: 30_000 }
      );
      if (reqId !== lookupReqIds[mediaId]) return;
      lookupResults[mediaId] = (data.results ?? []).slice(0, 5);
      // Rows stored before years were kept can learn their date from the live
      // results the moment they arrive. Ids are untouched, so this never
      // flips the changed-detection.
      const sel = selected[mediaId];
      if (sel && (sel.year == null || sel.title == null || sel.image == null)) {
        const m = (data.results ?? []).find((o) => sameIdentity(o, sel));
        if (m) {
          const healed = {
            ...sel,
            year: sel.year ?? m.year,
            title: sel.title ?? m.title,
            image: sel.image ?? m.image,
            library: sel.library ?? m.library,
          };
          selected[mediaId] = healed;
          const base = baseline[mediaId];
          if (base && sameIdentity(base, sel)) baseline[mediaId] = { ...healed };
        }
      }
    } catch {
      if (reqId !== lookupReqIds[mediaId]) return;
      lookupError[mediaId] = 'Lookup failed.';
    } finally {
      if (reqId === lookupReqIds[mediaId]) lookupBusy[mediaId] = false;
    }
  }

  function pick(mediaId: number, r: LookupResult) {
    selected[mediaId] = r;
    openFor = null;
  }

  /** The last resolver sweep's summary, from `/identity/resolve`. */
  let sweep: {
    finishedAt: number; looked: number; accepted: number; queued: number;
    rejected: number; remaining: number; retired?: number;
    tracked?: number; unmatched?: number; cooldown?: number;
    never?: number; ready?: number;
    tiers?: { id: number; title: number; notHeld: number; noMatch: number };
    overrides: number; mapSize: number;
  } | null = null;

  /**
   * The manual sweep trigger. POST starts a drain run on the server and
   * returns immediately (a cold-start drain runs for minutes); completion is
   * detected by polling the sweep summary — via `/identity/resolve` with an
   * empty `mediaIds`, which skips the identity work and returns just the
   * status — until `finishedAt` advances past the run we started from.
   * Completion updates the status line only: reloading the rows out from
   * under an admin mid-review is worse than a stale list, so Reload stays a
   * deliberate click.
   */
  let sweepRun: 'idle' | 'running' = 'idle';
  let sweepPoll: ReturnType<typeof setInterval> | null = null;
  const stopSweepPoll = () => {
    if (sweepPoll) clearInterval(sweepPoll);
    sweepPoll = null;
    sweepRun = 'idle';
  };
  onDestroy(stopSweepPoll);

  async function runSweep() {
    if (sweepRun !== 'idle') return;
    sweepRun = 'running';
    const before = sweep?.finishedAt ?? 0;
    try {
      await apiJson(
        '/api/jellyfin/identity/sweep',
        { method: 'POST', headers: auth() },
        { label: 'admin/sweep', timeoutMs: QUICK }
      );
    } catch {
      // 503 (not configured / identity still loading) or unreachable — either
      // way nothing is running; don't sit polling for a run that never began.
      stopSweepPoll();
      return;
    }
    const startedAt = Date.now();
    sweepPoll = setInterval(async () => {
      // A drain over a big cold start is long, but not an hour long.
      if (Date.now() - startedAt > 60 * 60_000) return stopSweepPoll();
      try {
        const r = await apiJson<{ sweep?: typeof sweep }>(
          '/api/jellyfin/identity/resolve',
          { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth() },
            body: JSON.stringify({ mediaIds: [] }) },
          { label: 'admin/sweep-poll', timeoutMs: QUICK, retries: 0 }
        );
        if (r?.sweep && r.sweep.finishedAt > before) {
          sweep = r.sweep;
          stopSweepPoll();
        }
      } catch {
        /* one missed poll is fine — the next tick asks again */
      }
    }, 10_000);
  }

  function ago(ms: number): string {
    const m = Math.round((Date.now() - ms) / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  }

  /** ago()'s forward twin, for "retries in ~…". */
  function inAbout(ms: number): string {
    const m = Math.round((ms - Date.now()) / 60_000);
    if (m < 60) return `in ~${Math.max(1, m)} min`;
    const h = Math.round(m / 60);
    if (h < 48) return `in ~${h} h`;
    return `in ~${Math.round(h / 24)} d`;
  }

  /** The per-row caption beside an unmatched match control. */
  function retryText(r: NonNullable<Row['retry']>): string {
    if (r.state === 'retired') return 'retired — aired years ago and still unknown upstream; not re-asked';
    if (r.state === 'cooldown') return `auto-searched ${ago(r.lastLookupAt!)} — retries ${inAbout(r.nextRetryAt!)}`;
    return r.lastLookupAt == null
      ? 'never auto-searched — eligible for the next sweep'
      : `auto-searched ${ago(r.lastLookupAt)} — retries on the next sweep`;
  }

  /**
   * The at-a-glance tiles. Two groups on purpose: what the season resolved to
   * (already fine) and where the auto-search queue stands (work remaining) —
   * blended into one line these read as noise, which is what the user said
   * about the first sketch. Title-matched rows appear in BOTH groups when
   * they carry no id: the sweep still owes them a lookup.
   */
  $: stats = (() => {
    const un = rows.filter((r) => r.retry);
    const cooling = un.filter((r) => r.retry!.state === 'cooldown');
    // From the backend's classifier, so these four partition `entries` exactly
    // once. Deriving them from availability's `matchedBy` could not: an unheld
    // film reported 'id' while an unheld series reported nothing, and the
    // fourth bucket was a subtraction that quietly absorbed the difference.
    const tier = (t: string) => rows.filter((r) => r.tier === t).length;
    return {
      total: rows.length,
      byId: tier('id'),
      byTitle: tier('title'),
      notInLib: tier('notHeld'),
      noMatch: tier('noMatch'),
      // The auto-search queue is NOT a subset of the above: an entry with no id
      // can title-match today and still be owed a lookup, so it is counted
      // separately and never presented as a slice of one bucket.
      queued: un.length,
      never: un.filter((r) => r.retry!.state === 'eligible' && r.retry!.lastLookupAt == null).length,
      ready: un.filter((r) => r.retry!.state === 'eligible' && r.retry!.lastLookupAt != null).length,
      cooldown: cooling.length,
      nextRetryAt: cooling.length ? Math.min(...cooling.map((r) => r.retry!.nextRetryAt!)) : null,
      retired: un.filter((r) => r.retry!.state === 'retired').length,
    };
  })();

  const auth = () => ({ Authorization: `Bearer ${$authToken}` });

  async function load() {
    if (!$authToken) return;
    status = 'loading';
    error = '';
    try {
      // The season list is the slow one (a cold fetch has been measured at 186s
      // under AniList rate-limiting), so it gets SEASON rather than QUICK.
      const shows = await apiJson<any[]>(
        `/api/anime?season=${season}&year=${year}`,
        { headers: auth() },
        { label: 'admin/anime', timeoutMs: SEASON }
      );
      const items = shows.map((s) => ({
        mediaId: s.id,
        titles: [s.title?.english, s.title?.romaji, s.title?.native].filter(Boolean),
        startDate: s.startDate,
      }));

      // Two calls, deliberately: availability says whether and how a show
      // resolved, identity says which id produced it and whether a human has
      // signed off. Neither alone tells you what needs review.
      //
      // Chunked at the endpoints' own 100-item limit rather than truncated. A
      // season can exceed it — FALL 2025 has 128 — and slicing silently hid
      // every entry past the first hundred, so a review page could report
      // "nothing needs review" while a third of the season was never looked at.
      const CHUNK = 100;
      const avail: Record<string, any> = {};
      const identities: Record<string, any> = {};
      for (let i = 0; i < items.length; i += CHUNK) {
        const slice = items.slice(i, i + CHUNK);
        const [a, b] = await Promise.all([
          apiJson<{ [k: string]: any }>(
            '/api/jellyfin/availability/batch',
            { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth() },
              body: JSON.stringify({ items: slice }) },
            { label: 'admin/availability', timeoutMs: QUICK }
          ),
          apiJson<{ identities: Record<string, any>; sweep?: typeof sweep }>(
            '/api/jellyfin/identity/resolve',
            { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth() },
              // years feed the per-row retry state — the tier arithmetic
              // lives on the backend, but only this page knows the premiere.
              body: JSON.stringify({
                mediaIds: slice.map((x) => x.mediaId),
                years: Object.fromEntries(
                  slice.filter((x) => x.startDate?.year).map((x) => [x.mediaId, x.startDate.year])
                ),
                // Titles let the backend report each row's match tier with the
                // same classifier the sweep tallies with, so the panel's two
                // scopes can't disagree.
                titles: Object.fromEntries(slice.map((x) => [x.mediaId, x.titles])),
              }) },
            { label: 'admin/identity', timeoutMs: QUICK }
          ),
        ]);
        Object.assign(avail, a ?? {});
        Object.assign(identities, b?.identities ?? {});
        if (b?.sweep) sweep = b.sweep;
      }
      const ident = { identities };

      rows = shows.map((s) => {
        const a = avail?.[s.id] ?? {};
        const i = ident?.identities?.[s.id] ?? {};
        return {
          mediaId: s.id,
          title: s.title?.english || s.title?.romaji || String(s.id),
          cover: s.coverImage?.medium,
          format: s.format,
          libraryTitle: a.libraryTitle,
          matchedBy: a.matchedBy,
          titleTier: a.titleTier,
          available: !!a.available,
          tvdbId: i.tvdbId ?? null,
          tmdbId: i.tmdbId ?? null,
          tmdbKind: i.tmdbKind ?? null,
          source: i.source,
          year: i.year ?? null,
          confirmed: !!i.confirmed,
          rejected: !!i.rejected,
          pending: !!i.pending,
          matchedTitle: i.matchedTitle ?? null,
          candidates: Array.isArray(i.candidates) ? i.candidates : null,
          note: i.note ?? null,
          retry: i.retry ?? null,
          tier: i.tier ?? null,
          startDateMs: s.startDate?.year
            ? Date.UTC(s.startDate.year, (s.startDate.month ?? 1) - 1, s.startDate.day ?? 1)
            : null,
        };
      });
      // By display title — the API returns AniList's default (media id
      // ascending, i.e. entry-creation order), which reads as arbitrary here.
      rows.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
      // Pre-populate every match control with what the row currently
      // resolves to — the admin changes it only when it looks wrong.
      selected = {};
      baseline = {};
      searchText = {};
      lookupResults = {};
      lookupError = {};
      openFor = null;
      for (const r of rows) {
        const def = (r.candidates ?? []).find((c) => c.matchedTitle === r.matchedTitle) ?? null;
        const base: LookupResult | null = (r.tvdbId || r.tmdbId)
          ? {
              // A community-map identity names no title of its own, but the
              // map is a 1:1 assertion — "this entry IS tvdb X" — so the
              // entry's own title is the honest name for it.
              title: r.matchedTitle ?? r.libraryTitle ?? (r.source === 'map' ? r.title : null),
              year: def?.year ?? r.year ?? null,
              tvdbId: r.tvdbId ?? null,
              tmdbId: r.tmdbId ?? null,
              tmdbKind: (r.tmdbKind as 'tv' | 'movie' | null) ?? null,
              image: (def as any)?.image ?? null,
              library: r.libraryTitle ? { title: r.libraryTitle } : null,
            }
          : null;
        baseline[r.mediaId] = base;
        selected[r.mediaId] = base;
      }
      status = 'ok';
    } catch (e) {
      const err = e as ApiError;
      error = err?.unreachable
        ? "Couldn't reach the server."
        : 'Could not load the season.';
      status = 'failed';
    }
  }

  // The "Needs attention" queue — the three row kinds are in the header doc.
  // A pending row with NO ids is a recorded *miss* (the resolver searched and
  // found nothing), so it stays out of the queue.
  /** A viewer corrected this from the Watch pop-up — see `viewerPick`. */
  const isViewerPick = (r: Row) => (r.note ?? '').startsWith('viewer:');
  const needsAttention = (r: Row) =>
    // A viewer contradicted the matcher from the pop-up. That is exactly the
    // signal this queue exists for, and it is unconfirmed by construction.
    (isViewerPick(r) && !r.confirmed && !r.rejected) ||
    (r.pending && !!(r.tvdbId || r.tmdbId)) ||
    (!r.confirmed && (r.candidates?.length ?? 0) > 1) ||
    (!r.pending && r.matchedBy === 'title' && !r.confirmed);

  // Title-text / release-year accepts: reachable but never demanding review —
  // the rationale is the "resolver accepts" bullet in the header doc.
  const dateVerified = (r: Row) => {
    const n = r.note ?? '';
    return n.startsWith('remote: air date') || n.startsWith('remote: premiere date')
      || n.startsWith('remote: tvdb season premiere');
  };
  const resolverAccept = (r: Row) =>
    !r.confirmed && r.source === 'remote' && !r.pending &&
    !!(r.tvdbId || r.tmdbId) && !dateVerified(r) &&
    !needsAttention(r);

  $: visible =
    filterMode === 'all'
      ? rows
      : filterMode === 'attention+accepts'
        ? [...rows.filter(needsAttention), ...rows.filter(resolverAccept)]
        : rows.filter(needsAttention);

  /**
   * Why a suggestion couldn't be verified, in the terms a reviewer judges it
   * on: how far the match's own premiere is from this entry's.
   *
   * Derived from the stored candidate, so it says nothing when the evidence
   * isn't there rather than inventing a reason — which is the bug this
   * replaced.
   */
  function unverifiedBecause(r: Row): string {
    const chosen = (r.candidates ?? []).find((c) => c.matchedTitle === r.matchedTitle);
    const prem = (chosen as { premiereDate?: string | null } | undefined)?.premiereDate;
    if (prem && r.startDateMs != null) {
      const days = Math.round(Math.abs(Date.parse(prem) - r.startDateMs) / 86_400_000);
      if (Number.isFinite(days)) {
        return `nothing could verify it — the match premiered ${prem}, ${days.toLocaleString()} days off`;
      }
    }
    const y = chosen?.year ?? r.year;
    const mine = r.startDateMs != null ? new Date(r.startDateMs).getUTCFullYear() : null;
    if (y && mine && y !== mine) {
      return `nothing could verify it — the match is from ${y}, this premieres ${mine}`;
    }
    return 'nothing could verify it — no date to check against';
  }

  /** The state column: verdict + reason, derived from the stored acceptance
   * rung so it can't contradict it — see the header's UI contract. */
  function statusOf(r: Row): { verdict: string; detail: string; cls: string; options: number | null } {
    const options = (r.candidates?.length ?? 0) > 1 && !r.confirmed ? (r.candidates?.length ?? 0) : null;
    const rung = (r.note ?? '').replace(/^remote:\s*/, '');
    if (r.rejected) {
      return { verdict: 'Rejected', detail: 'marked not-in-library by hand', cls: 'badge-neutral', options: null };
    }
    if (r.confirmed) {
      return r.libraryTitle
        ? { verdict: 'Matched ✓', detail: 'human-confirmed', cls: 'badge-success', options: null }
        : { verdict: 'Confirmed', detail: 'human-confirmed — not in library yet', cls: 'badge-success', options: null };
    }
    if (r.libraryTitle) {
      if (r.matchedBy === 'id') {
        if (r.source === 'remote') {
          if (rung.startsWith('air date')) {
            return { verdict: 'Matched', detail: `auto-match, air date verified (${rung.replace('air date ', '')} off)`, cls: 'badge-success', options };
          }
          if (rung.startsWith('premiere date')) {
            return { verdict: 'Matched', detail: `auto-match, premiere date verified (${rung.replace('premiere date ', '')} off)`, cls: 'badge-success', options };
          }
          if (rung.startsWith('tvdb season premiere')) {
            return { verdict: 'Matched', detail: `auto-match, TVDB season premiere verified (${rung.replace('tvdb season premiere ', '')} off)`, cls: 'badge-success', options };
          }
          if (rung.startsWith('release year')) {
            return { verdict: 'Matched', detail: `auto-match, release year ${rung.replace('release year ', '')}`, cls: 'badge-info', options };
          }
          // `exact title` is a real rung and keeps its name. Everything else
          // reaching here accepted on NO rung at all (`remote: unverified`),
          // and claiming a rung it didn't use broke this page's own contract:
          // measured on the dev deployment, 81 rows read "on exact title"
          // against 13 that genuinely used it — and Bananya's candidate was
          // not even an exact match.
          if (rung.startsWith('exact title')) {
            return { verdict: 'Matched', detail: 'auto-match on exact title — no date could confirm it', cls: 'badge-info', options };
          }
          return { verdict: 'Matched', detail: `auto-match, ${unverifiedBecause(r)}`, cls: 'badge-info', options };
        }
        if (isViewerPick(r)) {
          // The note carries the provenance a bare "manual id" would hide:
          // this row was set by someone watching, not by an admin here.
          return {
            verdict: 'Viewer pick', detail: (r.note ?? '').replace(/^viewer:\s*/, ''),
            cls: 'badge-info', options,
          };
        }
        return {
          verdict: 'Matched',
          detail: r.source === 'manual' ? 'manual id' : 'community-map id',
          cls: 'badge-success', options,
        };
      }
      if (r.matchedBy === 'title') {
        return r.titleTier === 1
          ? { verdict: 'Matched?', detail: 'title prefix only — weakest tier', cls: 'badge-warning', options }
          : { verdict: 'Matched?', detail: 'same title, no id to verify', cls: 'badge-warning', options };
      }
      return { verdict: 'Matched', detail: `→ ${r.libraryTitle}`, cls: 'badge-success', options };
    }
    if (r.pending && (r.tvdbId || r.tmdbId)) {
      return { verdict: 'Needs review', detail: `auto-search found a likely match — ${unverifiedBecause(r)}`, cls: 'badge-warning', options };
    }
    if (r.tvdbId || r.tmdbId) {
      const from = r.source === 'map' ? 'community map' : r.source === 'remote' ? 'auto-search' : 'stored';
      return { verdict: 'Not in library', detail: `id known (${from}), not held`, cls: 'badge-ghost', options };
    }
    if (r.pending) {
      return { verdict: 'Not matched', detail: 'auto-search found nothing at TMDB or TVDB', cls: 'badge-error badge-outline', options: null };
    }
    return { verdict: 'Not matched', detail: 'no id anywhere, no title match', cls: 'badge-error badge-outline', options: null };
  }

  async function save(r: Row, body: Record<string, unknown>) {
    saving = new Set(saving).add(r.mediaId);
    try {
      await apiJson('/api/jellyfin/identity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...auth() },
        body: JSON.stringify({ anilistId: r.mediaId, ...body }),
      }, { label: 'admin/identity-save', timeoutMs: QUICK });
      await load();
    } catch {
      error = `Couldn't save the change for "${r.title}".`;
    } finally {
      const next = new Set(saving);
      next.delete(r.mediaId);
      saving = next;
    }
  }

  async function clearOverride(r: Row) {
    saving = new Set(saving).add(r.mediaId);
    try {
      await apiJson(`/api/jellyfin/identity/${r.mediaId}`, { method: 'DELETE', headers: auth() },
                    { label: 'admin/identity-clear', timeoutMs: QUICK });
      await load();
    } catch {
      error = `Couldn't remove the override for "${r.title}".`;
    } finally {
      const next = new Set(saving);
      next.delete(r.mediaId);
      saving = next;
    }
  }

  onMount(load);
</script>

<main class="max-w-[100rem] mx-auto px-4 flex flex-col gap-4">
  <h1 class="text-2xl font-bold">Admin</h1>
  <AdminTabs current="matching" />

  {#if !$authToken || $isAdmin === false}
    <div class="alert alert-warning"><span>This page is only available to the site admin.</span></div>
  {:else}
    <p class="text-sm opacity-70">
      Review how this season matched the library — Confirm or correct a match to
      record it permanently.
    </p>

    <div class="flex flex-wrap items-end gap-2">
      <select class="select select-bordered select-sm" bind:value={season} on:change={load}>
        {#each SEASONS as s}<option value={s}>{s}</option>{/each}
      </select>
      <input class="input input-bordered input-sm w-24" type="number" bind:value={year} on:change={load} />
      <select class="select select-bordered select-sm" bind:value={filterMode}
        aria-label="Which rows to show" data-filter-mode>
        <option value="attention">Needs attention</option>
        <option value="attention+accepts">+ unverified auto-matches</option>
        <option value="all">Everything</option>
      </select>
      <button class="btn btn-sm btn-outline" on:click={load} disabled={status === 'loading'}>
        {#if status === 'loading'}<span class="loading loading-spinner loading-xs"></span>{/if}
        Reload
      </button>
      <button class="btn btn-sm btn-outline normal-case ml-auto" data-run-sweep on:click={runSweep}
        disabled={status === 'loading' || sweepRun !== 'idle'}
        title="Look up every entry still missing an id right now — including ones on a retry cooldown — instead of waiting for the daily run">
        {#if sweepRun !== 'idle'}<span class="loading loading-spinner loading-xs"></span>{/if}
        Run sweep now
      </button>
    </div>

    {#if error}
      <div class="alert alert-warning text-sm" data-matching-error>
        <span>{error}</span>
        <button class="btn btn-xs btn-outline normal-case" on:click={load}>Retry</button>
      </div>
    {/if}

    {#if status === 'ok' && rows.length}
      <!-- A table, not two tile groups: the same columns for the season on
           screen and for every cached season, so the two scopes are read by
           comparison and the numbers line up BY CONSTRUCTION. Two earlier
           tile layouts drifted out of alignment the moment one group gained
           a line the other lacked, and a prose "of those: …" caption below
           them read as applying to every column instead of one.
           `entries` = by id + by title + not in library + no id yet, and the
           row is ordered that way — unexplained arithmetic reads as a bug
           even when each number is individually right. All-seasons cells the
           sweep can't know are an em-dash, never a zero. -->
      <!-- One panel, two halves: the counts on the left (aligned to the same
           left edge as every other element on this page — a centred table
           would float free of that spine) and, on the right, WHEN they were
           measured. The provenance used to sit in its own paragraph below,
           where it both repeated the queue numbers and left the table alone
           in a 1600px container looking unfinished. -->
      <div class="rounded-lg border border-base-300 bg-base-200/70 px-4 py-3
                  flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        <div class="overflow-x-auto -my-1" data-matching-stats>
          <table class="table table-xs w-auto [&_td]:py-1 [&_th]:py-1">
          <!-- Two header tiers, because the data is two levels deep and a flat
               row of eight numbers hid it: columns 1–4 partition `entries`,
               and the last four partition `no id yet`. Group rules mark both
               boundaries. Flat columns had a reader asking which numbers were
               subsets of which — that is the structure failing to say
               something true about the content. -->
          <thead>
            <tr class="text-[10px] uppercase tracking-wider opacity-40">
              <th class="font-normal"></th>
              <th class="font-normal"></th>
              <th class="font-normal text-center border-l border-base-300" colspan="4">
                how it resolves against your library
              </th>
              <th class="font-normal text-center border-l border-base-300" colspan="5">
                still owed an auto-search
              </th>
            </tr>
            <tr class="text-[11px] opacity-60">
              <th class="font-normal"></th>
              <th class="font-normal text-right">entries</th>
              <th class="font-normal text-right border-l border-base-300">by id</th>
              <th class="font-normal text-right">by title</th>
              <th class="font-normal text-right"
                title="Id known, but it points at nothing the library holds (includes rejections)">not in library</th>
              <th class="font-normal text-right" title="Nothing found by id or by title">no match</th>
              <th class="font-normal text-right border-l border-base-300"
                title="Entries with no known id that the auto-search still owes an answer for — some of these DO match by title today, so this is not a slice of the four columns to the left">queued</th>
              <th class="font-normal text-right border-l border-base-300">never searched</th>
              <th class="font-normal text-right"
                title="Searched before and past its retry window — the next sweep picks these up">ready to retry</th>
              <th class="font-normal text-right">on cooldown</th>
              <th class="font-normal text-right"
                title="Aired more than 2 years ago and still unknown upstream — no longer re-asked automatically">retired</th>
            </tr>
          </thead>
          <tbody class="[&_td]:tabular-nums [&_td]:text-right [&_td]:text-base">
            <tr>
              <th class="text-[11px] font-normal opacity-60 uppercase tracking-wide text-left whitespace-nowrap">
                {season} {year}
              </th>
              <td class="font-semibold">{stats.total}</td>
              <td class="border-l border-base-300">{stats.byId}</td>
              <td>{stats.byTitle}</td>
              <td>{stats.notInLib}</td>
              <td>{stats.noMatch}</td>
              <td class="font-semibold border-l border-base-300">{stats.queued}</td>
              <td class="border-l border-base-300">{stats.never}</td>
              <td>{stats.ready}</td>
              <!-- The next-retry time is a tooltip, never inline: any extra
                   glyph in a right-aligned numeric cell shoves the digit out
                   of its column, which is the whole reason this is a table. -->
              <td title={stats.nextRetryAt ? `next retry ${inAbout(stats.nextRetryAt)}` : undefined}>
                {stats.cooldown}
              </td>
              <td>{stats.retired}</td>
            </tr>
            <tr>
              <th class="text-[11px] font-normal opacity-60 uppercase tracking-wide text-left whitespace-nowrap"
                title="Every season in the cache, all years — from the last auto-search sweep">
                <!-- No timestamp here: the provenance beside the table already
                     dates these numbers, and saying it twice invites the two
                     copies to disagree. -->
                all seasons
              </th>
              {#if sweep?.tracked != null}
                <td class="font-semibold">{sweep.tracked}</td>
                {#if sweep.tiers}
                  <td class="border-l border-base-300">{sweep.tiers.id}</td>
                  <td>{sweep.tiers.title}</td>
                  <td>{sweep.tiers.notHeld}</td>
                  <td>{sweep.tiers.noMatch}</td>
                {:else}
                  <!-- Only rows written before the sweep counted tiers. One run
                       fills them; it needs no provider calls. -->
                  <td class="opacity-25 font-normal border-l border-base-300" colspan="4"
                    title="Counted from the next sweep onwards">after the next sweep</td>
                {/if}
                <td class="font-semibold border-l border-base-300">{sweep.unmatched ?? '—'}</td>
                <td class="border-l border-base-300">{sweep.never ?? '—'}</td>
                <td>{sweep.ready ?? '—'}</td>
                <td>{sweep.cooldown ?? '—'}</td>
                <td>{sweep.retired ?? '—'}</td>
              {:else}
                <td colspan="9" class="text-left text-xs opacity-60 font-normal">
                  Appears after the next sweep — press Run sweep now.
                </td>
              {/if}
            </tr>
            </tbody>
          </table>
          <!-- The arithmetic, stated once for the whole table: a reader asked
               which numbers were subsets of which, and a legend answers that
               far more directly than a tooltip nobody hovers. -->
          <p class="text-[10px] opacity-40 mt-1">
            entries = by id + by title + not in library + no match &nbsp;·&nbsp;
            queued = never searched + ready to retry + on cooldown + retired
            <span class="opacity-70">(queued counts entries with no known id, so it overlaps
            &ldquo;by title&rdquo; &mdash; it is not a slice of the four)</span>
          </p>
        </div>
        <!-- The daily resolver had no admin-visible trace at all — a background
             system that "silently stops improving" is this codebase's
             most-repeated failure class, and its only signal was a backend
             console line. This says what the last run DID; the table beside it
             says what the state IS. -->
        <div class="text-[11px] leading-relaxed opacity-70 sm:text-right" data-sweep-status>
          {#if sweepRun !== 'idle'}
            <span class="loading loading-spinner loading-xs align-middle"></span>
            Sweep running now — these numbers update when it finishes
          {:else if sweep}
            Last sweep {ago(sweep.finishedAt)}: looked up {sweep.looked},
            matched {sweep.accepted}, queued {sweep.queued} for review,
            ruled out {sweep.rejected} on air date
          {:else}
            No sweep has finished yet. One runs 90 s after the server starts and
            daily after that — or press Run sweep now.
          {/if}
          {#if sweep}
            <br />
            <span class="opacity-70">
              {sweep.overrides.toLocaleString()} saved match{sweep.overrides === 1 ? '' : 'es'}
              · community map {sweep.mapSize.toLocaleString()} pairs
            </span>
          {/if}
        </div>
      </div>
    {/if}

    {#if status === 'loading'}
      <p class="opacity-70 text-sm">Loading {season} {year}…</p>
    {:else if status === 'ok' && !visible.length}
      <p class="opacity-70 text-sm" data-matching-empty>
        Nothing needs review in {season} {year} — every resolved entry was matched by id
        or already confirmed.
      </p>
    {/if}

    <ul class="flex flex-col gap-2" data-matching-list>
      {#each visible as r (r.mediaId)}
        <li class="card bg-base-100 shadow-sm">
          <div class="card-body p-3 flex-row items-center gap-3 flex-wrap">
            {#if r.cover}
              <img src={r.cover} alt="" class="w-10 h-14 object-cover rounded" loading="lazy" />
            {/if}
            <div class="flex-1 min-w-[12rem]">
              <p class="font-semibold leading-tight">{r.title}</p>
              <p class="text-xs opacity-70">
                {r.format ?? ''}
                {#if r.libraryTitle}
                  → <span class="italic">{r.libraryTitle}</span>
                {:else}
                  → <span class="opacity-60">not in library</span>
                {/if}

              </p>

            </div>
            <div class="w-52 shrink-0 flex flex-col gap-0.5" data-status-cell>
              <span class="badge badge-sm whitespace-nowrap {statusOf(r).cls}" data-status>
                {statusOf(r).verdict}
              </span>
              <span class="text-xs opacity-70 leading-tight">{statusOf(r).detail}</span>
              {#if statusOf(r).options}
                <span class="text-xs text-warning leading-tight">
                  {statusOf(r).options} possible matches
                </span>
              {/if}
            </div>
            <div class="relative flex-1 min-w-[24rem] max-w-2xl flex flex-col gap-0.5" data-match-cell>
              <!-- Sonarr-import-style match control — behaviour (picking FILLS,
                   never saves; Confirm agrees) is in the header's UI contract. -->
              <button type="button"
                class="btn btn-sm btn-outline w-full justify-start normal-case font-normal overflow-hidden flex-nowrap gap-2"
                data-match-control
                aria-label={`Change the match for ${r.title}`}
                on:click={() => (openFor === r.mediaId ? closePicker() : openPicker(r))}
              >
                {#if selected[r.mediaId]}
                  <span class="truncate">
                    {selected[r.mediaId]?.title ? withYear(selected[r.mediaId]?.title, selected[r.mediaId]?.year) : 'Id known — open to name it'}
                  </span>
                  <!-- Sonarr/Radarr convention: a series shows its TVDB id, a
                       film its TMDB id. The other appears only when the
                       canonical one is unknown — which on this deployment
                       means a gap entry no free source can cross-walk. The
                       full pair is on the hover title. -->
                  <span class="opacity-60 text-xs truncate"
                    title={`TVDB ${selected[r.mediaId]?.tvdbId ?? '—'} · TMDB ${selected[r.mediaId]?.tmdbId ?? '—'}`}
                  >
                    {#if selected[r.mediaId]?.tmdbKind === 'movie'}
                      {#if selected[r.mediaId]?.tmdbId}TMDB {selected[r.mediaId]?.tmdbId}
                      {:else if selected[r.mediaId]?.tvdbId}TVDB {selected[r.mediaId]?.tvdbId}{/if}
                    {:else if selected[r.mediaId]?.tvdbId}TVDB {selected[r.mediaId]?.tvdbId}
                    {:else if selected[r.mediaId]?.tmdbId}TMDB {selected[r.mediaId]?.tmdbId}{/if}
                  </span>
                {:else}
                  <span class="opacity-60">No match — search…</span>
                {/if}
              </button>
              {#if r.retry}
                <span class="text-[11px] opacity-60" data-retry-state>{retryText(r.retry)}</span>
              {/if}
              {#if !sameIdentity(selected[r.mediaId] ?? null, baseline[r.mediaId] ?? null)}
                <p class="text-xs text-info" data-match-changed>
                  changed — Confirm saves this as a manual correction
                  <button type="button" class="btn btn-ghost btn-xs"
                    aria-label={`Reset the match for ${r.title}`}
                    on:click={() => resetPick(r.mediaId)}
                  >↺</button>
                </p>
              {:else if selected[r.mediaId] && !selected[r.mediaId]?.library && !r.libraryTitle}
                <p class="text-xs opacity-60">
                  not in your library — positive-only until the library gains it
                </p>
              {/if}
              {#if openFor === r.mediaId}
                <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
                <div class="fixed inset-0 z-10 cursor-default" on:click={closePicker}></div>
                <div class="absolute top-full left-0 z-20 mt-1 w-full min-w-[24rem] max-w-[85vw] bg-base-100 border border-base-300 rounded shadow-lg p-2 flex flex-col gap-1"
                  data-match-dropdown>
                  <input
                    class="input input-bordered input-sm w-full"
                    placeholder="name, tvdb:12345, or tmdb:12345"
                    bind:value={searchText[r.mediaId]}
                    on:input={() => queueLookup(r.mediaId)}
                    data-lookup-input
                  />
                  {#if lookupBusy[r.mediaId]}
                    <span class="loading loading-spinner loading-xs"></span>
                  {/if}
                  {#if lookupError[r.mediaId]}
                    <p class="text-xs text-warning">
                      {lookupError[r.mediaId]}
                      <button type="button" class="btn btn-xs btn-ghost normal-case"
                        on:click={() => void runLookup(r.mediaId, (searchText[r.mediaId] ?? '').trim())}
                      >Retry</button>
                    </p>
                  {/if}
                  <ul class="max-h-72 overflow-auto flex flex-col text-xs" data-lookup-results>
                    {#each optionsFor(r, lookupResults[r.mediaId] ?? []) as opt}
                      <li>
                        <button type="button"
                          class="w-full text-left flex gap-2 items-start p-1 rounded hover:bg-base-200"
                          on:click={() => pick(r.mediaId, opt)}
                        >
                          {#if opt.image}
                            <img src={opt.image} alt="" class="w-6 h-9 object-cover rounded" loading="lazy" />
                          {/if}
                          <span class="min-w-0 flex-1 whitespace-normal break-words">
                            {opt.title ? withYear(opt.title, opt.year) : 'Unnamed'}
                          </span>
                          <span class="opacity-60 shrink-0">{opt.tmdbKind === 'movie' ? 'film' : 'series'}</span>
                          {#if opt.suggested}
                            <span class="badge badge-xs badge-info shrink-0">suggested</span>
                          {/if}
                          {#if opt.library}
                            <span class="badge badge-xs badge-success shrink-0">in library</span>
                          {:else if !opt.suggested}
                            <span class="badge badge-xs shrink-0">not in library</span>
                          {/if}
                          {#if sameIdentity(opt, selected[r.mediaId] ?? null)}
                            <span class="shrink-0">✓</span>
                          {/if}
                        </button>
                      </li>
                    {:else}
                      <li class="opacity-60 p-1">No results yet — type a name or paste an id.</li>
                    {/each}
                  </ul>
                </div>
              {/if}
            </div>
            <div class="flex gap-1">
              <button
                class="btn btn-xs btn-success"
                disabled={saving.has(r.mediaId)}
                title="Record this match as correct"
                on:click={() => {
                  // Selection-vs-baseline decides manual correction vs sign-off
                  // — the provenance rules are in the header's UI contract.
                  const sel = selected[r.mediaId] ?? null;
                  const changed = !sameIdentity(sel, baseline[r.mediaId] ?? null);
                  save(r, changed && sel
                    ? {
                        // A human picked this: the control is the whole truth,
                        // and it must not wear the resolver's badge.
                        tvdbId: sel.tvdbId,
                        tmdbId: sel.tmdbId,
                        tmdbKind: sel.tmdbId ? (sel.tmdbKind ?? 'tv') : null,
                        confirmed: true, rejected: false, pending: false,
                        matchedTitle: sel.title ?? null, source: 'manual', note: null,
                        year: sel.year ?? null,
                      }
                    : {
                        // Fields left out keep their stored values, so source,
                        // note and candidates survive — Confirm means "yes,
                        // this", never "clear".
                        tvdbId: r.tvdbId ?? null,
                        tmdbId: r.tmdbId ?? null,
                        tmdbKind: r.tmdbKind ?? null,
                        confirmed: true, rejected: false, pending: false,
                        matchedTitle: r.matchedTitle ?? null,
                      });
                }}
              >Confirm</button>
              <button
                class="btn btn-xs btn-error btn-outline"
                disabled={saving.has(r.mediaId)}
                title="Record that this is NOT in the library — stops the title match"
                on:click={() => save(r, { tvdbId: null, tmdbId: null, confirmed: true, rejected: true })}
              >Reject</button>
              {#if r.source === 'manual'}
                <button
                  class="btn btn-xs btn-ghost"
                  disabled={saving.has(r.mediaId)}
                  on:click={() => clearOverride(r)}
                >Clear</button>
              {/if}
            </div>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</main>
