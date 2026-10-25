# Pull backup.json from the private repo into .\backup\latest.json
# Keep this file pure ASCII: Windows PowerShell 5.1 reads .ps1 as GBK.
# (That is also why the folder is named "backup" and not a Chinese name:
#  a non-ASCII literal inside a .ps1 gets decoded as GBK and silently creates
#  a mojibake directory.)
#
# Used by the daily sync automation. Deliberately read-only with respect to
# the app's own data: it never writes into localStorage, only drops a copy.
param([switch]$Quiet)

$ErrorActionPreference = 'Stop'

$GH   = 'C:\Users\GuangGuang\AppData\Local\Microsoft\WinGet\Packages\GitHub.cli_Microsoft.Winget.Source_8wekyb3d8bbwe\bin\gh.exe'
$Repo = 'guangcat/life-rpg-data'
$File = 'backup.json'
$Dest = Join-Path (Split-Path -Parent $PSScriptRoot) 'backup'

# Resolve the installed CLI without assuming the original package path exists.
if (-not (Test-Path -LiteralPath $GH)) {
  $cli = Get-Command gh -ErrorAction SilentlyContinue
  if (-not $cli) { Write-Output 'CLI_NOT_FOUND: install or locate GitHub CLI'; exit 3 }
  $GH = $cli.Source
}

# Capture diagnostics for classification; never print raw stderr or credentials.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$raw = & $GH api "/repos/$Repo/contents/$File" --jq '.content' 2>&1
$ghCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap

if ($ghCode -ne 0) {
  $diag = ($raw | ForEach-Object { $_.ToString() }) -join "`n"
  if ($diag -match 'HTTP 401|Bad credentials|not logged') {
    Write-Output 'AUTH_FAILED: check GitHub CLI login'; exit 3
  }
  if ($diag -match 'HTTP 403') {
    Write-Output 'FORBIDDEN: check repository permission or rate limit'; exit 3
  }
  if ($diag -match 'HTTP 404') {
    Write-Output 'NOT_FOUND_OR_FORBIDDEN: check repository access and backup path'; exit 2
  }
  if ($diag -match 'no such host|could not resolve|timeout|timed out|TLS|connection|network|dial tcp') {
    Write-Output 'NETWORK_FAILED: check network and retry later'; exit 3
  }
  Write-Output 'REQUEST_FAILED: GitHub CLI request failed; sync state is unknown'; exit 3
}
if (-not $raw) {
  Write-Output 'EMPTY_RESPONSE: no content received; sync state is unknown'
  exit 2
}

# gh returns base64 with newlines; strip them before decoding. Decoding the
# bytes ourselves avoids the PS 5.1 console codepage mangling Chinese text.
$b64 = ($raw -join '') -replace '\s', ''
try {
  $bytes = [Convert]::FromBase64String($b64)
  $text = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($bytes)
  $data = $text | ConvertFrom-Json -ErrorAction Stop
  if ($null -eq $data -or $data -isnot [pscustomobject]) { throw 'Expected backup object' }
  if ($data.days -isnot [pscustomobject] -or $data.attr -isnot [pscustomobject]) { throw 'Missing backup fields' }
  foreach ($p in $data.attr.PSObject.Properties) {
    $value = 0
    if (-not [int]::TryParse([string]$p.Value, [ref]$value) -or $value -lt 0) { throw 'Invalid XP value' }
  }
  foreach ($day in $data.days.PSObject.Properties) {
    if ($day.Value -isnot [pscustomobject]) { throw 'Invalid day object' }
    foreach ($field in @('n', 'xp')) {
      $value = 0
      if (-not [int]::TryParse([string]$day.Value.$field, [ref]$value) -or $value -lt 0) { throw 'Invalid day value' }
    }
  }
  if ($null -ne $data.log) {
    if ($data.log -isnot [array]) { throw 'Invalid log array' }
    foreach ($entry in $data.log) {
      $value = 0
      if ($entry -isnot [pscustomobject] -or -not [int]::TryParse([string]$entry.xp, [ref]$value) -or $value -lt 0) { throw 'Invalid log XP value' }
    }
  }
} catch {
  Write-Output 'INVALID_BACKUP: invalid encoding, JSON, or required backup fields'; exit 4
}
$stamp = (Get-Date).ToString('yyyy-MM-dd')
$out = Join-Path $Dest ("life-rpg-$stamp.json")

$today = $stamp
$n = 0; $xp = 0
if ($data.days -and $data.days.$today) { $n = $data.days.$today.n; $xp = $data.days.$today.xp }
$total = 0
if ($data.attr) { foreach ($p in $data.attr.PSObject.Properties) { $total += [int]$p.Value } }
# Same curve as index.html: need(lv) = 100 + (lv-1)*60
$lv = 1; $left = $total
while ($left -ge (100 + ($lv - 1) * 60)) { $left -= (100 + ($lv - 1) * 60); $lv++ }

# No valid local backup is replaced until decoding, shape checks and summaries succeed.
if (-not (Test-Path -LiteralPath $Dest)) {
  New-Item -ItemType Directory -Path $Dest | Out-Null
}
[IO.File]::WriteAllText($out, $text, (New-Object System.Text.UTF8Encoding($false)))
Copy-Item -LiteralPath $out -Destination (Join-Path $Dest 'latest.json') -Force

if (-not $Quiet) {
  Write-Output ("OK  " + $out)
  Write-Output ("TOTAL_XP=" + $total + "  LV=" + $lv)
  Write-Output ("TODAY=" + $today + "  COUNT=" + $n + "  XP=" + $xp)
}
exit 0
