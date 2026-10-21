#requires -Version 7.0
Set-StrictMode -Version Latest

function Get-K7DbErrorClass {
    param([string]$Message)
    if ($Message -match '(?i)password authentication failed|authentication failed|no password supplied|SASL|SCRAM') { return 'Kimlik doğrulama' }
    if ($Message -match '(?i)SSL|TLS|certificate|root cert') { return 'TLS' }
    if ($Message -match '(?i)could not translate|name or service not known|no such host|hostname') { return 'Bağlantı/DNS' }
    if ($Message -match '(?i)network is unreachable|no route to host|IPv6|cannot assign requested address') { return 'Bağlantı/IPv6' }
    if ($Message -match '(?i)timeout|timed out|connection refused|could not connect|connection to server|connection reset') { return 'Bağlantı' }
    return 'SQL/işlem'
}

function Invoke-K7Psql {
    param(
        [Parameter(Mandatory)][string]$Psql,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$Password,
        [Parameter(Mandatory)][string]$Ca
    )
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Psql
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in $Arguments) { [void]$info.ArgumentList.Add($argument) }
    foreach ($key in @($info.Environment.Keys)) {
        if ($key.StartsWith('PG', [StringComparison]::OrdinalIgnoreCase)) { [void]$info.Environment.Remove($key) }
    }
    $info.Environment['PGPASSWORD'] = $Password
    $info.Environment['PGSSLMODE'] = 'verify-full'
    $info.Environment['PGSSLROOTCERT'] = $Ca
    $info.Environment['PGCONNECT_TIMEOUT'] = '10'
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(180000)) {
            $process.Kill($true)
            $process.WaitForExit()
            return [pscustomobject]@{ ExitCode = -1; Output = ''; ErrorClass = 'Zaman aşımı; inceleme gerekli' }
        }
        $errorText = $stderr.GetAwaiter().GetResult()
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $stdout.GetAwaiter().GetResult(); ErrorClass = (Get-K7DbErrorClass $errorText) }
    } finally {
        $info.Environment['PGPASSWORD'] = ''
        $process.Dispose()
    }
}
