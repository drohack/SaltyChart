import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_ID,
  deviceProfile,
  jellyfinApi,
  jellyfinAuthHeader,
  jellyfinAxios,
  jellyfinErrorInfo,
} from './jellyfinApi';

// The device id is a contract between two endpoints that never talk to each
// other: a stream is started under it, and `DELETE /Videos/ActiveEncodings`
// matches on it to kill the encode. Nothing errors if they drift — the ffmpeg
// just survives and keeps writing the episode to the transcode cache — so it is
// asserted here rather than left to a convention.
test('the auth header carries the device id ActiveEncodings matches on', () => {
  const header = jellyfinAuthHeader('deadbeef');
  assert.equal(DEVICE_ID, 'saltychart');
  assert.match(header, /DeviceId="saltychart"/);
  assert.match(header, /Token="deadbeef"/);
  assert.match(header, /^MediaBrowser /);
});

test('the axios instance sends that header and keeps the 8s default timeout', () => {
  const ax = jellyfinAxios({ url: 'http://jellyfin.example', apiKey: 'deadbeef' });
  assert.equal(ax.defaults.baseURL, 'http://jellyfin.example');
  assert.equal(ax.defaults.timeout, 8000);
  assert.equal(ax.defaults.headers.Authorization, jellyfinAuthHeader('deadbeef'));
});

// The SDK is ESM and this backend is CommonJS. That import is the one thing in
// this migration that can pass every type-check and still fail at runtime, so
// it gets exercised rather than assumed.
test('the ESM SDK loads under CommonJS and builds an Api', async () => {
  const api = await jellyfinApi({ url: 'http://jellyfin.example', apiKey: 'deadbeef' });
  assert.match(api.authorizationHeader, /DeviceId="saltychart"/);
  // Memoized on the credentials, so no reset hook is needed when config changes.
  const again = await jellyfinApi({ url: 'http://jellyfin.example', apiKey: 'deadbeef' });
  assert.equal(api, again);
  const other = await jellyfinApi({ url: 'http://jellyfin.example', apiKey: 'different' });
  assert.notEqual(api, other);
});

// Captured from the hand-written profile before it was retyped with SDK enums.
// The SDK's members carry the same strings, so retyping must not have moved a
// single byte on the wire — which is the whole claim this migration rests on.
const PRE_MIGRATION_PROFILE =
  '{"MaxStreamingBitrate":8000000,"MaxStaticBitrate":8000000,"DirectPlayProfiles":[],' +
  '"TranscodingProfiles":[{"Container":"ts","Type":"Video","VideoCodec":"h264","AudioCodec":"aac",' +
  '"Protocol":"hls","Context":"Streaming","MaxAudioChannels":"2","MinSegments":1,' +
  '"BreakOnNonKeyFrames":true}],"CodecProfiles":[{"Type":"Video","Codec":"h264","Conditions":[' +
  '{"Condition":"LessThanEqual","Property":"Width","Value":"1920","IsRequired":false},' +
  '{"Condition":"LessThanEqual","Property":"VideoBitrate","Value":"8000000","IsRequired":false},' +
  '{"Condition":"LessThanEqual","Property":"VideoBitDepth","Value":"8","IsRequired":false}]}],' +
  '"SubtitleProfiles":[{"Format":"ass","Method":"Encode"}]}';

test('the typed DeviceProfile is byte-identical to the hand-written one', () => {
  assert.equal(JSON.stringify(deviceProfile(1920, 8_000_000)), PRE_MIGRATION_PROFILE);
});

// Three invariants that are not obvious from the shape, each with a failure mode
// that is silent rather than loud. Asserted separately from the snapshot so a
// deliberate future change to some unrelated field can't quietly take one out.
test('DirectPlayProfiles stays empty — browsers cannot demux MKV', () => {
  assert.deepEqual(deviceProfile(1280, 4_000_000).DirectPlayProfiles, []);
});

test('the 8-bit ceiling stays — Chrome cannot decode Hi10P', () => {
  const conds = deviceProfile(1280, 4_000_000).CodecProfiles?.[0]?.Conditions ?? [];
  const depth = conds.find((c) => c.Property === 'VideoBitDepth');
  assert.ok(depth, 'no VideoBitDepth condition — Hi10P releases would play as a black picture');
  assert.equal(depth?.Condition, 'LessThanEqual');
  assert.equal(depth?.Value, '8');
});

test('subtitles stay burned in — this one field is the whole architecture', () => {
  assert.deepEqual(deviceProfile(854, 1_500_000).SubtitleProfiles, [
    { Format: 'ass', Method: 'Encode' },
  ]);
});

test('the quality tiers reach the profile', () => {
  const p = deviceProfile(854, 1_500_000);
  assert.equal(p.MaxStreamingBitrate, 1_500_000);
  const conds = p.CodecProfiles?.[0]?.Conditions ?? [];
  assert.equal(conds.find((c) => c.Property === 'Width')?.Value, '854');
  assert.equal(conds.find((c) => c.Property === 'VideoBitrate')?.Value, '1500000');
});

test('a logged Jellyfin error never carries the API key', () => {
  // An axios error carries its whole request config, and the config carries the
  // Authorization header. `console.warn('…', err)` therefore prints the server's
  // Jellyfin key into the backend log — observed for real when a library refresh
  // timed out. The proxy already refuses to hand a credential to a browser;
  // this is the same secret leaving by a different door.
  const key = '36e12d0c65894b03afcee74d7e4e67c6';
  const axiosish: any = {
    code: 'ECONNABORTED',
    message: 'timeout of 30000ms exceeded',
    isAxiosError: true,
    config: {
      timeout: 30_000,
      headers: { Authorization: jellyfinAuthHeader(key), Accept: 'application/json' },
    },
    response: { status: 504 },
  };
  const logged = jellyfinErrorInfo(axiosish);
  assert.ok(!logged.includes(key), `the key leaked into the log line: ${logged}`);
  assert.ok(!/token=/i.test(logged), `an auth header reached the log line: ${logged}`);
  // Still worth reading, or nobody will use it.
  assert.match(logged, /ECONNABORTED/);
  assert.match(logged, /504/);
  assert.match(logged, /timeout/);
});

test('a plain Error still logs something useful', () => {
  assert.match(jellyfinErrorInfo(new Error('boom')), /boom/);
  assert.match(jellyfinErrorInfo('just a string'), /just a string/);
});
