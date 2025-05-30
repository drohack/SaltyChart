<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  // --- Props ---
  export type Season = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';
  export let season: Season;
  export let year: number;
  export let hideSequels: boolean = false;
  export let hideInList: boolean = false;
  export let showListToggle: boolean = true;

  // --- Constants ---
  const SEASONS: Array<{ value: Season; label: string }> = [
    { value: 'WINTER', label: 'Winter' },
    { value: 'SPRING', label: 'Spring' },
    { value: 'SUMMER', label: 'Summer' },
    { value: 'FALL', label: 'Fall' }
  ];

  const currentYear: number = new Date().getFullYear();
  // Provide a selectable range of years (current ±10 years)
  const years: number[] = Array.from({ length: 21 }, (_, i) => currentYear - 10 + i);

  const dispatch = createEventDispatcher();

  function selectSeason(s: Season) {
    if (season !== s) {
      season = s;
      dispatch('change');
    }
  }

  function updateYear(event: Event) {
    const newVal = Number((event.target as HTMLSelectElement).value);
    if (!Number.isNaN(newVal) && year !== newVal) {
      year = newVal;
      dispatch('change');
    }
  }

  // No extra toggle functions; bind:checked updates props automatically.
</script>

<div class="flex flex-wrap items-center mb-6 justify-between w-full gap-y-2 relative z-10">
  <!-- Left controls: season buttons + year dropdown -->
  <div class="flex gap-4 items-center">
    <!-- Season buttons -->
    <div class="flex gap-2">
      {#each SEASONS as { value, label }}
        <button
          type="button"
          class={`btn btn-sm ${season === value ? 'btn-primary' : 'btn-ghost'}`}
          on:click={() => selectSeason(value)}
        >
          {label}
        </button>
      {/each}
    </div>

    <!-- Year dropdown -->
    <select
      class="select select-bordered w-28"
      bind:value={year}
      on:change={updateYear}
    >
      {#each years as y}
        <option value={y}>{y}</option>
      {/each}
    </select>
  </div>

  <!-- Right-aligned toggles -->
  <div class="flex items-center gap-6 text-sm">
    <label class="flex items-center gap-2 select-none cursor-pointer">
      <input
        type="checkbox"
        class="checkbox checkbox-sm"
        bind:checked={hideSequels}
        on:change={() => dispatch('change')}
      />
      Hide sequels
    </label>

    {#if showListToggle}
      <label class="flex items-center gap-2 select-none cursor-pointer">
        <input
          type="checkbox"
          class="checkbox checkbox-sm"
          bind:checked={hideInList}
          on:change={() => dispatch('change')}
        />
        Hide in My List
      </label>
    {/if}
  </div>
</div>
