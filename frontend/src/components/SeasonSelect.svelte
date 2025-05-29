<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let season: 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';
  export let year: number;

  const dispatch = createEventDispatcher();

  function updateSeason(event: Event) {
    season = (event.target as HTMLSelectElement).value as any;
    dispatch('change');
  }

  function updateYear(event: Event) {
    year = Number((event.target as HTMLInputElement).value);
    dispatch('change');
  }
</script>

<div class="flex gap-4 items-center mb-6">
  <select class="select select-bordered" bind:value={season} on:change={updateSeason}>
    <option value="WINTER">Winter</option>
    <option value="SPRING">Spring</option>
    <option value="SUMMER">Summer</option>
    <option value="FALL">Fall</option>
  </select>

  <input type="number" class="input input-bordered w-28" bind:value={year} min="1900" max="2100" on:input={updateYear} />
</div>
