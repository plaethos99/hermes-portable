# Stage the portable build inputs for commit, without personal data.
#
# scripts/build-portable.ps1 needs runtime/python (embedded CPython) and
# runtime/hermes/hermes-agent (agent checkout + pre-installed venv). runtime/ is
# gitignored because it is also the dev Hermes home (profiles, keys, sessions),
# so only those two folders are force-added here. The agent checkout carries
# its own nested .gitignore files (which would drop venv/ and node_modules/),
# hence -f, with bytecode and absolute-path junctions excluded by pathspec.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Python = "runtime/python"
$Agent = "runtime/hermes/hermes-agent"

$Exclude = @(
    "$Python/**/__pycache__/**", "$Agent/**/__pycache__/**", "$Python/**/*.pyc", "$Agent/**/*.pyc",
    "$Agent/.web_ui_build.lock",
    # Its eol=lf/crlf rules would rewrite line endings in the venv; see info/attributes below
    "$Agent/.gitattributes",
    # npm workspace junctions with absolute targets; build-portable.ps1 recreates them
    "$Agent/node_modules/hermes-tui", "$Agent/node_modules/web",
    "$Agent/node_modules/@hermes/ink", "$Agent/node_modules/@hermes/shared"
)

# .git/info/attributes outranks the nested agent .gitattributes during add, so
# files are stored byte-for-byte (the root .gitattributes covers fresh clones).
$GitDir = & git rev-parse --git-dir
$InfoAttr = Join-Path $GitDir "info/attributes"
New-Item -ItemType Directory -Force (Split-Path $InfoAttr) | Out-Null
Set-Content -Path $InfoAttr -Value "$Python/** -text -eol`r`n$Agent/** -text -eol" -Encoding ascii

# git stops at a nested .git and would record the agent as an embedded repo, so
# its history (a clone of NousResearch/hermes-agent) is parked during the add.
$AgentGit = Join-Path $Agent ".git"
$Parked = Join-Path $Agent ".git-parked"
if (Test-Path $AgentGit) { Rename-Item $AgentGit ".git-parked" }
try {
    $Pathspecs = @($Python, $Agent, ":(exclude)$Agent/.git-parked") + ($Exclude | ForEach-Object { ":(exclude,glob)$_" })
    & git add -f -A -- @Pathspecs
    if ($LASTEXITCODE -ne 0) { throw "git add failed" }
} finally {
    if (Test-Path $Parked) { Rename-Item $Parked ".git" }
}

Write-Host "Staged $Python and $Agent (bytecode and personal data excluded)." -ForegroundColor Green
