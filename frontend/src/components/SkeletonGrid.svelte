<script lang="ts">
  // Shimmer placeholders shown while a Home section's season data is in
  // flight. Mirrors the AnimeGridTranslate card layout (title bar, cover +
  // trailer row, airing line, tag row, description block) so the page
  // doesn't reflow when real cards land.
  export let count = 6;
</script>

<div class="grid grid-cols-1 2cols:grid-cols-2 3cols:grid-cols-3 gap-6" aria-hidden="true">
  {#each Array(count) as _, i (i)}
    <div class="flex flex-col bg-base-100 shadow rounded-lg overflow-hidden">
      <!-- Title bar -->
      <div class="flex items-center px-3 py-2 border-b border-base-300">
        <div class="skeleton h-7 w-2/3"></div>
      </div>
      <!-- Cover + trailer row (height driven by the aspect-video thumb, like real cards) -->
      <div class="flex gap-3 px-3 py-1">
        <div class="skeleton shrink-0 w-32 md:w-40 rounded"></div>
        <div class="skeleton flex-1 aspect-video rounded"></div>
      </div>
      <!-- Airing info line -->
      <div class="px-3 py-1">
        <div class="skeleton h-4 w-3/4"></div>
      </div>
      <!-- Tag badges row -->
      <div class="px-3 flex gap-2">
        <div class="skeleton h-5 w-16 rounded-full"></div>
        <div class="skeleton h-5 w-20 rounded-full"></div>
      </div>
      <!-- Description block -->
      <div class="px-3 py-3 flex flex-col gap-2">
        <div class="skeleton h-4 w-full"></div>
        <div class="skeleton h-4 w-full"></div>
        <div class="skeleton h-4 w-full"></div>
        <div class="skeleton h-4 w-11/12"></div>
        <div class="skeleton h-4 w-full"></div>
        <div class="skeleton h-4 w-4/5"></div>
        <div class="skeleton h-4 w-full"></div>
        <div class="skeleton h-4 w-2/3"></div>
      </div>
    </div>
  {/each}
</div>
