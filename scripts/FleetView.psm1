# Fleet View automation API from PowerShell (README: "Automation API").
#   Import-Module Z:\Github\fleet-view\scripts\FleetView.psm1
#   $s = Start-FleetSession -Repo Z:\Github\fleet-view -Account B -Prompt 'Summarise the README.' -Wait
#   $s.reply
#   (Send-FleetMessage $s.id 'Now in two lines.' -Wait).reply
#   Stop-FleetSession $s.id -Remove
# A throwaway session that leaves no trace on the map once it ends, on a cheap model:
#   $t = Start-FleetSession -Repo Z:\Github\fleet-view -Account B -Prompt 'List the TODOs.' -Model haiku -Effort low -Temp -Wait
#   if ($t.endedBy -eq 'menu') { $t.menu; Send-FleetAnswer $t.id 1 -Sig $t.menu.sig }
# The same from any shell: fv (scripts/fv.js, `fv help`).
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
    # Windows PowerShell 5.1 often leaves ErrorDetails empty: read the reply body from the response itself
    if (-not $msg -and $_.Exception.Response) {
      try { $msg = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream(), [Text.Encoding]::UTF8)).ReadToEnd() } catch {}
    }
    if ($msg) {
      # the whole reply rides on the error as .Exception.Data['reply'] (a stale answer's current menu, say)
      $reply = $null
      try { $reply = $msg | ConvertFrom-Json; if ($reply.message) { $msg = $reply.message } } catch {}
      $ex = New-Object Exception("Fleet View: $msg")
      $ex.Data['reply'] = $reply
      throw $ex
    }
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
    [ValidateLength(1, 80)][string]$Name,
    [ValidatePattern('^[A-Za-z0-9.\-\[\]]{1,60}$')][string]$Model,
    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max')][string]$Effort,
    [string]$ForkFrom,
    [switch]$Temp,
    [switch]$Wait, [int]$WaitSeconds
  )
  $w = waitArg -Wait:$Wait -WaitSeconds $WaitSeconds
  $b = @{ repo = $Repo; account = $Account; prompt = $Prompt; wait = $w }
  if ($null -ne $Chrome) { $b.chrome = [bool]$Chrome }
  if ($Name) { $b.name = $Name }
  if ($Model) { $b.model = $Model }
  if ($Effort) { $b.effort = $Effort }
  if ($ForkFrom) { $b.forkFrom = $ForkFrom }
  if ($Temp) { $b.temp = $true }
  Invoke-Fleet -Method Post -Path '/sessions' -Body $b -TimeoutSec ((timeoutFor $w) + 60)
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

# -Remove also hides it from the map (its log is kept)
function Stop-FleetSession {
  param([Parameter(Mandatory, Position = 0)][string]$Id, [switch]$Remove)
  $b = if ($Remove) { @{ remove = $true } } else { $null }
  Invoke-Fleet -Method Post -Path "/sessions/$Id/stop" -Body $b
}

# Esc once: stops Claude mid-turn (refused while a menu is up: Esc would answer it, use Send-FleetAnswer -Esc)
function Stop-FleetTurn([Parameter(Mandatory, Position = 0)][string]$Id) {
  Invoke-Fleet -Method Post -Path "/sessions/$Id/interrupt" -Body @{}
}

# hides a conversation from the map; refused while it is hosted and alive (Stop-FleetSession -Remove does both)
function Remove-FleetConversation([Parameter(Mandatory, Position = 0)][string]$Id) {
  Invoke-Fleet -Method Post -Path "/sessions/$Id/remove" -Body @{}
}

# the select menu the session shows ({kind, title, context, options:[{n,label,desc,on}], sig}), or $null
function Get-FleetMenu([Parameter(Mandatory, Position = 0)][string]$Id) {
  (Invoke-Fleet -Path "/sessions/$Id/menu").menu
}

# answers the menu: -Option <n>, or -Esc. -Sig (from Get-FleetMenu) refuses if the menu changed since.
# -Text goes with a "Type something." option. A permission or trust prompt needs -AllowPermission: only when
# the user asked for it.
function Send-FleetAnswer {
  param(
    [Parameter(Mandatory, Position = 0)][string]$Id,
    [Parameter(Position = 1)][int]$Option,
    [switch]$Esc, [string]$Sig, [string]$Text, [switch]$AllowPermission,
    [switch]$Wait, [int]$WaitSeconds
  )
  if ($Esc -eq ($Option -gt 0)) { throw 'Give -Option <n> or -Esc (one of them).' }
  $w = waitArg -Wait:$Wait -WaitSeconds $WaitSeconds
  $b = @{ option = $(if ($Esc) { 'esc' } else { $Option }); wait = $w }
  if ($Sig) { $b.sig = $Sig }
  if ($Text) { $b.text = $Text }
  if ($AllowPermission) { $b.allowPermission = $true }
  Invoke-Fleet -Method Post -Path "/sessions/$Id/answer" -Body $b -TimeoutSec (timeoutFor $w)
}

# waits (sending nothing) until the session is ready for you: .endedBy idle, reply, question, menu, apiError, exit, gone
function Wait-FleetSession {
  param([Parameter(Mandatory, Position = 0)][string]$Id, [ValidateRange(1, 3600)][int]$TimeoutSeconds = 1800)
  Invoke-Fleet -Method Post -Path "/sessions/$Id/wait" -Body @{ timeout = $TimeoutSeconds } -TimeoutSec ($TimeoutSeconds + 60)
}

# resumes a conversation Fleet View knows as a session in the desktop app, optionally with a follow-up
function Open-FleetSession {
  param(
    [Parameter(Mandatory, Position = 0)][string]$Id,
    [ValidateSet('A', 'B')][string]$Account, [string]$Prompt,
    [switch]$Wait, [int]$WaitSeconds
  )
  $w = waitArg -Wait:$Wait -WaitSeconds $WaitSeconds
  $b = @{ wait = $w }
  if ($Account) { $b.account = $Account }
  if ($Prompt) { $b.prompt = $Prompt }
  Invoke-Fleet -Method Post -Path "/sessions/$Id/open" -Body $b -TimeoutSec ((timeoutFor $w) + 60)
}

# any conversation's transcript, compact: the last 50 items, or -Since <n> on; -Limit at most 500
function Get-FleetTranscript {
  param([Parameter(Mandatory, Position = 0)][string]$Id, [int]$Since = -1, [ValidateRange(1, 500)][int]$Limit)
  $q = @()
  if ($Since -ge 0) { $q += "since=$Since" }
  if ($Limit -gt 0) { $q += "limit=$Limit" }
  $qs = if ($q.Count) { '?' + ($q -join '&') } else { '' }
  (Invoke-Fleet -Path "/sessions/$Id/transcript$qs").items
}

# every conversation Fleet View shows (not only hosted); -All includes hidden ones
function Get-FleetConversations {
  param([string]$State, [string]$Repo, [switch]$All, [int]$Limit)
  $q = @()
  if ($State) { $q += 'state=' + [uri]::EscapeDataString($State) }
  if ($Repo) { $q += 'repo=' + [uri]::EscapeDataString($Repo) }
  if ($All) { $q += 'all=1' }
  if ($Limit -gt 0) { $q += "limit=$Limit" }
  $qs = if ($q.Count) { '?' + ($q -join '&') } else { '' }
  (Invoke-Fleet -Path "/conversations$qs").conversations
}

Export-ModuleMember -Function Set-FleetPort, Start-FleetSession, Send-FleetMessage, Get-FleetSession, Get-FleetReply, Stop-FleetSession,
  Stop-FleetTurn, Remove-FleetConversation, Get-FleetMenu, Send-FleetAnswer, Wait-FleetSession, Open-FleetSession,
  Get-FleetTranscript, Get-FleetConversations
