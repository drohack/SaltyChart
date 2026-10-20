<script lang="ts">
  // Shown on Randomize in place of the empty wheel when you have no list for
  // the season: copy another account's trailer ranking, plus the shows other
  // accounts ranked that it doesn't have. The ordering rules live in
  // lib/copyList.ts; this component only fetches, shows and saves.
  import { createEventDispatcher } from 'svelte';
  import { options } from '../stores/options';
  import { apiFetch, apiJson, QUICK, ApiError } from '../lib/remote';
  import { buildCopiedList, defaultMain, type AccountList } from '../lib/copyList';
  import LoadingSpinner from './LoadingSpinner.svelte';

  export let season: string;
  export let year: number;
  export let anime: any[] = [];
  export let token: string;
  export let self: string | null = null;

  const dispatch = createEventDispatcher<{ copied: void }>();

  let lists: AccountList[] = [];
  let mainUser: string | null = null;
  let excluded = new Set<string>();
  let loading = true;
  let loadError = '';
  let saving = false;
  let saveError = '';

  $: seasonLabel = season.charAt(0) + season.slice(1).toLowerCase();

  // Same request-id guard as Randomize's own season load: a late answer for the
  // previous season must not land on this one.
  let _reqId = 0;
  $: load(season, year);

  async function load(s: string, y: number) {
    const reqId = ++_reqId;
    loading = true;
    loadError = '';
    saveError = '';
    try {
      const names = await apiJson<string[]>(
        `/api/list/users-with-ratings?season=${s}&year=${y}`, {},
        { timeoutMs: QUICK, label: 'copy list users' }
      );
      const others = names.filter((n) => n !== self);
      const fetched = await Promise.all(others.map(async (user) => {
        try {
          const rows = await apiJson<{ mediaId: number; customName: string | null }[]>(
            `/api/public-list?username=${encodeURIComponent(user)}&season=${s}&year=${y}`, {},
            { timeoutMs: QUICK, label: `copy list ${user}` }
          );
          return { user, entries: rows.map((r) => ({ mediaId: r.mediaId, customName: r.customName ?? null })) };
        } catch (err) {
          // 404: the account turned on hide-from-Compare (or was deleted)
          // between the two calls. That is one account gone, not a failed
          // panel - anything else still fails the whole load and says so.
          if (err instanceof ApiError && err.status === 404) return null;
          throw err;
        }
      }));
      if (reqId !== _reqId) return;
      lists = fetched.filter((l): l is NonNullable<typeof l> => !!l && l.entries.length > 0);
      mainUser = defaultMain(lists);
      excluded = new Set();
    } catch (err) {
      if (reqId !== _reqId) return;
      console.warn('[copy list] load failed', err);
      lists = [];
      loadError = err instanceof ApiError && !err.unreachable
        ? "Couldn't load the other lists for this season."
        : "Couldn't load the other lists - the server didn't answer.";
    } finally {
      if (reqId === _reqId) loading = false;
    }
  }

  $: byCount = [...lists].sort((a, b) => b.entries.length - a.entries.length || a.user.localeCompare(b.user));
  $: copied = mainUser ? buildCopiedList(lists, mainUser, excluded) : { items: [], bonus: [] };
  // The footer says where the total comes from, because with many accounts the
  // extras' checkboxes scroll out of view - and they are part of the copy.
  $: fromMain = mainUser ? copied.items.length - copied.bonus
      .filter((b) => !excluded.has(b.user)).reduce((n, b) => n + b.mediaIds.length, 0) : 0;
  $: extraUsers = copied.bonus.filter((b) => !excluded.has(b.user)).length;
  $: split = `${fromMain} from ${mainUser}` + (extraUsers
    ? ` + ${copied.items.length - fromMain} from ${extraUsers} other${extraUsers === 1 ? '' : 's'}`
    : '');

  $: titleById = new Map(anime.map((a) => [a.id, a]));
  function titleFor(id: number, lang: string): string | null {
    const a = titleById.get(id);
    if (!a) return null;
    const t = a.title ?? {};
    if (lang === 'ROMAJI') return t.romaji || t.english || t.native || null;
    if (lang === 'NATIVE') return t.native || t.english || t.romaji || null;
    return t.english || t.romaji || t.native || null;
  }
  // A show the season data doesn't have still copies; it just can't be named.
  // Long lists name the first few and say how many follow, with a toggle for
  // the rest - picking a small main list can make another account's extras
  // run to dozens of titles.
  const BONUS_NAMED = 4;
  let expanded = new Set<string>();
  function bonusNames(ids: number[], lang: string): string[] {
    const named = ids.map((id) => titleFor(id, lang)).filter(Boolean) as string[];
    const unnamed = ids.length - named.length;
    if (unnamed) named.push(`${unnamed} more not in this season's data`);
    return named;
  }
  function toggleExpanded(user: string) {
    const next = new Set(expanded);
    if (next.has(user)) next.delete(user);
    else next.add(user);
    expanded = next;
  }

  // The account you copy from is never also an unticked extra.
  $: if (mainUser && excluded.has(mainUser)) {
    const next = new Set(excluded);
    next.delete(mainUser);
    excluded = next;
  }

  function toggle(user: string) {
    const next = new Set(excluded);
    if (next.has(user)) next.delete(user);
    else next.add(user);
    excluded = next;
  }

  async function copy() {
    if (saving || !copied.items.length) return;
    saving = true;
    saveError = '';
    const headers = { Authorization: `Bearer ${token}` };
    try {
      // PUT /api/list replaces the whole season, so a list made since this
      // panel opened (another tab, another device) must never be overwritten.
      // Reloading shows that list in place of this panel.
      const mine = await apiJson<any[]>(`/api/list?season=${season}&year=${year}`, { headers },
        { timeoutMs: QUICK, label: 'copy list recheck' });
      if (mine.length) {
        dispatch('copied');
        return;
      }
      const res = await apiFetch('/api/list', {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ season, year, items: copied.items }),
      }, { timeoutMs: QUICK, label: 'copy list save' });
      if (!res.ok) throw new ApiError('http', `copy list save: HTTP ${res.status}`, res.status);
      dispatch('copied');
    } catch (err) {
      console.warn('[copy list] save failed', err);
      saveError = "Couldn't copy the list - nothing was changed. Try again.";
    } finally {
      saving = false;
    }
  }
</script>

<!-- The card is capped to the wheel area's height and scrolls in the middle,
     so the title and the Copy button are always on screen: uncapped, ten
     accounts ran the button past the bottom of a 1366x768 laptop. Choosing
     whose list to copy is the decision; the extra accounts below it are
     secondary - smaller, but shown and ticked by default, since combining
     every account is the point and not an option tucked away. -->
<div class="mt-4 sm:mt-8 w-full max-w-md mx-auto px-4 sm:px-0 text-left" data-copy-list>
  {#if loading}
    <div class="flex justify-center"><LoadingSpinner size="lg" /></div>
  {:else if loadError}
    <div class="text-center">
      <p class="opacity-70 mb-3">{loadError}</p>
      <button class="btn btn-sm btn-outline" on:click={() => load(season, year)}>Retry</button>
    </div>
  {:else if !lists.length}
    <div class="text-center opacity-70">
      <p>My List for this season is empty.</p>
      <p class="text-sm mt-1">Nobody else has ranked this season yet.</p>
    </div>
  {:else}
    <div class="copy-card card bg-base-200 shadow flex flex-col overflow-hidden">
      <div class="shrink-0 px-5 pt-4 pb-3">
        <h2 class="card-title text-lg">Copy a trailer list for {seasonLabel} {year}</h2>
        <p class="text-sm opacity-70">Your list for this season is empty. Start from someone else's.</p>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-5 pb-4 flex flex-col gap-4" data-copy-scroll>
        <fieldset>
          <legend class="font-semibold mb-1.5">Copy from</legend>
          <div class="flex flex-col gap-1">
            {#each byCount as list (list.user)}
              <label class="flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-colors
                {mainUser === list.user ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-base-300'}">
                <input type="radio" class="radio radio-sm radio-primary" name="copy-main"
                  value={list.user} bind:group={mainUser} data-copy-main={list.user} />
                <span class="flex-1 truncate font-medium">{list.user}</span>
                <span class="text-sm opacity-60 tabular-nums shrink-0">
                  {list.entries.length} trailer{list.entries.length === 1 ? '' : 's'}
                </span>
              </label>
            {/each}
          </div>
        </fieldset>

        {#if copied.bonus.length}
          <div class="pt-3 border-t border-base-300"><fieldset>
            <legend class="text-xs font-semibold uppercase tracking-wide opacity-60 mb-1">Plus these shows from other users</legend>
            {#each copied.bonus as b, i (b.user)}
              {@const names = bonusNames(b.mediaIds, $options.titleLanguage)}
              {@const open = expanded.has(b.user) || names.length <= BONUS_NAMED + 1}
              <div class="flex items-start gap-2 py-1">
                <input type="checkbox" id="copy-bonus-{i}" class="checkbox checkbox-xs checkbox-primary mt-0.5"
                  checked={!excluded.has(b.user)} on:change={() => toggle(b.user)} data-copy-bonus={b.user} />
                <div class="min-w-0 text-xs leading-snug break-words" class:opacity-50={excluded.has(b.user)}>
                  <label for="copy-bonus-{i}" class="cursor-pointer">
                    <span class="font-medium">{b.user}</span>
                    <span class="opacity-60">({b.mediaIds.length})</span> -
                    <span class="opacity-80">{(open ? names : names.slice(0, BONUS_NAMED)).join(', ')}</span>
                  </label>
                  {#if names.length > BONUS_NAMED + 1}
                    <button type="button" class="link link-hover opacity-70 ml-1" on:click={() => toggleExpanded(b.user)}>
                      {open ? 'show less' : `and ${names.length - BONUS_NAMED} more`}
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </fieldset></div>
        {/if}
      </div>

      <div class="shrink-0 border-t border-base-300 px-5 py-3 flex flex-col gap-2">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0 tabular-nums">
            <div class="text-sm font-semibold" data-copy-total>{copied.items.length} show{copied.items.length === 1 ? '' : 's'}</div>
            <div class="text-xs opacity-70 leading-snug break-words" data-copy-split>{split}</div>
          </div>
          <button class="btn btn-primary btn-sm shrink-0" on:click={copy} disabled={saving || !copied.items.length} data-copy-save>
            {saving ? 'Copying...' : 'Copy list'}
          </button>
        </div>
        {#if saveError}<p class="text-sm text-error" role="alert">{saveError}</p>{/if}
      </div>
    </div>
  {/if}
</div>

<style>
  /* As tall as the wheel area it stands in for. On a phone that area is the
     square wheel's (~300px), which left the account list 104px at 320x568
     with the rest of the screen empty below - so there it takes the screen's
     height less the header and season row above it. */
  .copy-card { max-height: calc(var(--area-size, 70vh) - 2rem); }
  @media (max-width: 639.98px) {
    .copy-card { max-height: calc(100dvh - 14rem); }
  }
</style>
