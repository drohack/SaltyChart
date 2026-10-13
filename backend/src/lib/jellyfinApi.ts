/**
 * The Jellyfin client: one `Api` instance, one auth header, one device id.
 *
 * Everything here is about talking to Jellyfin *correctly* rather than
 * plausibly. The integration used to hand-write axios calls against hand-typed
 * object literals, and the two bugs that cost the most time were both
 * guessed-field bugs: a DeviceProfile missing `videoBitRate` silently produced
 * a 416x234 stream, and `SubtitleProfiles: [{ Format: 'ass', Method: 'Encode' }]`
 * - the field the whole burned-in-subtitle architecture turns on - was found by
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
 * `DELETE /Videos/ActiveEncodings?deviceId=...`, and Jellyfin only matches that
 * against the device id the *stream* was started under. If the two ever drift,
 * nothing errors - the encode simply survives, and its ffmpeg keeps writing the
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
 * header the SDK sends are literally the same string - they authenticate the
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
 * A loggable summary of a failed Jellyfin call - **never the error object**.
 *
 * An axios error carries its whole request `config`, and that config carries the
 * `Authorization` header. So `console.warn('...', err)` prints the server's
 * Jellyfin API key into the backend log, where it goes to the Docker logs and
 * into anything anyone pastes from them. Observed for real: a library-refresh
 * timeout logged `Token="..."` in full.
 *
 * The codebase already treats this key as something that must never leave the
 * server - the stream proxy refuses any manifest containing a credential, and
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
 * becomes `require()` of an ESM package - supported only on Node >= 20.19.
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
 * most conservative option it can construct - which is how a stream request
 * without `videoBitRate` came back as **416x234**. Hand-tuning query parameters
 * was reverse-engineering this structure badly.
 *
 * `SubtitleProfiles: [{ Format: 'ass', Method: 'Encode' }]` is the entire
 * burn-in switch. Jellyfin renders the ASS with libass and the episode's own
 * extracted fonts (`-vf subtitles=...:fontsdir=...`) and re-encodes the result -
 * so the picture the viewer gets is what libass would have drawn in the browser,
 * minus every way the browser can fail to draw it. Which encoder does that is
 * Jellyfin's setting, not ours: on this deployment hardware acceleration is
 * `none`, and every session log reads `libx264` (checked 2026-10-12; this
 * comment used to claim `h264_qsv`).
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

/**
 * Quality tiers the player offers. `auto` is resolved per item by `autoTier`.
 */
export const QUALITY_TIERS: Record<string, { width: number; bitrate: number } | null> = {
  auto: null,
  '1080p': { width: 1920, bitrate: 8_000_000 },
  '720p': { width: 1280, bitrate: 4_000_000 },
  '480p': { width: 854, bitrate: 1_500_000 },
};

/**
 * Room for the audio Jellyfin carves out of our ceiling before video gets its
 * share (its stereo AAC target: 128k and 189k observed). Without it the video
 * budget lands below the source, and that alone makes Jellyfin downscale.
 */
export const AUDIO_HEADROOM = 256_000;

/** The named tier's bitrate for a source this wide - Auto never asks for less. */
function floorFor(width: number): number {
  if (width >= 1920) return QUALITY_TIERS['1080p']!.bitrate;
  if (width >= 1280) return QUALITY_TIERS['720p']!.bitrate;
  return QUALITY_TIERS['480p']!.bitrate;
}

/**
 * The ceiling "Auto" sends: the source's own resolution, and a bitrate with
 * room above the source - never the source's bitrate itself.
 *
 * Auto used to send the file's video bitrate, on the theory that Jellyfin will
 * not encode above it anyway. That is backwards: Jellyfin already decides how
 * far above the source to go (`GetVideoBitrateParamValue` gives a source under
 * 2 Mbps up to 2.5x, and scales HEVC to H.264 by 1/0.6), then clamps the result
 * to OUR ceiling - so a ceiling equal to the source cancels the compensation.
 * And once the requested bitrate is below the source's video bitrate,
 * `ResolutionNormalizer` downscales too. PSYREN S01E01 (MeGusta HDTV, HEVC
 * 10-bit, 616 kbps video) got `-maxrate 487688` and **960x540** on 2026-10-11,
 * while every other episode that night kept its resolution.
 *
 * Above the source it costs little: the encode is CRF 23 and the ceiling only a
 * cap - that night, generously capped streams averaged 0.7 to 2.7 Mbps. It also
 * stops the cap sitting below the CONTAINER bitrate, which made Jellyfin re-encode
 * every file (`ContainerBitrateExceedsLimit`) even where a remux would do.
 */
export function autoTier(src: {
  width: number;
  videoBitrate: number;
  containerBitrate: number;
}): { width: number; bitrate: number } {
  const sourceBitrate = Math.max(src.videoBitrate || 0, src.containerBitrate || 0);
  if (!src.width || !sourceBitrate) return { width: 1920, bitrate: 8_000_000 };
  return {
    width: src.width,
    bitrate: Math.max(sourceBitrate + AUDIO_HEADROOM, floorFor(src.width)),
  };
}
