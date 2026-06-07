@echo off
chcp 65001 >nul
title RabiRoute AstrBot Adapter 部署脚本
setlocal enabledelayedexpansion

:: ============================================
:: RabiRoute → AstrBot Agent Adapter 一键部署
:: ============================================

for %%I in ("%~dp0..") do set "RABIROUTE_DIR=%%~fI"
if "%ASTRBOT_PLUGINS_DIR%"=="" set "ASTRBOT_PLUGINS_DIR=%USERPROFILE%\.astrbot\data\plugins\rabiroute_agent"

echo [1/5] 检查 RabiRoute 项目目录...
if not exist "%RABIROUTE_DIR%\package.json" (
    echo [错误] 未找到 RabiRoute 项目: %RABIROUTE_DIR%
    exit /b 1
)
echo  ✓

echo [2/5] 部署 AstrBot 插件...
if not exist "%ASTRBOT_PLUGINS_DIR%" mkdir "%ASTRBOT_PLUGINS_DIR%"
copy /Y "%RABIROUTE_DIR%\scripts\rabiroute_agent\metadata.yaml" "%ASTRBOT_PLUGINS_DIR%" >nul 2>&1
copy /Y "%RABIROUTE_DIR%\scripts\rabiroute_agent\main.py" "%ASTRBOT_PLUGINS_DIR%" >nul 2>&1
if %errorlevel% neq 0 (
    echo  [注意] 插件文件已由部署脚本内置，无需从 RabiRoute 复制
    echo  [提示] 请确保以下文件存在:
    echo         %ASTRBOT_PLUGINS_DIR%\metadata.yaml
    echo         %ASTRBOT_PLUGINS_DIR%\main.py
)
echo  ✓

echo [3/5] 检查 RabiRoute 端文件...
set FILES_OK=1
if not exist "%RABIROUTE_DIR%\src\agentAdapters\astrbotAdapter.ts" (
    echo  [错误] 缺少 astrbotAdapter.ts
    set FILES_OK=0
)
if not exist "%RABIROUTE_DIR%\src\agentAdapters\types.ts" (
    echo  [错误] 缺少 types.ts
    set FILES_OK=0
)
if !FILES_OK! equ 0 (
    echo [失败] 请先放置 RabiRoute 适配文件
    exit /b 1
)
echo  ✓

echo [4/5] 构建 RabiRoute 后端...
cd /d "%RABIROUTE_DIR%"
call npm run build:backend
if %errorlevel% neq 0 (
    echo [错误] 后端构建失败
    exit /b 1
)
echo  ✓

echo [5/5] 构建 RabiRoute 前端...
call npm run webgui:build
if %errorlevel% neq 0 (
    echo [错误] 前端构建失败
    exit /b 1
)
echo  ✓

echo.
echo ============================================
echo  AstrBot Adapter 部署完成!
echo ============================================
echo.
echo  使用前请设置环境变量:
echo    set ASTRBOT_URL=http://127.0.0.1:6185
echo    set ASTRBOT_USERNAME=你的用户名
echo    set ASTRBOT_PASSWORD=你的密码
echo    set AGENT_ADAPTERS=["astrbot"]
echo.
echo  或通过 RabiRoute WebGUI 网关配置:
echo    Agent → AstrBot → 填写地址
echo.
echo  然后重启 RabiRoute Manager 即可生效
echo.
echo  WebGUI 调用部署脚本时会自动退出；如果从终端运行，请查看上方输出。
