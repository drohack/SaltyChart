"""Delete the throwaway users the test suite creates.

Every run signs up fresh `smoke_test_*` / `ui_test_*` / `ui_cmp_*` users and
never deletes them - ~90 had accumulated in the dev DB, and every one showed
up auto-checked in Randomize's "Nicknames from" panel, because
`/users-with-ratings` counts them like real people.

Dev-only, and deliberately direct SQLite: there is no delete-user endpoint to
route this through (the app has no account deletion at all), and this only
ever runs on the machine that owns the dev database. `busy_timeout` because
the dev backend holds the same file open.

Usage:
  py -3.13 tools/tests/cleanup_users.py          # run_all.py calls this at startup
"""
import sqlite3
import sys
from pathlib import Path

DB = Path(__file__).resolve().parents[2] / "backend" / "prisma" / "prisma" / "data.db"

# Reused fixtures are NOT here (`jf_test_fixture`, `player_test_fixture`,
# `player_ui_fixture`, `plex_test_fixture`): those tests log back into the
# same account across runs. Everything the suite creates fresh carries a
# 10-digit epoch suffix, so the GLOB below catches every present and future
# throwaway prefix without enumerating them.
PATTERNS = [
    "smoke_test_%", "ui_test_%", "ui_cmp_%", "explore_%", "dup_test_%",
    "fe_smoke_%", "reset_test_%", "sub_test_%", "val_test_%",
    "flow16_%", "flow2x_%", "probe_%", "audit_smoke_%",
]
EPOCH_GLOB = "*_1[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]"


def cleanup() -> int:
    if not DB.exists():
        print(f"cleanup_users: no dev DB at {DB} - nothing to do", flush=True)
        return 0
    con = sqlite3.connect(DB, timeout=15)
    try:
        con.execute("PRAGMA busy_timeout=15000")
        where = " OR ".join("username LIKE ?" for _ in PATTERNS) + " OR username GLOB ?"
        ids = [r[0] for r in con.execute(
            f"SELECT id FROM User WHERE {where}", [*PATTERNS, EPOCH_GLOB])]
        if not ids:
            print("cleanup_users: 0 test users to remove", flush=True)
            return 0
        qs = ",".join("?" * len(ids))
        con.execute(f"DELETE FROM WatchList WHERE userId IN ({qs})", ids)
        con.execute(f"DELETE FROM Settings WHERE userId IN ({qs})", ids)
        con.execute(f"DELETE FROM User WHERE id IN ({qs})", ids)
        con.commit()
        print(f"cleanup_users: removed {len(ids)} test users and their list/settings rows",
              flush=True)
        return len(ids)
    finally:
        con.close()


if __name__ == "__main__":
    try:
        cleanup()
    except sqlite3.OperationalError as e:
        # Locked DB must not block a test run - the users just linger one more run.
        print(f"cleanup_users: skipped ({e})", flush=True)
        sys.exit(0)
