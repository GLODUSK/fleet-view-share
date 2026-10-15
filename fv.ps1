# fv for PowerShell (found before fv.cmd in the same folder): runs scripts/fv.js with the arguments whole. Through
# fv.cmd, cmd.exe would end a message at its first newline, expand its %VARS% and trip on its quotes and & | < >;
# here they go to node as base64 of UTF-8 JSON in FV_ARGS_B64, which fv.js reads and drops. Text piped in goes to
# node's stdin as UTF-8: $text | fv send <id> --stdin
# [string] keeps a number as typed (an id's start 01234567, not 1234567); a,b comes back as typed too
$list = @(foreach ($a in $args) { if ($a -is [array]) { ($a | ForEach-Object { [string]$_ }) -join ',' } else { [string]$a } })
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $list -Compress)))
# Windows caps one environment variable at 32767 characters
if ($b64.Length -gt 32000) {
  [Console]::Error.WriteLine('fv: the arguments are too long to pass; put the text in a file and give --file <path> (or pipe it in with --stdin)')
  exit 2
}
$fv = Join-Path $PSScriptRoot 'scripts\fv.js'
# the pipe to node is written in $OutputEncoding (ASCII by default in 5.1), read from the global scope
$enc = $global:OutputEncoding
$env:FV_ARGS_B64 = $b64
try {
  $global:OutputEncoding = New-Object System.Text.UTF8Encoding $false
  if ($MyInvocation.ExpectingInput) { $input | & node $fv } else { & node $fv }
} finally {
  $global:OutputEncoding = $enc
  Remove-Item Env:FV_ARGS_B64 -ErrorAction SilentlyContinue
}
exit $LASTEXITCODE
