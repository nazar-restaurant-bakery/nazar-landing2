#requires -Version 7.0
# Synthetic receipt fixtures only; no hosted connection, password, or success receipt.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$bundle=Split-Path -Parent $PSScriptRoot
$workspace=[IO.Path]::GetFullPath((Join-Path $bundle '../../..'))
$engine=(Get-Process -Id $PID).Path
$runner=Join-Path $bundle 'Operations-Runner.ps1'
$plans=Get-Content -LiteralPath (Join-Path $bundle 'migration-plans.json') -Raw|ConvertFrom-Json -AsHashtable
$targets=Get-Content -LiteralPath (Join-Path $bundle 'targets.json') -Raw|ConvertFrom-Json
$sandbox=$targets.Sandbox;$production=$targets.Production
$fixtures=Join-Path $PSScriptRoot ('fixtures/offline-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixtures)
$results=[Collections.Generic.List[object]]::new()
$utf8=[Text.UTF8Encoding]::new($false)
$before=@{}
if(Test-Path -LiteralPath (Join-Path $bundle 'receipts')) {
 Get-ChildItem -LiteralPath (Join-Path $bundle 'receipts') -File|ForEach-Object{$before[$_.Name]=(Get-FileHash -LiteralPath $_.FullName).Hash}
}

function Write-Json([string]$Path,[object]$Object){
 [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
 [IO.File]::WriteAllText($Path,($Object|ConvertTo-Json -Depth 10),$utf8)
}
function New-Case([string]$Name,[string]$Order,[string]$Target){
 $case=Join-Path $fixtures $Name
 [void][IO.Directory]::CreateDirectory((Join-Path $case 'sql'))
 [IO.File]::WriteAllText((Join-Path $case 'Migration_Sirasi.md'),[IO.File]::ReadAllText((Join-Path $workspace '20_Yonetim/Migration_Sirasi.md')),$utf8)
 foreach($p in $plans.Values){[IO.File]::WriteAllBytes((Join-Path $case ('sql/'+$p.file)),[IO.File]::ReadAllBytes((Join-Path $bundle ('sql/'+$p.file))))}
 $ref=if($Target -eq 'Sandbox'){$sandbox}else{$production}
 foreach($d in $plans[$Order].dependencies){
  $relative=$d.receipt -replace '\{target\}',$Target.ToLowerInvariant()
  Write-Json (Join-Path $case $relative) ([ordered]@{schemaVersion=1;synthetic=$true;order=$d.order;status='PASSED';target=$ref;migrationSha256=$d.sha256;psql='18.6';verifiedAtUtc='2026-10-20T01:00:00.0000000Z';checks=$d.checks;checkCount=if($d.order -eq '12'){26}elseif($plans.ContainsKey($d.order)){$plans[$d.order].postconditions.Count}else{0};password_recorded=$false})
 }
 if($Target -eq 'Production'){
  Write-Json (Join-Path $case "receipts/$Order-sandbox-success.json") ([ordered]@{schemaVersion=1;synthetic=$true;order=$Order;status='PASSED';target=$sandbox;migrationSha256=$plans[$Order].sha256;psql='18.6';verifiedAtUtc='2026-10-20T01:00:00.0000000Z';checks="migration_order_$Order";checkCount=$plans[$Order].postconditions.Count;password_recorded=$false})
 }
 $case
}
function Invoke-Case([string]$Name,[string]$Order,[string]$Target,[string]$Case,[int]$Expected,[string]$Phrase){
 $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$engine;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 foreach($v in @('-NoLogo','-NoProfile','-File',$runner,'-Order',$Order,'-Target',$Target,'-OfflineCheck','-OfflineFixtureRoot',$Case)){[void]$info.ArgumentList.Add($v)}
 $p=[Diagnostics.Process]::new();$p.StartInfo=$info
 [void]$p.Start();$out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync()
 if(-not $p.WaitForExit(30000)){$p.Kill($true);throw 'offline_test_timeout'}
 $text=$out.GetAwaiter().GetResult();$errors=$err.GetAwaiter().GetResult();$actual=$p.ExitCode;$p.Dispose()
 $ok=$actual -eq $Expected -and $text.Contains($Phrase) -and [string]::IsNullOrWhiteSpace($errors)
 $results.Add([pscustomobject]@{name=$Name;passed=$ok;expectedExit=$Expected;actualExit=$actual;output=$text.Trim();errors=$errors.Trim()})
 if(-not $ok){Write-Output "FAILED $Name`n$text`n$errors"}
}
function Mutate-Receipt([string]$Path,[string]$Field,[object]$Value){$r=Get-Content -LiteralPath $Path -Raw|ConvertFrom-Json -AsHashtable;$r[$Field]=$Value;Write-Json $Path $r}

foreach($order in @('11','13')){
 foreach($target in @('Sandbox','Production')){
  $name="valid-$order-$target";$c=New-Case $name $order $target
  Invoke-Case $name $order $target $c 0 'OFFLINE: PASSED'
 }
 $name="missing-prior-$order";$c=New-Case $name $order Sandbox
 $d=$plans[$order].dependencies[-1];$rp=Join-Path $c ($d.receipt -replace '\{target\}','sandbox');Remove-Item -LiteralPath $rp
 Invoke-Case $name $order Sandbox $c 2 'OFFLINE: WAITING'
 $name="missing-own-sandbox-$order";$c=New-Case $name $order Production;Remove-Item -LiteralPath (Join-Path $c "receipts/$order-sandbox-success.json")
 Invoke-Case $name $order Production $c 2 'OFFLINE: WAITING'
 foreach($mutation in @(
  @('wrong-target','target',$production),@('wrong-sha','migrationSha256',('0'*64)),
  @('wrong-psql','psql','18.5'),@('wrong-checks','checks','something_else'),
  @('wrong-schema','schemaVersion',2),@('wrong-count','checkCount',1),
  @('password-receipt-rejected','password_recorded',$true),
  @('future-time','verifiedAtUtc','2099-10-20T01:00:00.0000000Z'),@('non-utc-time','verifiedAtUtc','2026-10-20T01:00:00.0000000-04:00')
 )){
  if($order -eq '11' -and $mutation[1] -in @('schemaVersion','checkCount','password_recorded')){continue}
  $name="$($mutation[0])-$order";$c=New-Case $name $order Sandbox
  $d=$plans[$order].dependencies[-1];$rp=Join-Path $c ($d.receipt -replace '\{target\}','sandbox');Mutate-Receipt $rp $mutation[1] $mutation[2]
  Invoke-Case $name $order Sandbox $c 1 'FAILED'
 }
 $name="sql-tamper-$order";$c=New-Case $name $order Sandbox;$sql=Join-Path $c ('sql/'+$plans[$order].file);[IO.File]::AppendAllText($sql,"-- altered`n",$utf8)
 Invoke-Case $name $order Sandbox $c 1 'FAILED'
 $name="sql-crlf-$order";$c=New-Case $name $order Sandbox;$sql=Join-Path $c ('sql/'+$plans[$order].file);[IO.File]::WriteAllText($sql,([IO.File]::ReadAllText($sql).Replace("`n","`r`n")),$utf8)
 Invoke-Case $name $order Sandbox $c 1 'FAILED'
 $name="sequence-sha-$order";$c=New-Case $name $order Sandbox;$seq=Join-Path $c 'Migration_Sirasi.md';$t=[IO.File]::ReadAllText($seq).Replace($plans[$order].sha256.ToLowerInvariant(),('0'*64));[IO.File]::WriteAllText($seq,$t,$utf8)
 Invoke-Case $name $order Sandbox $c 1 'FAILED'
}
# A former K13/10 success must never substitute for the new same-target 10b prerequisite.
foreach($target in @('Sandbox','Production')){
 $name="old-10-only-11-$target";$c=New-Case $name '11' $target
 $d=$plans['11'].dependencies[0];$rp=Join-Path $c ($d.receipt -replace '\{target\}',$target.ToLowerInvariant());Remove-Item -LiteralPath $rp
 $oldRef=if($target -eq 'Sandbox'){$sandbox}else{$production}
 Write-Json (Join-Path $c ('K13_kanit/'+$target.ToLowerInvariant()+'-success.json')) ([ordered]@{target=$oldRef;migrationSha256='C0717B848CD75864F9410FDCAAE636BC07CDB7581EC70C34EFDF57F6EB1703C1';psql='18.6';verifiedAtUtc='2026-10-20T01:00:00.0000000Z';checks='commission_functions'})
 Invoke-Case $name '11' $target $c 2 'OFFLINE: WAITING'
}
$name='10b-production-cannot-use-sandbox';$c=New-Case $name '11' Production
$d=$plans['11'].dependencies[0];$rp=Join-Path $c ($d.receipt -replace '\{target\}','production');Mutate-Receipt $rp 'target' $sandbox
Invoke-Case $name '11' Production $c 1 'FAILED'
foreach($order in @('13')){
 foreach($m in @(@('order','99'),@('status','FAILED'))){
  $name="wrong-$($m[0])-$order";$c=New-Case $name $order Sandbox;$d=$plans[$order].dependencies[-1];$rp=Join-Path $c ($d.receipt -replace '\{target\}','sandbox');Mutate-Receipt $rp $m[0] $m[1]
  Invoke-Case $name $order Sandbox $c 1 'FAILED'
 }
}
$after=@{}
if(Test-Path -LiteralPath (Join-Path $bundle 'receipts')){Get-ChildItem -LiteralPath (Join-Path $bundle 'receipts') -File|ForEach-Object{$after[$_.Name]=(Get-FileHash -LiteralPath $_.FullName).Hash}}
$receiptOk=($before|ConvertTo-Json -Compress) -ceq ($after|ConvertTo-Json -Compress)
$results.Add([pscustomobject]@{name='hosted-receipts-unchanged';passed=$receiptOk})
$src=[IO.File]::ReadAllText($runner)
$boundary=$src.IndexOf('if ($OfflineCheck) { Write-Output')
$helperCall=$src.IndexOf('    . $helper')
$prompt=$src.IndexOf('Read-Host ')
$results.Add([pscustomobject]@{name='offline-boundary-before-helper-password-db';passed=($boundary -ge 0 -and $helperCall -gt $boundary -and $prompt -gt $boundary -and $src.IndexOf('Assert-DbChecks (Get-BooleanSql $pre)') -gt $prompt)})
$parsed=$true
foreach($f in @(Get-ChildItem -LiteralPath $bundle -Filter '*.ps1' -File|Where-Object{$_.Name -eq 'Operations-Runner.ps1' -or $_.Name -match '^Start-'})){
 $tokens=$null;$parseErrors=$null;[void][Management.Automation.Language.Parser]::ParseFile($f.FullName,[ref]$tokens,[ref]$parseErrors)
 if($parseErrors.Count -gt 0){$parsed=$false}
}
$results.Add([pscustomobject]@{name='powershell-parser-clean';passed=$parsed})
$failures=@($results|Where-Object{-not $_.passed})
$summary=[ordered]@{scope='OFFLINE_SYNTHETIC_ONLY';databaseConnections=0;passwordPrompts=0;hostedReceiptsWritten=0;passed=($results.Count-$failures.Count);total=$results.Count;results=@($results.ToArray())}
Write-Json (Join-Path $PSScriptRoot 'results.json') $summary
Write-Output "OFFLINE TESTS: $($summary.passed)/$($summary.total)"
if($failures.Count){exit 1}else{exit 0}
