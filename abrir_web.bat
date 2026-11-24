@echo off
cd /d "%~dp0"
py servidor.py --abrir || python servidor.py --abrir
pause
