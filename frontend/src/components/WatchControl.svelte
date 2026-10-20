<script lang="ts">
  // Watch for the show pane, or the reason there is nothing to watch. Rendered
  // in one of two places by Randomize: over the poster on a PC, and on its own
  // row under the episode line on a phone, where a big button over the poster
  // hid most of it (the owner's call, 2026-10-20). One component so the two
  // places can never say different things.
  import { createEventDispatcher } from 'svelte';

  export let watchInfo: any = null;
  export let openingPlayer = false;
  export let mediaConfigured = false;
  /** `overlay` sits on the poster (white text, a large button); `row` is the phone row. */
  export let variant: 'overlay' | 'row' = 'overlay';

  const dispatch = createEventDispatcher<{ watch: void }>();
</script>

{#if watchInfo?.available}
  <button class="btn btn-accent gap-2 {variant === 'overlay' ? 'btn-lg shadow-lg' : 'w-full'}"
    class:btn-disabled={openingPlayer} on:click={() => dispatch('watch')} data-watch>
    {#if openingPlayer}<span class="loading loading-spinner loading-sm"></span> Opening...{:else}<svg viewBox="0 0 24 24" class="w-5 h-5" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg> Watch{/if}
    {#if watchInfo.seasonNumber != null && watchInfo.episodeNumber != null}S{watchInfo.seasonNumber}E{watchInfo.episodeNumber}{/if}
  </button>
{:else if mediaConfigured && watchInfo?.unknown}
  <span class="opacity-80">Couldn't reach the media server - try again shortly</span>
{:else if mediaConfigured && watchInfo?.notAired}
  <span class="opacity-80" data-not-aired>Not aired yet</span>
{:else if mediaConfigured && watchInfo && !watchInfo.available}
  <span class="opacity-80">Not in library{watchInfo.libraryTitle ? ` (found "${watchInfo.libraryTitle}" but not this season)` : ''}</span>
{:else if mediaConfigured}
  <span class="loading loading-spinner loading-md"></span>
{:else}
  <span class="opacity-70">No media server set up</span>
{/if}
