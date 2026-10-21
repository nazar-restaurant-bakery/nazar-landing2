#requires -Version 7.0
param(
    [ValidateSet('14a')][string]$Order='14a',
    [Parameter(Mandatory)][ValidateSet('Sandbox','Production')][string]$Target,
    [switch]$OfflineCheck,
    [string]$WorkspaceRoot,
    [string]$OfflineFixtureRoot
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$workspace = if ($WorkspaceRoot) {[IO.Path]::GetFullPath($WorkspaceRoot)} else {[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))}
$psql = Join-Path $env:USERPROFILE 'scoop/apps/postgresql/18.6-4/bin/psql.exe'
$ca = Join-Path $workspace '20_Yonetim\Teslim_Raporlari\K3_kanit\tls\prod-ca-2021.crt'
$helper = Join-Path $PSScriptRoot 'K7-DbRunner.ps1'
$plansPath = Join-Path $PSScriptRoot 'migration-plans.json'
$plansSha = 'CF8620EC3BEA8EB723DAA3508835F0AD7AB4FA520B90E121A088D1F4BA2245C9'
$targetsPath=Join-Path $PSScriptRoot 'targets.json'
if (-not (Test-Path -LiteralPath $targetsPath) -or (Get-FileHash -LiteralPath $targetsPath).Hash -cne 'D3B0FD6973EC68CD81092E013D0035A5155B87C46465FCB25181C82571DA284E') { Write-Output 'COUPON DELIVERY: FAILED (hedef ayarı/pin)'; exit 1 }
$refs = Get-Content -LiteralPath $targetsPath -Raw | ConvertFrom-Json -AsHashtable
$targetRef = $refs[$Target]
$label = "MIGRATION $Order $($Target.ToUpperInvariant())"
$step = 'Dosya bütünlüğü'; $safeClass = 'Dosya/SHA256'; $privateRun = $null
$waiting = [Collections.Generic.List[string]]::new()
$prerequisites = [Collections.Generic.List[object]]::new()

function Assert-Pin([string]$Path,[string]$Sha) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or
        (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -cne $Sha) { throw 'integrity' }
}
function Assert-Lf([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0 -or $bytes -contains 13 -or $bytes[-1] -ne 10 -or
        ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191)) { throw 'line_ending' }
}
function Assert-Sequence([string]$Number,[string]$File,[string]$Sha) {
    $rows = @(Get-Content -LiteralPath $sequence | Where-Object { $_ -match ('^\| ' + [regex]::Escape($Number) + ' \|') })
    if ($rows.Count -ne 1) { throw 'sequence_missing_or_ambiguous' }
    $cells = $rows[0] -split '\|'
    if ($cells.Count -ne 8 -or $cells[1].Trim() -cne $Number -or $cells[2].Trim() -cne $File -or
        $cells[4].Trim().ToUpperInvariant() -cne $Sha) { throw 'sequence_invalid' }
}
function Add-Receipt([string]$Number,[string]$Path,[string]$Ref,[string]$Sha,[string]$Checks,[bool]$RequireOrder) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { $waiting.Add("$Number $([IO.Path]::GetFileName($Path))"); return }
    try {
        $json = Get-Content -LiteralPath $Path -Raw
        $r = $json | ConvertFrom-Json
        if (-not $OfflineFixtureRoot -and $r.PSObject.Properties['synthetic'] -and $r.synthetic) { throw 'synthetic_receipt_rejected' }
        $document = [Text.Json.JsonDocument]::Parse($json)
        try { $timestamp = $document.RootElement.GetProperty('verifiedAtUtc').GetString() }
        finally { $document.Dispose() }
        $when = [DateTimeOffset]::ParseExact($timestamp,'o',[Globalization.CultureInfo]::InvariantCulture)
        if ($r.target -cne $Ref -or $r.migrationSha256 -cne $Sha -or $r.psql -cne '18.6' -or
            $r.checks -cne $Checks -or $when.Offset -ne [TimeSpan]::Zero -or $when.Year -lt 2026 -or
            $when -gt [DateTimeOffset]::UtcNow) { throw 'receipt_fields' }
        if ($RequireOrder -and $r.order -cne $Number) { throw 'receipt_order' }
        if ($r.schemaVersion -ne 1 -or $r.status -cne 'PASSED') { throw 'receipt_status' }
        if ($r.password_recorded -cne $false) { throw 'receipt_secret_policy' }
        $expectedChecks=if ($Number -ceq '14') {86} else {$plans[$Number].postconditions.Count}
        if ($r.checkCount -ne $expectedChecks) { throw 'receipt_check_count' }
        # Receipts are local attestations, never database credentials. Bind the exact reviewed bytes.
        $prerequisites.Add([pscustomobject]@{order=$Number;target=$Ref;path=$Path;
            sha256=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash})
    } catch { throw 'receipt_invalid' }
}
function Assert-PrerequisiteBytes {
    foreach ($r in $prerequisites) { Assert-Pin $r.path $r.sha256 }
}
function Publish-ReceiptAlias([string]$Source,[string]$Destination) {
    $sourceSha=(Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
    if (Test-Path -LiteralPath $Destination) {
        if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -cne $sourceSha) { throw 'alias_conflict' }
    } else {
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Destination))
        [IO.File]::Copy($Source,$Destination,$false)
    }
    Assert-Pin $Destination $sourceSha
}
function Get-BooleanSql([string[]]$Conditions) {
    'SELECT ' + (($Conditions | ForEach-Object { '(COALESCE((' + $_ + '),false))::int' }) -join " || '|' || ")
}
function Assert-DbChecks([string]$Sql,[int]$Count,[string]$Password,[string[]]$Base) {
    $r = Invoke-K7Psql -Psql $psql -Arguments ($Base + @('-t','-A','-c',$Sql)) -Password $Password -Ca $ca
    if ($r.ExitCode -ne 0) { $script:safeClass=$r.ErrorClass; throw 'database_check_failed' }
    $expected = (@('1') * $Count) -join '|'
    if ($r.Output.Trim() -cne $expected) { $script:safeClass='Nesne/yetki denetimi eşleşmedi'; throw 'database_check_mismatch' }
}

try {
    if ($OfflineFixtureRoot -and -not $OfflineCheck) { throw 'offline_fixture_requires_offline' }
    $sequence = Join-Path $workspace '20_Yonetim\Migration_Sirasi.md'
    $receiptRoot = $PSScriptRoot
    $migrationRoot = Join-Path $PSScriptRoot 'sql'
    if ($OfflineFixtureRoot) {
        $fixtureBase = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'tests\fixtures')) + [IO.Path]::DirectorySeparatorChar
        $fixture = [IO.Path]::GetFullPath($OfflineFixtureRoot)
        if (-not $fixture.StartsWith($fixtureBase,[StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $fixture -PathType Container)) { throw 'fixture_path_rejected' }
        $sequence = Join-Path $fixture 'Migration_Sirasi.md'
        $receiptRoot = $fixture
        $migrationRoot = Join-Path $fixture 'sql'
    }
    Assert-Pin $plansPath $plansSha
    Assert-Pin $psql 'B22D9AC21C30EA131E91C0DCB1E3850383ADF1422848ED4233EE07ADDCA50132'
    Assert-Pin $ca '700723581420DD1AC98FD7E9AC529F0EF210EADCAF87FC868A3AD7D114C2F3B7'
    Assert-Pin $helper 'F33D200727A327EE5F2732922010EE79E9B079172FAEFFA41DC4E74A98252F3A'
    $plans = Get-Content -LiteralPath $plansPath -Raw | ConvertFrom-Json -AsHashtable
    $plan = $plans[$Order]
    $migration = Join-Path $migrationRoot $plan.file
    Assert-Pin $migration $plan.sha256
    Assert-Lf $migration
    $step = 'psql sürümü'; $safeClass='Sürüm'
    if ((& $psql --version) -cne 'psql (PostgreSQL) 18.6' -or $LASTEXITCODE -ne 0) { throw 'psql_version' }
    $step = 'Sıra/önkoşul kaydı'; $safeClass='Eksik/geçersiz kanıt'
    Assert-Sequence $Order ('supabase/migrations/' + $plan.file) $plan.sha256
    foreach ($d in $plan.dependencies) {
        Assert-Sequence $d.order ('supabase/migrations/' + $d.file) $d.sha256
        $suffix = $Target.ToLowerInvariant()
        $relative = ($d.receipt -replace '\{target\}',$suffix)
        if ($OfflineFixtureRoot) { $receipt = Join-Path $receiptRoot $relative }
        elseif ($d.legacy) { $receipt = Join-Path (Split-Path -Parent $PSScriptRoot) $relative }
        else { $receipt = Join-Path $PSScriptRoot $relative }
        Add-Receipt $d.order $receipt $targetRef $d.sha256 $d.checks $d.requireOrder
    }
    if ($Target -eq 'Production') {
        Add-Receipt $Order (Join-Path $receiptRoot "receipts/$Order-sandbox-success.json") $refs.Sandbox $plan.sha256 "migration_order_$Order" $true
    }
    $currentReceipt = Join-Path $receiptRoot "receipts/$Order-$($Target.ToLowerInvariant())-success.json"
    $compatibilityReceipt=$null
    if ($Order -eq '8') {
        $aliasRoot=if ($OfflineFixtureRoot) {$receiptRoot} else {Split-Path -Parent $PSScriptRoot}
        $compatibilityReceipt=Join-Path $aliasRoot "K9_kanit/$($Target.ToLowerInvariant())-success.json"
        if (Test-Path -LiteralPath $compatibilityReceipt) {
            if (-not (Test-Path -LiteralPath $currentReceipt) -or
                (Get-FileHash -LiteralPath $currentReceipt).Hash -cne (Get-FileHash -LiteralPath $compatibilityReceipt).Hash) {
                throw 'alias_conflict_or_orphan'
            }
        }
    }
    if (Test-Path -LiteralPath $currentReceipt -PathType Leaf) {
        Add-Receipt $Order $currentReceipt $targetRef $plan.sha256 "migration_order_$Order" $true
        if (-not $OfflineCheck) { $safeClass='Bu sıra zaten kayıtlı; yeniden uygulama reddedildi'; throw 'already_applied' }
    }
    if ($waiting.Count -gt 0) {
        Write-Output ('Beklenen başarı kaydı: ' + ($waiting -join '; '))
        if ($OfflineCheck) { Write-Output "$label OFFLINE: WAITING" } else { Write-Output "$label`: WAITING" }
        exit 2
    }
    if ($OfflineCheck) { Write-Output "$label OFFLINE: PASSED (bağlantı/parola/yazma yok)"; exit 0 }

    # Only the explicit non-offline path can load the process helper, ask for a password, or contact a database.
    Assert-Pin $helper 'F33D200727A327EE5F2732922010EE79E9B079172FAEFFA41DC4E74A98252F3A'
    . $helper
    $step='Operatör onayı'; $safeClass='Onay eşleşmedi'
    $expected = if ($Target -eq 'Sandbox') { 'TEST' } else { 'URETIM' }
    if ((Read-Host "Yalnız $targetRef için $expected yazın") -cne $expected) { throw 'cancelled' }
    $secure = Read-Host "$Target veritabanı parolası" -AsSecureString
    $bstr=[IntPtr]::Zero; $password=$null
    try {
        $bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        $password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        $base=@('-X','-w','-h',"db.$targetRef.supabase.co",'-p','5432','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1')
        $pre = @("current_database()='postgres'","current_user='postgres'","current_setting('session_replication_role')='origin'")
        $pre += $plan.preconditions
        $step='Salt okunur ön kontrol'; $safeClass='Yerel işlem'
        Assert-DbChecks (Get-BooleanSql $pre) $pre.Count $password $base

        # Freeze exactly the reviewed bytes in an ACL-private, unique per-run directory.
        $privateRun=Join-Path $PSScriptRoot ('runs/' + [guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($privateRun)
        $acl=[Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true,$false)
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
        Set-Acl -LiteralPath $privateRun -AclObject $acl
        $frozen=Join-Path $privateRun $plan.file
        [IO.File]::WriteAllBytes($frozen,[IO.File]::ReadAllBytes($migration))
        (Get-Item -LiteralPath $frozen).IsReadOnly=$true
        $step='Son SHA/LF/önkoşul kontrolü'; $safeClass='Dosya/SHA256'
        Assert-Pin $psql 'B22D9AC21C30EA131E91C0DCB1E3850383ADF1422848ED4233EE07ADDCA50132'
        Assert-Pin $ca '700723581420DD1AC98FD7E9AC529F0EF210EADCAF87FC868A3AD7D114C2F3B7'
        Assert-Pin $helper 'F33D200727A327EE5F2732922010EE79E9B079172FAEFFA41DC4E74A98252F3A'
        Assert-Pin $plansPath $plansSha
        Assert-Pin $frozen $plan.sha256
        Assert-Lf $frozen
        Assert-PrerequisiteBytes
        Assert-Sequence $Order ('supabase/migrations/' + $plan.file) $plan.sha256
        $step='Migration uygulama'; $safeClass='Yerel işlem'
        $write=Invoke-K7Psql -Psql $psql -Arguments ($base+@('-f',$frozen)) -Password $password -Ca $ca
        if ($write.ExitCode -ne 0) { $safeClass=$write.ErrorClass; throw 'migration_failed' }
        $step='Salt okunur son kontrol'; $safeClass='Yerel işlem'
        Assert-DbChecks (Get-BooleanSql $plan.postconditions) $plan.postconditions.Count $password $base
        Assert-PrerequisiteBytes
        [void][IO.Directory]::CreateDirectory((Join-Path $PSScriptRoot 'receipts'))
        $receipt = [ordered]@{schemaVersion=1;module=$plan.module;order=$Order;status='PASSED';target=$targetRef;
            migrationFile=('supabase/migrations/'+$plan.file);migrationSha256=$plan.sha256;psql='18.6';
            verifiedAtUtc=[DateTimeOffset]::UtcNow.ToString('o');checks="migration_order_$Order";
            checkCount=$plan.postconditions.Count;password_recorded=$false;prerequisites=@($prerequisites.ToArray())}
        $tempReceipt=Join-Path $privateRun 'success.json'
        [IO.File]::WriteAllText($tempReceipt,($receipt|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
        # No overwrite of a concurrent or prior successful attestation.
        [IO.File]::Move($tempReceipt,$currentReceipt,$false)
        # K11/K13 compatibility is an exact copy of the real post-check receipt, never a second attestation.
        if ($compatibilityReceipt) { Publish-ReceiptAlias $currentReceipt $compatibilityReceipt }
        Write-Output "$label`: PASSED"
    } finally {
        if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        $password=$null
        if ($secure) { $secure.Dispose() }
    }
} catch {
    Write-Output "Adım: $step; Sınıf: $safeClass"
    Write-Output "$label`: FAILED"
    exit 1
}
