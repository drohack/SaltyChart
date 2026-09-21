<script lang="ts">
  /**
   * A TVDB or TMDB id, rendered as the bare number but linked to the record.
   *
   * Why this exists: the admin pages printed ids as plain text, and there is no
   * way to check one. TVDB has no by-id page - `thetvdb.com/series/471609` is a
   * 404, because the public URL is a slug (`/series/psyren-sairen`), so the only
   * way to verify a stored id was to guess the show's name and search for it.
   * That is exactly backwards on a page whose whole job is asking "is this id
   * the right series?".
   *
   * `dereferrer` is TVDB's own by-id redirect and the one documented entry point
   * that takes a number (verified 2026-09-20: /dereferrer/series/471609 -> 301
   * -> /series/psyren-sairen). TMDB needs no such thing, but it does number
   * films and shows independently, so the kind has to be in the path.
   */
  export let kind: 'tvdb' | 'tmdb' = 'tvdb';
  /** TMDB only - tv and movie are separate id spaces. Ignored for TVDB. */
  export let tmdbKind: string | null = null;
  export let id: string | number | null | undefined = null;
  /** Shown instead of the bare id (e.g. "TVDB 471609"). */
  export let label: string | null = null;
  /** Rendered when there is no id, so a column keeps its shape. */
  export let placeholder = '';

  $: href = id == null || id === ''
    ? null
    : kind === 'tvdb'
      ? `https://www.thetvdb.com/dereferrer/series/${id}`
      : `https://www.themoviedb.org/${tmdbKind === 'movie' ? 'movie' : 'tv'}/${id}`;
</script>

{#if href}
  <a
    {href}
    target="_blank"
    rel="noopener noreferrer"
    class="link link-primary"
    title="Open {kind === 'tvdb' ? 'TVDB' : 'TMDB'} {id} in a new tab"
    on:click|stopPropagation
  >{label ?? id}</a>
{:else}{placeholder}{/if}
