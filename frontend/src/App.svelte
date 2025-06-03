<script lang="ts">
  // Pages are lazy-loaded so the initial bundle stays small
  let Home: any;
  let Login: any;
  let SignUp: any;
  let Randomize: any;
import { authToken, userName } from './stores/auth';

  // simple client-side router using location.pathname
  import { onMount } from 'svelte';

  let route = window.location.pathname;

  let Page: any = null;

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
      default:
        Home = Home || (await import('./pages/Home.svelte')).default;
        return Home;
    }
  }

  $: (async () => {
    Page = await loadPage(route);
  })();
</script>

<header class="flex justify-between items-center p-4 w-full md:w-3/4 mx-auto">
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

  <nav class="flex items-center gap-6 text-lg">
    <a href="/" class="link" on:click|preventDefault={() => goto('/')}>Anime</a>
    {#if $authToken}
      <a href="/random" class="link" on:click|preventDefault={() => goto('/random')}>Randomize</a>
    {/if}
  </nav>

  <div class="flex items-center gap-4">
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
