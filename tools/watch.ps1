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
    [string]$Server = '',
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
            $list += [pscustomobject]@{ Id = $p.Id; Name = $p.ProcessName + '.exe'; Title = $title; Mb = [int]($p.WorkingSet64 / 1MB); Pid = $p.Id }
        }
        catch { }
    }
    return $list
}

function Get-AllProcesses {
    # Snapshot list: every process, windowed or not. Background services such as
    # ollama.exe have no window and would otherwise be invisible.
    $list = @()
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
        try {
            $title = ''
            try { $title = $p.MainWindowTitle } catch { }
            $list += [pscustomobject]@{ Name = $p.ProcessName + '.exe'; Title = $title; Mb = [int]($p.WorkingSet64 / 1MB); Pid = $p.Id; Sid = $p.SessionId }
        }
        catch { }
    }
    return $list
}

# Windows components that spawn constantly and would drown the event stream.
$systemNoise = @(
    'svchost.exe','conhost.exe','RuntimeBroker.exe','SearchApp.exe','SearchHost.exe',
    'StartMenuExperienceHost.exe','TextInputHost.exe','ShellExperienceHost.exe','dllhost.exe',
    'taskhostw.exe','backgroundTaskHost.exe','ctfmon.exe','WmiPrvSE.exe','smartscreen.exe',
    'SecurityHealthSystray.exe','ApplicationFrameHost.exe','LockApp.exe','SystemSettings.exe',
    'MoUsoCoreWorker.exe','sihost.exe','fontdrvhost.exe','dwm.exe','explorer.exe','MsMpEng.exe'
)

function Resolve-Server {
    foreach ($candidate in @('192.168.3.3', '192.168.3.2')) {
        try {
            $probe = New-Object System.Net.Sockets.TcpClient
            $probe.Connect($candidate, 80)
            $probe.Close()
            return 'http://' + $candidate
        }
        catch { }
    }
    return ''
}

if ([string]::IsNullOrWhiteSpace($Server)) { $Server = Resolve-Server }
while ([string]::IsNullOrWhiteSpace($Server)) {
    Write-Host '[!] Cannot reach the exam server yet, retrying every 30s ...' -ForegroundColor Yellow
    Start-Sleep -Seconds 30
    $Server = Resolve-Server
}
Write-Host ('[*] Server resolved: ' + $Server) -ForegroundColor Cyan

$reportUrl = ($Server.TrimEnd('/')) + '/d/system/exam-report'
$headers = @{ 'X-Exam-Token' = $token }
$hostName = $env:COMPUTERNAME
$userName = $env:USERNAME
$ip = Get-LocalIp

$prev = @{}
$lastTitle = @{}
$mySession = (Get-Process -Id $PID).SessionId
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
    $all = @(Get-AllProcesses)
    $cur = @{}
    foreach ($p in $all) { $cur[[string]$p.Id] = $p }

    # New processes: anything started in this user session that is not Windows noise,
    # with or without a window. A background model runner is reported right here.
    foreach ($key in @($cur.Keys)) {
        $p = $cur[$key]
        if (-not $prev.ContainsKey($key)) {
            if ($p.Sid -eq $mySession -and $systemNoise -notcontains $p.Name) {
                [void]$pending.Add([pscustomobject]@{ n = $p.Name; t = $p.Title; act = 'start'; at = [int64]($now.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds })
                Write-Host ('[+] ' + $p.Name + '  ' + $p.Title) -ForegroundColor Yellow
            }
        }
        else {
            $old = $prev[$key]
            if ($old.Title -ne $p.Title -and -not [string]::IsNullOrWhiteSpace($p.Title)) {
                $last = $lastTitle[$key]
                if (-not $last -or ($now - $last).TotalSeconds -ge 5) {
                    $lastTitle[$key] = $now
                    [void]$pending.Add([pscustomobject]@{ n = $p.Name; t = $p.Title; act = 'title'; at = [int64]($now.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds })
                    Write-Host ('[~] ' + $p.Name + '  ' + $p.Title) -ForegroundColor DarkYellow
                }
            }
        }
    }
    foreach ($key in @($prev.Keys)) {
        if (-not $cur.ContainsKey($key)) {
            $p = $prev[$key]
            if (-not [string]::IsNullOrWhiteSpace($p.Title) -or ($p.Sid -eq $mySession -and $systemNoise -notcontains $p.Name)) {
                [void]$pending.Add([pscustomobject]@{ n = $p.Name; t = $p.Title; act = 'stop'; at = [int64]($now.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds })
                Write-Host ('[-] ' + $p.Name + '  ' + $p.Title) -ForegroundColor DarkGray
            }
        }
    }
    if ($pending.Count -gt 60) { $pending.RemoveRange(60, $pending.Count - 60) }
    $prev = $cur

    $due = ($now - $lastReport).TotalSeconds -ge $ReportSeconds
    if ($due -or $pending.Count -gt 0) {
        $payload = @{
            at = [int64]($now.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds
            host = $hostName
            user = $userName
            ip = $ip
            items = @($all | Sort-Object -Property Mb -Descending | Select-Object -First 250 | ForEach-Object { @{ n = $_.Name; t = $_.Title; m = $_.Mb; p = $_.Pid } })
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
            if ($failures -ge 3) {
                $retry = Resolve-Server
                if ($retry -and $retry -ne $Server) {
                    $Server = $retry
                    $reportUrl = ($Server.TrimEnd('/')) + '/d/system/exam-report'
                    Write-Host ('[*] Server moved, now reporting to ' + $Server) -ForegroundColor Cyan
                }
                $failures = 0
            }
        }
        if ($ok) {
            $failures = 0
            $lastReport = $now
            $pending.Clear()
        }
    }

    if (($now - $lastLine).TotalSeconds -ge 10) {
        $lastLine = $now
        $ago = 'never'
        if ($lastReport -ne [datetime]::MinValue) {
            $secs = [int](($now - $lastReport).TotalSeconds)
            $ago = '' + $secs + 's ago'
        }
        Write-Host ('[' + $now.ToString('HH:mm:ss') + '] processes: ' + $all.Count + ' (' + $procs.Count + ' windowed)   last report: ' + $ago) -ForegroundColor DarkGray
    }

    Start-Sleep -Seconds $PollSeconds
}
