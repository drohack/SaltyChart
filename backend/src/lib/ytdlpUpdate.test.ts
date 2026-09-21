import { test } from 'node:test';
import assert from 'node:assert';
import { recycleOutcomeLine } from './ytdlpUpdate';

test('an idle daemon is not reported as busy', () => {
  // The common case on a quiet server is that no daemon is running at all
  // (it exits after two idle hours). Calling that "busy" told the operator the
  // opposite of the truth about whether the new version was in use.
  const none = recycleOutcomeLine('none');
  assert.ok(!/busy/i.test(none), none);
  assert.ok(/not running|next spawn/i.test(none), none);
  assert.ok(/busy/i.test(recycleOutcomeLine('busy')));
  assert.ok(/recycled/i.test(recycleOutcomeLine('recycled')));
});
