<script lang="ts">
  import { onMount } from 'svelte';
  import { authToken } from '../stores/auth';
  import { isAdmin } from '../stores/jellyfin';

  // ── Plex integration config ─────────────────────────────────────────
  let url = '';
  let token = '';
  let tokenSet = false;
  let saving = false;
  let testing = false;
  let saveMsg = '';
  let saveErr = '';
  let testResult:
    | {
        ok: boolean;
        error?: string;
        serverName?: string;
        machineIdentifier?: string;
        libraries?: { title: string; type: string }[];
      }
    | null = null;

  // ── Jellyfin config ─────────────────────────────────────────────────
  // Separate server, separate credentials. Unlike Plex, Jellyfin exposes
  // subtitle tracks (and the MKV's embedded fonts) as a real API, so having
  // this configured lets that be measured against the actual library.
  let jfUrl = '';
  let jfKey = '';
  let jfKeySet = false;
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
      }
    | null = null;

  async function loadConfig() {
    if (!$authToken) return;
    const auth = { Authorization: `Bearer ${$authToken}` };
    try {
      const res = await fetch('/api/plex/config', { headers: auth });
      if (res.ok) {
        const data = await res.json();
        url = data.url ?? '';
        tokenSet = !!data.tokenSet;
      }
    } catch {}
    try {
      const res = await fetch('/api/jellyfin/config', { headers: auth });
      if (res.ok) {
        const data = await res.json();
        jfUrl = data.url ?? '';
        jfKeySet = !!data.apiKeySet;
      }
    } catch {}
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
      const res = await fetch('/api/jellyfin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$authToken}` },
        body: JSON.stringify({ url: jfUrl, apiKey: jfKey || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        jfSaveMsg = 'Saved.';
        if (jfKey.trim()) {
          jfKeySet = true;
          jfKey = '';
        }
      } else {
        jfSaveErr = data?.error ?? 'Save failed.';
      }
    } catch {
      jfSaveErr = 'Network error.';
    } finally {
      jfSaving = false;
    }
  }

  async function testConnection() {
    testing = true;
    testResult = null;
    try {
      const res = await fetch('/api/plex/config/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${$authToken}`,
        },
        // Empty fields fall back to the stored values server-side, so the
        // admin can test a new URL against the already-saved token.
        body: JSON.stringify({ url, token: token || undefined }),
      });
      testResult = await res.json();
    } catch {
      testResult = { ok: false, error: 'Request failed — is the backend up?' };
    } finally {
      testing = false;
    }
  }

  async function save() {
    saving = true;
    saveMsg = '';
    saveErr = '';
    try {
      const res = await fetch('/api/plex/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${$authToken}`,
        },
        body: JSON.stringify({ url, token: token || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        saveMsg = 'Saved.';
        if (token.trim()) {
          tokenSet = true;
          token = '';
        }
      } else {
        saveErr = data?.error ?? 'Save failed.';
      }
    } catch {
      saveErr = 'Network error.';
    } finally {
      saving = false;
    }
  }
</script>

<main class="max-w-2xl mx-auto px-4 flex flex-col gap-6">
  <h1 class="text-2xl font-bold">Admin</h1>

  {#if !$authToken || $isAdmin === false}
    <div class="alert alert-warning">
      <span>This page is only available to the site admin.</span>
    </div>
  {:else}
    <section class="card bg-base-100 shadow">
      <div class="card-body gap-4">
        <h2 class="card-title">Plex integration</h2>
        <p class="text-sm opacity-70">
          Point SaltyChart at your Plex server to get "Watch on Plex" links and
          in-page playback on the Randomize page. The token is stored
          server-side and never sent to browsers.
        </p>

        <div class="form-control">
          <label class="label" for="plex-url">
            <span class="label-text">Server URL</span>
          </label>
          <input
            id="plex-url"
            type="text"
            class="input input-bordered w-full"
            placeholder="http://192.168.1.2:32400"
            bind:value={url}
          />
        </div>

        <div class="form-control">
          <label class="label" for="plex-token">
            <span class="label-text">X-Plex-Token</span>
          </label>
          <input
            id="plex-token"
            type="password"
            class="input input-bordered w-full"
            placeholder={tokenSet ? '•••••••••• (saved — leave blank to keep)' : 'Paste your Plex token'}
            bind:value={token}
          />
          <div class="label">
            <span class="label-text-alt opacity-60">
              Find it via Plex Web → play something → ⋯ → Get Info → View XML →
              the X-Plex-Token query param in that page's URL.
            </span>
          </div>
        </div>

        <div class="card-actions items-center gap-2">
          <button class="btn btn-outline btn-sm" on:click={testConnection} disabled={testing}>
            {#if testing}<span class="loading loading-spinner loading-xs"></span>{/if}
            Test Connection
          </button>
          <button class="btn btn-primary btn-sm" on:click={save} disabled={saving}>
            {#if saving}<span class="loading loading-spinner loading-xs"></span>{/if}
            Save
          </button>
          {#if saveMsg}<span class="text-success text-sm">{saveMsg}</span>{/if}
          {#if saveErr}<span class="text-error text-sm">{saveErr}</span>{/if}
        </div>

        {#if testResult}
          {#if testResult.ok}
            <div class="alert alert-success">
              <div>
                <p class="font-semibold">Connected to “{testResult.serverName}”</p>
                <ul class="list-disc list-inside text-sm mt-1">
                  {#each testResult.libraries ?? [] as lib}
                    <li>{lib.title} <span class="opacity-60">({lib.type})</span></li>
                  {/each}
                </ul>
              </div>
            </div>
          {:else}
            <div class="alert alert-error">
              <span>{testResult.error}</span>
            </div>
          {/if}
        {/if}
      </div>
    </section>

    <section class="card bg-base-100 shadow">
      <div class="card-body gap-4">
        <h2 class="card-title">Jellyfin</h2>
        <p class="text-sm opacity-70">
          Optional second media server. Jellyfin serves subtitle tracks (and a
          file's embedded fonts) directly, which Plex has no endpoint for — so
          this can replace reading whole episode files just to pull subtitles
          out. The API key is stored server-side and never sent to browsers.
        </p>

        <div class="form-control">
          <label class="label" for="jf-url">
            <span class="label-text">Server URL</span>
          </label>
          <input
            id="jf-url"
            type="text"
            class="input input-bordered w-full"
            placeholder="http://192.168.1.2:8096"
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
            bind:value={jfKey}
          />
          <div class="label">
            <span class="label-text-alt opacity-60">
              Jellyfin → Dashboard → API Keys → “+” to create one.
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
