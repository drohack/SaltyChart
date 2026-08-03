import { writable, type Readable } from 'svelte/store';

/**
 * One way to read from the API.
 *
 * Every remote read used to be written from scratch, and only one of them —
 * `Home.fetchMainSeason` — got it right: a request-id staleness guard, loading
 * and error flags, shape validation, a real log line. Everywhere else shipped
 * with `catch {}`, so a failure rendered exactly like a successful empty result.
 * A real outage (no Watch buttons, nothing on screen, no logs) could not be
 * explained afterwards because nothing anywhere had written down that it failed.
 *
 * There were also **no** `AbortSignal`s in the frontend at all, so a hung
 * backend hung the page forever — no error, no timeout, nothing to catch.
 */

export type ApiErrorKind = 'timeout' | 'network' | 'http';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
  /** "Couldn't reach it" as opposed to "it answered, with a no". */
  get unreachable(): boolean {
    return this.kind !== 'http' || (this.status ?? 0) >= 500;
  }
}

export interface ApiFetchOpts {
  /**
   * Per call, never global. A cold `/api/anime` legitimately took 186s under
   * AniList rate-limiting, so one blanket value either breaks season loading or
   * is useless everywhere else.
   */
  timeoutMs?: number;
  /** Extra attempts after the first. Ignored for timeouts — see below. */
  retries?: number;
  /** Whole-operation ceiling across all attempts. */
  budgetMs?: number;
  /** Shown in logs so a warning names the caller. */
  label?: string;
}

/** Sensible for anything talking to our own backend about local data. */
export const QUICK = 15_000;
/** `/api/anime` only: a cold season is 6-12 upstream pages behind a 30/min limit. */
export const SEASON = 200_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `fetch` that cannot hang, reports why it failed, and retries only when
 * retrying can help.
 *
 * Timeouts are deliberately **not** retried. A slow-but-working server is the
 * case where retrying hurts most: three attempts against something taking a
 * minute is three minutes of the user seeing nothing, and the request was
 * probably going to succeed. `budgetMs` caps the whole operation so retries can
 * never multiply out to N x the worst case.
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  { timeoutMs = QUICK, retries = 2, budgetMs = timeoutMs * 2, label = path }: ApiFetchOpts = {}
): Promise<Response> {
  const deadline = Date.now() + budgetMs;
  let last: ApiError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) {
      const wait = Math.min(500 * 2 ** (attempt - 1), 4000);
      if (Date.now() + wait >= deadline) break;
      await sleep(wait);
    }
    try {
      const res = await fetch(path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 500) {
        last = new ApiError('http', `${label}: HTTP ${res.status}`, res.status);
        console.warn(`[api] ${label}: HTTP ${res.status} (attempt ${attempt + 1}/${retries + 1})`);
        continue; // a 5xx is worth another go; a 4xx is an answer
      }
      return res;
    } catch (err: any) {
      // AbortSignal.timeout rejects with a TimeoutError; a real abort or a
      // dropped connection rejects with AbortError/TypeError.
      const timedOut = err?.name === 'TimeoutError';
      last = new ApiError(timedOut ? 'timeout' : 'network', `${label}: ${err?.message ?? err}`);
      console.warn(`[api] ${label}: ${timedOut ? `timed out after ${timeoutMs}ms` : 'network error'} (attempt ${attempt + 1}/${retries + 1})`);
      if (timedOut) break; // see above — retrying a slow server makes it worse
    }
    if (Date.now() >= deadline) break;
  }
  throw last ?? new ApiError('network', `${label}: failed`);
}

/** Convenience: `apiFetch` plus JSON parsing, with the same error semantics. */
export async function apiJson<T>(path: string, init?: RequestInit, opts?: ApiFetchOpts): Promise<T> {
  const res = await apiFetch(path, init, opts);
  if (!res.ok) throw new ApiError('http', `${opts?.label ?? path}: HTTP ${res.status}`, res.status);
  return (await res.json()) as T;
}

export type RemoteStatus = 'idle' | 'loading' | 'ok' | 'failed';

export interface Remote<T> {
  status: Readable<RemoteStatus>;
  data: Readable<T | null>;
  error: Readable<ApiError | null>;
  /** Run a loader, tracking status and discarding stale responses. */
  run: (fn: () => Promise<T>) => Promise<T | null>;
  /** Re-run whatever `run` was last given. Powers every Retry button. */
  retry: () => Promise<T | null>;
}

/**
 * The `Home.fetchMainSeason` shape, extracted so a page gets it for free.
 *
 * The request-id guard is the non-obvious part: without it a slow response for
 * the *previous* season can land after a newer one and overwrite it. Home
 * already carried that guard by hand; nothing else did.
 */
export function createRemote<T>(label: string): Remote<T> {
  const status = writable<RemoteStatus>('idle');
  const data = writable<T | null>(null);
  const error = writable<ApiError | null>(null);
  let reqId = 0;
  let lastFn: (() => Promise<T>) | null = null;

  const run = async (fn: () => Promise<T>): Promise<T | null> => {
    lastFn = fn;
    const id = ++reqId;
    status.set('loading');
    error.set(null);
    try {
      const value = await fn();
      if (id !== reqId) return null; // superseded; do not clobber newer data
      data.set(value);
      status.set('ok');
      return value;
    } catch (err: any) {
      if (id !== reqId) return null;
      const e = err instanceof ApiError ? err : new ApiError('network', `${label}: ${err?.message ?? err}`);
      console.warn(`[remote] ${label} failed:`, e.message);
      error.set(e);
      status.set('failed');
      return null;
    }
  };

  return {
    status: { subscribe: status.subscribe },
    data: { subscribe: data.subscribe },
    error: { subscribe: error.subscribe },
    run,
    retry: () => (lastFn ? run(lastFn) : Promise.resolve(null)),
  };
}
