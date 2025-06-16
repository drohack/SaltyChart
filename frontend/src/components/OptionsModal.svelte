<script lang="ts">
  import { options, Theme, TitleLanguage, Options } from '../stores/options';
  import { createEventDispatcher } from 'svelte';

  const themeOptions: { value: Theme; label: string }[] = [
    { value: 'LIGHT', label: 'Light' },
    { value: 'NIGHT', label: 'Night' },
    { value: 'SYSTEM', label: 'System' },
    { value: 'HIGH_CONTRAST', label: 'High Contrast' }
  ];
  const titleLangOptions: { value: TitleLanguage; label: string }[] = [
    { value: 'ENGLISH', label: 'English' },
    { value: 'ROMAJI', label: 'Romaji' },
    { value: 'NATIVE', label: 'Native' }
  ];

  export let open: boolean = false;
  const dispatch = createEventDispatcher();
  function close() {
    open = false;
    dispatch('close');
  }
</script>

 {#if open}
  <!-- Overlay acts as a dismiss button and is keyboard accessible -->
  <div
    class="modal modal-open"
    role="button"
    aria-label="Close options"
    tabindex="0"
    on:click={close}
    on:keydown={(e) => (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') && close()}
  >
    <div
      class="modal-box"
      role="dialog"
      aria-modal="true"
      on:click|stopPropagation
    >
      <h3 class="font-bold text-lg mb-4">Options</h3>
      <div class="form-control mb-4">
        <label class="label" for="themeSelect"><span class="label-text">Theme</span></label>
        <select
          id="themeSelect"
          class="select select-bordered"
          bind:value={$options.theme}
        >
          {#each themeOptions as opt}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>
      <div class="form-control mb-4">
        <label class="label" for="titleLangSelect"><span class="label-text">Title Language</span></label>
        <select
          id="titleLangSelect"
          class="select select-bordered"
          bind:value={$options.titleLanguage}
        >
          {#each titleLangOptions as opt}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>
      <div class="form-control mb-4">
        <label class="label cursor-pointer">
          <span class="label-text">Video Autoplay</span>
          <input type="checkbox" class="toggle" bind:checked={$options.videoAutoplay} />
        </label>
      </div>
      <div class="form-control mb-4">
        <label class="label cursor-pointer">
          <span class="label-text">Hide from Compare</span>
          <input type="checkbox" class="toggle" bind:checked={$options.hideFromCompare} />
        </label>
      </div>
      <div class="modal-action">
        <button class="btn" on:click={close}>Close</button>
      </div>
    </div>
  </div>
{/if}