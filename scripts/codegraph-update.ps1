# CodeGraph updater: keeps the npm-installed CodeGraph on its latest release without breaking what relies on it.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\codegraph-update.ps1 [-Force]
# Henry's PC runs it every 10 minutes: the ClaudeCode-SafeUpdate scheduled task's Update-ClaudeSafe.ps1 calls it last.
# docs\codegraph-update.md is the whole story. In short:
#   1. At most hourly (or now with -Force), ask npm for the latest version.
#   2. Install it only when nothing holds CodeGraph open: no claude.exe (every session runs a CodeGraph MCP server)
#      and no CodeGraph process (a Fleet View index build). npm can't replace the bundled node.exe while it runs.
#      Always `npm i -g`, never `codegraph upgrade`, which also rewrites CLAUDE.md and agent configs.
#   3. Run scripts\codegraph-contract.js. If it passes, keep the new version: Fleet View notices it within 10 minutes and
#      rebuilds every index an older one built. If it fails, go back to the last good version and start a Fleet View
#      session to adapt our code (the doc's "When the contract fails"). That version is not tried again until
#      code-index.js or the contract test changes on main (the fix), or with -Force.
# State and log: %LOCALAPPDATA%\fleet-view\codegraph-update.json and codegraph-update.log.
# For trying the updater itself, point APPDATA (its npm folder) and LOCALAPPDATA at scratch folders and add:
#   -Test            skip the open-sessions check, and start the session with --temp
#   -Version <x.y.z> try that version instead of the latest
param([switch]$Force, [switch]$Test, [string]$Version)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$dir = Join-Path $env:LOCALAPPDATA 'fleet-view'
$log = Join-Path $dir 'codegraph-update.log'
$stateFile = Join-Path $dir 'codegraph-update.json'
New-Item -ItemType Directory -Force $dir | Out-Null
function Log($m) { Add-Content $log ("{0} {1}" -f (Get-Date -f s), $m) }

$mutex = New-Object System.Threading.Mutex($false, 'Local\FleetViewCodeGraphUpdate')
if (-not $mutex.WaitOne(0)) { exit 0 }

$npmDir = Join-Path $env:APPDATA 'npm'
$npm = (Get-Command npm.cmd -EA 0).Source
if (-not $npm) { $npm = 'C:\Program Files\nodejs\npm.cmd' }
$node = (Get-Command node.exe -EA 0).Source
$pkgJson = Join-Path $npmDir 'node_modules\@colbymchenry\codegraph\package.json'
if (-not (Test-Path $pkgJson)) { exit 0 } # not installed with npm: nothing to do

function Installed { try { (Get-Content $pkgJson -Raw | ConvertFrom-Json).version } catch { $null } }
function Newer($a, $b) { try { [version]$a -gt [version]$b } catch { $false } }
function Busy {
  if (Get-Process claude -EA 0) { return $true }
  $cg = Get-CimInstance Win32_Process -Filter "name='node.exe'" -EA 0 | Where-Object { $_.ExecutablePath -like '*\@colbymchenry\*' }
  return [bool]$cg
}
# the fix for a failed version lands in one of these, so a change to them lifts the block
function ContractKey {
  $text = foreach ($f in 'code-index.js', 'scripts\codegraph-contract.js') { Get-Content (Join-Path $repo $f) -Raw -EA 0 }
  $sha = [System.Security.Cryptography.SHA1]::Create()
  ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($text -join "`n"))) | ForEach-Object { $_.ToString('x2') }) -join ''
}
function Install($ver) {
  Log "npm i -g @colbymchenry/codegraph@$ver"
  & $npm i -g "@colbymchenry/codegraph@$ver" --no-audit --no-fund 2>&1 | Select-Object -Last 3 | ForEach-Object { Log "  npm: $_" }
}
function Contract {
  $out = & $node --no-warnings (Join-Path $repo 'scripts\codegraph-contract.js') --bin (Join-Path $npmDir 'codegraph.cmd') 2>&1 | ForEach-Object { "$_" }
  @{ ok = ($LASTEXITCODE -eq 0); out = ($out -join "`n") }
}
function SaveState { $state | ConvertTo-Json -Depth 5 | Set-Content $stateFile -Encoding UTF8 }

# a Fleet View session adapts our code to the version that failed, as docs\codegraph-update.md says
function StartSession {
  $b = $state.blocked
  # one line with no double quotes (PowerShell 5.1 does not escape them for a native command): a multi-line prompt
  # could arrive empty (2026-10-10), so the test's output goes in a file
  $outFile = Join-Path $dir "codegraph-contract-$($b.version).txt"
  Set-Content $outFile $b.reason -Encoding UTF8
  $prompt = "CodeGraph $($b.version) failed Fleet View's CodeGraph contract test, so the updater went back to $($state.good). Adapt our side so $($b.version) passes: follow Z:\Github\fleet-view\docs\codegraph-update.md, section 'When the contract fails', to the end (merge, restart, publish; then the updater installs it by itself). The test's output is in $outFile."
  $fvArgs = @('start', $repo, $prompt, '--name', "CodeGraph $($b.version) update")
  if ($Test) { $fvArgs[2] = "THIS IS A TEST of the CodeGraph updater: change nothing, run nothing, reply only 'test ok'. The prompt it would send: $prompt"; $fvArgs += '--temp' }
  $out = & $node (Join-Path $repo 'scripts\fv.js') @fvArgs 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -eq 0) {
    $state.blocked.session = (($out | Select-Object -First 1) -split '\s+')[0]
    Log "started session $($state.blocked.session) to adapt our code to CodeGraph $($b.version)"
  } else { Log "could not start a session yet (tries again next run): $(($out -join ' ').Trim())" }
  SaveState
}

$state = $null
try { $state = Get-Content $stateFile -Raw -EA Stop | ConvertFrom-Json } catch {}
if (-not $state) { $state = [pscustomobject]@{ lastCheck = $null; latest = $null; good = $null; blocked = $null } }
$cur = Installed
if (-not $state.good) { $state.good = $cur }

# 1. what is the latest release? (hourly)
$due = $Force -or -not $state.lastCheck -or ((Get-Date) - [datetime]$state.lastCheck).TotalMinutes -ge 60
if ($due) {
  $latest = (& $npm view @colbymchenry/codegraph version 2>$null | Select-Object -Last 1)
  if ("$latest".Trim() -match '^\d+\.\d+\.\d+$') { $state.latest = "$latest".Trim() }
  $state.lastCheck = (Get-Date -f s)
  SaveState
}
$latest = $state.latest
if ($Version) { $latest = $Version }
if (-not $latest -or -not (Newer $latest $cur)) { exit 0 }

# a version that failed waits for our fix
if ($state.blocked -and $state.blocked.version -eq $latest -and -not $Force) {
  if ($state.blocked.key -eq (ContractKey)) {
    if (-not $state.blocked.session) { StartSession }
    exit 0
  }
  Log "code-index.js or the contract test changed since CodeGraph $latest failed: trying it again"
}

# 2. install, only with nothing holding CodeGraph open
if (-not $Test -and (Busy)) { exit 0 }
$scripts = & $npm view "@colbymchenry/codegraph@$latest" scripts --json 2>$null | Out-String
if ($scripts -match '"(pre|post)?install"|"prepare"') {
  Log "CodeGraph $latest has npm install scripts; not installing it"
  $state.blocked = [pscustomobject]@{ version = $latest; key = (ContractKey); at = (Get-Date -f s); reason = "its npm package runs install scripts: $($scripts.Trim())"; session = $null }
  SaveState; StartSession; exit 0
}
Log "update: $cur -> $latest"
Install $latest
$now = Installed
if ($now -ne $latest) { Log "update: npm left $now installed; going back to $cur"; Install $cur; exit 0 }

# 3. the contract test
$c = Contract
if ($c.ok) {
  $state.good = $latest; $state.blocked = $null; SaveState
  Log "update: done, CodeGraph $latest passes the contract test"
  exit 0
}
Log "update: CodeGraph $latest failed the contract test; going back to $cur`n$($c.out)"
Install $cur
& (Join-Path $npmDir 'codegraph.cmd') telemetry off *> $null
Log "update: now $(Installed)"
$state.blocked = [pscustomobject]@{ version = $latest; key = (ContractKey); at = (Get-Date -f s); reason = $c.out; session = $null }
SaveState
StartSession
