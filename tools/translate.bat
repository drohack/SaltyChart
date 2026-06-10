@echo off
REM Windows wrapper for local_translate.py — uses Python 3.13 via py launcher.
REM No --within-days flag: always runs and covers all 3 seasons (prev, current,
REM next). Cache-check skips already-translated videos so fast runs are normal.
REM Runs every Sunday at 5am via "SaltyChart Translate" Windows Scheduled Task.
REM Usage: tools\translate.bat --server http://192.168.1.X:8085 -u user -p pass
py -3.13 "%~dp0local_translate.py" --log %*
