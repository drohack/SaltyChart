// Outside src/ on purpose: svelte-check type-checks src/ without Node's types.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCopiedList, defaultMain, type AccountList } from '../src/lib/copyList.ts';

const e = (mediaId: number, customName: string | null = null) => ({ mediaId, customName });

const group: AccountList = { user: 'group', entries: [e(1, 'Cats'), e(2), e(3, 'Robots'), e(4)] };
const alex: AccountList = { user: 'alex', entries: [e(9, 'Alex nick'), e(2, 'Other nick'), e(8)] };
const sam: AccountList = { user: 'sam', entries: [e(8), e(7)] };
const lists = [sam, group, alex];

test('main keeps its order and nicknames, bonus follows per account in its own order', () => {
  const { items } = buildCopiedList(lists, 'group', new Set());
  assert.deepEqual(items.map((i) => i.mediaId), [1, 2, 3, 4, 9, 8, 7]);
  assert.deepEqual(items.slice(0, 4).map((i) => i.customName), ['Cats', null, 'Robots', null]);
});

test('bonus shows never take a nickname', () => {
  const { items } = buildCopiedList(lists, 'group', new Set());
  assert.ok(items.slice(4).every((i) => i.customName === null));
});

test('a show an earlier bonus account holds is not repeated', () => {
  const { bonus } = buildCopiedList(lists, 'group', new Set());
  assert.deepEqual(bonus, [
    { user: 'alex', mediaIds: [9, 8] },
    { user: 'sam', mediaIds: [7] },
  ], 'a later account offered a show an earlier list already holds');
});

test('an excluded account is listed but not saved, and claims nothing', () => {
  const { items, bonus } = buildCopiedList(lists, 'group', new Set(['alex']));
  assert.deepEqual(items.map((i) => i.mediaId), [1, 2, 3, 4, 8, 7],
    "an unticked account's shows were saved anyway");
  assert.deepEqual(bonus, [
    { user: 'alex', mediaIds: [9, 8] },
    { user: 'sam', mediaIds: [8, 7] },
  ]);
});

test('an account adding nothing new is left out of bonus', () => {
  const subset: AccountList = { user: 'zed', entries: [e(1), e(3)] };
  const { bonus } = buildCopiedList([group, subset], 'group', new Set());
  assert.deepEqual(bonus, []);
});

test('switching main rebuilds the bonus around the new main', () => {
  const { items, bonus } = buildCopiedList(lists, 'alex', new Set());
  assert.deepEqual(items.map((i) => i.mediaId), [9, 2, 8, 1, 3, 4, 7]);
  assert.equal(items[1].customName, 'Other nick');
  assert.deepEqual(bonus.map((b) => b.user), ['group', 'sam']);
});

test('default main is the biggest list, ties broken by name', () => {
  assert.equal(defaultMain(lists), 'group');
  const a: AccountList = { user: 'bea', entries: [e(1)] };
  const b: AccountList = { user: 'abe', entries: [e(2)] };
  assert.equal(defaultMain([a, b]), 'abe');
  assert.equal(defaultMain([]), null);
});
