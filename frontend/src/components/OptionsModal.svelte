<script lang="ts">
  import { options, Theme, TitleLanguage } from '../stores/options';
  import { createEventDispatcher, onDestroy } from 'svelte';

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

  /** Close on Escape key even if focus is inside the dialog */
  function handleKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }

  // Ensure global listener is removed if the component unmounts while open
  $: {
    if (open) {
      window.addEventListener('keydown', handleKey);
    } else {
      window.removeEventListener('keydown', handleKey);
    }
  }

  onDestroy(() => {
    window.removeEventListener('keydown', handleKey);
  });
</script>

{#if open}
  <!-- Modal overlay: covers the viewport and dims background without disabling page scroll -->
  <div class="fixed inset-0 z-50 flex items-center justify-center pointer-events-auto">
    <!-- Backdrop -->
    <div class="absolute inset-0 bg-black/50" on:click={close}></div>

    <!-- Dialog box -->
    <div
      class="modal-box relative z-10"
      role="dialog"
      aria-modal="true"
      on:click|stopPropagation
    >
      <h3 class="font-bold text-lg mb-4">Options</h3>

      <!-- Theme selection -->
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

      <!-- Title language selection -->
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

      <!-- Toggles -->
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

<!-- Custom styles: none (tailwind classes cover it) -->
