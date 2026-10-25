# Pull the newest backup and rebuild the daily XP table.
# ASCII only: Windows PowerShell 5.1 reads .ps1 as GBK, so any non-ASCII
# literal here would be mangled. The Chinese table header lives in
# _md_header.txt (UTF-8) and the output path is passed in by the caller.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

$pullOutput = & (Join-Path $PSScriptRoot '_pull_backup.ps1') -Quiet
if ($LASTEXITCODE -ne 0) {
  $pullCode = $LASTEXITCODE
  Write-Output $pullOutput
  exit $pullCode
}

$j = Get-Content -LiteralPath (Join-Path $Root 'backup\latest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$cats = @('math', 'eng', 'cs', 'grad', 'vit', 'intel')

$all = @($j.days.PSObject.Properties | Sort-Object Name)
$cum = @{}
$run = 0
foreach ($p in $all) { $run += [int]$p.Value.xp; $cum[$p.Name] = $run }
$total = $run

function Get-Lv([int]$xp) {
  $lv = 1
  $r = $xp
  while ($r -ge (100 + ($lv - 1) * 60)) { $r -= (100 + ($lv - 1) * 60); $lv++ }
  return $lv
}

$today = (Get-Date).ToString('yyyy-MM-dd')
$from = (Get-Date).AddDays(-6).ToString('yyyy-MM-dd')

$rows = New-Object System.Collections.Generic.List[string]
foreach ($p in $all) {
  if ($p.Name -lt $from) { continue }
  $d = $p.Name
  $n = [int]$p.Value.n
  $xp = [int]$p.Value.xp
  $cells = @("| $d | $n | $xp |")
  foreach ($c in $cats) {
    $s = 0
    foreach ($l in $j.log) { if ($l.d -eq $d -and $l.c -eq $c) { $s += [int]$l.xp } }
    $cells += " $s |"
  }
  $c2 = [int]$cum[$d]
  $rows.Add((($cells -join '') + " $c2 | Lv" + (Get-Lv $c2) + " |"))
}

$hasToday = $false
foreach ($r in $rows) { if ($r.StartsWith("| $today |")) { $hasToday = $true } }
if (-not $hasToday) {
  $rows.Add("| $today | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | $total | Lv" + (Get-Lv $total) + " |")
}

$header = Get-Content -LiteralPath (Join-Path $PSScriptRoot '_md_header.txt') -Raw -Encoding UTF8
$md = $header.TrimEnd() + "`r`n" + ($rows -join "`r`n") + "`r`n"
[IO.File]::WriteAllText($Out, $md, (New-Object System.Text.UTF8Encoding($false)))

# ---- one-line summary ----
$tn = 0; $tx = 0
if ($j.days.$today) { $tn = [int]$j.days.$today.n; $tx = [int]$j.days.$today.xp }
$engToday = 0; $mathToday = 0
foreach ($l in $j.log) {
  if ($l.d -eq $today -and $l.c -eq 'eng') { $engToday++ }
  if ($l.d -eq $today -and $l.c -eq 'math') { $mathToday++ }
}

$keys = @($all | ForEach-Object { $_.Name })
$streak = 0
$cursor = Get-Date
while ($true) {
  $k = $cursor.ToString('yyyy-MM-dd')
  if ($keys -contains $k -and [int]$j.days.$k.n -gt 0) { $streak++; $cursor = $cursor.AddDays(-1) }
  elseif ($streak -eq 0 -and $k -eq $today) { $cursor = $cursor.AddDays(-1) }
  else { break }
}

Write-Output ("TODAY=" + $tn + "/" + $tx + " ENG=" + $(if ($engToday -gt 0) { 'yes' } else { 'no' }) + " MATH=" + $(if ($mathToday -gt 0) { 'yes' } else { 'no' }) + " STREAK=" + $streak + " TOTAL=" + $total + " LV=" + (Get-Lv $total))
Write-Output ("OUT=" + $Out)
exit 0
