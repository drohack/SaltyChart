"""
Batch pre-translation of anime trailers for upcoming seasons.

Safety net behind the local GPU script (tools/local_translate.py) which runs
large-v3 every Sunday with no window gate, covering 3 seasons. This batch
runs on Wednesdays within 50 days, catching any trailers the local run missed.

Uses the Whisper `medium` model (int8 quantized, ~1.5GB RAM) with full-audio
transcription (no chunking) for better quality than the on-demand `small` model.
Videos previously translated with `small` are automatically upgraded to `medium`.
Will NOT downgrade a `large-v3` translation from the local GPU script.

Fetches the anime list for a given season from AniList, filters to eligible
shows (TV, TV_SHORT, OVA, ONA, SPECIAL -- skipping 18+, sequels, no-trailer),
and translates each trailer. Results are saved to SubtitleCache in SQLite
using a single persistent connection for the entire batch run.

The script is resumable: checks SubtitleCache before each video and skips
already-translated ones (at medium quality or better). Respects a time cutoff
(default 10am) for safe overnight scheduling. Logs ETA based on rolling average.

Usage:
  python3 -u batch_translate.py                          # auto-detect next season
  python3 -u batch_translate.py --season SPRING --year 2026
  python3 -u batch_translate.py --dry-run                # list trailers only
  python3 -u batch_translate.py --cutoff 10              # stop by 10am

Note: use -u flag for unbuffered stdout when spawned as a child process.

Scheduling: auto-scheduled by the backend (index.ts) on Wednesdays 2-4am,
50 days before season start.

Can also be triggered from the Options modal (admin only) via POST /api/translate/batch.
"""

import argparse
import json
import os
import sqlite3
import sys
import tempfile
import shutil
import time
from datetime import datetime

# Import shared helpers from translate_stream (same directory)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from translate_stream import download_audio, check_subtitles

# Model quality ranking — used for cache comparison. Keep in sync with the
# copies in backend/src/routes/translate.ts and tools/local_translate.py.
# 'large-v3-split' (the local champion pipeline) MUST be here — without it a
# Sunday-uploaded large-v3-split row ranks as 0 and the Wednesday batch
# needlessly re-downloads + re-transcribes the whole season for a no-op write.
MODEL_RANK = {"tiny": 0, "base": 1, "small": 2, "medium": 3, "large-v2": 4, "large-v3": 5, "large-v3-split": 6}

# ---------------------------------------------------------------------------
# AniList GraphQL
# ---------------------------------------------------------------------------

ANILIST_URL = "https://graphql.anilist.co"

ANILIST_QUERY = """
query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(season: $season, seasonYear: $seasonYear, type: ANIME) {
      id
      title { romaji english }
      isAdult
      format
      trailer { id site }
      relations {
        edges {
          relationType
        }
      }
    }
  }
}
"""

ELIGIBLE_FORMATS = {"TV", "TV_SHORT", "OVA", "ONA", "SPECIAL"}
SEQUEL_RELATIONS = {"SEQUEL", "PREQUEL", "SIDE_STORY", "SPINOFF"}


def fetch_season_anime(season: str, year: int) -> list:
    """Fetch all anime for a season from AniList (paginated)."""
    import urllib.request

    all_media = []
    page = 1

    while True:
        variables = {
            "page": page,
            "perPage": 50,
            "season": season,
            "seasonYear": year,
        }
        body = json.dumps({"query": ANILIST_QUERY, "variables": variables}).encode()
        req = urllib.request.Request(
            ANILIST_URL,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "SaltyChart/1.0 (batch-translate)",
            },
        )

        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    data = json.loads(resp.read().decode())
                break
            except Exception as e:
                if attempt == 2:
                    print(f"  [ERROR] AniList request failed after 3 attempts: {e}")
                    return all_media
                wait = (attempt + 1) * 5
                print(f"  [WARN] AniList request failed, retrying in {wait}s: {e}")
                time.sleep(wait)

        page_data = data.get("data", {}).get("Page", {})
        media = page_data.get("media", [])
        all_media.extend(media)

        if not page_data.get("pageInfo", {}).get("hasNextPage", False):
            break
        page += 1
        time.sleep(1)  # rate limit courtesy

    return all_media


def is_sequel(show: dict) -> bool:
    """Check if a show has sequel/prequel/side-story/spinoff relations."""
    edges = show.get("relations", {}).get("edges", [])
    return any(e.get("relationType") in SEQUEL_RELATIONS for e in edges)


def get_display_title(show: dict) -> str:
    """Get the best available title for display."""
    t = show.get("title", {})
    return t.get("english") or t.get("romaji") or str(show.get("id", "?"))


def filter_eligible(anime_list: list) -> list:
    """Filter to eligible shows with YouTube trailers."""
    eligible = []
    for show in anime_list:
        fmt = show.get("format")
        if fmt not in ELIGIBLE_FORMATS:
            continue
        if show.get("isAdult"):
            continue
        if is_sequel(show):
            continue
        trailer = show.get("trailer")
        if not trailer or trailer.get("site") != "youtube" or not trailer.get("id"):
            continue
        eligible.append(show)
    return eligible


# ---------------------------------------------------------------------------
# Season detection
# ---------------------------------------------------------------------------

SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"]
SEASON_STARTS = {
    "WINTER": (1, 1),   # January 1
    "SPRING": (4, 1),   # April 1
    "SUMMER": (7, 1),   # July 1
    "FALL": (10, 1),    # October 1
}


def next_season_info() -> tuple:
    """Return (season, year) for the next upcoming season (matches the app's default view)."""
    now = datetime.now()
    month = now.month

    if month <= 3:
        current = "WINTER"
    elif month <= 6:
        current = "SPRING"
    elif month <= 9:
        current = "SUMMER"
    else:
        current = "FALL"

    idx = SEASONS.index(current)
    next_idx = (idx + 1) % 4
    next_season = SEASONS[next_idx]
    next_year = now.year + (1 if next_idx == 0 else 0)

    return next_season, next_year


def get_seasons_to_process() -> list:
    """Return [(season, year), ...] covering prev, current-displayed, and next season.

    The app defaults to showing the upcoming season 76 days before it starts,
    so users browse 3 seasons of content. This ensures all of them are cached.
    """
    current, year = next_season_info()
    idx = SEASONS.index(current)

    prev_idx = (idx - 1) % 4
    prev_year = year - (1 if prev_idx == 3 else 0)   # WINTER→FALL wraps back a year

    next_idx = (idx + 1) % 4
    next_year = year + (1 if next_idx == 0 else 0)   # FALL→WINTER wraps forward a year

    return [
        (SEASONS[prev_idx], prev_year),
        (current, year),
        (SEASONS[next_idx], next_year),
    ]


# ---------------------------------------------------------------------------
# Translation
# ---------------------------------------------------------------------------

def _is_bot_block(msg: str) -> bool:
    """True if YouTube returned a 'confirm you're not a bot' challenge — we abort
    the run on this rather than hammering YouTube with the remaining trailers."""
    m = (msg or "").lower()
    return ("confirm you" in m and "not a bot" in m) or "sign in to confirm" in m


def translate_video(model, video_id: str, media_id: int, conn: sqlite3.Connection,
                     has_english: bool = None):
    """Translate a single video and save to SubtitleCache.

    Args:
        conn: persistent SQLite connection (reused across batch)
        has_english: if already known from cache, skip the YouTube API check
    """
    # Check for English subs if not already known from cache
    if has_english is None:
        has_english = check_subtitles(video_id).get("hasEnglish", False)

    tmpdir = tempfile.mkdtemp()
    try:
        full_audio, duration = download_audio(video_id, tmpdir)

        # Full-audio transcription — better quality than chunking because
        # Whisper has full conversation context. Fine for batch since it
        # runs off-hours and quality matters more than speed.
        segments = []
        segs, _ = model.transcribe(
            full_audio, language="ja", task="translate",
            vad_filter=True, beam_size=5,
            condition_on_previous_text=True,
            word_timestamps=True,
        )
        for seg in segs:
            text = seg.text.strip()
            if not text:
                continue
            w = seg.words
            segments.append({
                "start": round(w[0].start if w else seg.start, 2),
                "end":   round(w[-1].end  if w else seg.end,   2),
                "text": text,
            })

        # Save to database (using persistent connection)
        seg_json = json.dumps(segments)
        conn.execute(
            """INSERT INTO "SubtitleCache" ("videoId", "mediaId", "modelName", "hasEnglishSubs", "segments", "lastEnCheckAt")
               VALUES (?, ?, 'medium', ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT("videoId") DO UPDATE SET
                 "mediaId" = COALESCE(excluded."mediaId", "SubtitleCache"."mediaId"),
                 "modelName" = excluded."modelName",
                 "hasEnglishSubs" = excluded."hasEnglishSubs",
                 "segments" = excluded."segments",
                 "lastEnCheckAt" = CURRENT_TIMESTAMP
               WHERE "SubtitleCache"."modelName" IS NULL
                  OR "SubtitleCache"."modelName" IN ('tiny', 'base', 'small')
            """,
            (video_id, media_id, 1 if has_english else 0, seg_json),
        )
        conn.commit()

        return len(segments)

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def is_cached(video_id: str, conn: sqlite3.Connection, min_model: str = "medium") -> bool:
    """Check if a video already has cached segments from a sufficient model.

    Returns False if the video was only translated with a lower-quality model
    (e.g. 'small' on-demand) so the batch can upgrade it to 'medium'.
    Uses the persistent connection passed in (no per-call open/close).
    """
    min_rank = MODEL_RANK.get(min_model, 3)
    row = conn.execute(
        'SELECT "segments", "modelName" FROM "SubtitleCache" WHERE "videoId" = ? LIMIT 1',
        (video_id,),
    ).fetchone()
    if row is None or row[0] is None:
        return False
    cached_rank = MODEL_RANK.get(row[1] or "small", 0)
    return cached_rank >= min_rank


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Batch pre-translate anime trailers")
    parser.add_argument("--season", type=str, help="Season: WINTER, SPRING, SUMMER, FALL")
    parser.add_argument("--year", type=int, help="Year (e.g. 2026)")
    parser.add_argument("--dry-run", action="store_true", help="List trailers without translating")
    parser.add_argument("--cutoff", type=int, default=10, help="Stop after this hour (24h, default: 10)")
    parser.add_argument("--db", type=str, default=None, help="SQLite database path")
    parser.add_argument("--download-delay", type=float, default=5.0, metavar="SECONDS",
                        help="Seconds between trailers to stay polite to YouTube / avoid "
                             "bot-detection (default: 5). Downloads are sequential.")
    parser.add_argument("--all-seasons", action="store_true",
                        help="Process prev + current + next season (3). Default is the "
                             "single current-displayed season only, so a run never hits "
                             "YouTube with more than one season's worth of downloads.")
    args = parser.parse_args()

    # Determine seasons to process. Default = just the current-displayed season
    # (the one the app shows); --all-seasons restores the old 3-season sweep.
    if args.season and args.year:
        seasons_to_process = [(args.season.upper(), args.year)]
    elif args.all_seasons:
        seasons_to_process = get_seasons_to_process()
    else:
        seasons_to_process = [next_season_info()]

    # Determine DB path
    db_path = args.db
    if not db_path:
        db_url = os.environ.get("DATABASE_URL", "")
        if db_url.startswith("file:"):
            raw = db_url[5:]
            # Prisma resolves relative paths from the schema directory (/app/prisma/)
            if not os.path.isabs(raw):
                raw = os.path.join("/app/prisma", raw)
            db_path = os.path.normpath(raw)
        else:
            db_path = "/app/prisma/prisma/data.db"

    print(f"[batch] Seasons: {', '.join(f'{s} {y}' for s, y in seasons_to_process)}")
    print(f"[batch] Database: {db_path}")
    print(f"[batch] Cutoff: {args.cutoff}:00")
    print()

    # Single persistent DB connection and lazily-loaded model reused across all seasons
    conn = sqlite3.connect(db_path)
    model = None
    bot_blocked = False
    try:
        for season, year in seasons_to_process:
            print(f"[batch] -- {season} {year} {'-' * 50}")

            # Fetch anime list
            print(f"[batch] Fetching anime list from AniList...")
            anime = fetch_season_anime(season, year)
            print(f"[batch] Found {len(anime)} total anime for {season} {year}")

            # Filter eligible
            eligible = filter_eligible(anime)
            print(f"[batch] {len(eligible)} eligible trailers (after filtering 18+, sequels, no-trailer)")
            print()

            if not eligible:
                print(f"[batch] Nothing to translate for {season} {year}.")
                print()
                continue

            # Batch cache check — one query per video, reusing connection
            uncached = []
            for show in eligible:
                vid = show["trailer"]["id"]
                row = conn.execute(
                    'SELECT "segments", "modelName", "hasEnglishSubs" FROM "SubtitleCache" WHERE "videoId" = ? LIMIT 1',
                    (vid,),
                ).fetchone()
                if row and row[0] is not None and MODEL_RANK.get(row[1] or "small", 0) >= MODEL_RANK.get("medium", 3):
                    print(f"  [SKIP] {get_display_title(show)} ({vid}) -- already cached ({row[1]})")
                else:
                    reason = f"upgrade from {row[1]}" if row and row[0] else "not cached"
                    has_english = bool(row[2]) if row and row[2] is not None else None
                    uncached.append((show, reason, has_english))

            print()
            print(f"[batch] {len(uncached)} trailers need translation ({len(eligible) - len(uncached)} already cached)")
            print()

            if args.dry_run:
                print(f"[batch] DRY RUN -- {season} {year} trailers that would be translated:")
                for show, reason, _ in uncached:
                    vid = show["trailer"]["id"]
                    print(f"  {show['format']:10s} {get_display_title(show)} ({vid}) [{reason}]")
                print()
                continue

            if not uncached:
                print(f"[batch] All {season} {year} trailers already cached.")
                print()
                continue

            # Load model lazily — once, then reused for all subsequent seasons
            if model is None:
                print(f"[batch] Loading Whisper medium model (int8)... this may take a while on first run")
                from faster_whisper import WhisperModel
                model = WhisperModel("medium", device="cpu", compute_type="int8")
                print(f"[batch] Model loaded.")
                print()

            # Translate with ETA tracking
            translated = 0
            errors = 0
            elapsed_sum = 0.0
            cutoff_hit = False
            for i, (show, reason, has_english) in enumerate(uncached):
                # Time cutoff check — stop all remaining seasons too
                now = datetime.now()
                if now.hour >= args.cutoff:
                    print(f"\n[batch] Cutoff reached ({now.strftime('%H:%M')} >= {args.cutoff}:00). Stopping.")
                    cutoff_hit = True
                    break

                vid = show["trailer"]["id"]
                title = get_display_title(show)

                # ETA based on rolling average
                eta_str = ""
                if translated > 0:
                    avg = elapsed_sum / translated
                    remaining_count = len(uncached) - i
                    eta_min = (avg * remaining_count) / 60
                    eta_str = f" [ETA: {eta_min:.0f}m]"

                print(f"[{i+1}/{len(uncached)}] {title} ({vid}) [{reason}]{eta_str}...")

                # Polite gap between trailers (downloads are sequential). Skip
                # before the first one.
                if i > 0 and args.download_delay:
                    time.sleep(args.download_delay)

                try:
                    start_time = time.time()
                    num_segments = translate_video(model, vid, show["id"], conn, has_english=has_english)
                    elapsed = time.time() - start_time
                    elapsed_sum += elapsed
                    print(f"  Done -- {num_segments} segments in {elapsed:.1f}s")
                    translated += 1
                except Exception as e:
                    if _is_bot_block(str(e)):
                        print(f"\n[batch] ABORT: YouTube bot-challenge ('not a bot') — "
                              f"stopping to avoid deepening the block. Re-run after a cool-down.")
                        bot_blocked = True
                        break
                    print(f"  ERROR: {e}")
                    errors += 1

            print()
            remaining = len(uncached) - translated - errors
            print(f"[batch] {season} {year}: {translated} translated, {errors} errors"
                  + (f", {remaining} remaining" if remaining > 0 else ""))
            print()

            if cutoff_hit or bot_blocked:
                break  # Don't start further seasons after cutoff / bot-block

    finally:
        conn.close()


if __name__ == "__main__":
    main()
