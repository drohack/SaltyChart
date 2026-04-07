@echo off
REM Windows wrapper for local_translate.py — uses Python 3.13 via py launcher.
REM Usage: tools\translate.bat --server http://192.168.1.X:8085 -u user -p pass
py -3.13 "%~dp0local_translate.py" %*
