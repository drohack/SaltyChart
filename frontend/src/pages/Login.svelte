<script lang="ts">
import { authToken, userName } from '../stores/auth';
import { apiFetch, QUICK } from '../lib/remote';

  let username = '';
  let password = '';
  let error = '';

  let userInput: HTMLInputElement;

  import { onMount } from 'svelte';
  onMount(() => {
    userInput?.focus();
  });

  let busy = false;

  async function submit() {
    if (busy) return;
    error = '';
    busy = true;
    let data: any;
    // Bounded and caught: a bare fetch here meant a backend that was down (or a
    // proxy's HTML 502, which `res.json()` cannot parse) produced an unhandled
    // rejection and NOTHING on screen - the button just did nothing.
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      }, { timeoutMs: QUICK, retries: 0, label: 'login' });
      data = await res.json().catch(() => null);
      if (!res.ok) {
        error = data?.error || `Login failed (the server answered ${res.status})`;
        return;
      }
    } catch (err: any) {
      error = err?.unreachable
        ? "Couldn't reach the server - check your connection and try again."
        : 'Login failed - please try again.';
      return;
    } finally {
      busy = false;
    }
    authToken.set(data.token);
    userName.set(data.username);
    // Navigate home
    window.history.pushState({}, '', '/');
    const navEvent = new PopStateEvent('popstate');
    dispatchEvent(navEvent);
  }
</script>

<form on:submit|preventDefault={submit} class="max-w-sm mx-auto my-20 p-6 shadow rounded bg-base-200 space-y-4">
  <h2 class="text-xl font-bold text-center">Login</h2>
  {#if error}
    <div class="text-error text-sm">{error}</div>
  {/if}
  <input bind:this={userInput} class="input w-full" placeholder="Username" bind:value={username} />
  <input class="input w-full" type="password" placeholder="Password" bind:value={password} />
  <button class="btn btn-primary w-full" type="submit" disabled={busy}>Login</button>
  <div class="text-sm text-center space-y-1">
    <p>Don't have an account? <a href="/signup" class="link" on:click|preventDefault={() => { window.history.pushState({}, '', '/signup'); dispatchEvent(new PopStateEvent('popstate')); }}>Sign up here</a></p>
    <p>Forgot your password? <a href="/reset-password" class="link" on:click|preventDefault={() => { window.history.pushState({}, '', '/reset-password'); dispatchEvent(new PopStateEvent('popstate')); }}>Reset it here</a></p>
  </div>
</form>
