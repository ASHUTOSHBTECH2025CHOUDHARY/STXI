@echo off
echo Starting SentinelX Server...
echo.
echo Make sure GROQ_API_KEY is set:
echo   set GROQ_API_KEY=gsk_xxxx
echo.
cd /d "%~dp0"
python -m uvicorn resume_server:app --port 8000
pause
