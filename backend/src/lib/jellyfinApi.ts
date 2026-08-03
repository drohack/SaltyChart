/**
 * The Jellyfin client: one `Api` instance, one auth header, one device id.
 *
 * Everything here is about talking to Jellyfin *correctly* rather than
 * plausibly. The integration used to hand-write axios calls against hand-typed
 * object literals, and the two bugs that cost the most time were both
 * guessed-field bugs: a DeviceProfile missing `videoBitRate` silently produced
 * a 416x234 stream, and `SubtitleProfiles: [{ Format: 'ass', Method: 'Encode' }]`
 * — the field the whole burned-in-subtitle architecture turns on — was found by
 * poking at the API rather than read off a contract. The official SDK generates
 * both from Jellyfin's own OpenAPI spec, so those are now enums a typo cannot
 * survive.
 *
 * The one thing deliberately NOT routed through here is the `/stream/*` proxy in
 * `routes/jellyfin.ts`. It replays a URL Jellyfin itself chose (`TranscodingUrl`)
 * with the parameters Jellyfin baked into it; a typed accessor would mean
 * re-deriving those parameters, which is exactly the mistake that produced the
 * 416x234. The SDK has nothing to offer it.
 */
import axios, { AxiosInstance } from 'axios';
import type { Api } from '@jellyfin/sdk/lib/api';
import { Jellyfin } from '@jellyfin/sdk';
import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import { CodecType } from '@jellyfin/sdk/lib/generated-client/models/codec-type';
import { DlnaProfileType } from '@jellyfin/sdk/lib/generated-client/models/dlna-profile-type';
import { EncodingContext } from '@jellyfin/sdk/lib/generated-client/models/encoding-context';
import { MediaStreamProtocol } from '@jellyfin/sdk/lib/generated-client/models/media-stream-protocol';
import { ProfileConditionType } from '@jellyfin/sdk/lib/generated-client/models/profile-condition-type';
import { ProfileConditionValue } from '@jellyfin/sdk/lib/generated-client/models/profile-condition-value';
import { SubtitleDeliveryMethod } from '@jellyfin/sdk/lib/generated-client/models/subtitle-delivery-method';

export interface JellyfinConfig {
  url: string; // no trailing slash
  apiKey: string;
}

/**
 * Must stay exactly this string.
 *
 * `POST /playback/stop` tears a transcode down with
 * `DELETE /Videos/ActiveEncodings?deviceId=…`, and Jellyfin only matches that
 * against the device id the *stream* was started under. If the two ever drift,
 * nothing errors — the encode simply survives, and its ffmpeg keeps writing the
 * whole episode to the transcode cache.
 */
export const DEVICE_ID = 'saltychart';
export const CLIENT_INFO = { name: 'SaltyChart', version: '1.0' };
export const DEVICE_INFO = { name: 'Web', id: DEVICE_ID };

/**
 * Jellyfin accepts the API key as an Authorization header; keeping it out of
 * the URL means it can't leak through logs or error messages the way a query
 * parameter does.
 *
 * Built with the SDK's own formatter so the header the raw proxy sends and the
 * header the SDK sends are literally the same string — they authenticate the
 * same requests, so they must not be able to drift.
 */
export function jellyfinAuthHeader(apiKey: string): string {
  return [
    `MediaBrowser Client="${encodeURIComponent(CLIENT_INFO.name)}"`,
    `Device="${encodeURIComponent(DEVICE_INFO.name)}"`,
    `DeviceId="${encodeURIComponent(DEVICE_INFO.id)}"`,
    `Version="${encodeURIComponent(CLIENT_INFO.version)}"`,
    `Token="${encodeURIComponent(apiKey)}"`,
  ].join(', ');
}

/**
 * A loggable summary of a failed Jellyfin call — **never the error object**.
 *
 * An axios error carries its whole request `config`, and that config carries the
 * `Authorization` header. So `console.warn('…', err)` prints the server's
 * Jellyfin API key into the backend log, where it goes to the Docker logs and
 * into anything anyone pastes from them. Observed for real: a library-refresh
 * timeout logged `Token="…"` in full.
 *
 * The codebase already treats this key as something that must never leave the
 * server — the stream proxy refuses any manifest containing a credential, and
 * `test_jellyfin` asserts it. That guard was written against browsers; logs are
 * the same secret by a different route.
 *
 * Use this at every `catch` that logs. It keeps what is diagnostically useful
 * (message, code, HTTP status) and drops everything that could carry a header.
 */
export function jellyfinErrorInfo(err: any): string {
  const status = err?.response?.status;
  const parts = [
    err?.code,
    status ? `HTTP ${status}` : null,
    err?.message,
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : String(err);
}

export function jellyfinAxios(cfg: JellyfinConfig): AxiosInstance {
  return axios.create({
    baseURL: cfg.url,
    timeout: 8000,
    headers: {
      Authorization: jellyfinAuthHeader(cfg.apiKey),
      Accept: 'application/json',
    },
  });
}

let _api: { key: string; api: Api } | null = null;

/**
 * The `Api`, memoized on the credentials it was built from.
 *
 * Keying on `url|apiKey` means this needs no hook into config invalidation:
 * `PUT /config` already clears the config cache, the next read produces a
 * different key, and the `Api` rebuilds itself. A `reset()` someone has to
 * remember to call would be a bug waiting for a quiet afternoon.
 *
 * **This import crosses a module-system boundary.** `@jellyfin/sdk` is ESM
 * (`"type": "module"`) while this backend emits CommonJS, so importing it
 * becomes `require()` of an ESM package — supported only on Node >= 20.19.
 * Verified by actually loading it on 20.19.2 and 22.16; production runs 20.20.2.
 * That is what the `engines` floor in package.json is for: if the base image is
 * ever rebuilt on something older, a declared floor turns a mystery crash into
 * an install-time complaint.
 */
export async function jellyfinApi(cfg: JellyfinConfig): Promise<Api> {
  const key = `${cfg.url} ${cfg.apiKey}`;
  if (_api?.key === key) return _api.api;
  // The custom axios instance carries our timeout and auth; the SDK defers to
  // its `baseURL` when one is set, so passing `cfg.url` to both keeps the
  // instance and the SDK's own basePath from ever disagreeing.
  const api = new Jellyfin({ clientInfo: CLIENT_INFO, deviceInfo: DEVICE_INFO }).createApi(
    cfg.url,
    cfg.apiKey,
    jellyfinAxios(cfg)
  );
  _api = { key, api };
  return api;
}

/**
 * What this player can actually do, in the form Jellyfin expects.
 *
 * Sending a profile is not optional politeness: Jellyfin has no "assume
 * everything is supported" fallback, so a client that declares nothing gets the
 * most conservative option it can construct — which is how a stream request
 * without `videoBitRate` came back as **416×234**. Hand-tuning query parameters
 * was reverse-engineering this structure badly.
 *
 * `SubtitleProfiles: [{ Format: 'ass', Method: 'Encode' }]` is the entire
 * burn-in switch. Jellyfin renders the ASS with libass and the episode's own
 * extracted fonts (`-vf subtitles=…:fontsdir=…`), composites it on the GPU via
 * `overlay_qsv`, and encodes with `h264_qsv` — so the picture the viewer gets is
 * what libass would have drawn in the browser, minus every way the browser can
 * fail to draw it.
 *
 * Every value below is an SDK enum member carrying the exact string we used to
 * write by hand, so this is byte-identical on the wire (asserted in the tests)
 * while a typo in `VideoBitDepth` or `'encode'` can no longer compile.
 */
export function deviceProfile(width: number, bitrate: number): DeviceProfile {
  return {
    MaxStreamingBitrate: bitrate,
    MaxStaticBitrate: bitrate,
    // Deliberately empty: browsers cannot demux MKV, so direct play never
    // applies here and claiming otherwise would only produce a stream the
    // <video> element refuses.
    DirectPlayProfiles: [],
    TranscodingProfiles: [
      {
        Container: 'ts',
        Type: DlnaProfileType.Video,
        VideoCodec: 'h264',
        AudioCodec: 'aac',
        Protocol: MediaStreamProtocol.Hls,
        Context: EncodingContext.Streaming,
        MaxAudioChannels: '2',
        MinSegments: 1,
        BreakOnNonKeyFrames: true,
      },
    ],
    CodecProfiles: [
      {
        // CodecType here, but DlnaProfileType on the transcoding profile above.
        // Both have a `Video` member valued 'Video'; the compiler keeps them
        // straight so a copy-paste between the two can't go unnoticed.
        Type: CodecType.Video,
        Codec: 'h264',
        Conditions: [
          {
            Condition: ProfileConditionType.LessThanEqual,
            Property: ProfileConditionValue.Width,
            Value: String(width),
            IsRequired: false,
          },
          {
            Condition: ProfileConditionType.LessThanEqual,
            Property: ProfileConditionValue.VideoBitrate,
            Value: String(bitrate),
            IsRequired: false,
          },
          // Chrome cannot decode 10-bit H.264 (Hi10P), which anime releases do
          // ship. Declaring the ceiling makes Jellyfin re-encode those rather
          // than hand over a stream that plays as a black picture.
          {
            Condition: ProfileConditionType.LessThanEqual,
            Property: ProfileConditionValue.VideoBitDepth,
            Value: '8',
            IsRequired: false,
          },
        ],
      },
    ],
    SubtitleProfiles: [{ Format: 'ass', Method: SubtitleDeliveryMethod.Encode }],
  };
}
