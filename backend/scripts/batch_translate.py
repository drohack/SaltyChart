"""
Batch pre-translation of anime trailers for upcoming seasons.

Safety net behind the local GPU script (tools/local_translate.py) which runs
large-v3 every Sunday with no window gate, covering 3 seasons. This batch
runs on Wednesdays within 50 days, catching any trailers the local run missed.

Uses the Whisper `medium` model (int8 quantized, ~1.5GB RAM) with full-audio
transcription (no chunking) for better quality than the on-demand `small` model.
Videos previously translated with `small` are automatically upgraded to `medium`.
Will NOT downgrade a `large-v3` translation from the local GPU script.

Fetches the anime list from AniList, filters to eligible shows (TV, TV_SHORT,
OVA, ONA, SPECIAL -- skipping 18+, sequels, no-trailer), and translates each
trailer. By default a run covers ONLY the single current-displayed season, so
it never hits YouTube with more than one season's worth of downloads;
--all-seasons restores the old prev+current+next sweep. Downloads are
sequential with a polite gap between trailers (--download-delay; the default is
DOWNLOAD_DELAY_DEFAULT in translate_stream.py, reasoning at its definition).
Results are saved to SubtitleCache in SQLite using a single persistent
connection for the entire batch run.

The script is resumable: checks SubtitleCache before each video and skips
already-translated ones (at medium quality or better). Respects a time cutoff
(default 10am) for safe overnight scheduling. Logs ETA based on rolling average.

Usage:
  python3 -u batch_translate.py                          # current-displayed season only
  python3 -u batch_translate.py --all-seasons            # prev + current + next
  python3 -u batch_translate.py --season SPRING --year 2026
  python3 -u batch_translate.py --dry-run                # list trailers only
  python3 -u batch_translate.py --cutoff 10              # stop by 10am
  python3 -u batch_translate.py --download-delay 20      # slower / politer to YouTube

Note: use -u flag for unbuffered stdout when spawned as a child process.

Exit code is the run's verdict (translate_stream.run_verdict): 0 fine, 2 most
downloads failed, 3 aborted on a YouTube bot-challenge. The backend stores it
(persistBatchRun) and /admin/subtitles renders a non-zero code as a failed run.
yt-dlp is self-upgraded before the first download unless --no-update/--dry-run.

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
from translate_stream import (download_audio, check_subtitles, DOWNLOAD_DELAY_DEFAULT,
                              is_bot_block, classify_error, run_verdict, ensure_ytdlp_current,
                              MODEL_RANK)

# Run-wide tallies for the exit verdict. Per-season counters already existed and
# were printed; nothing ever added them up or looked at the total, which is how a
# run with 46 of 49 downloads failing exited 0. See run_verdict.
RUN_STATS = {"attempted": 0, "errors": 0, "kinds": {}, "aborted": False}

# MODEL_RANK is imported from translate_stream (one Python definition; the
# TypeScript twin is lib/subtitleReport.ts and test_run_verdict.py asserts they
# are equal). It used to be a third hand-synced copy here, and a missing
# 'large-v3-split' in any copy made that path rank the Sunday champion output as
# 0 and re-transcribe the whole season for a no-op write.

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
    """[(season, year), ...] for prev, current-displayed, and next season -
    rationale at local_translate.get_seasons_to_process."""
    current, year = next_season_info()
    idx = SEASONS.index(current)

    prev_idx = (idx - 1) % 4
    prev_year = year - (1 if prev_idx == 3 else 0)   # WINTER->FALL wraps back a year

    next_idx = (idx + 1) % 4
    next_year = year + (1 if next_idx == 0 else 0)   # FALL->WINTER wraps forward a year

    return [
        (SEASONS[prev_idx], prev_year),
        (current, year),
        (SEASONS[next_idx], next_year),
    ]


# ---------------------------------------------------------------------------
# Translation
# ---------------------------------------------------------------------------

# The detector lives in translate_stream.is_bot_block - one definition for the
# container. This alias keeps the call sites below readable and greppable.
_is_bot_block = is_bot_block


def translate_video(model, video_id: str, media_id: int, conn: sqlite3.Connection,
                     has_english: bool = None):
    """Translate a single video and save to SubtitleCache.

    Args:
        conn: persistent SQLite connection (reused across batch)
        has_english: if already known from cache, skip the YouTube API check
    """
    # Check for English subs if not already known from cache. THREE-valued:
    # True / False are verdicts; None means the check could not find out (IP
    # block, package missing, timeout) and must NOT be written as "no CC" -
    # that pinned a false negative for seven days per transient block.
    if has_english is None:
        has_english = check_subtitles(video_id).get("hasEnglish")

    tmpdir = tempfile.mkdtemp()
    try:
        full_audio, duration = download_audio(video_id, tmpdir)

        # Full-audio transcription - better quality than chunking because
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

        # Save to database (using persistent connection). The CC verdict is
        # the third write site after the two in routes/translate.ts (which go
        # through lib/subtitleCheck.ts checkVerdict): a None verdict binds NULL,
        # COALESCE keeps whatever verdict the row already had, and the check
        # timestamp only moves when a real verdict was written - otherwise a
        # failed check would be trusted as "checked, no CC" for seven days.
        seg_json = json.dumps(segments)
        en_val = None if has_english is None else int(bool(has_english))
        conn.execute(
            """INSERT INTO "SubtitleCache" ("videoId", "mediaId", "modelName", "hasEnglishSubs", "segments", "lastEnCheckAt")
               VALUES (?, ?, 'medium', ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END)
               ON CONFLICT("videoId") DO UPDATE SET
                 "mediaId" = COALESCE(excluded."mediaId", "SubtitleCache"."mediaId"),
                 "modelName" = excluded."modelName",
                 "hasEnglishSubs" = COALESCE(excluded."hasEnglishSubs", "SubtitleCache"."hasEnglishSubs"),
                 "segments" = excluded."segments",
                 "lastEnCheckAt" = CASE WHEN excluded."hasEnglishSubs" IS NULL
                                        THEN "SubtitleCache"."lastEnCheckAt" ELSE CURRENT_TIMESTAMP END
               WHERE "SubtitleCache"."modelName" IS NULL
                  OR "SubtitleCache"."modelName" IN ('tiny', 'base', 'small')
            """,
            (video_id, media_id, en_val, seg_json, en_val),
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

# Prisma's schema directory, and the base a relative DATABASE_URL resolves
# against. Derived from this file rather than hardcoded, so it is right in the
# image (/app/scripts -> /app/prisma) and in the repo (backend/scripts ->
# backend/prisma) without either knowing about the other.
SCHEMA_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "prisma")
)


def main():
    # Show titles carry characters cp1252 cannot encode - a Cyrillic "o" in
    # `Jyuou Mujin Dandivine` is what found this - and Python on Windows encodes
    # REDIRECTED stdout as cp1252, not UTF-8. The backend always spawns this
    # through a pipe, so one such title raised UnicodeEncodeError and killed the
    # whole run. `errors='replace'` is the backstop: a console that cannot
    # represent a glyph should mangle one title, never lose the run.
    #
    # Every script in tools/ already did this; none of the three in
    # backend/scripts/ did, which is exactly backwards - these are the ones
    # something else always pipes.
    import sys as _sys
    if hasattr(_sys.stdout, 'reconfigure'):
        _sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    if hasattr(_sys.stderr, 'reconfigure'):
        _sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description="Batch pre-translate anime trailers")
    parser.add_argument("--season", type=str, help="Season: WINTER, SPRING, SUMMER, FALL")
    parser.add_argument("--year", type=int, help="Year (e.g. 2026)")
    parser.add_argument("--dry-run", action="store_true", help="List trailers without translating")
    parser.add_argument("--cutoff", type=int, default=10, help="Stop after this hour (24h, default: 10)")
    parser.add_argument("--db", type=str, default=None, help="SQLite database path")
    parser.add_argument("--download-delay", type=float, default=DOWNLOAD_DELAY_DEFAULT, metavar="SECONDS",
                        help="Seconds between trailers to stay polite to YouTube / avoid "
                             "bot-detection (default: %(default)s). Downloads are sequential.")
    parser.add_argument("--no-update", action="store_true",
                        help="Skip the yt-dlp self-upgrade at the start of the run (it is "
                             "best-effort and skipped on --dry-run anyway)")
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
            # Prisma resolves a relative DATABASE_URL from the SCHEMA directory,
            # so that is what a relative path has to be joined to.
            #
            # That base was hardcoded to `/app/prisma` - the container's layout -
            # which is right in production and cannot be right anywhere else. The
            # stock dev `DATABASE_URL` is `file:./prisma/data.db`, so off the
            # container it resolved to `/app/prisma/prisma/data.db` and the run
            # died with "unable to open database file". It stayed hidden because
            # nothing on screen could start a batch; the moment /admin/subtitles
            # grew a Run-now button, every dev-machine run failed.
            #
            # Deriving it from this file's own location is correct in BOTH: the
            # script sits at <base>/scripts/ and the schema at <base>/prisma/,
            # in the image (/app/scripts, /app/prisma) and in the repo
            # (backend/scripts, backend/prisma) alike.
            if not os.path.isabs(raw):
                raw = os.path.join(SCHEMA_DIR, raw)
            db_path = os.path.normpath(raw)
        else:
            db_path = os.path.join(SCHEMA_DIR, "prisma", "data.db")

    print(f"[batch] Seasons: {', '.join(f'{s} {y}' for s, y in seasons_to_process)}")
    print(f"[batch] Database: {db_path}")
    print(f"[batch] Cutoff: {args.cutoff}:00")
    print()

    # Before the first download, not on a timer: a stale yt-dlp is the one
    # failure that takes out every trailer at once. See ensure_ytdlp_current.
    if not args.dry_run and not args.no_update:
        ensure_ytdlp_current(say=lambda s: print(f"[batch] {s}", flush=True))
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

            # Batch cache check - one query per video, reusing connection
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

            # Load model lazily - once, then reused for all subsequent seasons
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
                # Time cutoff check - stop all remaining seasons too
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
                        print(f"\n[batch] ABORT: YouTube bot-challenge ('not a bot') - "
                              f"stopping to avoid deepening the block. Re-run after a cool-down.")
                        bot_blocked = True
                        RUN_STATS["aborted"] = True
                        break
                    print(f"  ERROR: {e}")
                    errors += 1
                    kind = classify_error(e)
                    RUN_STATS["kinds"][kind] = RUN_STATS["kinds"].get(kind, 0) + 1

            print()
            remaining = len(uncached) - translated - errors
            RUN_STATS["attempted"] += translated + errors
            RUN_STATS["errors"] += errors
            print(f"[batch] {season} {year}: {translated} translated, {errors} errors"
                  + (f", {remaining} remaining" if remaining > 0 else ""))
            print()

            if cutoff_hit or bot_blocked:
                break  # Don't start further seasons after cutoff / bot-block

    finally:
        conn.close()

    # The verdict is the LAST line and the exit code. The backend's
    # persistBatchRun() stores the code and the log tail, and /admin/subtitles
    # already renders a non-zero code as a failed run - it just never received
    # one before, because this function used to end here with no exit at all.
    code, line = run_verdict(RUN_STATS["attempted"], RUN_STATS["errors"], RUN_STATS["kinds"], RUN_STATS["aborted"])
    print(line, flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
