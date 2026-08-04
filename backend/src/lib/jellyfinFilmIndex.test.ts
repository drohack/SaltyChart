import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFilmIndex, __setFilmIndexForTest } from './jellyfinFilmIndex';

const api = {} as any;

test('concurrent cold callers share ONE film fetch', async () => {
  // The guard's whole job. Its first shape checked the in-flight promise, then
  // awaited the persisted-copy read, then assigned it — so two callers racing
  // through the cold path (the availability batch runs a concurrency-5 pool)
  // both passed the check and each started its own ~6,600-item Jellyfin scan.
  let fetches = 0;
  __setFilmIndexForTest({
    fetch: async () => {
      fetches++;
      await new Promise((r) => setTimeout(r, 30));
      return { '1': { itemId: 'a', title: 'A' } };
    },
    load: async () => null,
    save: async () => {},
  });
  const [x, y] = await Promise.all([getFilmIndex(api), getFilmIndex(api)]);
  assert.equal(
    fetches, 1,
    'two concurrent cold lookups must share one in-flight fetch — each starting ' +
    'its own full film scan is the stampede the guard exists to stop'
  );
  assert.deepEqual(x, y);
});

test('a persisted copy answers immediately while the refresh runs behind', async () => {
  let resolveFetch!: (v: Record<string, { itemId: string; title: string }>) => void;
  __setFilmIndexForTest({
    fetch: () => new Promise((r) => { resolveFetch = r; }),
    load: async () => JSON.stringify({ '2': { itemId: 'b', title: 'B' } }),
    save: async () => {},
  });
  const first = await getFilmIndex(api);
  assert.equal(first['2']?.itemId, 'b',
    'the stale persisted copy must answer without waiting on the refresh — ' +
    'a viewer sat on this await once, for the whole fetch');
  resolveFetch({ '3': { itemId: 'c', title: 'C' } });
});

test('a failed refresh degrades to an empty index, never a throw', async () => {
  __setFilmIndexForTest({
    fetch: async () => { throw new Error('jellyfin down'); },
    load: async () => null,
    save: async () => {},
  });
  const out = await getFilmIndex(api);
  assert.deepEqual(out, {}, 'no copy at all just means films report as not held');
});
