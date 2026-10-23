# Build Hermes Portable Package
# Produces a self-contained, sandboxed, relocatable distribution in dist/HermesPortable
# All caches and temp during build are redirected to runtime/ to never touch C: drive.

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# Go defaults its build cache to %LOCALAPPDATA%\go-build; keep it in the checkout.
$env:GOCACHE = Join-Path $Root "runtime\cache\go"
$env:GOMODCACHE = Join-Path $Root "runtime\cache\gomod"
$env:GOTMPDIR = Join-Path $Root "runtime\scratch"
New-Item -ItemType Directory -Force $env:GOCACHE, $env:GOMODCACHE, $env:GOTMPDIR | Out-Null

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " Building Hermes Portable Distribution   " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# 1. Check prerequisites
$PythonExe = Join-Path $Root "runtime\python\python.exe"
$VenvPython = Join-Path $Root "runtime\hermes\hermes-agent\venv\Scripts\python.exe"
$AgentDir = Join-Path $Root "runtime\hermes\hermes-agent"

if (-not (Test-Path $PythonExe)) {
    throw "Missing embedded Python at $PythonExe"
}
if (-not (Test-Path $VenvPython)) {
    throw "Missing agent venv at $VenvPython"
}

# A fresh clone keeps the absolute interpreter path from the machine that
# committed it; Windows venvs need an absolute home, so point it at this checkout.
$PythonHome = Split-Path -Parent $PythonExe
Set-Content -Path (Join-Path $AgentDir "venv\pyvenv.cfg") -Encoding utf8 -Value "home = $PythonHome`r`ninclude-system-site-packages = false`r`nexecutable = $PythonExe`r`n"

# npm workspace junctions are not stored in git (their targets are absolute).
foreach ($link in @(
    @("node_modules\hermes-tui", "ui-tui"),
    @("node_modules\web", "web"),
    @("node_modules\@hermes\ink", "ui-tui\packages\hermes-ink"),
    @("node_modules\@hermes\shared", "apps\shared")
)) {
    $LinkPath = Join-Path $AgentDir $link[0]
    $Target = Join-Path $AgentDir $link[1]
    if (-not (Test-Path $LinkPath) -and (Test-Path $Target)) {
        New-Item -ItemType Directory -Force (Split-Path $LinkPath) | Out-Null
        New-Item -ItemType Junction -Path $LinkPath -Target $Target | Out-Null
    }
}

# 2. Verify all API SDKs in venv
Write-Host "[1/7] Verifying API SDKs in Python venv..." -ForegroundColor Yellow
$VerifyCmd = @"
mods = ['openai', 'anthropic', 'aiohttp', 'httpx', 'pydantic', 'duckduckgo_search', 'ddgs', 'tavily', 'exa_py', 'firecrawl', 'boto3', 'google.auth', 'agent.gemini_native_adapter', 'agent.anthropic_adapter']
missing = []
for m in mods:
    try:
        __import__(m)
    except Exception as e:
        missing.append(f'{m} ({e})')
if missing:
    print('MISSING: ' + ', '.join(missing))
    exit(1)
print('ALL_APIS_VERIFIED')
"@

$verifyResult = & $VenvPython -c $VerifyCmd 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "API verification failed: $verifyResult"
}
Write-Host "  -> All LLM and tool APIs verified (OpenAI, Anthropic, Gemini, Bedrock, Search, etc.)" -ForegroundColor Green

# Ensure sitecustomize.py is in venv
$SiteCustomizeSrc = Join-Path $Root "runtime\hermes\hermes-agent\venv\Lib\site-packages\sitecustomize.py"
if (-not (Test-Path $SiteCustomizeSrc)) {
    Write-Host "  -> Creating sitecustomize.py for Python 3.14 typing compatibility..."
    $SiteCustomizeContent = @"
import inspect
import typing

_original_eval_type = typing._eval_type
_accepts_prefer_fwd_module = "prefer_fwd_module" in inspect.signature(_original_eval_type).parameters

def _eval_type(*args, **kwargs):
    if not _accepts_prefer_fwd_module:
        kwargs.pop("prefer_fwd_module", None)
    return _original_eval_type(*args, **kwargs)

typing._eval_type = _eval_type
"@
    Set-Content -Path $SiteCustomizeSrc -Value $SiteCustomizeContent -Encoding utf8
}

# 3. Bundled tools
# The portable app runs offline with lazy installs off, so every binary the agent
# reaches for must already be in PM's store (HERMES_HOME\tools):
#   cua-driver (computer_use), agent-browser + chromium (browser_*), ffmpeg (media),
#   and node, npm, ripgrep, which PM's store check requires before the launcher's
#   PATH entries mean anything. The first build downloads them; later builds re-verify.
Write-Host "[2/7] Installing bundled tools into runtime\hermes\tools..." -ForegroundColor Yellow
$BundledTools = @("cua-driver", "agent-browser", "ffmpeg", "node", "npm", "ripgrep")
$ToolStore = Join-Path $Root "runtime\hermes\tools"
$SavedEnv = @{}
$ToolEnv = @{
    HERMES_HOME = (Join-Path $Root "runtime\hermes")
    TEMP = (Join-Path $Root "runtime\scratch")
    TMP = (Join-Path $Root "runtime\scratch")
    PYTHONNOUSERSITE = "1"
    UV_CACHE_DIR = (Join-Path $Root "runtime\cache\uv")
    HERMES_DISABLE_LAZY_INSTALLS = $null
    UV_OFFLINE = $null
    PIP_NO_INDEX = $null
}
foreach ($name in $ToolEnv.Keys) {
    $SavedEnv[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    [Environment]::SetEnvironmentVariable($name, $ToolEnv[$name], "Process")
}
Push-Location $AgentDir
try {
    & $VenvPython -m hermes_cli.main pm install @BundledTools
    if ($LASTEXITCODE -ne 0) {
        throw "Installing bundled tools failed"
    }
    $storeProblems = & $VenvPython -c "from pm.install import check; p = check(); print('; '.join(p) if p else 'OK')" 2>&1
    if ($LASTEXITCODE -ne 0 -or "$storeProblems".Trim() -ne "OK") {
        throw "Tool store check failed: $storeProblems"
    }
} finally {
    Pop-Location
    foreach ($name in $SavedEnv.Keys) {
        [Environment]::SetEnvironmentVariable($name, $SavedEnv[$name], "Process")
    }
}
Write-Host "  -> $($BundledTools -join ', ') ready" -ForegroundColor Green

# 4. Compile Launcher
Write-Host "[3/7] Compiling portable launcher Hermes.exe..." -ForegroundColor Yellow
$LauncherDir = Join-Path $Root "scripts\portable-launcher"
Push-Location $LauncherDir
try {
    & go build -ldflags="-H windowsgui -s -w" -o (Join-Path $Root "Hermes.exe") .
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to compile Hermes.exe"
    }
} finally {
    Pop-Location
}
Write-Host "  -> Hermes.exe compiled successfully" -ForegroundColor Green

# 5. Build Production UI and Unpacked App
Write-Host "[4/7] Building production UI (electron-vite build)..." -ForegroundColor Yellow
& node scripts/run-portable.mjs electron-vite build
if ($LASTEXITCODE -ne 0) {
    throw "electron-vite build failed"
}

Write-Host "[5/7] Building unpacked Electron app (electron-builder)..." -ForegroundColor Yellow
& node scripts/run-portable.mjs electron-builder --dir --config.directories.output=dist/builder
if ($LASTEXITCODE -ne 0) {
    throw "electron-builder failed"
}

# 6. Assemble HermesPortable
Write-Host "[6/7] Assembling dist/HermesPortable..." -ForegroundColor Yellow
$PortableDir = Join-Path $Root "dist\HermesPortable"
$PortableRuntime = Join-Path $PortableDir "runtime"
$PortableHermes = Join-Path $PortableRuntime "hermes"
$PortablePython = Join-Path $PortableRuntime "python"
$PortableApp = Join-Path $PortableDir "app"

# Clean any existing user data or state in dist/HermesPortable
if (Test-Path $PortableDir) {
    Write-Host "  -> Cleaning prior build artifacts in $PortableDir..."
    # Keep python and hermes-agent if already there to speed up, but remove logs/dbs/user files
    $UserArtifacts = @(
        (Join-Path $PortableHermes "state.db*"),
        (Join-Path $PortableHermes "kanban.db*"),
        (Join-Path $PortableHermes "projects.db*"),
        (Join-Path $PortableHermes "response_store.db*"),
        (Join-Path $PortableHermes "shared-state.db*"),
        (Join-Path $PortableHermes "runs_idempotency.db*"),
        (Join-Path $PortableHermes "*.log"),
        (Join-Path $PortableHermes ".env"),
        (Join-Path $PortableHermes "models.json"),
        (Join-Path $PortableHermes "models_dev_cache.*"),
        (Join-Path $PortableHermes "provider_models_cache.json"),
        (Join-Path $PortableHermes "desktop.json"),
        (Join-Path $PortableHermes "config.yaml"),
        (Join-Path $PortableHermes "auth.json"),
        (Join-Path $PortableHermes "auth.lock"),
        (Join-Path $PortableHermes "sessions"),
        (Join-Path $PortableHermes "memories"),
        (Join-Path $PortableHermes "profiles"),
        (Join-Path $PortableRuntime "electron"),
        (Join-Path $PortableRuntime "scratch"),
        (Join-Path $PortableRuntime "crashes"),
        (Join-Path $PortableRuntime "cache")
    )
    foreach ($item in $UserArtifacts) {
        if (Test-Path $item) {
            Remove-Item -Path $item -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
} else {
    New-Item -ItemType Directory -Path $PortableDir -Force | Out-Null
}

# Copy Hermes.exe and PORTABLE marker
Copy-Item -Path (Join-Path $Root "Hermes.exe") -Destination (Join-Path $PortableDir "Hermes.exe") -Force
Set-Content -Path (Join-Path $PortableDir "PORTABLE") -Value "Hermes Desktop Portable Root`r`nThis directory is self-contained. All data and caches stay inside runtime/`r`n" -Encoding utf8

# Copy unpacked app
$UnpackedSrc = Join-Path $Root "dist\builder\win-unpacked"
if (-not (Test-Path $UnpackedSrc)) {
    throw "Unpacked app missing at $UnpackedSrc"
}
Write-Host "  -> Copying unpacked app..."
if (Test-Path $PortableApp) {
    Remove-Item -Path $PortableApp -Recurse -Force
}
Copy-Item -Path $UnpackedSrc -Destination $PortableApp -Recurse -Force

# Copy Python runtime
Write-Host "  -> Syncing Python runtime..."
if (-not (Test-Path $PortablePython)) {
    New-Item -ItemType Directory -Path $PortablePython -Force | Out-Null
    Copy-Item -Path (Join-Path $Root "runtime\python\*") -Destination $PortablePython -Recurse -Force
}

# Copy hermes-agent code + venv (excluding .git and caches)
Write-Host "  -> Syncing hermes-agent & pre-installed venv..."
$PortableAgent = Join-Path $PortableHermes "hermes-agent"
if (-not (Test-Path $PortableAgent)) {
    New-Item -ItemType Directory -Path $PortableAgent -Force | Out-Null
}

# Use robocopy to mirror hermes-agent excluding .git and cache dirs
& robocopy $AgentDir $PortableAgent /E /XD ".git" "__pycache__" ".pytest_cache" /XF "*.pyc" "*.lock" /R:1 /W:1 /NJH /NJS /NDL /NC /NS | Out-Null

# Mirror PM's tool store. facts.json stores {{store}}-relative paths, so the copy
# stays valid wherever the folder lands; leftover staging dirs and the lock stay behind.
Write-Host "  -> Syncing bundled tools (cua-driver, agent-browser, chromium, ffmpeg, node, ripgrep)..."
& robocopy $ToolStore (Join-Path $PortableHermes "tools") /MIR /XD ".staging-*" /XF ".install.lock" /R:1 /W:1 /NJH /NJS /NDL /NC /NS /NFL | Out-Null
if ($LASTEXITCODE -ge 8) {
    throw "Copying the tool store failed (robocopy exit $LASTEXITCODE)"
}

# 7. Final setup of clean portable directories
Write-Host "[7/7] Finalizing clean runtime layout..." -ForegroundColor Yellow
foreach ($dir in @(
    (Join-Path $PortableRuntime "electron"),
    (Join-Path $PortableRuntime "scratch"),
    (Join-Path $PortableRuntime "crashes"),
    (Join-Path $PortableRuntime "cache\pyc"),
    (Join-Path $PortableRuntime "cache\pip"),
    (Join-Path $PortableRuntime "cache\uv"),
    (Join-Path $PortableRuntime "cache\electron")
)) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}

# Ensure pyvenv.cfg in portable agent points to current python
$PortableVenvCfg = Join-Path $PortableAgent "venv\pyvenv.cfg"
$CfgContent = "home = $PortablePython`r`ninclude-system-site-packages = false`r`nexecutable = $(Join-Path $PortablePython 'python.exe')`r`n"
Set-Content -Path $PortableVenvCfg -Value $CfgContent -Encoding utf8

# Ensure install-stamp has updateMechanism: "packaged" so no self-updates are attempted
$StampFile = Join-Path $PortableAgent "install-stamp.json"
if (Test-Path $StampFile) {
    try {
        $stampJson = Get-Content $StampFile -Raw | ConvertFrom-Json
        $stampJson.updateMechanism = "packaged"
        $stampJson | ConvertTo-Json -Depth 5 | Set-Content $StampFile -Encoding utf8
    } catch {
        # best effort
    }
}

Write-Host "=========================================" -ForegroundColor Green
Write-Host " BUILD COMPLETE!                         " -ForegroundColor Green
Write-Host " Portable folder: $PortableDir" -ForegroundColor Green
Write-Host " Launcher:        $(Join-Path $PortableDir 'Hermes.exe')" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
