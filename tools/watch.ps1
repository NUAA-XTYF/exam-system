<#
  Exam process watchdog for student PCs.
  - stays in a foreground console window (closing it makes the monitor page show "agent stopped")
  - samples windowed processes once per second
  - reports a full snapshot every 30 seconds
  - reports immediately when a process with a window starts or stops
  ASCII only - Windows PowerShell 5.1 decodes this file as ANSI.
#>
[CmdletBinding()]
param(
    [string]$Server = 'http://192.168.3.2',
    [string]$TokenFile = 'C:\ProgramData\ExamMonitor\token.txt',
    [int]$PollSeconds = 1,
    [int]$ReportSeconds = 30
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$mutex = New-Object System.Threading.Mutex($false, 'Local\ExamMonitorWatch')
if (-not $mutex.WaitOne(0)) {
    Write-Host 'Exam monitor agent is already running.' -ForegroundColor Yellow
    Start-Sleep -Seconds 5
    exit 0
}

function Get-Token {
    if (Test-Path -LiteralPath $TokenFile) {
        return (Get-Content -LiteralPath $TokenFile -Raw).Trim()
    }
    return ''
}
$token = Get-Token
if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host ('[x] token file not found: ' + $TokenFile) -ForegroundColor Red
    Write-Host '    Run setup.cmd again to install the monitor agent.' -ForegroundColor Red
    Start-Sleep -Seconds 10
    exit 1
}

function Get-LocalIp {
    $sock = $null
    try {
        $sock = New-Object System.Net.Sockets.Socket(
            [System.Net.Sockets.AddressFamily]::InterNetwork,
            [System.Net.Sockets.SocketType]::Dgram,
            [System.Net.Sockets.ProtocolType]::Udp)
        $sock.Connect('192.168.3.2', 80)
        return ([System.Net.IPEndPoint]$sock.LocalEndPoint).Address.ToString()
    }
    catch { return '' }
    finally { if ($null -ne $sock) { $sock.Close() } }
}

function Get-WindowProcesses {
    $list = @()
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
        try {
            $title = $p.MainWindowTitle
            if ([string]::IsNullOrWhiteSpace($title)) { continue }
            $list += [pscustomobject]@{ Id = $p.Id; Name = $p.ProcessName + '.exe'; Title = $title; Mb = [int]($p.WorkingSet64 / 1MB) }
        }
        catch { }
    }
    return $list
}

$reportUrl = ($Server.TrimEnd('/')) + '/d/system/exam-report'
$headers = @{ 'X-Exam-Token' = $token }
$hostName = $env:COMPUTERNAME
$userName = $env:USERNAME
$ip = Get-LocalIp

$prev = @{}
$pending = New-Object System.Collections.ArrayList
$lastReport = [datetime]::MinValue
$lastLine = [datetime]::MinValue
$failures = 0

[Console]::Title = 'Exam monitor - do not close'
Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' Exam monitor agent is running. Keep this window open.' -ForegroundColor Cyan
Write-Host (' PC ' + $hostName + '  user ' + $userName + '  ip ' + $ip) -ForegroundColor Cyan
Write-Host (' Server ' + $Server + '   report every ' + $ReportSeconds + 's') -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

while ($true) {
    $now = Get-Date
    $procs = @(Get-WindowProcesses)
    $cur = @{}
    foreach ($p in $procs) { $cur[[string]$p.Id] = $p }

    foreach ($key in @($cur.Keys)) {
        if (-not $prev.ContainsKey($key)) {
            $p = $cur[$key]
            [void]$pending.Add([pscustomobject]@{ n = $p.Name; t = $p.Title; act = 'start'; at = [int64]($now.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds })
            Write-Host ('[+] ' + $p.Name + '  ' + $p.Title) -ForegroundColor Yellow
        }
    }
    foreach ($key in @($prev.Keys)) {
        if (-not $cur.ContainsKey($key)) {
            $p = $prev[$key]
            [void]$pending.Add([pscustomobject]@{ n = $p.Name; t = $p.Title; act = 'stop'; at = [int64]($now.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds })
            Write-Host ('[-] ' + $p.Name + '  ' + $p.Title) -ForegroundColor DarkGray
        }
    }
    $prev = $cur

    $due = ($now - $lastReport).TotalSeconds -ge $ReportSeconds
    if ($due -or $pending.Count -gt 0) {
        $payload = @{
            at = [int64]($now.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds
            host = $hostName
            user = $userName
            ip = $ip
            items = @($procs | ForEach-Object { @{ n = $_.Name; t = $_.Title; m = $_.Mb } })
            events = @($pending.ToArray())
        }
        $ok = $false
        try {
            $body = $payload | ConvertTo-Json -Depth 4 -Compress
            $null = Invoke-RestMethod -Uri $reportUrl -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 6
            $ok = $true
        }
        catch {
            $failures++
            Write-Host ('[!] report failed (' + $failures + '): ' + $_.Exception.Message) -ForegroundColor Red
        }
        if ($ok) {
            $failures = 0
            $lastReport = $now
            $pending.Clear()
        }
    }

    if (($now - $lastLine).TotalSeconds -ge 10) {
        $lastLine = $now
        $ago = if ($lastReport -eq [datetime]::MinValue) { 'never' } else { [int](($now - $lastReport).TotalSeconds).ToString() + 's ago' }
        Write-Host ('[' + $now.ToString('HH:mm:ss') + '] windowed processes: ' + $procs.Count + '   last report: ' + $ago) -ForegroundColor DarkGray
    }

    Start-Sleep -Seconds $PollSeconds
}
