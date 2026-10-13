<script lang="ts">
import { authToken, userName } from '../stores/auth';
import { apiFetch, QUICK } from '../lib/remote';
import { options } from '../stores/options';
import { get } from 'svelte/store';

  let username = '';
  let password = '';
  let error = '';

  let userInput: HTMLInputElement;
  import { onMount } from 'svelte';
  onMount(() => userInput?.focus());

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
      const res = await apiFetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      }, { timeoutMs: QUICK, retries: 0, label: 'signup' });
      data = await res.json().catch(() => null);
      if (!res.ok) {
        error = data?.error || `Sign-up failed (the server answered ${res.status})`;
        return;
      }
    } catch (err: any) {
      error = err?.unreachable
        ? "Couldn't reach the server - check your connection and try again."
        : 'Sign-up failed - please try again.';
      return;
    } finally {
      busy = false;
    }

    // Carry the choices made as a guest onto the new account, BEFORE the token
    // lands. Setting the token makes the options store fetch this account's row -
    // freshly created defaults - and adopt them, so someone who picked a dark
    // theme while browsing had it silently reverted the moment they signed up,
    // with localStorage still claiming their choice for good afterwards.
    //
    // "The server wins" is right for a login (a new device should not overwrite
    // your account), but a brand-new account has no preferences yet, so there is
    // nothing to defer to. This is the one moment that distinction is knowable.
    //
    // Awaited rather than fired alongside: the store's GET is triggered by
    // `authToken.set` below, so a PUT racing it would land after the defaults had
    // already been read and applied. A failure is not fatal - the account exists
    // and the user just gets defaults, exactly as before.
    try {
      const saved = await fetch('/api/options', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${data.token}`
        },
        body: JSON.stringify(get(options))
      });
      if (!saved.ok) {
        console.warn('[signup] could not carry guest options over:', saved.status);
      }
    } catch (err) {
      console.warn('[signup] could not carry guest options over:', err);
    }

    authToken.set(data.token);
    userName.set(data.username);
    window.history.pushState({}, '', '/');
    dispatchEvent(new PopStateEvent('popstate'));
  }
</script>

<form on:submit|preventDefault={submit} class="max-w-sm mx-auto my-20 p-6 shadow rounded bg-base-200 space-y-4">
  <h2 class="text-xl font-bold text-center">Sign Up</h2>
  {#if error}
    <div class="text-error text-sm">{error}</div>
  {/if}
  <input bind:this={userInput} class="input w-full" placeholder="Username" bind:value={username} />
  <input class="input w-full" type="password" placeholder="Password" bind:value={password} />
  <button class="btn btn-primary w-full" type="submit" disabled={busy}>Create Account</button>
  <p class="text-sm text-center">Already have an account? <a href="/login" class="link" on:click|preventDefault={() => { window.history.pushState({}, '', '/login'); dispatchEvent(new PopStateEvent('popstate')); }}>Log in here</a></p>
</form>
