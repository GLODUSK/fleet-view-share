# Fleet View installer: run once after cloning, and again to update (it pulls first).
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-StartAtSignIn] [-NoDesktop] [-NoLaunch]
# It checks Node 18+, git and Claude Code, installs the desktop window's packages (desktop/, Electron and node-pty),
# puts this folder on your user PATH so "fleet-view" and "fv" work in any new console, installs the fleet-view skill
# and the fleet-view-feed mod into every Claude login (~/.claude and each ~/.claude-<letter>), and starts Fleet View.
# Run again while Fleet View runs, it puts the update in: when the desktop packages changed it asks to quit Fleet View
# first (the sessions open again when it starts); a changed session host or window restarts by itself.
# Nothing here needs admin rights, and nothing leaves this machine: Fleet View reads your own ~/.claude and
# serves its page on 127.0.0.1 only.
param([switch]$StartAtSignIn, [switch]$NoDesktop, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$desk = Join-Path $dir 'desktop'
function Say($t) { Write-Host "  $t" }
function Warn($t) { Write-Host "  $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host "  $t" -ForegroundColor Red; exit 1 }

# every Claude login: ~/.claude, and each ~/.claude-<letter> (the same rule Fleet View uses for its accounts)
function Get-ClaudeLogins {
  @(Get-ChildItem -LiteralPath $HOME -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\.claude(-[a-z])?$' } | Sort-Object Name)
}

# Fleet View's processes that run from this folder's desktop\node_modules: the window, the server it started and
# the session host (all electron.exe), which npm ci can't replace while they run
function Get-DesktopProcesses {
  $mods = (Join-Path $desk 'node_modules') + '\'
  @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($mods, [StringComparison]::OrdinalIgnoreCase) })
}

# Closes the window the way its close button does (the sessions keep running in the host), and waits up to 15 s for
# it to go. True when it went. A main window hidden behind the mini view comes back on the first try and closes on the next.
function Close-Window {
  for ($i = 0; $i -lt 15; $i++) {
    $wins = @(Get-DesktopProcesses | Where-Object { $_.CommandLine -like '*--url=*' })
    if (-not $wins.Count) { return $true }
    foreach ($w in $wins) { try { [void](Get-Process -Id $w.ProcessId -ErrorAction Stop).CloseMainWindow() } catch {} }
    Start-Sleep -Seconds 1
  }
  return -not @(Get-DesktopProcesses | Where-Object { $_.CommandLine -like '*--url=*' }).Count
}

# Quits Fleet View the way the tray's "Quit everything" does: the window closes, then the session host saves the
# restore list, ends every session and exits (desktop\quit-all.js). True once nothing runs from desktop\node_modules.
function Stop-FleetView {
  if (-not (Close-Window)) { return $false }
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & node (Join-Path $desk 'quit-all.js') | ForEach-Object { Say $_ } } finally { $ErrorActionPreference = $prev }
  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-DesktopProcesses).Count) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

# Adds a folder to the user PATH as it is in the registry: the raw value (an unexpanded %USERPROFILE%\... stays as it
# is) written back as REG_EXPAND_SZ, then the change is announced so new consoles see it. True when it was added.
function Send-EnvChange {
  # setting a user variable announces the change (WM_SETTINGCHANGE); this one is removed again at once
  [Environment]::SetEnvironmentVariable('FLEET_VIEW_PATH_CHANGED', '1', 'User')
  [Environment]::SetEnvironmentVariable('FLEET_VIEW_PATH_CHANGED', $null, 'User')
}
function Add-UserPath($folder) {
  $key = Get-Item -LiteralPath 'HKCU:\Environment'
  $raw = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  $parts = @($raw -split ';' | Where-Object { $_ })
  if ($parts | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $folder.TrimEnd('\') }) { return $false }
  New-ItemProperty -LiteralPath 'HKCU:\Environment' -Name 'Path' -Value (($parts + $folder) -join ';') -PropertyType ExpandString -Force | Out-Null
  Send-EnvChange
  return $true
}

# dot-sourced (tests): the functions above only
if ($MyInvocation.InvocationName -eq '.') { return }

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
else { Warn 'Claude Code is not installed yet. In PowerShell: irm https://claude.ai/install.ps1 | iex   then run "claude" once to log in, and run this again.' }
if (-not (Test-Path (Join-Path $HOME '.claude'))) { Warn 'No ~/.claude folder yet: run "claude" once and log in with your Claude account, then run this again (it installs the skill and the mod there).' }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Say 'Optional: the GitHub CLI (winget install GitHub.cli, then gh auth login) adds PR and merge tracking.' }

# ---------- update: pull when this is a git checkout ----------
# $changed: the files the pull changed, so a running Fleet View can take them in below
$changed = @()
if (Test-Path (Join-Path $dir '.git')) {
  $old = (& git -C $dir rev-parse HEAD).Trim()
  # npm install (not npm ci) rewrites desktop\package-lock.json; this script installs from the committed one
  if (& git -C $dir status --porcelain --untracked-files=no -- desktop/package-lock.json) {
    & git -C $dir checkout -- desktop/package-lock.json
    Say 'desktop\package-lock.json was changed here (npm install does that): put back as it was'
  }
  & git -C $dir pull --ff-only --quiet
  if ($LASTEXITCODE -ne 0) { Warn 'git pull failed (local changes?); carrying on with what is here.' }
  $new = (& git -C $dir rev-parse HEAD).Trim()
  if ($old -and $new -and $old -ne $new) { $changed = @(& git -C $dir diff --name-only $old $new) }
}

# ---------- the desktop window (Electron); without it Fleet View opens in an Edge app window ----------
$relaunch = $false
if (-not $NoDesktop) {
  $lock = Join-Path $desk 'package-lock.json'
  $stamp = Join-Path $desk 'node_modules\.fleet-view-lock'
  $want = (Get-FileHash $lock -Algorithm SHA256).Hash
  $have = if (Test-Path $stamp) { (Get-Content $stamp -Raw).Trim() } else { '' }
  if ($have -ne $want -or -not (Test-Path (Join-Path $desk 'node_modules\electron'))) {
    # npm ci empties node_modules first: never under a running window or session host
    if ((Get-DesktopProcesses).Count) {
      $quit = 'Fleet View is running, and this update changes its desktop window''s packages, so it has to quit first. Choose "Quit everything" from its tray icon (the orange diamond by the clock), then run this again.'
      if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { Fail $quit }
      Write-Host '  Fleet View is running, and this update changes its desktop window''s packages, so it has to quit first.' -ForegroundColor Yellow
      Write-Host '  Its window closes and its Claude sessions end; they open again when Fleet View starts (a session mid-turn is told to carry on).' -ForegroundColor Yellow
      $answer = Read-Host '  Quit Fleet View now? [y/N]'
      if ($answer -notmatch '^\s*y') { Fail $quit }
      Say 'Quitting Fleet View...'
      if (-not (Stop-FleetView)) { Fail $quit }
      $relaunch = $true
    }
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
    if ($LASTEXITCODE -ne 0) { Warn 'electron.exe could not be downloaded; Fleet View opens in an Edge window until this runs again.' }
  }
  Say 'Desktop window ready'
}

# ---------- a running Fleet View takes in what the pull changed (as "Update now" does) ----------
# fleet-view.js and web/ reload by themselves; a changed host.js or handoff.js restarts the session host once no
# session is mid-turn (it resumes them); any other change in desktop/ restarts the window (the sessions stay)
if ($changed.Count -and (Get-DesktopProcesses).Count) {
  if ($changed | Where-Object { $_ -match '^(desktop/host\.js|handoff\.js)$' }) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & node (Join-Path $desk 'restart-host.js') | ForEach-Object { Say $_ } } finally { $ErrorActionPreference = $prev }
  }
  $windowOpen = @(Get-DesktopProcesses | Where-Object { $_.CommandLine -like '*--url=*' }).Count
  if ($windowOpen -and ($changed | Where-Object { $_ -match '^desktop/' -and $_ -notmatch '^desktop/host\.js$' })) {
    if (Close-Window) { Say 'Restarting the Fleet View window (the sessions keep running)...'; $relaunch = $true }
    else { Warn 'The Fleet View window did not close; close it and open Fleet View again to load the update.' }
  }
}

# ---------- "fleet-view" and "fv" on the user PATH ----------
if (Add-UserPath $dir) { Say 'Added to your PATH: type fleet-view (or fv) in any new console window' } else { Say 'Already on your PATH' }
# and on this console's own PATH, which Fleet View started below inherits: its sessions find fv at once
if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $dir.TrimEnd('\') })) { $env:Path = "$dir;$env:Path" }

# ---------- the fleet-view skill, so Claude Code sessions know the fv command ----------
# into each Claude login there is (~/.claude and every ~/.claude-<letter>); replaced on every run, and refreshed by
# the in-app update too
$skill = Join-Path $dir 'skills\fleet-view\SKILL.md'
foreach ($login in Get-ClaudeLogins) {
  if (-not (Test-Path $skill)) { break }
  $to = Join-Path $login.FullName 'skills\fleet-view'
  # a skills\fleet-view that is a link (to this folder's skill, say) is left as it is: copying would copy onto itself
  $link = Get-Item $to -Force -ErrorAction SilentlyContinue
  if ($link -and $link.LinkType) { Say "Skill fleet-view in ~/$($login.Name) is a link; left as it is"; continue }
  try {
    New-Item -ItemType Directory -Force $to | Out-Null
    Copy-Item $skill (Join-Path $to 'SKILL.md') -Force
    Say "Skill fleet-view installed in ~/$($login.Name)"
  } catch { Warn "Could not install the skill fleet-view in ~/$($login.Name): $($_.Exception.Message)" }
}

# ---------- the fleet-view-feed mod: each claude tells Fleet View when a turn starts and ends and what runs ----------
# The mod folder is a marketplace read in place, so a git pull updates it; new sessions load the new copy.
# claude's own warnings on stderr must not stop this script: PowerShell 5.1 turns a redirected stderr line into an
# error, which 'Stop' would make fatal
$mods = Join-Path $dir 'mod'
if ((Test-Path (Join-Path $mods '.claude-plugin\marketplace.json')) -and (Get-Command claude -ErrorAction SilentlyContinue)) {
  $prevCfg = $env:CLAUDE_CONFIG_DIR
  $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    foreach ($login in Get-ClaudeLogins) {
      $cfg = $login.Name
      $env:CLAUDE_CONFIG_DIR = $(if ($cfg -eq '.claude') { $null } else { $login.FullName })
      $known = (& claude plugin marketplace list 2>$null) -join "`n"
      if ($known -notmatch '\bfleet-view\b') { & claude plugin marketplace add $mods *> $null }
      & claude plugin install fleet-view-feed@fleet-view --scope user *> $null
      if ($LASTEXITCODE -eq 0) { Say "Live feed mod installed in ~/$cfg" }
      else { Warn "Could not install the live feed mod in ~/$cfg (claude plugin install fleet-view-feed@fleet-view); Fleet View works without it." }
    }
  } finally { $env:CLAUDE_CONFIG_DIR = $prevCfg; $ErrorActionPreference = $prevEap }
}

if ($StartAtSignIn) { & node (Join-Path $dir 'fleet-view.js') --install-startup }

# the version now here (version.js: 1.0.12), so "which version are you on" has an answer
$ver = "$(& node (Join-Path $dir 'version.js') 2>$null)".Trim()
if ($ver) { Say "Fleet View $ver" }

# a Fleet View this script quit or closed starts again, -NoLaunch or not
if (-not $NoLaunch -or $relaunch) {
  Say 'Starting Fleet View...'
  Start-Process wscript.exe -ArgumentList '//nologo', "`"$(Join-Path $dir 'fleet-view.vbs')`""
}
Write-Host "`n  Done. Next time: type fleet-view, or find Fleet View in the Start menu.`n  Update later: run this script again (it pulls and reinstalls only what changed).`n" -ForegroundColor Green
