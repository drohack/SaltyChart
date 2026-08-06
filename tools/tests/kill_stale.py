"""
Kill stale node and ts-node-dev processes from previous dev sessions.

Run before starting fresh dev servers / smoke tests to ensure:
  - Backend port 3000 is free
  - Frontend port 5173 is free (strictPort=true, so will fail to start otherwise)
  - SQLite DB file isn't locked by a leftover process

Works on Windows + Linux/macOS. It kills whatever is LISTENING on ports 3000
and 5173 - it does not inspect command lines, so anything else parked on those
ports goes too. In practice that is only ever a stale ts-node-dev or vite, but
don't run it while something you care about holds either port. Note it frees
the *ports* only: ts-node-dev pairs from old sessions that aren't listening
survive it (and can still hold the Prisma engine DLL - see CLAUDE.md
Troubleshooting).

Usage:
  py -3.13 tools/tests/kill_stale.py
"""
import os
import subprocess
import sys


def kill_listeners_on_port(port: int) -> list[int]:
    """Return PIDs that were holding the port (killed if any)."""
    killed: list[int] = []
    if sys.platform == "win32":
        # netstat -ano then taskkill /PID N /F
        r = subprocess.run(["netstat", "-ano"], capture_output=True, text=True)
        for line in r.stdout.splitlines():
            if f":{port}" in line and "LISTENING" in line:
                pid = line.split()[-1]
                try:
                    subprocess.run(["taskkill", "/PID", pid, "/F"],
                                   capture_output=True, check=True)
                    killed.append(int(pid))
                except subprocess.CalledProcessError:
                    pass
    else:
        # lsof -ti:PORT | xargs kill -9
        r = subprocess.run(["lsof", "-ti", f":{port}"], capture_output=True, text=True)
        for pid in r.stdout.strip().splitlines():
            if pid.strip():
                try:
                    os.kill(int(pid), 9)
                    killed.append(int(pid))
                except OSError:
                    pass
    return killed


def main():
    print("Killing stale processes holding dev ports...", flush=True)
    for port in (3000, 5173):
        killed = kill_listeners_on_port(port)
        if killed:
            print(f"  port {port}: killed PIDs {killed}", flush=True)
        else:
            print(f"  port {port}: already free", flush=True)
    print("Done - safe to start fresh dev servers.", flush=True)


if __name__ == "__main__":
    main()
