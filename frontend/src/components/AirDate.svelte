<script lang="ts">
  /**
   * A premiere date that says whether it has happened.
   *
   * It used to be plain grey `2026-10-14`, which read the same as a date three
   * months gone - "has this aired?" took arithmetic. Unaired is a blue badge
   * with a countdown, and the last fortnight before a premiere (when Sonarr
   * starts acting on it) is bold; an aired date stays quiet.
   *
   * Partial AniList dates read as the earliest day they could mean, the same
   * rule `isUnaired` (backend lib/entryStatus.ts) uses everywhere else.
   */
  export let date: { year?: number | null; month?: number | null; day?: number | null } | null | undefined;
  /** AniList status, authoritative over the date when present. */
  export let status: string | null | undefined = null;

  const DAY = 86_400_000;
  const SOON_DAYS = 14;

  $: ms = date?.year ? Date.UTC(date.year, (date.month ?? 1) - 1, date.day ?? 1) : null;
  $: unaired = status ? status === 'NOT_YET_RELEASED' : ms != null && ms > Date.now();
  $: days = ms != null ? Math.ceil((ms - Date.now()) / DAY) : null;
  $: label = ms == null
    ? 'no date'
    : new Date(ms).toLocaleDateString(undefined, {
        month: 'short',
        day: date?.day ? 'numeric' : undefined,
        // The year only when the date is far enough off to be ambiguous - the
        // countdown already says how far, and the column has a fixed width.
        year: Math.abs(ms - Date.now()) > 300 * DAY ? 'numeric' : undefined,
        timeZone: 'UTC',
      });
</script>

{#if unaired}
  <span
    class="badge badge-sm badge-info badge-outline whitespace-nowrap"
    class:font-bold={days != null && days <= SOON_DAYS}
    data-air="unaired"
    title={ms != null ? `Premieres ${new Date(ms).toISOString().slice(0, 10)}` : 'No premiere date yet'}
  >{label}{#if days != null && days > 0}{` - in ${days} d`}{/if}</span>
{:else}
  <span class="opacity-60 whitespace-nowrap" data-air="aired">{ms == null ? label : `aired ${label}`}</span>
{/if}
