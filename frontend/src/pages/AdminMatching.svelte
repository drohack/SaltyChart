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
   * Three things land here, and only these three:
   *
   *  - a **title-only** match, which resolved but has no id to verify it;
   *  - a suggestion from our own remote lookup that no air date could confirm;
   *  - any row where the lookup returned **more than one plausible answer**,
   *    even if the air-date gate accepted one — that is precisely where a
   *    picker earns its keep.
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
    confirmed?: boolean;
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

  /** Which candidate is selected per row. Defaults to the resolver's pick. */
  let choice: Record<number, number> = {};

  let rows: Row[] = [];
  let status: 'idle' | 'loading' | 'ok' | 'failed' = 'idle';
  let error = '';
  let saving = new Set<number>();
  let onlyUnconfirmed = true;
  /** Per-row draft of the TVDB id box, so typing doesn't fight a reload. */
  let draft: Record<number, string> = {};

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
          apiJson<{ identities: Record<string, any> }>(
            '/api/jellyfin/identity/resolve',
            { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth() },
              body: JSON.stringify({ mediaIds: slice.map((x) => x.mediaId) }) },
            { label: 'admin/identity', timeoutMs: QUICK }
          ),
        ]);
        Object.assign(avail, a ?? {});
        Object.assign(identities, b?.identities ?? {});
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
          confirmed: !!i.confirmed,
          pending: !!i.pending,
          matchedTitle: i.matchedTitle ?? null,
          candidates: Array.isArray(i.candidates) ? i.candidates : null,
          note: i.note ?? null,
        };
      });
      // Default the picker to whichever candidate the resolver acted on — the
      // closest match it found — so the common case is one click and the
      // alternatives are there only when the default looks wrong.
      for (const r of rows) {
        const idx = (r.candidates ?? []).findIndex((c) => c.matchedTitle === r.matchedTitle);
        choice[r.mediaId] = idx >= 0 ? idx : 0;
      }
      for (const r of rows) draft[r.mediaId] = r.tvdbId ?? '';
      status = 'ok';
    } catch (e) {
      const err = e as ApiError;
      error = err?.unreachable
        ? "Couldn't reach the server."
        : 'Could not load the season.';
      status = 'failed';
    }
  }

  // Two things need a human, and they look different:
  //  - a title-only match, which resolved but can't be verified from an id
  //  - a *pending* suggestion from the remote resolver, which deliberately
  //    isn't being used until approved (so it shows as "not in library")
  // A pending row with no ids is a recorded *miss* — the resolver searched and
  // found nothing. It exists so the next sweep doesn't ask again, not because
  // anyone should look at it, so it stays out of the queue.
  $: visible = onlyUnconfirmed
    ? rows.filter(
        (r) =>
          (r.pending && (r.tvdbId || r.tmdbId)) ||
          // More than one plausible answer came back. Even when the air-date
          // gate accepted one, a human should get the chance to say it picked
          // wrong — that is exactly the case where a picker earns its keep.
          (!r.confirmed && (r.candidates?.length ?? 0) > 1) ||
          (!r.pending && r.matchedBy === 'title' && !r.confirmed)
      )
    : rows;

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

<main class="max-w-4xl mx-auto px-4 flex flex-col gap-4">
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
      <label class="label cursor-pointer gap-2">
        <input type="checkbox" class="checkbox checkbox-sm" bind:checked={onlyUnconfirmed} />
        <span class="label-text">Only unconfirmed title matches</span>
      </label>
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
                {#if r.matchedBy}
                  <span class="badge badge-xs ml-1" class:badge-warning={r.matchedBy === 'title'}>
                    {r.matchedBy}{r.titleTier === 1 ? ' (prefix)' : ''}
                  </span>
                {/if}
                {#if r.confirmed}<span class="badge badge-xs badge-success ml-1">confirmed</span>{/if}
                {#if r.source === 'manual'}<span class="badge badge-xs ml-1">override</span>{/if}
              </p>
              {#if r.source === 'remote' && r.note}
                <!-- Say HOW this was arrived at. These ids are ones we looked up
                     ourselves rather than took from the community map, so
                     presenting them without provenance would dress a search
                     result up as fact. -->
                <p class="text-xs mt-1 opacity-70">
                  <span class="badge badge-xs badge-warning">our lookup</span>
                  {r.note.replace(/^remote:\s*/, '')}
                  {#if (r.candidates?.length ?? 0) > 1}
                    · <span class="text-warning">{r.candidates?.length} possible matches</span>
                  {/if}
                </p>
              {/if}
              {#if (r.candidates?.length ?? 0) > 1}
                <!-- More than one plausible answer came back, so let a human pick
                     instead of silently keeping the first. -->
                <select
                  class="select select-bordered select-xs w-full max-w-md mt-1"
                  bind:value={choice[r.mediaId]}
                  aria-label={`Which match for ${r.title}`}
                >
                  {#each r.candidates ?? [] as c, i}
                    <option value={i}>
                      {c.matchedTitle}{c.year ? ` (${c.year})` : ''}
                      {c.tmdbKind === 'movie' ? ' — film' : ''}{c.exact ? ' — exact title' : ''}
                    </option>
                  {/each}
                </select>
              {/if}
              {#if r.pending && r.matchedTitle}
                <!-- The resolver's suggestion, shown so it can be judged here
                     rather than by searching again elsewhere. Not in use until
                     Confirm is pressed. -->
                <p class="text-xs mt-1">
                  <span class="badge badge-xs badge-info">suggested</span>
                  <span class="italic">{r.matchedTitle}</span>
                  <span class="opacity-60">
                    ({r.tmdbKind === 'movie' ? 'TMDB film' : r.tvdbId ? 'TVDB' : 'TMDB'}
                    {r.tvdbId ?? r.tmdbId})
                  </span>
                </p>
              {:else if r.pending}
                <p class="text-xs mt-1 opacity-60">searched, nothing found</p>
              {/if}
            </div>
            <input
              class="input input-bordered input-xs w-28"
              placeholder="TVDB id"
              bind:value={draft[r.mediaId]}
              aria-label={`TVDB id for ${r.title}`}
            />
            <div class="flex gap-1">
              <button
                class="btn btn-xs btn-success"
                disabled={saving.has(r.mediaId)}
                title="Record this match as correct"
                on:click={() => {
                  // Order matters: a typed TVDB id wins, then whichever
                  // candidate is selected, then whatever the row already had.
                  // A blank box must not throw the id away — that is the
                  // opposite of what Confirm means on a suggestion.
                  const picked = (r.candidates ?? [])[choice[r.mediaId] ?? 0];
                  save(r, {
                    tvdbId: draft[r.mediaId] || picked?.tvdbId || r.tvdbId || null,
                    tmdbId: draft[r.mediaId] ? null : (picked?.tmdbId ?? r.tmdbId ?? null),
                    tmdbKind: draft[r.mediaId] ? null : (picked?.tmdbKind ?? r.tmdbKind ?? null),
                    confirmed: true, rejected: false, pending: false,
                    matchedTitle: picked?.matchedTitle ?? r.matchedTitle ?? null,
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
