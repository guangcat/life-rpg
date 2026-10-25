# Validate by default; publish only when explicitly invoked with -Publish.
param([switch]$Publish,[string]$Branch='main')
$ErrorActionPreference='Stop'
$Root=Split-Path -Parent $PSScriptRoot
$ToolName=Split-Path -Leaf $PSScriptRoot
& node (Join-Path $PSScriptRoot '_selftest.js')
if($LASTEXITCODE -ne 0){throw 'Regression checks failed; nothing published'}
$Files=@('index.html','app.css','app.mjs','sw.js','manifest.webmanifest','icon-180.png','icon-192.png','icon-512.png','README.md','.github/workflows/ci.yml')
$Files+=@(Get-ChildItem -LiteralPath (Join-Path $Root 'modules') -File -Filter '*.mjs' | ForEach-Object {'modules/'+$_.Name})
$Files+=@(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'tests') -File -Filter '*.test.mjs' | ForEach-Object {$ToolName+'/tests/'+$_.Name})
$Files+=@('_selftest.js','_deploy.ps1','README.md','preview.cjs','browser-smoke.cjs','_pull_backup.ps1','_sync_to_kaoyan.ps1','_md_header.txt','_make_icons.py') | ForEach-Object {$ToolName+'/'+$_}
foreach($File in $Files){if(-not(Test-Path -LiteralPath (Join-Path $Root $File))){throw ('Missing publish file: '+$File)}}
if(-not $Publish){Write-Output ('Validated '+$Files.Count+' public source files. No remote changes. Use -Publish after reviewing.');exit 0}
$GH=(Get-Command gh -ErrorAction SilentlyContinue).Source
if(-not $GH){throw 'GitHub CLI not found. Install it or publish through the connected GitHub tool.'}
function Api([string]$Method,[string]$Endpoint,$Body=$null){
  $apiArgs=@('api','--method',$Method,$Endpoint)
  $requestFile=$null
  if($null -ne $Body){$requestFile=Join-Path $env:TEMP ([IO.Path]::GetRandomFileName()+'.json');[IO.File]::WriteAllText($requestFile,($Body|ConvertTo-Json -Depth 12 -Compress),(New-Object Text.UTF8Encoding($false)));$apiArgs+=@('--input',$requestFile)}
  try{$response=& $GH @apiArgs;if($LASTEXITCODE -ne 0){throw ('GitHub request failed: '+$Endpoint)};return (($response -join "`n")|ConvertFrom-Json)}
  finally{if($requestFile -and (Test-Path -LiteralPath $requestFile)){Remove-Item -LiteralPath $requestFile}}
}
$Repo='guangcat/life-rpg'
$ref=Api 'GET' "/repos/$Repo/git/ref/heads/$Branch"
$head=$ref.object.sha
$commit=Api 'GET' "/repos/$Repo/git/commits/$head"
$swPath=Join-Path $Root 'sw.js'
$sw=[IO.File]::ReadAllText($swPath)
$cache='liferpg-'+(Get-Date -Format 'yyyyMMddHHmmss')
$sw=[regex]::Replace($sw,"const CACHE = '[^']*';","const CACHE = '$cache';")
[IO.File]::WriteAllText($swPath,$sw,(New-Object Text.UTF8Encoding($false)))
$entries=@()
foreach($File in $Files){$blob=Api 'POST' "/repos/$Repo/git/blobs" @{content=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $Root $File)));encoding='base64'};$entries+=@{path=$File;mode='100644';type='blob';sha=$blob.sha}}
$tree=Api 'POST' "/repos/$Repo/git/trees" @{base_tree=$commit.tree.sha;tree=$entries}
$newCommit=Api 'POST' "/repos/$Repo/git/commits" @{message='Improve Life RPG learning flow and reliable offline state';tree=$tree.sha;parents=@($head)}
$latest=Api 'GET' "/repos/$Repo/git/ref/heads/$Branch"
if($latest.object.sha -ne $head){throw 'Branch advanced during upload; no ref was changed. Review the newer commit before retrying.'}
$null=Api 'PATCH' "/repos/$Repo/git/refs/heads/$Branch" @{sha=$newCommit.sha;force=$false}
Write-Output ('Pushed '+$newCommit.sha+' to '+$Branch+'. Verify GitHub checks and Pages before reporting the live site updated.')
