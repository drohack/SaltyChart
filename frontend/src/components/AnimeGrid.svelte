<script lang="ts">
  export let anime: any[] = [];

  // id of trailer currently open in modal (null = none)
  let modal: string | null = null;

  function openModal(id: string) {
    modal = id;
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    modal = null;
    document.body.style.overflow = '';
  }
</script>

<!-- grid of horizontal cards -->
<div class="grid gap-6 md:grid-cols-3">
  {#each anime as show (show.id)}
    {#key show.id}
    <div class="flex bg-base-100 shadow rounded-lg overflow-hidden h-full">
      <!-- thumbnail -->
      <div class="relative shrink-0 w-32 md:w-40">
        <img src={show.coverImage.large} alt={show.title.romaji} class="object-cover w-full h-auto" />

        <!-- floating title -->
        <h3
          class="absolute bottom-0 left-0 w-full text-xs md:text-sm font-semibold text-white bg-black/70 px-2 py-1 leading-tight whitespace-normal"
          title={show.title.english ?? show.title.romaji}
        >
          {show.title.english ?? show.title.romaji}
        </h3>
      </div>

      <!-- right column -->
      <div class="flex flex-col gap-2 p-3 flex-1 overflow-hidden">
        {#if show.trailer?.site === 'youtube'}
          <button
            class="relative w-full aspect-video rounded overflow-hidden"
            on:click={() => openModal(show.trailer.id)}
          >
            <img
              src={`https://i.ytimg.com/vi/${show.trailer.id}/hqdefault.jpg`}
              alt="Trailer thumbnail"
              class="absolute inset-0 object-cover w-full h-full"
              loading="lazy"
            />
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              class="absolute inset-0 m-auto h-12 w-12 fill-white/90"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        {/if}

        {#if show.relations?.edges?.some(e => e.relationType === 'SEQUEL')}
          <span class="self-start badge badge-accent text-xs">Sequel</span>
        {/if}

        {#if show.description}
          <div class="text-sm overflow-y-auto max-h-40 pr-1 prose prose-sm dark:prose-invert">
            {@html show.description}
          </div>
        {/if}
      </div>
    </div>
    {/key}
  {/each}
</div>

<!-- Modal overlay for large trailer player -->
{#if modal}
  <div
    class="fixed inset-0 bg-black/80 flex items-center justify-center z-50"
    on:click|self={closeModal}
  >
    <div class="w-[95%] md:w-5/6 lg:w-4/5 xl:w-4/5 aspect-video">
      <iframe
        class="w-full h-full rounded"
        src={`https://www.youtube.com/embed/${modal}?autoplay=1&cc_load_policy=1&cc_lang_pref=en&hl=en`}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen
        on:click|stopPropagation
      />
    </div>
  </div>
{/if}
