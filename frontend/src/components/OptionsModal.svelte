<script lang="ts">
  import { options } from '../stores/options';
  import type { Theme, TitleLanguage } from '../stores/options';
  import { authToken } from '../stores/auth';
  import { seasonYear, type Season } from '../stores/season';
  import { createEventDispatcher, onDestroy } from 'svelte';

  const SEASONS: Season[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

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

  // ── Batch translation (admin only) ─────────────────────────────────
  let batchRunning = false;
  let batchMessage = '';
  let batchIsAdmin: boolean | null = null; // null = not checked yet
  let batchSeason: Season = $seasonYear.season;
  let batchYear: number = $seasonYear.year;

  async function checkBatchStatus() {
    if (!$authToken) return;
    try {
      const res = await fetch('/api/translate/batch/status', {
        headers: { Authorization: `Bearer ${$authToken}` },
      });
      if (res.status === 403) {
        batchIsAdmin = false;
        return;
      }
      batchIsAdmin = true;
      const data = await res.json();
      batchRunning = data.running;
      if (data.running) {
        batchMessage = `Running since ${new Date(data.startedAt).toLocaleTimeString()}`;
      }
    } catch {}
  }

  // Check admin status and sync season when modal first opens
  let lastOpenState = false;
  $: if (open && !lastOpenState) {
    lastOpenState = true;
    batchSeason = $seasonYear.season;
    batchYear = $seasonYear.year;
    if ($authToken && batchIsAdmin === null) {
      checkBatchStatus();
    }
  }
  $: if (!open) {
    lastOpenState = false;
  }

  async function startBatch(dryRun = false) {
    if (!$authToken) return;
    batchMessage = dryRun ? 'Checking trailers...' : 'Starting batch...';
    batchRunning = true;
    try {
      const res = await fetch('/api/translate/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${$authToken}`,
        },
        body: JSON.stringify({ dryRun, season: batchSeason, year: batchYear }),
      });
      const data = await res.json();
      if (data.error) {
        batchMessage = data.error;
        batchRunning = false;
      } else {
        batchMessage = dryRun ? 'Fetching anime list...' : 'Batch started, fetching anime list...';
        // Poll quickly — dry runs finish in seconds
        pollBatchStatus();
      }
    } catch (e) {
      batchMessage = 'Failed to start batch';
      batchRunning = false;
    }
  }

  async function pollBatchStatus() {
    if (!$authToken) return;
    try {
      const res = await fetch('/api/translate/batch/status', {
        headers: { Authorization: `Bearer ${$authToken}` },
      });
      const data = await res.json();
      batchRunning = data.running;
      const logLines: string[] = data.log || [];
      if (data.running) {
        const meaningful = [...logLines].reverse().find((l: string) => l.trim() && !l.startsWith('  [SKIP]'));
        batchMessage = meaningful || 'Running...';
        setTimeout(pollBatchStatus, 1500);
      } else if (logLines.length > 0) {
        // Build a useful completion summary
        const needsLine = logLines.find((l: string) => l.includes('trailers need translation'));
        const completeLine = logLines.find((l: string) => l.includes('Complete:'));
        const nothingLine = logLines.find((l: string) => l.includes('Nothing to translate') || l.includes('already cached. Done'));
        const isDryRun = logLines.some((l: string) => l.includes('DRY RUN'));

        if (isDryRun) {
          const trailerLines = logLines.filter((l: string) => /^\s{2}\S/.test(l) && !l.startsWith('  [SKIP]'));
          batchMessage = needsLine
            ? `${needsLine.trim()} (${trailerLines.length} to translate)`
            : `Dry run complete: ${trailerLines.length} trailers`;
        } else {
          batchMessage = completeLine?.trim() || nothingLine?.trim() || 'Done';
        }
      } else {
        batchMessage = 'Done';
      }
    } catch {}
  }
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

      <!-- Batch translation (admin only) -->
      {#if $authToken && batchIsAdmin}
        <div class="divider"></div>
        <div class="form-control mb-4">
          <label class="label"><span class="label-text font-semibold">Subtitle Pre-Translation</span></label>
          <p class="text-sm text-base-content/60 mb-2">
            Batch translate trailers using a higher quality model.
          </p>
          <div class="flex items-center gap-2 mb-2">
            <select class="select select-bordered select-sm" bind:value={batchSeason} disabled={batchRunning}>
              {#each SEASONS as s}
                <option value={s}>{s}</option>
              {/each}
            </select>
            <input
              type="number"
              class="input input-bordered input-sm w-24"
              bind:value={batchYear}
              disabled={batchRunning}
              min={2020}
              max={2030}
            />
          </div>
          <div class="flex gap-2">
            <button
              class="btn btn-sm btn-neutral"
              disabled={batchRunning}
              on:click={() => startBatch(true)}
            >
              Dry Run
            </button>
            <button
              class="btn btn-sm btn-primary"
              disabled={batchRunning}
              on:click={() => startBatch(false)}
            >
              {batchRunning ? 'Running...' : 'Start Batch'}
            </button>
          </div>
          {#if batchMessage}
            <p class="text-sm mt-2 text-base-content/70">{batchMessage}</p>
          {/if}
        </div>
      {/if}

      <div class="modal-action">
        <button class="btn" on:click={close}>Close</button>
      </div>
    </div>
  </div>
{/if}

<!-- Custom styles: none (tailwind classes cover it) -->
