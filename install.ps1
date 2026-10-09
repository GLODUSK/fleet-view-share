# Fleet View installer: run once after cloning, and again after a pull to update.
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-StartAtSignIn] [-NoDesktop] [-NoLaunch]
# It checks Node 18+, git and Claude Code, installs the desktop window's packages (desktop/, Electron and node-pty),
# puts this folder on your user PATH so "fleet-view" works in any new console, and starts Fleet View.
# Nothing here needs admin rights, and nothing leaves this machine: Fleet View reads your own ~/.claude and
# serves its page on 127.0.0.1 only.
param([switch]$StartAtSignIn, [switch]$NoDesktop, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
function Say($t) { Write-Host "  $t" }
function Fail($t) { Write-Host "  $t" -ForegroundColor Red; exit 1 }
Write-Host "`nFleet View setup ($dir)`n" -ForegroundColor Cyan

if ($env:OS -ne 'Windows_NT') { Fail 'Fleet View runs on Windows 10/11 only.' }

# ---------- what it needs ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js is missing. Install it (winget install OpenJS.NodeJS.LTS), open a new PowerShell window and run this again.' }
$major = [int]((& node -v).Trim().TrimStart('v').Split('.')[0])
if ($major -lt 18) { Fail "Node $major is too old: Fleet View needs 18 or newer (winget upgrade OpenJS.NodeJS.LTS)." }
Say "Node $(& node -v)"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git is missing. Install it (winget install Git.Git) and run this again.' }
if (Get-Command claude -ErrorAction SilentlyContinue) { Say 'Claude Code found' }
else { Write-Host '  Claude Code is not installed yet: npm install -g @anthropic-ai/claude-code, then run "claude" once to log in.' -ForegroundColor Yellow }
if (-not (Test-Path (Join-Path $HOME '.claude'))) { Write-Host '  No ~/.claude folder yet: run "claude" once and log in with your Claude account, or Fleet View has nothing to show.' -ForegroundColor Yellow }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Say 'Optional: the GitHub CLI (winget install GitHub.cli, then gh auth login) adds PR and merge tracking.' }

# ---------- update: pull when this is a git checkout ----------
if (Test-Path (Join-Path $dir '.git')) {
  & git -C $dir pull --ff-only --quiet
  if ($LASTEXITCODE -ne 0) { Write-Host '  git pull failed (local changes?); carrying on with what is here.' -ForegroundColor Yellow }
}

# ---------- the desktop window (Electron); without it Fleet View opens in an Edge app window ----------
if (-not $NoDesktop) {
  $desk = Join-Path $dir 'desktop'
  $lock = Join-Path $desk 'package-lock.json'
  $stamp = Join-Path $desk 'node_modules\.fleet-view-lock'
  $want = (Get-FileHash $lock -Algorithm SHA256).Hash
  $have = if (Test-Path $stamp) { (Get-Content $stamp -Raw).Trim() } else { '' }
  if ($have -ne $want -or -not (Test-Path (Join-Path $desk 'node_modules\electron'))) {
    Say 'Installing the desktop window (Electron, about 100 MB, a minute or two)...'
    Push-Location $desk
    try { & npm.cmd ci --no-audit --no-fund --loglevel=error } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Fail 'npm ci in desktop\ failed (see above). Run this again, or add -NoDesktop to use the Edge window.' }
    Set-Content -Path $stamp -Value $want -Encoding ascii
  }
  # some npm setups skip electron's postinstall, which downloads electron.exe: fetch it here then
  if (-not (Test-Path (Join-Path $desk 'node_modules\electron\dist\electron.exe'))) {
    Say 'Downloading electron.exe...'
    & node (Join-Path $desk 'node_modules\electron\install.js')
    if ($LASTEXITCODE -ne 0) { Write-Host '  electron.exe could not be downloaded; Fleet View opens in an Edge window until this runs again.' -ForegroundColor Yellow }
  }
  Say 'Desktop window ready'
}

# ---------- "fleet-view" on the user PATH ----------
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($userPath -split ';' | Where-Object { $_ })
if (-not ($parts | Where-Object { $_.TrimEnd('\') -ieq $dir.TrimEnd('\') })) {
  [Environment]::SetEnvironmentVariable('Path', (($parts + $dir) -join ';'), 'User')
  Say 'Added to your PATH: type fleet-view in any new console window'
} else { Say 'Already on your PATH' }

if ($StartAtSignIn) { & node (Join-Path $dir 'fleet-view.js') --install-startup }

if (-not $NoLaunch) {
  Say 'Starting Fleet View...'
  Start-Process wscript.exe -ArgumentList '//nologo', "`"$(Join-Path $dir 'fleet-view.vbs')`""
}
Write-Host "`n  Done. Next time: type fleet-view, or find Fleet View in the Start menu.`n  Update later: run this script again (it pulls and reinstalls only what changed).`n" -ForegroundColor Green
