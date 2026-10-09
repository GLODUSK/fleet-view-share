# Fleet View automation API from PowerShell (README: "Automation API").
#   Import-Module Z:\Github\fleet-view\scripts\FleetView.psm1
#   $s = Start-FleetSession -Repo Z:\Github\fleet-view -Account B -Prompt 'Summarise the README.' -Wait
#   $s.reply
#   (Send-FleetMessage $s.id 'Now in two lines.' -Wait).reply
#   Stop-FleetSession $s.id
# Everything runs in the calling PowerShell over local HTTP: no window, console or process is started.

$script:Port = 4777

function Set-FleetPort([int]$Port) { $script:Port = $Port }

function Invoke-Fleet {
  param([string]$Method = 'Get', [string]$Path, $Body, [int]$TimeoutSec = 30)
  $file = Join-Path $env:LOCALAPPDATA 'fleet-view\api-token'
  if (-not (Test-Path $file)) { throw "No API token at $file. Start Fleet View once to make it." }
  $token = (Get-Content -Raw $file).Trim()
  $a = @{
    Method = $Method; Uri = "http://127.0.0.1:$script:Port/api$Path"; TimeoutSec = $TimeoutSec
    Headers = @{ Authorization = "Bearer $token" }
  }
  if ($null -ne $Body) {
    # bytes, so Windows PowerShell 5.1 sends UTF-8 rather than its default Latin-1
    $a.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress -Depth 5))
    $a.ContentType = 'application/json; charset=utf-8'
  }
  try { Invoke-RestMethod @a }
  catch {
    # the API's own message ("no such hosted session", ...) rather than PowerShell's generic one
    $msg = $_.ErrorDetails.Message
    if ($msg) { try { $msg = ($msg | ConvertFrom-Json).message } catch {} ; throw "Fleet View: $msg" }
    throw
  }
}

# -Wait: until Claude's turn ends, then the reply is in .reply (-WaitSeconds sets the limit, default 1800)
function waitArg([switch]$Wait, [int]$WaitSeconds) {
  if ($WaitSeconds -gt 0) { return $WaitSeconds }
  if ($Wait) { return $true }
  return $false
}
function timeoutFor($w) {
  if ($w -is [bool]) { if ($w) { return 1800 + 120 } else { return 120 } }
  return [int]$w + 120
}

function Start-FleetSession {
  param(
    [Parameter(Mandatory)][string]$Repo,
    [Parameter(Mandatory)][ValidateSet('A', 'B')][string]$Account,
    [Parameter(Mandatory)][string]$Prompt,
    [Nullable[bool]]$Chrome,
    [switch]$Wait, [int]$WaitSeconds
  )
  $w = waitArg -Wait:$Wait -WaitSeconds $WaitSeconds
  $b = @{ repo = $Repo; account = $Account; prompt = $Prompt; wait = $w }
  if ($null -ne $Chrome) { $b.chrome = [bool]$Chrome }
  Invoke-Fleet -Method Post -Path '/sessions' -Body $b -TimeoutSec (timeoutFor $w)
}

function Send-FleetMessage {
  param(
    [Parameter(Mandatory, Position = 0)][string]$Id,
    [Parameter(Mandatory, Position = 1)][string]$Text,
    [switch]$Wait, [int]$WaitSeconds
  )
  $w = waitArg -Wait:$Wait -WaitSeconds $WaitSeconds
  Invoke-Fleet -Method Post -Path "/sessions/$Id/message" -Body @{ text = $Text; wait = $w } -TimeoutSec (timeoutFor $w)
}

function Get-FleetSession {
  param([Parameter(Position = 0)][string]$Id, [int]$Tail)
  if (-not $Id) { return (Invoke-Fleet -Path '/sessions').sessions }
  $q = if ($Tail -gt 0) { "?tail=$Tail" } else { '' }
  Invoke-Fleet -Path "/sessions/$Id$q"
}

function Get-FleetReply([Parameter(Mandatory, Position = 0)][string]$Id) { (Get-FleetSession $Id).lastReply }

function Stop-FleetSession([Parameter(Mandatory, Position = 0)][string]$Id) {
  Invoke-Fleet -Method Post -Path "/sessions/$Id/stop"
}

Export-ModuleMember -Function Set-FleetPort, Start-FleetSession, Send-FleetMessage, Get-FleetSession, Get-FleetReply, Stop-FleetSession
