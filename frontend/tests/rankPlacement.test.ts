// Outside src/ on purpose: svelte-check type-checks src/ without Node's types.
// Run: npm run test:unit
//
// moveIndex/nudgeTarget decide every reorder on Randomize - the Watched rail's
// drag and arrows and the expanded ranking's drop line, "put it last" and
// arrows all save whatever these return. An off-by-one here reads as "the show
// landed one place from where I dropped it", which nobody reports as a bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveIndex, nudgeTarget } from '../src/lib/rankPlacement.ts';

const abcd = ['a', 'b', 'c', 'd'];

test('moving down lands in front of the item at `to`, not on its index', () => {
  // Dropped on the line above 'c': 'a' ends up between 'b' and 'c'.
  assert.deepEqual(moveIndex(abcd, 0, 2), ['b', 'a', 'c', 'd']);
  assert.deepEqual(moveIndex(abcd, 1, 3), ['a', 'c', 'b', 'd']);
});

test('moving up lands in front of the item at `to`', () => {
  assert.deepEqual(moveIndex(abcd, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveIndex(abcd, 2, 1), ['a', 'c', 'b', 'd']);
});

test('to === length puts it last ("put it last")', () => {
  assert.deepEqual(moveIndex(abcd, 0, 4), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveIndex(abcd, 2, 4), ['a', 'b', 'd', 'c']);
});

test('a drop that changes nothing returns null, so no save is sent', () => {
  // The line directly above or below an item is its own position.
  for (let i = 0; i < abcd.length; i++) {
    assert.equal(moveIndex(abcd, i, i), null, `to the line above itself (${i})`);
    assert.equal(moveIndex(abcd, i, i + 1), null, `to the line below itself (${i})`);
  }
});

test('out-of-range indexes return null rather than a corrupted order', () => {
  assert.equal(moveIndex(abcd, -1, 2), null);
  assert.equal(moveIndex(abcd, 4, 0), null);
  assert.equal(moveIndex(abcd, 0, 5), null);
  assert.equal(moveIndex(abcd, 0, -1), null);
  assert.equal(moveIndex([], 0, 0), null);
});

test('the input list is never mutated', () => {
  const list = [...abcd];
  moveIndex(list, 0, 4);
  assert.deepEqual(list, abcd);
});

test('every result is a permutation - nothing dropped or duplicated', () => {
  for (let from = 0; from < abcd.length; from++) {
    for (let to = 0; to <= abcd.length; to++) {
      const out = moveIndex(abcd, from, to);
      if (out) assert.deepEqual([...out].sort(), [...abcd].sort(), `from ${from} to ${to}`);
    }
  }
});

test('nudge swaps exactly one neighbour, and stops at the ends', () => {
  for (let i = 0; i < abcd.length; i++) {
    for (const d of [-1, 1]) {
      const to = nudgeTarget(i, d, abcd.length);
      const j = i + d;
      if (j < 0 || j >= abcd.length) {
        assert.equal(to, null, `${i} ${d > 0 ? 'down' : 'up'} at the end`);
        continue;
      }
      const expected = [...abcd];
      [expected[i], expected[j]] = [expected[j], expected[i]];
      assert.deepEqual(moveIndex(abcd, i, to!), expected, `${i} ${d > 0 ? 'down' : 'up'}`);
    }
  }
});
