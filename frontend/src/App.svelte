<script lang="ts">
  // Pages are lazy-loaded so the initial bundle stays small
  let Home: any;
  let Login: any;
  let SignUp: any;
  let Randomize: any;
  let Compare: any;
import { authToken, userName } from './stores/auth';
import OptionsModal from './components/OptionsModal.svelte';
import { options } from './stores/options';

  // simple client-side router using location.pathname
  import { onMount } from 'svelte';

  let route = window.location.pathname;

  let Page: any = null;
  let showOptions = false;
// Apply theme by setting data-theme or class on document <html>
$: {
  const t = $options.theme;
  if (t === 'SYSTEM') {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.classList.remove('high-contrast');
  } else if (t === 'HIGH_CONTRAST') {
    // use light base theme with high-contrast class
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.classList.add('high-contrast');
  } else {
    document.documentElement.setAttribute('data-theme', t.toLowerCase());
    document.documentElement.classList.remove('high-contrast');
  }
}

  onMount(() => {
    window.addEventListener('popstate', () => (route = window.location.pathname));
  });

  function goto(path: string) {
    if (route === path) return;
    history.pushState({}, '', path);
    route = path;
  }

  async function loadPage(path: string) {
    switch (path) {
      case '/login':
        Login = Login || (await import('./pages/Login.svelte')).default;
        return Login;
      case '/signup':
        SignUp = SignUp || (await import('./pages/SignUp.svelte')).default;
        return SignUp;
      case '/random':
        Randomize = Randomize || (await import('./pages/Randomize.svelte')).default;
        return Randomize;
      case '/compare':
        Compare = Compare || (await import('./pages/Compare.svelte')).default;
        return Compare;
      default:
        Home = Home || (await import('./pages/Home.svelte')).default;
        return Home;
    }
  }

  $: (async () => {
    Page = await loadPage(route);
  })();
</script>

  <!-- Header layout: logo left, actions right, primary navigation hard-centered -->
  <header class="relative flex items-center justify-between p-4 w-full md:w-3/4 mx-auto">
  <!-- Logo / Home link -->
  <h1 class="text-3xl font-bold">
    <a
      href="/"
      class="cursor-pointer"
      on:click|preventDefault={() => goto('/')}
    >
      SaltyChart
    </a>
  </h1>

  <!-- Centered primary nav.  Using absolute + translate to stay centred regardless
       of variable logo / actions widths. -->
  <nav class="absolute left-1/2 -translate-x-1/2 flex items-center gap-6 text-lg pointer-events-none">
    <a
      href="/"
      class="link pointer-events-auto" class:font-bold={route === '/'} class:text-primary={route === '/'}
      on:click|preventDefault={() => goto('/')}
    >
      Anime
    </a>
    {#if $authToken}
      <a
        href="/random"
        class="link pointer-events-auto" class:font-bold={route === '/random'} class:text-primary={route === '/random'}
        on:click|preventDefault={() => goto('/random')}
      >
        Randomize
      </a>
      <a
        href="/compare"
        class="link pointer-events-auto" class:font-bold={route === '/compare'} class:text-primary={route === '/compare'}
        on:click|preventDefault={() => goto('/compare')}
      >
        Compare
      </a>
    {/if}
  </nav>

  <div class="flex items-center gap-4">
    <!-- Options icon -->
    <button
      type="button"
      class="btn btn-ghost btn-sm p-1"
      aria-label="Options"
      on:click={() => (showOptions = true)}
    >
      <span class="material-icons text-xl" aria-hidden="true">settings</span>
    </button>
    {#if $authToken}
      <span>{$userName}</span>
      <button
        type="button"
        class="link"
        on:click={() => {
          authToken.set(null);
          userName.set(null);
        }}
      >
        Logout
      </button>
    {:else}
      <a
        href="/login"
        class="link"
        on:click|preventDefault={() => goto('/login')}
      >
        Login
      </a>
      <a
        href="/signup"
        class="link"
        on:click|preventDefault={() => goto('/signup')}
      >
        Sign Up
      </a>
    {/if}
  </div>
</header>

{#if Page}
  <svelte:component this={Page} />
{/if}

<!-- Options Modal -->
<OptionsModal bind:open={showOptions} />
