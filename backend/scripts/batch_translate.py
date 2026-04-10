"""
Batch pre-translation of anime trailers for upcoming seasons.

Uses the Whisper `medium` model (int8 quantized, ~1.5GB RAM) for higher quality
than the on-demand `small` model.  Videos previously translated with `small` are
automatically upgraded to `medium`.

Fetches the anime list for a given season from AniList, filters to eligible
shows (TV, TV_SHORT, OVA, ONA, SPECIAL — skipping 18+, sequels, no-trailer),
and translates each trailer.  Results are saved to SubtitleCache in SQLite.

The script is resumable: checks SubtitleCache before each video and skips
already-translated ones (at medium quality or better).  Respects a time cutoff
(default 10am) for safe overnight scheduling.

Usage:
  python3 -u batch_translate.py                          # auto-detect next season
  python3 -u batch_translate.py --season SPRING --year 2026
  python3 -u batch_translate.py --dry-run                # list trailers only
  python3 -u batch_translate.py --cutoff 10              # stop by 10am

Note: use -u flag for unbuffered stdout when spawned as a child process.

Scheduling (Unraid User Scripts):
  Cron: 0 2 1-31 3,6,9,12 1-5
  Command: docker exec saltychart-backend python3 -u /app/scripts/batch_translate.py --cutoff 10

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
from translate_stream import download_audio

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
    """Return (season, year) for the next upcoming season."""
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


# ---------------------------------------------------------------------------
# Translation
# ---------------------------------------------------------------------------

def translate_video(model, video_id: str, media_id: int, db_path: str):
    """Translate a single video and save to SubtitleCache (including English sub check)."""
    # Check for English subs first (saves a Python spawn when user opens the trailer)
    has_english = check_subtitles(video_id).get("hasEnglish", False)

    tmpdir = tempfile.mkdtemp()
    try:
        # Download audio
        full_audio, duration = download_audio(video_id, tmpdir)

        # Full-audio transcription — better quality than chunking because
        # Whisper has full conversation context (e.g. translates greetings
        # correctly instead of keeping Japanese). Fine for batch since it
        # runs off-hours and quality matters more than speed.
        segments = []
        segs, _ = model.transcribe(
            full_audio, language="ja", task="translate",
            vad_filter=True, beam_size=5,
            condition_on_previous_text=True
        )
        for seg in segs:
            text = seg.text.strip()
            if not text:
                continue
            segments.append({
                "start": round(seg.start, 2),
                "end": round(seg.end, 2),
                "text": text,
            })

        # Save to database
        seg_json = json.dumps(segments)
        conn = sqlite3.connect(db_path)
        try:
            # Only overwrite if existing model is lower rank than medium.
            # This prevents downgrading a large-v3 translation from local GPU.
            conn.execute(
                """INSERT INTO "SubtitleCache" ("videoId", "mediaId", "modelName", "hasEnglishSubs", "segments")
                   VALUES (?, ?, 'medium', ?, ?)
                   ON CONFLICT("videoId") DO UPDATE SET
                     "mediaId" = COALESCE(excluded."mediaId", "SubtitleCache"."mediaId"),
                     "modelName" = excluded."modelName",
                     "hasEnglishSubs" = excluded."hasEnglishSubs",
                     "segments" = excluded."segments"
                   WHERE "SubtitleCache"."modelName" IS NULL
                      OR "SubtitleCache"."modelName" IN ('tiny', 'base', 'small')
                """,
                (video_id, media_id, 1 if has_english else 0, seg_json),
            )
            conn.commit()
        finally:
            conn.close()

        return len(segments)

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def is_cached(video_id: str, db_path: str, min_model: str = "medium") -> bool:
    """Check if a video already has cached segments from a sufficient model.

    Returns False if the video was only translated with a lower-quality model
    (e.g. 'small' on-demand) so the batch can upgrade it to 'medium'.
    """
    MODEL_RANK = {"tiny": 0, "base": 1, "small": 2, "medium": 3, "large-v2": 4, "large-v3": 5}
    min_rank = MODEL_RANK.get(min_model, 3)

    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            'SELECT "segments", "modelName" FROM "SubtitleCache" WHERE "videoId" = ? LIMIT 1',
            (video_id,),
        ).fetchone()
        if row is None or row[0] is None:
            return False
        cached_rank = MODEL_RANK.get(row[1] or "small", 0)
        return cached_rank >= min_rank
    finally:
        conn.close()


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
    args = parser.parse_args()

    # Determine season
    if args.season and args.year:
        season, year = args.season.upper(), args.year
    else:
        season, year = next_season_info()

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

    print(f"[batch] Season: {season} {year}")
    print(f"[batch] Database: {db_path}")
    print(f"[batch] Cutoff: {args.cutoff}:00")
    print()

    # Fetch anime list
    print(f"[batch] Fetching anime list from AniList...")
    anime = fetch_season_anime(season, year)
    print(f"[batch] Found {len(anime)} total anime for {season} {year}")

    # Filter eligible
    eligible = filter_eligible(anime)
    print(f"[batch] {len(eligible)} eligible trailers (after filtering 18+, sequels, no-trailer)")
    print()

    if not eligible:
        print("[batch] Nothing to translate.")
        return

    # Check which are already cached (single DB connection for all checks)
    uncached = []
    conn = sqlite3.connect(db_path)
    try:
        for show in eligible:
            vid = show["trailer"]["id"]
            row = conn.execute(
                'SELECT "segments", "modelName" FROM "SubtitleCache" WHERE "videoId" = ? LIMIT 1',
                (vid,),
            ).fetchone()
            MODEL_RANK = {"tiny": 0, "base": 1, "small": 2, "medium": 3, "large-v2": 4, "large-v3": 5}
            if row and row[0] is not None and MODEL_RANK.get(row[1] or "small", 0) >= MODEL_RANK.get("medium", 3):
                print(f"  [SKIP] {get_display_title(show)} ({vid}) — already cached ({row[1]})")
            else:
                reason = f"upgrade from {row[1]}" if row and row[0] else "not cached"
                uncached.append((show, reason))
    finally:
        conn.close()

    print()
    print(f"[batch] {len(uncached)} trailers need translation ({len(eligible) - len(uncached)} already cached)")
    print()

    if args.dry_run:
        print("[batch] DRY RUN — trailers that would be translated:")
        for show, reason in uncached:
            vid = show["trailer"]["id"]
            print(f"  {show['format']:10s} {get_display_title(show)} ({vid}) [{reason}]")
        return

    if not uncached:
        print("[batch] All trailers already cached. Done!")
        return

    # Load model
    print(f"[batch] Loading Whisper medium model (int8)... this may take a while on first run")
    from faster_whisper import WhisperModel
    model = WhisperModel("medium", device="cpu", compute_type="int8")
    print(f"[batch] Model loaded.")
    print()

    # Translate
    translated = 0
    errors = 0
    for i, (show, reason) in enumerate(uncached):
        # Time cutoff check
        now = datetime.now()
        if now.hour >= args.cutoff:
            print(f"\n[batch] Cutoff reached ({now.strftime('%H:%M')} >= {args.cutoff}:00). Stopping.")
            break

        vid = show["trailer"]["id"]
        title = get_display_title(show)
        print(f"[{i+1}/{len(uncached)}] {title} ({vid}) [{reason}]...")

        try:
            start_time = time.time()
            num_segments = translate_video(model, vid, show["id"], db_path)
            elapsed = time.time() - start_time
            print(f"  Done — {num_segments} segments in {elapsed:.1f}s")
            translated += 1
        except Exception as e:
            print(f"  ERROR: {e}")
            errors += 1

    print()
    remaining = len(uncached) - translated - errors
    print(f"[batch] Complete: {translated} translated, {errors} errors"
          + (f", {remaining} remaining" if remaining > 0 else ""))


if __name__ == "__main__":
    main()
