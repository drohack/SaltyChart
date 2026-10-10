<script lang="ts">
  /**
   * One /admin/sonarr row, shared by the season tables and the "Not auto-added"
   * section so both read identically - same columns, same badge, same reason.
   * Ten cells, matching the page's one `<colgroup>`; flow 28 counts them.
   */
  import { createEventDispatcher } from 'svelte';
  import ExternalIdLink from './ExternalIdLink.svelte';
  import StatusBadge from './StatusBadge.svelte';
  import AirDate from './AirDate.svelte';
  import { LEVEL, type EntryStatus } from '../lib/entryStatus';

  export let row: {
    kind: 'proposed' | 'rejected';
    anilistId: number | null;
    tvdbId: number | null;
    title: string | null;
    format: string | null;
    status: EntryStatus;
    startDate: { year?: number | null; month?: number | null; day?: number | null } | null;
    season: string | null;
    year: number | null;
    cover: string | null;
    episodes: number | null;
    english?: { label: string; ok: boolean } | null;
    listedBy?: number;
    monitor?: 'firstSeason' | 'lastSeason';
    wantedBy?: 'rules' | 'list' | 'include' | null;
    onMyList?: boolean;
    reason?: string;
    unverified: boolean;
    outlier?: boolean;
    offset?: number;
    airing?: string | null;
  };
  /** Disables the Include button while a request is in flight. */
  export let busy = false;

  const dispatch = createEventDispatcher<{ include: typeof row }>();

  /** Problems fixed by correcting the match - those rows link to /admin/matching. */
  const MATCH_CODES = new Set([
    'noId', 'guess', 'ambiguous', 'titleOnly', 'unconfirmedAuto', 'viewerPick',
    'sonarrRejected', 'noTvdbId', 'unverifiedListed', 'duplicateTvdbId',
  ]);

  $: codes = [row.status.code, ...(row.status.also ?? []).map((a) => a.code)];
  $: fixOnMatching = row.status.level !== 'ok' && codes.some((c) => MATCH_CODES.has(c));
  // Not on a row waiting for its air date (it joins by itself) or one with no
  // usable TVDB id - an Include cannot add a show Sonarr cannot look up.
  $: canInclude = row.kind === 'rejected' && !!row.anilistId
    && !['outsideAirWindow', 'noUsableTvdbId', 'duplicateTvdbId'].includes(row.reason ?? '');
  $: matchingHref = row.season && row.year ? `/admin/matching?season=${row.season}&year=${row.year}` : '/admin/matching';
</script>

<tr data-entry-row data-level={row.status.level} data-anilist={row.anilistId ?? ''}>
  <td class="px-1">
    {#if row.cover}
      <img src={row.cover} alt="" class="h-11 w-auto rounded" loading="lazy" />
    {/if}
  </td>
  <td title={row.title ?? ''}>
    <div class="truncate">{row.title ?? '(untitled)'}</div>
    <!-- Why it is here when the rules would skip it, and what a sequel
         downloads: only its newest season. -->
    {#if row.listedBy || row.monitor === 'lastSeason' || row.wantedBy === 'include' || row.onMyList}
      <div class="truncate text-[11px] opacity-60" data-listed={row.listedBy ?? 0}>
        {[
          row.onMyList ? 'on your list' : '',
          row.listedBy ? `on ${row.listedBy} trusted list${row.listedBy === 1 ? '' : 's'}` : '',
          row.wantedBy === 'include' ? 'included by hand' : '',
          row.monitor === 'lastSeason' ? 'new season only' : '',
        ].filter(Boolean).join(' - ')}
      </div>
    {/if}
  </td>
  <td class="opacity-60"><ExternalIdLink id={row.tvdbId} /></td>
  <td class="opacity-60">{row.format ?? '-'}</td>
  <!-- Allowed to wrap, so the outlier badge drops under the date rather than
       overflowing the column. -->
  <td>
    <AirDate date={row.startDate} status={row.airing} />
    {#if row.outlier && row.offset}
      <span
        class="badge badge-xs badge-warning badge-outline ml-1"
        title={`Premieres ${Math.abs(row.offset)} days ${row.offset < 0 ? 'before' : 'after'} the rest of its season`}
      >{row.offset > 0 ? '+' : ''}{row.offset}d</span>
    {/if}
  </td>
  <td class="opacity-60 text-right">{row.episodes ?? '?'}</td>
  <td class="whitespace-nowrap text-xs" data-english>{#if row.english}<span class="font-medium {row.english.ok ? 'text-success' : 'text-error'}">{row.english.label}</span>{/if}</td>
  <td><StatusBadge status={row.status} /></td>
  <!-- The reason, always printed. A reason you have to hover for is hidden. -->
  <td class="text-xs leading-snug whitespace-normal break-words" data-why>
    <div>{row.status.text}</div>
    {#each row.status.also ?? [] as a (a.code)}
      <div class="{LEVEL[a.level].text} mt-0.5">also: {a.text}</div>
    {/each}
  </td>
  <td class="whitespace-nowrap">
    <div class="flex flex-col items-start gap-1">
      {#if fixOnMatching}
        <a class="link link-primary text-xs" href={matchingHref} data-fix-match>Fix match</a>
      {/if}
      {#if canInclude}
        <!-- An unverified identity gets a different label AND a confirm. The
             backend 409s regardless - this is so the click is informed, not so
             it is possible. -->
        <button
          class="btn btn-xs normal-case"
          class:btn-primary={!row.unverified}
          class:btn-warning={row.unverified}
          disabled={busy}
          on:click={() => dispatch('include', row)}
        >{row.unverified ? 'Include anyway' : 'Include'}</button>
      {/if}
    </div>
  </td>
</tr>
