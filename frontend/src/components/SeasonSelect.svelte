<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  // --- Props ---
  export type Season = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';
  export let season: Season;
  export let year: number;
  export let hideSequels: boolean = false;
  export let hideInList: boolean = false;
  export let showListToggle: boolean = true;
  export let showSequelToggle: boolean = true;
  // Toggle to hide adult (18+) content
  export let hideAdult: boolean = false;
  export let showAdultToggle: boolean = false;
  // Search query for filtering in parent
  export let searchQuery: string = '';
  // Show search box (binds to searchQuery)
  export let showSearch: boolean = false;

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

  <!-- Responsive layout: 1 col (<1122px), 2 cols (>=1122px), 3 cols (>=1732px) -->
  <div class="grid w-full mb-6 gap-4 relative z-10 \
    grid-cols-1 2cols:grid-cols-[auto,1fr] 3cols:grid-cols-[auto,1fr,auto] items-center">
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
  {#if showSearch}
    <!-- Centered search box -->
    <div class="flex-1 flex justify-center items-center">
      <label for="search" class="font-medium mr-2">Search series:</label>
      <input
        id="search"
        type="text"
        bind:value={searchQuery}
        class="input w-auto"
      />
    </div>
  {/if}

  <!-- Right-aligned toggles; span both columns on 2cols -->
  <div class="flex items-center gap-6 text-sm 2cols:col-span-2 3cols:col-span-1">
    {#if showAdultToggle}
      <label class="flex items-center gap-2 select-none cursor-pointer">
        <input
          type="checkbox"
          class="checkbox checkbox-sm"
          bind:checked={hideAdult}
          on:change={() => dispatch('change')}
        />
        Hide 18+
      </label>
    {/if}
    {#if showSequelToggle}
      <label class="flex items-center gap-2 select-none cursor-pointer">
        <input
          type="checkbox"
          class="checkbox checkbox-sm"
          bind:checked={hideSequels}
          on:change={() => dispatch('change')}
        />
        Hide sequels
      </label>
    {/if}

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
