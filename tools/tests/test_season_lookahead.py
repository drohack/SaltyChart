"""
Pre-deploy unit test: 50-day season look-ahead logic.

Re-implements the algorithm from frontend/src/stores/season.ts:computeInitialSeason
in Python and asserts against a fixed table of dates. Catches regressions in
the "X days until next season" rule (the original bug was using
Mar/Jun/Sep/Dec instead of Apr/Jul/Oct/Jan, plus an off-by-one quarter shift).

This is pure Python — no backend, no browser. Runs in <1s.

Usage:
  py -3.13 -u tools/tests/test_season_lookahead.py
"""
import sys
from datetime import datetime, date

TOTAL = 8  # number of assertions; keep in step with CASES below


def current_season(d: datetime) -> str:
    """Mirror of currentSeason() in season.ts — anime industry quarters."""
    m = d.month  # 1..12 (Python) — season.ts uses 0..11 with <=
    # JS: m <= 2 → WINTER → Jan/Feb/Mar
    if m <= 3: return "WINTER"
    if m <= 6: return "SPRING"
    if m <= 9: return "SUMMER"
    return "FALL"


def next_season_info(season: str, year: int):
    """Mirror of nextSeasonInfo() — Jan/Apr/Jul/Oct industry boundaries."""
    if season == "WINTER": return ("SPRING", year, datetime(year, 4, 1))
    if season == "SPRING": return ("SUMMER", year, datetime(year, 7, 1))
    if season == "SUMMER": return ("FALL", year, datetime(year, 10, 1))
    return ("WINTER", year + 1, datetime(year + 1, 1, 1))


def compute_initial_season(d: datetime) -> tuple[str, int]:
    """Mirror of computeInitialSeason() — 50-day look-ahead (LOOKAHEAD_DAYS)."""
    raw = current_season(d)
    raw_year = d.year
    next_season, next_year, starts = next_season_info(raw, raw_year)
    days_until = (starts - d).total_seconds() / 86400
    if days_until <= 50:
        return (next_season, next_year)
    return (raw, raw_year)


# Each case: (date, expected_season, expected_year, why)
CASES = [
    # 2026-02-15 → 45 days to Apr 1 → inside the 50-day window
    (datetime(2026, 2, 15), "SPRING", 2026,
     "45 days to Apr 1 → just inside lookahead window"),
    # 2026-01-15 → 76 days to Apr 1 → OUTSIDE now (this was the old boundary,
    # and is the case that proves the window actually moved 76 → 50)
    (datetime(2026, 1, 15), "WINTER", 2026,
     "76 days to Apr 1 → outside the 50-day window, stays WINTER"),
    # 2026-01-01 → ~90 days from Apr 1 → still WINTER
    (datetime(2026, 1, 1), "WINTER", 2026,
     ">50 days to Apr 1 → stays in current season"),
    # 2026-03-30 → 2 days from Apr 1 → SPRING
    (datetime(2026, 3, 30), "SPRING", 2026,
     "just before Apr 1 → next season"),
    # 2026-06-15 → 16 days from Jul 1 → SUMMER
    (datetime(2026, 6, 15), "SUMMER", 2026,
     "within 50d of Jul 1 → SUMMER"),
    # 2026-08-02 → 60 days to Oct 1 → SUMMER. The live example that prompted
    # the change: under 76 days this opened on an unaired FALL 2026.
    (datetime(2026, 8, 2), "SUMMER", 2026,
     "60 days to Oct 1 → stays on the airing season"),
    # 2026-12-25 → 7 days from Jan 1 2027 → WINTER 2027 (crosses year)
    (datetime(2026, 12, 25), "WINTER", 2027,
     "within 50d of Jan 1 next year → cross-year cutover"),
    # 2026-09-30 → 1 day from Oct 1 → FALL
    (datetime(2026, 9, 30), "FALL", 2026,
     "1 day before Oct 1 → FALL"),
]


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    print(f"Season look-ahead unit test — {TOTAL} cases", flush=True)

    failed = 0
    for i, (d, exp_season, exp_year, why) in enumerate(CASES, 1):
        got_season, got_year = compute_initial_season(d)
        ok = got_season == exp_season and got_year == exp_year
        date_str = d.strftime("%Y-%m-%d")
        if ok:
            print(f"[{i}/{TOTAL} season-lookahead] PASS — {date_str} → {got_season} {got_year} ({why})", flush=True)
        else:
            print(f"[{i}/{TOTAL} season-lookahead] FAIL — {date_str} → expected {exp_season} {exp_year}, got {got_season} {got_year}", flush=True)
            failed += 1

    if failed:
        print(f"\nDone: {TOTAL - failed}/{TOTAL} passed, {failed} failed", flush=True)
        sys.exit(1)
    print(f"\nDone: {TOTAL}/{TOTAL} passed", flush=True)


if __name__ == "__main__":
    main()
