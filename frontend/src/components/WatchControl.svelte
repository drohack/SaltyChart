<script lang="ts">
  // Watch for the show pane, or the reason there is nothing to watch, on the
  // poster. On a PC it is the full "Watch S1E1" button; on a phone a plain
  // round play button in the middle - the full one hid most of the poster
  // there, and a row of its own under the video vanished once the episode
  // started, which moved everything below it (the owner's call, 2026-10-20).
  import { createEventDispatcher } from 'svelte';

  export let watchInfo: any = null;
  export let openingPlayer = false;
  export let mediaConfigured = false;
  /** `full` is the PC's "Watch S1E1" button; `icon` is the phone's round play button. */
  export let variant: 'full' | 'icon' = 'full';

  const dispatch = createEventDispatcher<{ watch: void }>();
</script>

{#if watchInfo?.available}
  {@const ep = watchInfo.seasonNumber != null && watchInfo.episodeNumber != null
    ? `S${watchInfo.seasonNumber}E${watchInfo.episodeNumber}` : ''}
  {#if variant === 'icon'}
    <!-- Centred on the poster; the episode is already on the line under it. -->
    <button class="btn btn-accent btn-circle btn-lg shadow-lg absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
      class:btn-disabled={openingPlayer} on:click={() => dispatch('watch')}
      aria-label={`Watch ${ep}`.trim()} data-watch>
      {#if openingPlayer}<span class="loading loading-spinner loading-sm"></span>{:else}<svg viewBox="0 0 24 24" class="w-7 h-7 ml-0.5" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>{/if}
    </button>
  {:else}
    <button class="btn btn-accent btn-lg gap-2 shadow-lg"
      class:btn-disabled={openingPlayer} on:click={() => dispatch('watch')} data-watch>
      {#if openingPlayer}<span class="loading loading-spinner loading-sm"></span> Opening...{:else}<svg viewBox="0 0 24 24" class="w-5 h-5" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg> Watch{/if}
      {ep}
    </button>
  {/if}
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
