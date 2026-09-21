<script lang="ts">
  /**
   * /admin/status - is every upstream service actually answering us?
   *
   * WHY THIS PAGE EXISTS. In one week two third-party services changed and
   * broke silently: YouTube stopped serving unbounded media requests (four
   * weeks of failed trailer downloads, reported as success), and skyhook began
   * answering 400 to our User-Agent (the whole TVDB tier dead, and a bare
   * `catch` cached the empty result). Both were found by hand, months and weeks
   * late. This page is where "could not ask" stops looking like "nothing to do".
   *
   * THE RULE IT LIVES BY: the verdict comes from the server (`stateOf` in
   * lib/upstreamHealth.ts). This file renders a verdict, it never computes one -
   * so the page and the alert email can never disagree. Two of the five states
   * exist only to stop a reader being misled, and both are rendered as
   * themselves rather than folded into OK: `unknown` ("we have not asked yet")
   * and `notConfigured` ("nobody set this up"). Rendering either as green is
   * the same mistake as an unreachable Sonarr reading "0 still to add".
   */
  import { onMount } from 'svelte';
  import AdminShell from '../components/AdminShell.svelte';
  import { authToken } from '../stores/auth';
  import { ApiError, QUICK, apiFetch, apiJson } from '../lib/remote';

  type State = 'ok' | 'failing' | 'down' | 'unknown' | 'notConfigured';

  interface Service {
    id: string;
    label: string;
    impact: string;
    adminPath: string | null;
    brokenAfter: number;
    probed: boolean;
    passiveOnly: boolean;
    alertsEnabled: boolean;
    state: State;
    lastOkAt: string | null;
    lastFailAt: string | null;
    lastFailReason: string | null;
    lastFailStatus: number | null;
    consecutiveFailures: number;
    okCount: number;
    failCount: number;
    lastCheckedAt: string | null;
    lastSkipped: string | null;
  }

  interface Settings {
    masterEnabled: boolean;
    perService: Record<string, boolean>;
    extraRecipients: string[];
  }

  interface Report {
    services: Service[];
    settings: Settings;
    /**
     * The first admin with a VERIFIED address - derived, never configured.
     * `null` means no admin has one, which means alerts reach nobody; that has
     * to be visible, because "alerting is on" and "an alert will arrive" are
     * different claims and only the second one matters.
     */
    owner: string | null;
    smtpConfigured: boolean;
    generatedAt: string;
  }

  /**
   * Every state gets a visible badge, including the settled ones, and each
   * carries a `title` that explains it - the /admin/sonarr lesson, where
   * badging only the interesting rows left a table that read as mostly
   * rendering failures.
   */
  const STATE: Record<State, { label: string; cls: string; help: string }> = {
    ok: {
      label: 'OK',
      cls: 'badge-success',
      help: 'The last check succeeded.',
    },
    failing: {
      label: 'Failing',
      cls: 'badge-warning',
      help: 'Calls are failing, but something succeeded recently - a flaky service '
          + 'mid-burst, not an outage. It turns red once nothing has worked for a while.',
    },
    down: {
      label: 'Down',
      cls: 'badge-error',
      help: 'Enough consecutive failures AND nothing has worked for long enough to '
          + 'be sure. One email goes out at this point, not one per failure.',
    },
    unknown: {
      label: 'Not checked',
      cls: 'badge-outline opacity-70',
      help: 'Nothing has asked this service yet. This is NOT the same as working - it means we do not know.',
    },
    notConfigured: {
      label: 'Not set up',
      cls: 'badge-ghost opacity-60',
      help: 'This service has no configuration, so there is nothing to check. Deliberate, not a fault.',
    },
  };

  let report: Report | null = null;
  let loading = true;
  let loadError = '';
  let notice = '';

  // Alert settings, edited locally and saved as a block.
  let masterEnabled = true;
  let silenced: Record<string, boolean> = {};
  let extraText = '';
  let saving = false;
  let saveMsg = '';
  let saveErr = '';

  let probing = false;
  let testing = false;
  let testResult: { ok: boolean; error?: string } | null = null;

  $: auth = { Authorization: `Bearer ${$authToken}` };

  function fromSettings(s: Settings) {
    masterEnabled = s.masterEnabled;
    silenced = { ...s.perService };
    extraText = s.extraRecipients.join('\n');
  }

  async function load() {
    if (!$authToken) return;
    loading = true;
    loadError = '';
    try {
      report = await apiJson<Report>('/api/status/report', { headers: auth }, {
        timeoutMs: QUICK,
        label: 'status-report',
      });
      fromSettings(report.settings);
    } catch (e) {
      // "Couldn't reach it" and "it said no" are different problems on a page
      // whose entire job is telling you which is which.
      loadError = e instanceof ApiError && e.unreachable
        ? "Couldn't reach the backend, so this page cannot say anything about the other services either."
        : 'Could not load the service status.';
    } finally {
      loading = false;
    }
  }

  async function save() {
    saving = true;
    saveMsg = '';
    saveErr = '';
    try {
      const extraRecipients = extraText
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const perService: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(silenced)) if (v === false) perService[k] = false;
      const res = await apiFetch('/api/status/alerts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ masterEnabled, perService, extraRecipients }),
      }, { timeoutMs: QUICK, label: 'status-alerts-save' });
      const data = await res.json();
      if (res.ok) {
        saveMsg = 'Saved.';
        // Echo back what was STORED, not what was typed: an address the server
        // dropped must disappear from the box, or the page lies about its state.
        if (data?.settings) fromSettings(data.settings);
        await load();
      } else {
        saveErr = data?.error ?? 'Save failed.';
      }
    } catch (e) {
      saveErr = (e as ApiError)?.unreachable
        ? "Couldn't reach the backend - nothing was saved."
        : 'Save failed.';
    } finally {
      saving = false;
    }
  }

  async function checkNow() {
    probing = true;
    notice = '';
    try {
      // Waits on third parties, so a longer timeout than QUICK and no retry -
      // re-running probes is not free for the services being probed.
      const data = await apiJson<{ summary: string }>('/api/status/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: '{}',
      }, { timeoutMs: 60_000, retries: 0, label: 'status-probe' });
      notice = data.summary ?? 'Checks finished.';
      await load();
    } catch (e) {
      notice = (e as ApiError)?.unreachable
        ? "Couldn't reach the backend to run the checks."
        : 'The checks could not be run.';
    } finally {
      probing = false;
    }
  }

  async function sendTest() {
    testing = true;
    testResult = null;
    try {
      const res = await apiFetch('/api/admin/users/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({}),
      }, { timeoutMs: 30_000, retries: 0, label: 'status-test-email' });
      testResult = await res.json();
    } catch {
      testResult = { ok: false, error: "Couldn't reach the backend to send a test." };
    } finally {
      testing = false;
    }
  }

  /**
   * Lives here, not inline in the markup: `lang="ts"` applies to this block
   * only - a template expression is parsed as plain JavaScript, so a TypeScript
   * cast inside one is a syntax error rather than a type error.
   */
  function setServiceAlerts(id: string, on: boolean) {
    silenced = { ...silenced, [id]: on };
  }

  function when(iso: string | null): string {
    if (!iso) return 'never';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleString();
  }

  function ago(iso: string | null): string {
    if (!iso) return 'never';
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return 'unknown';
    const mins = Math.round(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  // Actionable rows first, then the ones that need a human eye, then the quiet
  // ones - the same ordering /admin/sonarr uses.
  const ORDER: State[] = ['down', 'failing', 'unknown', 'ok', 'notConfigured'];
  $: rows = report ? [...report.services].sort(
    (a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.label.localeCompare(b.label),
  ) : [];
  $: downCount = rows.filter((r) => r.state === 'down').length;
  $: smtpDown = rows.some((r) => r.id === 'smtp' && r.state === 'down');

  onMount(load);
</script>

<AdminShell current="status">
  {#if loading && !report}
    <p class="opacity-70">Loading service status...</p>
  {:else if loadError}
    <div class="alert alert-error">
      <span>{loadError}</span>
      <button class="btn btn-sm btn-outline" on:click={load}>Retry</button>
    </div>
  {:else if report}
    {#if notice}
      <div class="alert alert-info py-2">
        <span class="text-sm">{notice}</span>
        <button class="btn btn-xs btn-outline" on:click={() => (notice = '')}>Dismiss</button>
      </div>
    {/if}

    {#if downCount > 0}
      <div class="alert alert-error">
        <div>
          <h3 class="font-semibold">
            {downCount} service{downCount === 1 ? ' is' : 's are'} not responding
          </h3>
          <p class="text-sm">
            A status code like 400 or 403 usually means the service changed what it accepts,
            not that it is offline. The rows below carry the exact reason.
          </p>
        </div>
      </div>
    {/if}

    {#if smtpDown}
      <div class="alert alert-warning">
        <div>
          <h3 class="font-semibold">Email is down, so alerts cannot be delivered</h3>
          <p class="text-sm">
            Nothing can email you to say that email is broken. That is why this page shows it
            directly - while this row is red, treat the absence of alerts as meaningless.
          </p>
        </div>
      </div>
    {/if}

    {#if !report.smtpConfigured}
      <div class="alert alert-warning py-2">
        <span class="text-sm">
          SMTP is not configured on the server, so no alert can be sent. Set SMTP_HOST, SMTP_USER
          and SMTP_PASS in the backend environment. Everything below is still recorded.
        </span>
      </div>
    {/if}

    <section class="flex flex-col gap-2">
      <div class="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 class="text-lg font-semibold mb-1">Upstream services</h2>
          <p class="text-sm opacity-70">
            Recorded from real traffic as it happens, plus a daily check so a service nobody has
            used still reports. Checked {ago(report.generatedAt)}.
          </p>
        </div>
        <button class="btn btn-outline btn-sm" on:click={checkNow} disabled={probing}>
          {#if probing}<span class="loading loading-spinner loading-xs"></span>{/if}
          Check now
        </button>
      </div>

      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr>
              <th>Service</th>
              <th>State</th>
              <th>Last success</th>
              <th>Last failure</th>
              <th class="text-right">Alerts</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as s (s.id)}
              <tr>
                <td>
                  <div class="font-medium">{s.label}</div>
                  <div class="text-xs opacity-60 max-w-[34rem]">{s.impact}</div>
                  {#if s.adminPath}
                    <a class="link link-primary text-xs" href={s.adminPath}>{s.adminPath}</a>
                  {/if}
                </td>
                <td class="whitespace-nowrap">
                  <span class="badge badge-sm {STATE[s.state].cls}" title={STATE[s.state].help}>
                    {STATE[s.state].label}
                  </span>
                  {#if s.state === 'failing' || s.state === 'down'}
                    <div class="text-xs opacity-70">
                      {s.consecutiveFailures} in a row (down at {s.brokenAfter})
                    </div>
                  {/if}
                  {#if s.state === 'unknown' && !s.probed}
                    <div class="text-xs opacity-70">no check of its own; waits for real traffic</div>
                  {/if}
                  {#if s.lastSkipped}
                    <div class="text-xs opacity-70">{s.lastSkipped}</div>
                  {/if}
                </td>
                <td class="whitespace-nowrap text-sm" title={when(s.lastOkAt)}>{ago(s.lastOkAt)}</td>
                <td class="text-sm">
                  {#if s.lastFailAt}
                    <div class="whitespace-nowrap" title={when(s.lastFailAt)}>{ago(s.lastFailAt)}</div>
                    {#if s.lastFailReason}
                      <div class="font-mono text-xs opacity-80 max-w-[28rem] break-words">
                        {#if s.lastFailStatus}HTTP {s.lastFailStatus} - {/if}{s.lastFailReason}
                      </div>
                    {/if}
                  {:else}
                    <span class="opacity-60">never</span>
                  {/if}
                </td>
                <td class="text-right whitespace-nowrap">
                  {#if !masterEnabled}
                    <span class="badge badge-ghost badge-sm opacity-60" title="The master switch below is off.">all off</span>
                  {:else if s.alertsEnabled}
                    <span class="badge badge-outline badge-sm opacity-70">on</span>
                  {:else}
                    <span class="badge badge-ghost badge-sm opacity-60" title="Silenced on purpose below.">off</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="card bg-base-100 shadow w-full max-w-2xl">
      <div class="card-body gap-4">
        <h2 class="card-title">Alerts</h2>
        <p class="text-sm opacity-70">
          One email when a service crosses into failing, and one when it recovers - never one per
          failure. The SMTP connection itself is set on the server, not here.
        </p>

        {#if report.owner}
          <p class="text-sm">
            Alerts go to <span class="font-mono">{report.owner}</span>
            <span class="opacity-60">
              - the first admin account with a verified email address. Other admins are not
              included automatically; add them below if they should be.
            </span>
          </p>
        {:else}
          <div class="alert alert-warning py-2">
            <span class="text-sm">
              No admin has a verified email address, so alerts would reach nobody. Verify an
              address on your account, or add one below. An unverified address does not count -
              a typo would silently send every alert into a black hole.
            </span>
          </div>
        {/if}

        <label class="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" class="toggle toggle-primary" bind:checked={masterEnabled} />
          <span class="text-sm">Send alert emails</span>
        </label>

        <div class="flex flex-col gap-1" class:opacity-50={!masterEnabled}>
          <span class="text-sm opacity-80">Per service</span>
          {#each rows as s (s.id)}
            <label class="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                class="checkbox checkbox-sm"
                disabled={!masterEnabled}
                checked={silenced[s.id] !== false}
                on:change={(e) => setServiceAlerts(s.id, e.currentTarget.checked)}
              />
              <span class="text-sm">{s.label}</span>
            </label>
          {/each}
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-sm opacity-80" for="extra-recipients">
            <span>Also email (one address per line)</span>
          </label>
          <textarea
            id="extra-recipients"
            class="textarea textarea-bordered w-full font-mono text-sm"
            rows="3"
            placeholder="ops@example.com"
            bind:value={extraText}
          ></textarea>
          <span class="label-text-alt opacity-60">
            Admins with a verified address are always included and do not need listing.
          </span>
        </div>

        <div class="card-actions items-center gap-2">
          <button class="btn btn-outline btn-sm" on:click={sendTest} disabled={testing}>
            {#if testing}<span class="loading loading-spinner loading-xs"></span>{/if}
            Send test email
          </button>
          <button class="btn btn-primary btn-sm" on:click={save} disabled={saving || !!loadError}>
            {#if saving}<span class="loading loading-spinner loading-xs"></span>{/if}
            Save
          </button>
          {#if saveMsg}<span class="text-success text-sm">{saveMsg}</span>{/if}
          {#if saveErr}<span class="text-error text-sm">{saveErr}</span>{/if}
        </div>

        {#if testResult}
          <div class="text-sm" class:text-success={testResult.ok} class:text-error={!testResult.ok}>
            {testResult.ok ? 'Test email sent.' : testResult.error ?? 'The test email failed.'}
          </div>
        {/if}
      </div>
    </section>
  {/if}
</AdminShell>
