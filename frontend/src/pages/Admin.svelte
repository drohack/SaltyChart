<script lang="ts">
  import { onMount } from 'svelte';
  import { authToken } from '../stores/auth';
  import { apiFetch, apiJson, QUICK, ApiError } from '../lib/remote';
  import AdminShell from '../components/AdminShell.svelte';

  // -- Jellyfin config -------------------------------------------------
  // The API key is stored server-side and never sent back to a browser;
  // reads return only `apiKeySet`.
  let jfUrl = '';
  let jfKey = '';
  let jfKeySet = false;
  /** Which Jellyfin account playback runs as; '' falls back to an administrator. */
  let jfUserId = '';
  let jfUsers: { id: string; name: string; isAdministrator: boolean }[] = [];
  let jfSaving = false;
  let jfTesting = false;
  let jfSaveMsg = '';
  let jfSaveErr = '';
  let jfTestResult:
    | {
        ok: boolean;
        error?: string;
        serverName?: string;
        version?: string;
        libraries?: { title: string; type: string }[];
        playbackAccount?: string;
      }
    | null = null;

  /** Placeholder text only - a blank box means "keep the stored URL", enforced server-side. */
  const DEFAULT_JF_URL = 'http://192.168.1.2:8096';

  /** Set when the saved config couldn't be read - distinct from "nothing saved". */
  let jfLoadError = '';

  async function loadConfig() {
    if (!$authToken) return;
    const auth = { Authorization: `Bearer ${$authToken}` };
    // One `catch {}` used to wrap this *and* loadUsers, so any failure rendered
    // as empty fields and an empty account picker - i.e. "nothing is
    // configured", on the page whose entire job is showing what is configured.
    try {
      const data = await apiJson<any>('/api/jellyfin/config', { headers: auth },
                                      { label: 'jellyfin/config', timeoutMs: QUICK });
      jfUrl = data.url ?? '';
      jfKeySet = !!data.apiKeySet;
      jfUserId = data.userId ?? '';
      jfLoadError = '';
    } catch {
      jfLoadError = "Couldn't load the saved configuration - the fields below may be blank for that reason, not because nothing is saved.";
    }
    await loadUsers();
  }

  /**
   * The playback-account picker.
   *
   * Split out because it needs re-running after Test and after Save, not only on
   * mount: `/api/jellyfin/users` reads the *stored* config, so on a first setup
   * (or after correcting a bad URL/key) the mount-time call returns nothing and
   * the picker sits empty with no way to choose an account - which is the one
   * thing you came to this page to do.
   */
  async function loadUsers() {
    if (!$authToken) return;
    try {
      const data = await apiJson<{ users?: any[] }>(
        '/api/jellyfin/users',
        { headers: { Authorization: `Bearer ${$authToken}` } },
        { label: 'jellyfin/users', timeoutMs: QUICK }
      );
      jfUsers = data.users ?? [];
    } catch {
      // Not fatal: an unconfigured or unreachable server legitimately has no
      // list to give. The picker's own empty state covers it, and apiJson
      // logged why.
      jfUsers = [];
    }
  }

  // -- Sonarr config ---------------------------------------------------
  // These credentials can now ADD a series - that is the feature. What they
  // still cannot do is remove or change one: `lib/sonarrApi.ts` exports exactly
  // one write verb, `addSeries`, and no delete, update or exclusion write.
  // Cleanup is Maintainerr's. Adding is gated again on /admin/sonarr by a master
  // switch that defaults off, so saving credentials here never starts anything.
  let snUrl = '';
  let snKey = '';
  let snKeySet = false;
  let snTags = 'anime, saltychart';
  let snMarkerTag = 'saltychart';
  let snRootFolder = '';
  let snQualityProfileId = 0;
  let snSeriesType = 'standard';
  /**
   * What Sonarr offers, for the two dropdowns. Null until read.
   *
   * Dropdowns and not text boxes because `rootFolderPath` has to match one of
   * Sonarr's own paths exactly - `/media/Anime/` against its `/media/Anime` is
   * rejected at add time, a long way from where the trailing slash was typed.
   */
  let snOptions: {
    ok: boolean;
    error?: string;
    rootFolders?: { path: string }[];
    qualityProfiles?: { id: number; name: string }[];
    missingTags?: string[];
  } | null = null;
  let snOptionsLoading = false;
  let snSaving = false;
  let snTesting = false;
  let snSaveMsg = '';
  let snSaveErr = '';
  let snTestResult: { ok: boolean; version?: string; error?: string } | null = null;
  let snLoadError = '';

  /** Sonarr's default port, and where it answers on this deployment. */
  const DEFAULT_SONARR_URL = 'http://192.168.1.2:8989';

  async function loadSonarrConfig() {
    if (!$authToken) return;
    try {
      const data = await apiJson<any>('/api/sonarr/config',
                                      { headers: { Authorization: `Bearer ${$authToken}` } },
                                      { label: 'sonarr/config', timeoutMs: QUICK });
      // Prefill the example when the read SUCCEEDED and told us nothing is
      // stored, so first-time setup is one click instead of retyping a URL that
      // is right nearly always. The box then holds a real, editable value rather
      // than a ghost that only becomes real on Save.
      //
      // Deliberately here and not in the save path. The Jellyfin block above
      // once defaulted at Save time, so a form left blank by a FAILED config
      // read overwrote a working address with the placeholder. On that path we
      // land in the catch below, never assign, and Save is disabled anyway -
      // "we don't know what's stored" and "nothing is stored" stay distinct.
      snUrl = data.url || DEFAULT_SONARR_URL;
      snKeySet = !!data.apiKeySet;
      snTags = (data.tags ?? ['anime', 'saltychart']).join(', ');
      snMarkerTag = data.markerTag ?? 'saltychart';
      snRootFolder = data.rootFolderPath ?? '';
      snQualityProfileId = data.qualityProfileId ?? 0;
      snSeriesType = data.seriesType ?? 'standard';
      snLoadError = '';
      void loadSonarrOptions();
    } catch {
      // Same trap as the Jellyfin block: blank fields after a failed read look
      // exactly like "nothing is configured".
      snLoadError = "Couldn't load the saved Sonarr configuration - the fields below may be blank for that reason, not because nothing is saved.";
    }
  }

  /**
   * Ask Sonarr what root folders, quality profiles and tags it has.
   *
   * Separate from `loadSonarrConfig` and deliberately non-fatal: it talks to
   * Sonarr, so it fails whenever Sonarr is down, and that must not blank the
   * credentials form. A failure leaves the dropdowns showing the stored value
   * with a note, rather than an empty select that reads as "you chose nothing".
   */
  async function loadSonarrOptions() {
    snOptionsLoading = true;
    try {
      snOptions = await apiJson<NonNullable<typeof snOptions>>(
        '/api/sonarr/config/options',
        { headers: { Authorization: `Bearer ${$authToken}` } },
        { label: 'sonarr/config-options', timeoutMs: 30_000 }
      );
    } catch {
      snOptions = { ok: false, error: "Couldn't ask Sonarr for its folders and profiles." };
    } finally {
      snOptionsLoading = false;
    }
  }

  /**
   * The two pickers are only usable once Sonarr has told us what it offers.
   *
   * Both values must match Sonarr exactly - a root folder it does not have is
   * rejected at add time, which is a long way from where the typo was made - so
   * "choose from what exists" is the only safe input. Until then they are
   * disabled rather than free text.
   */
  $: snFoldersReady = !!snOptions?.ok && !!snOptions.rootFolders?.length;
  $: snProfilesReady = !!snOptions?.ok && !!snOptions.qualityProfiles?.length;

  onMount(() => {
    void loadConfig();
    void loadSonarrConfig();
  });

  async function snTestConnection() {
    snTesting = true;
    snTestResult = null;
    try {
      // Hits Sonarr's authenticated /system/status, so green proves the key is
      // accepted rather than merely that something answered on the port.
      snTestResult = await apiJson<NonNullable<typeof snTestResult>>(
        '/api/sonarr/config/test',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$authToken}` },
          body: JSON.stringify({ url: snUrl, apiKey: snKey || undefined }),
        },
        { label: 'sonarr/config-test', timeoutMs: 30_000 }
      );
      // A green test means these credentials work, so the folder and profile
      // lists can be fetched with them right now. Doing it here is what stops
      // the pickers staying greyed out until someone thinks to reload the page.
      // Save first if the URL or key changed: /config/options reads the STORED
      // config, not what is typed in the boxes.
      if (snTestResult?.ok) await loadSonarrOptions();
    } catch {
      snTestResult = { ok: false, error: "Couldn't reach the backend to run the test." };
    } finally {
      snTesting = false;
    }
  }

  async function snSave() {
    snSaving = true;
    snSaveMsg = '';
    snSaveErr = '';
    try {
      const res = await apiFetch('/api/sonarr/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$authToken}` },
        // Blank URL / key mean "keep the stored one", enforced server-side.
        body: JSON.stringify({
          url: snUrl.trim(),
          apiKey: snKey || undefined,
          tags: snTags.trim(),
          markerTag: snMarkerTag.trim(),
          rootFolderPath: snRootFolder,
          qualityProfileId: snQualityProfileId,
          seriesType: snSeriesType,
        }),
      }, { label: 'sonarr/config-save', timeoutMs: QUICK });
      const data = await res.json();
      if (res.ok) {
        snSaveMsg = 'Saved.';
        if (snKey.trim()) {
          snKeySet = true;
          snKey = '';
        }
        await loadSonarrConfig();
      } else {
        snSaveErr = data?.error ?? 'Save failed.';
      }
    } catch (e) {
      snSaveErr = (e as ApiError)?.unreachable
        ? "Couldn't reach the backend - nothing was saved."
        : 'Save failed.';
    } finally {
      snSaving = false;
    }
  }

  async function jfTestConnection() {
    jfTesting = true;
    jfTestResult = null;
    try {
      // apiJson, not bare fetch: this page is the one most likely to face an
      // unresponsive backend, and the button used to spin forever on one. The
      // test endpoint always answers 200 with { ok, ... }. 30s sits above the
      // backend's own probe timeout, so a slow Jellyfin is reported by the
      // server's answer rather than cut off by our abort.
      jfTestResult = await apiJson<NonNullable<typeof jfTestResult>>(
        '/api/jellyfin/config/test',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$authToken}` },
          body: JSON.stringify({ url: jfUrl, apiKey: jfKey || undefined }),
        },
        { label: 'jellyfin/config-test', timeoutMs: 30_000 }
      );
      // A green test means the stored credentials can reach the server, so the
      // account list is worth (re)fetching - otherwise you'd have to save and
      // reload the page before the picker had anything in it.
      if (jfTestResult?.ok) await loadUsers();
    } catch {
      jfTestResult = { ok: false, error: "Couldn't reach the backend to run the test." };
    } finally {
      jfTesting = false;
    }
  }

  async function jfSave() {
    jfSaving = true;
    jfSaveMsg = '';
    jfSaveErr = '';
    try {
      // A blank URL means "keep the stored one" - enforced SERVER-side, the
      // same way a blank key is. The old fallback chain here ended at the
      // hardcoded placeholder, so Save on a form left blank by a failed config
      // read could overwrite a working address with the default.
      const res = await apiFetch('/api/jellyfin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$authToken}` },
        // `apiKey: undefined` is the documented "keep the stored key" signal -
        // the key is never sent to the browser, so a blank box means unchanged.
        body: JSON.stringify({ url: jfUrl.trim(), apiKey: jfKey || undefined, userId: jfUserId }),
      }, { label: 'jellyfin/config-save', timeoutMs: QUICK });
      const data = await res.json();
      if (res.ok) {
        jfSaveMsg = 'Saved.';
        if (jfKey.trim()) {
          jfKeySet = true;
          jfKey = '';
        }
        // Re-read the stored config: fills a blank URL box back in with what
        // the server kept, and refreshes the picker now that /users can answer.
        await loadConfig();
      } else {
        jfSaveErr = data?.error ?? 'Save failed.';
      }
    } catch (e) {
      jfSaveErr = (e as ApiError)?.unreachable
        ? "Couldn't reach the backend - nothing was saved."
        : 'Save failed.';
    } finally {
      jfSaving = false;
    }
  }

</script>

<AdminShell current="connection">
  <!-- The frame matches the other admin tabs; only the FORM is narrow, because a
       credentials form at 1600px is unreadable. Constraining the content rather
       than the shell is what keeps the heading and tabs in the same place on
       every tab. -->
  <div class="flex flex-col gap-6 w-full max-w-2xl">
    <section class="card bg-base-100 shadow">
      <div class="card-body gap-4">
        <h2 class="card-title">Jellyfin</h2>
        <!-- Kept to one line on purpose. This is a form, not documentation:
             the two cards here were ~630px each for three inputs apiece, and
             almost all of it was prose. The full reasoning (why a playback
             account is needed at all, what burn-in costs) is in
             backend/CLAUDE.md, which is where someone changing this behaviour
             will actually be. Resist re-expanding it. -->
        <p class="text-sm opacity-70">
          Streaming and library lookups. The API key is stored server-side and never
          sent to browsers.
        </p>

        {#if jfLoadError}
          <!-- Blank fields after a failed read look exactly like "nothing is
               configured", which is the one thing this page must not imply. -->
          <div class="alert alert-warning text-sm mb-3" data-config-load-error>
            <span>{jfLoadError}</span>
            <button type="button" class="btn btn-xs btn-outline normal-case" on:click={loadConfig}>Retry</button>
          </div>
        {/if}

        <div class="grid grid-cols-[7rem,1fr] items-center gap-x-3">
          <label class="text-sm opacity-80" for="jf-url">
            <span>Server URL</span>
          </label>
          <!-- Password managers treat any text/password pair as a login form and
               offer to fill it. These are server settings, not credentials for a
               site, so opt out the same way Compare's username box does. -->
          <input
            id="jf-url"
            type="text"
            class="input input-bordered w-full"
            placeholder="http://192.168.1.2:8096"
            autocomplete="off"
            data-bwignore="true"
            data-1p-ignore="true"
            data-lpignore="true"
            bind:value={jfUrl}
          />
        </div>

        <div class="grid grid-cols-[7rem,1fr] items-center gap-x-3">
          <label class="text-sm opacity-80" for="jf-key">
            <span>API key</span>
          </label>
          <input
            id="jf-key"
            type="password"
            class="input input-bordered w-full"
            placeholder={jfKeySet ? '•••••••••• (saved - leave blank to keep)' : 'Paste a Jellyfin API key'}
            autocomplete="new-password"
            data-bwignore="true"
            data-1p-ignore="true"
            data-lpignore="true"
            bind:value={jfKey}
          />
          <div class="col-start-2">
            <span class="label-text-alt opacity-60">
              Jellyfin &rarr; Dashboard &rarr; API Keys &rarr; “+” to create one.
            </span>
          </div>
        </div>

        <div class="grid grid-cols-[7rem,1fr] items-center gap-x-3">
          <label class="text-sm opacity-80" for="jf-user">
            <span>Playback account</span>
          </label>
          <select id="jf-user" class="select select-bordered w-full" bind:value={jfUserId}>
            <option value="">Any administrator (default)</option>
            {#each jfUsers as u}
              <option value={u.id}>{u.name}{u.isAdministrator ? ' - administrator' : ''}</option>
            {/each}
          </select>
          <div class="col-start-2">
            <span class="label-text-alt opacity-60">
              Needs library access and no bitrate or rating limits; it does not
              need to be an administrator. A dedicated account keeps playback off
              a real person's profile.
            </span>
          </div>
        </div>

        <div class="card-actions items-center gap-2">
          <button class="btn btn-outline btn-sm" on:click={jfTestConnection} disabled={jfTesting}>
            {#if jfTesting}<span class="loading loading-spinner loading-xs"></span>{/if}
            Test Connection
          </button>
          <!-- Saving over a config that couldn't be read is how a placeholder
               once replaced the real URL; Retry the load first. The server-side
               keep-on-empty makes this belt-and-braces, not the only guard. -->
          <button class="btn btn-primary btn-sm" on:click={jfSave} disabled={jfSaving || !!jfLoadError}>
            {#if jfSaving}<span class="loading loading-spinner loading-xs"></span>{/if}
            Save
          </button>
          {#if jfSaveMsg}<span class="text-success text-sm">{jfSaveMsg}</span>{/if}
          {#if jfSaveErr}<span class="text-error text-sm">{jfSaveErr}</span>{/if}
        </div>

        {#if jfTestResult}
          {#if jfTestResult.ok}
            <div class="alert alert-success">
              <div>
                <p class="font-semibold">
                  Connected to “{jfTestResult.serverName}”
                  {#if jfTestResult.version}<span class="opacity-70 font-normal"> - Jellyfin {jfTestResult.version}</span>{/if}
                </p>
                <ul class="list-disc list-inside text-sm mt-1">
                  {#each jfTestResult.libraries ?? [] as lib}
                    <li>{lib.title} <span class="opacity-60">({lib.type})</span></li>
                  {/each}
                </ul>
                {#if jfTestResult.playbackAccount}
                  <p class="text-sm mt-2">
                    Playing as <span class="font-semibold">{jfTestResult.playbackAccount}</span>
                  </p>
                {/if}
              </div>
            </div>
          {:else}
            <div class="alert alert-error">
              <span>{jfTestResult.error}</span>
            </div>
          {/if}
        {/if}
      </div>
    </section>

    <section class="card bg-base-100 shadow">
      <div class="card-body gap-4">
        <h2 class="card-title">Sonarr</h2>
        <p class="text-sm opacity-70">
          Read-only. Sonarr pulls our Custom List; nothing here can add or delete a series. The
          API key is stored server-side and never sent to browsers.
        </p>

        {#if snLoadError}
          <div class="alert alert-warning text-sm mb-3" data-sonarr-config-load-error>
            <span>{snLoadError}</span>
            <button type="button" class="btn btn-xs btn-outline normal-case" on:click={loadSonarrConfig}>Retry</button>
          </div>
        {/if}

        <div class="grid grid-cols-[7rem,1fr] items-center gap-x-3">
          <label class="text-sm opacity-80" for="sn-url">
            <span>Server URL</span>
          </label>
          <!-- Same opt-out as the Jellyfin pair: password managers treat any
               text/password pair as a login form. These are server settings. -->
          <input
            id="sn-url"
            type="text"
            class="input input-bordered w-full"
            placeholder={DEFAULT_SONARR_URL}
            autocomplete="off"
            data-bwignore="true"
            data-1p-ignore="true"
            data-lpignore="true"
            bind:value={snUrl}
          />
        </div>

        <div class="grid grid-cols-[7rem,1fr] items-center gap-x-3">
          <label class="text-sm opacity-80" for="sn-key">
            <span>API key</span>
          </label>
          <input
            id="sn-key"
            type="password"
            class="input input-bordered w-full"
            placeholder={snKeySet ? '(saved - leave blank to keep)' : 'Paste a Sonarr API key'}
            autocomplete="new-password"
            data-bwignore="true"
            data-1p-ignore="true"
            data-lpignore="true"
            bind:value={snKey}
          />
          <div class="col-start-2">
            <span class="label-text-alt opacity-60">
              Sonarr &rarr; Settings &rarr; General &rarr; Security &rarr; API Key.
            </span>
          </div>
        </div>

        <div class="grid grid-cols-[7rem,1fr] items-center gap-x-3">
          <label class="text-sm opacity-80" for="sn-root">
            <span>Root folder</span>
          </label>
          <!-- Always a <select>, never a free-text fallback. The value has to
               match one of Sonarr's own paths exactly, so a box you can type
               anything into only produces a setting that fails at add time,
               a long way from where it was typed. Disabled until we have the
               real list. -->
          <div class="flex items-center gap-2">
            <select
              id="sn-root"
              class="select select-bordered w-full"
              disabled={!snFoldersReady}
              bind:value={snRootFolder}
            >
              {#if snRootFolder && !snFoldersReady}
                <!-- Keep the stored value visible while disabled: blanking it
                     would read as "nothing is configured", which is the same
                     lie the failed-config-read guard above exists to prevent. -->
                <option value={snRootFolder}>{snRootFolder}</option>
              {:else}
                <option value="">{snOptionsLoading ? 'Loading...' : 'Choose a folder'}</option>
              {/if}
              {#each snOptions?.rootFolders ?? [] as f (f.path)}
                <option value={f.path}>{f.path}</option>
              {/each}
            </select>
            {#if snOptionsLoading}
              <span class="loading loading-spinner loading-sm" aria-label="Loading folders"></span>
            {/if}
          </div>
          <div class="col-start-2">
            <span class="label-text-alt opacity-60">
              Where added series are stored. Must match one of Sonarr's own root folders exactly.
            </span>
          </div>
        </div>

        <div class="grid grid-cols-[7rem,1fr] items-center gap-x-3">
          <label class="text-sm opacity-80" for="sn-profile">
            <span>Quality profile</span>
          </label>
          <div class="flex items-center gap-2">
            <select
              id="sn-profile"
              class="select select-bordered w-full"
              disabled={!snProfilesReady}
              bind:value={snQualityProfileId}
            >
              <option value={0}>{snOptionsLoading ? 'Loading...' : 'Choose a profile'}</option>
              {#each snOptions?.qualityProfiles ?? [] as p (p.id)}
                <option value={p.id}>{p.name}</option>
              {/each}
            </select>
            {#if snOptionsLoading}
              <span class="loading loading-spinner loading-sm" aria-label="Loading profiles"></span>
            {/if}
          </div>
          <div class="col-start-2">
            <span class="label-text-alt opacity-60">
              {#if snOptionsLoading}
                Asking Sonarr what it offers...
              {:else if snOptions && !snOptions.ok}
                {snOptions.error} Press <b>Test Connection</b> once the URL and key are right - the
                folder and profile lists fill in from Sonarr itself.
              {:else}
                Applied to every series we add. Changing it later does not touch what is already
                there.
              {/if}
            </span>
          </div>
        </div>

        <div class="grid grid-cols-[7rem,1fr] items-center gap-x-3">
          <label class="text-sm opacity-80" for="sn-type">
            <span>Series type</span>
          </label>
          <select id="sn-type" class="select select-bordered w-full" bind:value={snSeriesType}>
            <option value="standard">Standard</option>
            <option value="anime">Anime</option>
          </select>
          <div class="col-start-2">
            <span class="label-text-alt opacity-60">
              How Sonarr matches releases to episodes. <b>Anime</b> enables absolute numbering; get
              this wrong and episodes download but never import.
            </span>
          </div>
        </div>

        <div class="grid grid-cols-[7rem,1fr] items-center gap-x-3">
          <label class="text-sm opacity-80" for="sn-tags">
            <span>Tags</span>
          </label>
          <input
            id="sn-tags"
            type="text"
            class="input input-bordered w-full"
            placeholder="anime, saltychart"
            autocomplete="off"
            bind:value={snTags}
          />
          <div class="col-start-2">
            <span class="label-text-alt" class:text-warning={snOptions?.missingTags?.length}
                  class:opacity-60={!snOptions?.missingTags?.length}>
              {#if snOptions?.missingTags?.length}
                Sonarr has no tag called {snOptions.missingTags.join(' or ')} - create it there
                first, or nothing will be added.
              {:else}
                Applied to every series we add. Each must already exist in Sonarr; we never create
                tags.
              {/if}
            </span>
          </div>
        </div>

        <div class="grid grid-cols-[7rem,1fr] items-center gap-x-3">
          <label class="text-sm opacity-80" for="sn-marker">
            <span>Marker tag</span>
          </label>
          <input
            id="sn-marker"
            type="text"
            class="input input-bordered w-full"
            placeholder="saltychart"
            autocomplete="off"
            bind:value={snMarkerTag}
          />
          <div class="col-start-2">
            <span class="label-text-alt opacity-60">
              The one tag that means <em>we</em> added it - what Maintainerr scopes on, and a record
              that survives losing the database. Always applied, whether or not it is listed above.
              Keep it dedicated: a shared tag like <code>anime</code> would mark most of your
              library as ours.
            </span>
          </div>
        </div>

        <div class="card-actions items-center gap-2">
          <button class="btn btn-outline btn-sm" on:click={snTestConnection} disabled={snTesting}>
            {#if snTesting}<span class="loading loading-spinner loading-xs"></span>{/if}
            Test Connection
          </button>
          <button class="btn btn-primary btn-sm" on:click={snSave} disabled={snSaving || !!snLoadError}>
            {#if snSaving}<span class="loading loading-spinner loading-xs"></span>{/if}
            Save
          </button>
          {#if snSaveMsg}<span class="text-success text-sm">{snSaveMsg}</span>{/if}
          {#if snSaveErr}<span class="text-error text-sm">{snSaveErr}</span>{/if}
        </div>

        {#if snTestResult}
          {#if snTestResult.ok}
            <div class="alert alert-success">
              <!-- The version span carries its own leading nbsp: Svelte trims
                   the whitespace between the text and the tag, which rendered
                   as "Connected to Sonarr- version 4.0.19". -->
              <span>
                Connected to Sonarr{#if snTestResult.version}<span class="opacity-70">&nbsp;- version {snTestResult.version}</span>{/if}
              </span>
            </div>
          {:else}
            <div class="alert alert-error"><span>{snTestResult.error}</span></div>
          {/if}
        {/if}
      </div>
    </section>
  </div>
</AdminShell>
