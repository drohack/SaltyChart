<script lang="ts">
  import { onMount } from 'svelte';
  import { authToken } from '../stores/auth';
  import { isAdmin } from '../stores/jellyfin';
  import { apiJson, QUICK } from '../lib/remote';
  import AdminTabs from '../components/AdminTabs.svelte';

  // ── Jellyfin config ─────────────────────────────────────────────────
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

  /** Shown as the URL placeholder, and used when the box is left blank. */
  const DEFAULT_JF_URL = 'http://192.168.1.2:8096';
  /** Last saved URL, so a blank box can fall back to it rather than clearing. */
  let jfStoredUrl = '';

  /** Set when the saved config couldn't be read — distinct from "nothing saved". */
  let jfLoadError = '';

  async function loadConfig() {
    if (!$authToken) return;
    const auth = { Authorization: `Bearer ${$authToken}` };
    // One `catch {}` used to wrap this *and* loadUsers, so any failure rendered
    // as empty fields and an empty account picker — i.e. "nothing is
    // configured", on the page whose entire job is showing what is configured.
    try {
      const data = await apiJson<any>('/api/jellyfin/config', { headers: auth },
                                      { label: 'jellyfin/config', timeoutMs: QUICK });
      jfStoredUrl = data.url ?? '';
      jfUrl = jfStoredUrl;
      jfKeySet = !!data.apiKeySet;
      jfUserId = data.userId ?? '';
      jfLoadError = '';
    } catch {
      jfLoadError = "Couldn't load the saved configuration — the fields below may be blank for that reason, not because nothing is saved.";
    }
    await loadUsers();
  }

  /**
   * The playback-account picker.
   *
   * Split out because it needs re-running after Test and after Save, not only on
   * mount: `/api/jellyfin/users` reads the *stored* config, so on a first setup
   * (or after correcting a bad URL/key) the mount-time call returns nothing and
   * the picker sits empty with no way to choose an account — which is the one
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

  onMount(loadConfig);

  async function jfTestConnection() {
    jfTesting = true;
    jfTestResult = null;
    try {
      const res = await fetch('/api/jellyfin/config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$authToken}` },
        body: JSON.stringify({ url: jfUrl, apiKey: jfKey || undefined }),
      });
      jfTestResult = await res.json();
      // A green test means the stored credentials can reach the server, so the
      // account list is worth (re)fetching — otherwise you'd have to save and
      // reload the page before the picker had anything in it.
      if (jfTestResult?.ok) await loadUsers();
    } catch {
      jfTestResult = { ok: false, error: 'Request failed — is the backend up?' };
    } finally {
      jfTesting = false;
    }
  }

  async function jfSave() {
    jfSaving = true;
    jfSaveMsg = '';
    jfSaveErr = '';
    try {
      // A blank URL means "I didn't touch this", not "clear it" — saving to
      // change only the playback account should not wipe the server address.
      // Fall back to whatever is stored, then to the placeholder default.
      const url = jfUrl.trim() || jfStoredUrl || DEFAULT_JF_URL;
      jfUrl = url;
      const res = await fetch('/api/jellyfin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$authToken}` },
        // `apiKey: undefined` is the documented "keep the stored key" signal —
        // the key is never sent to the browser, so a blank box means unchanged.
        body: JSON.stringify({ url, apiKey: jfKey || undefined, userId: jfUserId }),
      });
      const data = await res.json();
      if (res.ok) {
        jfSaveMsg = 'Saved.';
        if (jfKey.trim()) {
          jfKeySet = true;
          jfKey = '';
        }
        // Now that the URL/key are stored, /users can actually answer — so the
        // picker fills in without a page reload and the account can be chosen.
        await loadUsers();
      } else {
        jfSaveErr = data?.error ?? 'Save failed.';
      }
    } catch {
      jfSaveErr = 'Network error.';
    } finally {
      jfSaving = false;
    }
  }

</script>

<main class="max-w-2xl mx-auto px-4 flex flex-col gap-6">
  <h1 class="text-2xl font-bold">Admin</h1>
  <AdminTabs current="connection" />

  {#if !$authToken || $isAdmin === false}
    <div class="alert alert-warning">
      <span>This page is only available to the site admin.</span>
    </div>
  {:else}
    <section class="card bg-base-100 shadow">
      <div class="card-body gap-4">
        <h2 class="card-title">Jellyfin</h2>
        <p class="text-sm opacity-70">
          Where SaltyChart streams episodes from, and where it looks up
          whether a show is in your library. It also burns the episode's
          subtitles into the video, so they arrive already rendered. The API key
          is stored server-side and never sent to browsers.
        </p>

        {#if jfLoadError}
          <!-- Blank fields after a failed read look exactly like "nothing is
               configured", which is the one thing this page must not imply. -->
          <div class="alert alert-warning text-sm mb-3" data-config-load-error>
            <span>{jfLoadError}</span>
            <button type="button" class="btn btn-xs btn-outline normal-case" on:click={loadConfig}>Retry</button>
          </div>
        {/if}

        <div class="form-control">
          <label class="label" for="jf-url">
            <span class="label-text">Server URL</span>
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

        <div class="form-control">
          <label class="label" for="jf-key">
            <span class="label-text">API key</span>
          </label>
          <input
            id="jf-key"
            type="password"
            class="input input-bordered w-full"
            placeholder={jfKeySet ? '•••••••••• (saved — leave blank to keep)' : 'Paste a Jellyfin API key'}
            autocomplete="new-password"
            data-bwignore="true"
            data-1p-ignore="true"
            data-lpignore="true"
            bind:value={jfKey}
          />
          <div class="label">
            <span class="label-text-alt opacity-60">
              Jellyfin → Dashboard → API Keys → “+” to create one.
            </span>
          </div>
        </div>

        <div class="form-control">
          <label class="label" for="jf-user">
            <span class="label-text">Playback account</span>
          </label>
          <select id="jf-user" class="select select-bordered w-full" bind:value={jfUserId}>
            <option value="">Any administrator (default)</option>
            {#each jfUsers as u}
              <option value={u.id}>{u.name}{u.isAdministrator ? ' — administrator' : ''}</option>
            {/each}
          </select>
          <div class="label">
            <span class="label-text-alt opacity-60">
              Jellyfin applies its policy per account, so streaming needs one.
              A dedicated account keeps playback off a real person's profile and
              stops a later policy change quietly degrading it for everyone. It
              needs library access and no bitrate or rating limit; it does not
              need to be an administrator. Nothing is written to its watch
              history either way — SaltyChart never reports progress.
            </span>
          </div>
        </div>

        <div class="card-actions items-center gap-2">
          <button class="btn btn-outline btn-sm" on:click={jfTestConnection} disabled={jfTesting}>
            {#if jfTesting}<span class="loading loading-spinner loading-xs"></span>{/if}
            Test Connection
          </button>
          <button class="btn btn-primary btn-sm" on:click={jfSave} disabled={jfSaving}>
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
                  {#if jfTestResult.version}<span class="opacity-70 font-normal"> — Jellyfin {jfTestResult.version}</span>{/if}
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
  {/if}
</main>
