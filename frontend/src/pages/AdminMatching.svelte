<script lang="ts">
  import { onMount } from 'svelte';
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
  /**
   * What the list shows. "Needs attention" is the work queue; resolver
   * accepts are trusted-but-unverified, so they are reachable (second option,
   * listed last) rather than mixed into the queue — the admin asked for them
   * to be low-priority, and the invariant that matters is that they can be
   * reviewed at all, not that they demand it.
   */
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
    rejected: number; remaining: number; overrides: number; mapSize: number;
  } | null = null;

  function ago(ms: number): string {
    const m = Math.round((Date.now() - ms) / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  }

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
              body: JSON.stringify({ mediaIds: slice.map((x) => x.mediaId) }) },
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
        };
      });
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

  // What needs a human, and each looks different:
  //  - a title-only match, which resolved but can't be verified from an id
  //  - a *pending* suggestion from the remote resolver — its ids are already
  //    in use (positive-only), pending marks that nothing could verify them
  //  - more than one plausible candidate, even when the air-date gate accepted
  //    one — that is exactly where a picker earns its keep
  // A pending row with no ids is a recorded *miss* — the resolver searched and
  // found nothing. It exists so the next sweep doesn't ask again, not because
  // anyone should look at it, so it stays out of the queue.
  const needsAttention = (r: Row) =>
    (r.pending && !!(r.tvdbId || r.tmdbId)) ||
    (!r.confirmed && (r.candidates?.length ?? 0) > 1) ||
    (!r.pending && r.matchedBy === 'title' && !r.confirmed);

  // Accepted by our own lookup on title text or release year alone — never
  // air-date-verified, never seen by a human. The admin trusts these, so they
  // are NOT in the default queue; what matters is that they stay *reachable*
  // (second filter option, listed after the queue), because before that a
  // wrong exact-title collision (two works genuinely sharing a name) was
  // permanent and invisible. Air-date and premiere-date accepts stay out of
  // even that view: date evidence separates right from wrong by three orders
  // of magnitude.
  const dateVerified = (r: Row) => {
    const n = r.note ?? '';
    return n.startsWith('remote: air date') || n.startsWith('remote: premiere date');
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
   * The state column: a verdict to scan down the page, and the how/why under
   * it — in plain words, no jargon. For auto-matched rows the reason comes
   * from the stored acceptance rung (the note), so the column never
   * contradicts what actually verified the match: an air-date-verified
   * auto-match is as trustworthy as a map id and reads green, while a
   * title-text accept stays blue-unverified.
   */
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
          if (rung.startsWith('release year')) {
            return { verdict: 'Matched', detail: `auto-match, release year ${rung.replace('release year ', '')}`, cls: 'badge-info', options };
          }
          return { verdict: 'Matched', detail: 'auto-match on exact title — unverified', cls: 'badge-info', options };
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
      return { verdict: 'Needs review', detail: 'auto-search found a likely match — unverified', cls: 'badge-warning', options };
    }
    if (r.tvdbId || r.tmdbId) {
      const from = r.source === 'map' ? 'community map' : r.source === 'remote' ? 'auto-search' : 'stored';
      return { verdict: 'Not in library', detail: `id known (${from}), not held`, cls: 'badge-ghost', options };
    }
    if (r.pending) {
      return { verdict: 'Not matched', detail: 'auto-search found nothing (TMDB only — no TVDB plugin)', cls: 'badge-error badge-outline', options: null };
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
      Entries matched to the library <em>by title</em>, which is the only case a
      human can settle: an id match is exact, and an entry whose id the library
      doesn't have is now reported as missing rather than guessed at. Confirming
      one records it permanently, so the answer survives every future cache
      expiry and matcher change.
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
    </div>

    {#if error}
      <div class="alert alert-warning text-sm" data-matching-error>
        <span>{error}</span>
        <button class="btn btn-xs btn-outline normal-case" on:click={load}>Retry</button>
      </div>
    {/if}

    <!-- The daily resolver had no admin-visible trace at all — a background
         system that "silently stops improving" is this codebase's most-repeated
         failure class, and its only signal was a backend console line. -->
    {#if sweep}
      <p class="text-xs opacity-70" data-sweep-status>
        Last auto-match sweep {ago(sweep.finishedAt)} — {sweep.looked} looked up,
        {sweep.accepted} accepted, {sweep.queued} queued for review,
        {sweep.rejected} rejected on air date, {sweep.remaining} still waiting
        · {sweep.overrides} override row{sweep.overrides === 1 ? '' : 's'}
        · map {sweep.mapSize.toLocaleString()} pairs
      </p>
    {:else if status === 'ok'}
      <p class="text-xs opacity-70" data-sweep-status>
        The auto-match sweep hasn't completed a run yet — it runs 90 s after boot
        and daily after that.
      </p>
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
              <!-- Sonarr-import-style match control: the button shows what the
                   row currently resolves to (pre-populated), the dropdown has
                   its own search box (name / tvdb: / tmdb:) listing the
                   resolver's stored suggestions first, then live results.
                   Picking FILLS, never saves — Confirm is the agreement. -->
              <button type="button"
                class="btn btn-sm btn-outline w-full justify-start normal-case font-normal overflow-hidden flex-nowrap gap-2"
                data-match-control
                aria-label={`Change the match for ${r.title}`}
                on:click={() => (openFor === r.mediaId ? closePicker() : openPicker(r))}
              >
                {#if selected[r.mediaId]}
                  <span class="truncate">
                    {selected[r.mediaId]?.title ?? 'Id known — open to name it'}{selected[r.mediaId]?.year ? ` (${selected[r.mediaId]?.year})` : ''}
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
                            {opt.title ?? 'Unnamed'}{opt.year ? ` (${opt.year})` : ''}
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
                  // The discriminator is the match control: a selection that
                  // differs from the baseline is a manual correction; an
                  // untouched Confirm is a sign-off that preserves the
                  // resolver's provenance. (A prefill-comparison predecessor
                  // read every id-bearing confirm as hand-typed and wiped
                  // exactly the provenance the server merge preserves.)
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
