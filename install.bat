@echo off
setlocal EnableDelayedExpansion
title chunkchomp installer
color 0B
cls

set "ROOT=%~dp0"
set "OCROOT=%USERPROFILE%\.config\opencode"

echo ============================================================
echo   chunkchomp  -  context compaction for OpenCode
echo ============================================================
echo.
echo   Enter = keep the value in [brackets].
echo.

set "OCV="
for /f "delims=" %%v in ('opencode --version 2^>nul') do set "OCV=%%v"
if defined OCV (echo   opencode !OCV! detected.) else (echo   [!] opencode not found on PATH.)
echo.

set "BUILD=1"
if defined OCV for /f "tokens=1 delims=." %%m in ("!OCV!") do if %%m GEQ 2 set "BUILD=2"
echo   Plugin build: OpenCode !BUILD!.x
set /p "ANS=  Use a different build? 1 or 2 [keep]: "
if "!ANS!"=="1" set "BUILD=1"
if "!ANS!"=="2" set "BUILD=2"
echo.

echo   Where should the plugin go?
echo     [1] opencode config  - %OCROOT%\plugins\chunkchomp  (auto-loaded)
echo     [2] custom folder    - raw files into .\chunkchomp, place it anywhere
set /p "MODE=  Choose [1]: "
if "!MODE!"=="" set "MODE=1"

set "TARGET=%OCROOT%\plugins\chunkchomp"
if "!MODE!"=="2" (
  set /p "CDIR=  Custom folder [%CD%]: "
  if "!CDIR!"=="" set "CDIR=%CD%"
  set "TARGET=!CDIR!\chunkchomp"
)
echo   target: !TARGET!
echo.

echo   Where should the settings shortcut go?
echo     [1] Desktop
echo     [2] next to the plugin
echo     [3] none
set /p "SC=  Choose [2]: "
if "!SC!"=="" set "SC=2"
echo.

set "THRESH=2000"
set /p "ANS=  Flag chunks over N tokens [2000]: "
if not "!ANS!"=="" set "THRESH=!ANS!"

set "MAND=150000"
set /p "ANS=  Context size where ?COMPACT becomes !COMPACT [150000]: "
if not "!ANS!"=="" set "MAND=!ANS!"

set "TOK=1"
set /p "ANS=  Use real tokenizers? [Y/n] "
if /i "!ANS!"=="n" set "TOK=0"

set "MODELS="
set /p "ANS=  Restrict to models (comma list, empty = all): "
set "MODELS=!ANS!"

set "TOKSEL=3"
if "!TOK!"=="1" (
  echo.
  echo   Tokenizers
  echo     [1] all 18 families     ~205 MB, exact counts for every supported model
  echo     [2] DeepSeek V4.1 only  ~6.4 MB, pinned build, rest estimates
  echo     [3] none                calibrated estimates only, no download
  set /p "ANS=  Choose [1] "
  if "!ANS!"=="" set "ANS=1"
  set "TOKSEL=!ANS!"
)
echo.

echo ------------------------------------------------------------
echo   target     : !TARGET!
echo   build      : OpenCode !BUILD!.x
echo   threshold  : !THRESH! tok
echo   mandatory  : !MAND! tok
echo   tokenizers : !TOK!
echo   models     : !MODELS!
echo   tokenizers : !TOKSEL!
echo   shortcut   : !SC!
echo ------------------------------------------------------------
set /p "ANS=  Proceed? [Y/n] "
if /i "!ANS!"=="n" goto :cancel

if not exist "!TARGET!" mkdir "!TARGET!"
if errorlevel 1 goto :fail

if "!BUILD!"=="2" (
  copy /y "%ROOT%src\chunkchomp.v2.js" "!TARGET!\index.js" >nul
) else (
  copy /y "%ROOT%src\chunkchomp.v1.js" "!TARGET!\index.js" >nul
)
if errorlevel 1 goto :fail
copy /y "%ROOT%chunkchomp.txt" "!TARGET!\chunkchomp.example.txt" >nul

if not exist "!TARGET!\tools" mkdir "!TARGET!\tools"
copy /y "%ROOT%tools\logs.mjs" "!TARGET!\tools\logs.mjs" >nul
copy /y "%ROOT%tools\ctl.mjs" "!TARGET!\tools\ctl.mjs" >nul
copy /y "%ROOT%INSTRUCTIONS.template.md" "!TARGET!\INSTRUCTIONS_FOR_INSTALLATION.md" >nul
if exist "%ROOT%engine\target\release\chunkchomp-engine.exe" (
  copy /y "%ROOT%engine\target\release\chunkchomp-engine.exe" "!TARGET!\engine.exe" >nul
  echo   [OK] engine : !TARGET!\engine.exe
)

> "!TARGET!\chunkchomp.txt" echo # chunkchomp settings
>>"!TARGET!\chunkchomp.txt" echo # Edit, save, done. Re-read on the next request.
>>"!TARGET!\chunkchomp.txt" echo.
>>"!TARGET!\chunkchomp.txt" echo enabled = true
>>"!TARGET!\chunkchomp.txt" echo thresholdTokens = !THRESH!
>>"!TARGET!\chunkchomp.txt" echo toolThresholds =
>>"!TARGET!\chunkchomp.txt" echo mandatoryAfterTokens = !MAND!
>>"!TARGET!\chunkchomp.txt" echo useTokenizer = !TOK!
>>"!TARGET!\chunkchomp.txt" echo charsPerToken = 4.24
>>"!TARGET!\chunkchomp.txt" echo activeModels = !MODELS!
>>"!TARGET!\chunkchomp.txt" echo protectedTools =
>>"!TARGET!\chunkchomp.txt" echo ignoreTools =
>>"!TARGET!\chunkchomp.txt" echo ignoreToolPrefixes =
>>"!TARGET!\chunkchomp.txt" echo ignoreMcpServers =
>>"!TARGET!\chunkchomp.txt" echo ignorePathPrefixes =
>>"!TARGET!\chunkchomp.txt" echo ignoreCommandPrefixes =

if "!TOKSEL!"=="1" call :download
if "!TOKSEL!"=="2" call :download_ds

if "!SC!"=="1" (
  for /f "delims=" %%d in ('powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"') do set "LINKDIR=%%d"
) else if "!SC!"=="2" (
  set "LINKDIR=!TARGET!"
) else (
  set "LINKDIR="
)

if defined LINKDIR (
  powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut('!LINKDIR!\chunkchomp settings.lnk'); $s.TargetPath='!TARGET!\chunkchomp.txt'; $s.WorkingDirectory='!TARGET!'; $s.Description='chunkchomp parameters'; $s.Save()" >nul 2>&1
  if exist "!LINKDIR!\chunkchomp settings.lnk" echo   shortcut: !LINKDIR!\chunkchomp settings.lnk
)

echo.
echo   [OK] plugin : !TARGET!\index.js
echo   [OK] config : !TARGET!\chunkchomp.txt
echo   [OK] guide  : !TARGET!\INSTRUCTIONS_FOR_INSTALLATION.md
echo.
echo   Usage report is written to:
echo     %USERPROFILE%\.config\opencode\chunkchomp-status.txt
echo   next to opencode.json. It updates on every request.
echo.
if "!MODE!"=="2" (
  echo   Custom install. Add this to opencode.json so OpenCode loads it:
  echo     "plugins": ["!TARGET:\=/!"]
  echo   Configured local paths must be directories, then restart.
) else (
  echo   Installed into the plugins folder, which OpenCode auto-loads.
)
if "!TOKSEL!"=="3" echo   Tokenizers skipped - counting falls back to estimates.
echo   Restart OpenCode to load it.
echo.
pause
exit /b 0

:download
echo   downloading tokenizers to !TARGET!\tok ...
if not exist "!TARGET!\tok" mkdir "!TARGET!\tok"
call :get deepseek-v41 deepseek-ai/DeepSeek-V4.1-Flash
call :get deepseek-v4  deepseek-ai/DeepSeek-V4-Flash
call :get glm         zai-org/GLM-5.3-Flash
call :get ling        inclusionAI/Ling-3.1-flash
call :get ring        inclusionAI/Ring-1T
call :get mimo        XiaomiMiMo/MiMo-V2.6-Flash-RL
call :get minimax     MiniMaxAI/MiniMax-M3.1-Flash
call :get qwen        Qwen/Qwen3.8-Flash-Next
call :get longcat     meituan-longcat/LongCat-2.0
call :get hunyuan     tencent/Hunyuan-A13B-Instruct
call :get seed        ByteDance-Seed/Seed-OSS-36B-Instruct
call :get step        stepfun-ai/Step-3.5-Flash
call :get nemotron    nvidia/Llama-3.1-Nemotron-70B-Instruct-HF
call :get trinity     arcee-ai/Trinity-Large-Preview
call :get inkling     thinkingmachines/Inkling
call :get laguna      poolside/laguna-s-2.1
call :get beam        reflection/Beam-1.0-501B-A23B
call :get gpt         Xenova/gpt-4o
echo   tokenizers done.
exit /b 0

:get
echo     %~1
curl -L --fail --silent --show-error -o "!TARGET!\tok\%~1.json" "https://huggingface.co/%~2/resolve/main/tokenizer.json"
curl -L --fail --silent -o "!TARGET!\tok\%~1.config.json" "https://huggingface.co/%~2/resolve/main/tokenizer_config.json" 2>nul
exit /b 0

:download_ds
echo   downloading the pinned DeepSeek V4.1 tokenizer to %USERPROFILE%\.config\opencode\chunkchomp ...
if not exist "%USERPROFILE%\.config\opencode\chunkchomp" mkdir "%USERPROFILE%\.config\opencode\chunkchomp"
curl -L --fail --silent --show-error -o "%USERPROFILE%\.config\opencode\chunkchomp\tokenizer.json" "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/resolve/main/tokenizer.json"
curl -L --fail --silent -o "%USERPROFILE%\.config\opencode\chunkchomp\tokenizer_config.json" "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/resolve/main/tokenizer_config.json" 2>nul
echo   done.
exit /b 0
:cancel
echo   cancelled, nothing written.
pause
exit /b 1

:fail
echo   install failed.
pause
exit /b 1
