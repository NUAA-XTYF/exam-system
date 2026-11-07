<#
  One-click Veyon WebAPI setup for a student PC.
  Run as administrator (the .cmd wrapper handles elevation automatically).
  Default OJ server: http://192.168.3.2:8080
  Default WebAPI port: 11080

  IP selection strategy (important on PCs with Docker/WSL/Hyper-V adapters):
    1. -LocalIp if given
    2. the address the OS would use to reach the OJ server
    3. any local IPv4 that appears in the server's ips.txt
    4. any local IPv4 with a default gateway
  This file is ASCII-only so Windows PowerShell 5.1 cannot mis-decode it.
#>
[CmdletBinding()]
param(
    [string]$Source = 'http://192.168.3.2:8080',
    [int]$Port = 11080,
    [string]$AllowedRemote = '',
    [string]$LocalIp = ''
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$text) { Write-Host ('[*] ' + $text) -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host ('[+] ' + $text) -ForegroundColor Green }
function Write-Err([string]$text) { Write-Host ('[x] ' + $text) -ForegroundColor Red }

function Get-RouteLocalIp([string]$serverHost, [int]$serverPort) {
    $sock = $null
    try {
        $sock = New-Object System.Net.Sockets.Socket(
            [System.Net.Sockets.AddressFamily]::InterNetwork,
            [System.Net.Sockets.SocketType]::Dgram,
            [System.Net.Sockets.ProtocolType]::Udp)
        $sock.Connect($serverHost, $serverPort)
        $endpoint = $sock.LocalEndPoint
        return ([System.Net.IPEndPoint]$endpoint).Address.ToString()
    }
    catch { return $null }
    finally { if ($null -ne $sock) { $sock.Close() } }
}

function Get-LocalIpv4 {
    $result = @()
    if (Get-Command Get-NetIPAddress -ErrorAction SilentlyContinue) {
        foreach ($a in @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)) {
            if ($a.IPAddress -like '127.*') { continue }
            if ($a.IPAddress -like '169.254.*') { continue }
            if ($result -notcontains $a.IPAddress) { $result += $a.IPAddress }
        }
    }
    return $result
}

# ---------- 0. admin check ----------
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Err 'Administrator privileges are required.'
    exit 1
}

# ---------- 1. locate veyon-cli ----------
$cli = $null
$candidates = @()
if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
    $candidates += (Join-Path $env:ProgramFiles 'Veyon\veyon-cli.exe')
}
if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
    $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Veyon\veyon-cli.exe')
}
$candidates += 'C:\Program Files\Veyon\veyon-cli.exe'
$candidates += 'C:\Program Files (x86)\Veyon\veyon-cli.exe'
foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { $cli = $c; break }
}
if (-not $cli) {
    Write-Err 'veyon-cli.exe not found. Install Veyon 4.11.4 first.'
    exit 1
}

# ---------- 2. server host ----------
$base = $Source.TrimEnd([char[]]@('/', '\'))
$isHttp = $base -match '^https?://'
$serverHost = $null
$serverPort = 80
if ($isHttp) {
    $uri = [System.Uri]$base
    $serverHost = $uri.Host
    if ($uri.Port -gt 0) { $serverPort = $uri.Port }
}
elseif ($base.StartsWith('\\')) {
    $serverHost = $base.Substring(2).Split('\')[0]
}

# ---------- 3. load server-side IP list ----------
$generated = @()
try {
    if ($isHttp) {
        $resp = Invoke-WebRequest -Uri ($base + '/ips.txt') -UseBasicParsing
        $text = [string]$resp.Content
    }
    else {
        $text = Get-Content -LiteralPath (Join-Path $base 'ips.txt') -Raw
    }
    foreach ($line in $text.Split("`n")) {
        $t = $line.Trim()
        if ($t -match '^\d{1,3}(\.\d{1,3}){3}$') { $generated += $t }
    }
    Write-Step ('Server knows  : ' + $generated.Count + ' IPs')
}
catch {
    Write-Step 'Server ips.txt not available; using local detection only.'
}

# ---------- 3b. determine http/https mode ----------
$scheme = 'https'
try {
    if ($isHttp) {
        $scheme = ([string](Invoke-WebRequest -Uri ($base + '/scheme.txt') -UseBasicParsing).Content).Trim()
    }
    else {
        $scheme = (Get-Content -LiteralPath (Join-Path $base 'scheme.txt') -Raw).Trim()
    }
}
catch { }
if ($scheme -ne 'http' -and $scheme -ne 'https') { $scheme = 'https' }
Write-Step ('Access scheme : ' + $scheme)

# ---------- 4. choose local IP ----------
$ip = $null
$reason = ''

if (-not [string]::IsNullOrWhiteSpace($LocalIp)) {
    $ip = $LocalIp
    $reason = 'specified by -LocalIp'
}

if (-not $ip -and $serverHost) {
    $routeIp = Get-RouteLocalIp -serverHost $serverHost -serverPort $serverPort
    if ($routeIp) {
        if ($generated.Count -eq 0 -or $generated -contains $routeIp) {
            $ip = $routeIp
            $reason = 'route to server'
        }
        else {
            Write-Step ('Route IP ' + $routeIp + ' has no credentials, trying other adapters')
        }
    }
}

if (-not $ip) {
    $locals = Get-LocalIpv4
    if ($generated.Count -gt 0) {
        foreach ($candidate in $locals) {
            if ($generated -contains $candidate) {
                $ip = $candidate
                $reason = 'matches server ips.txt'
                break
            }
        }
    }
    if (-not $ip) {
        foreach ($candidate in $locals) {
            $ip = $candidate
            $reason = 'first local adapter'
            break
        }
    }
}

if (-not $ip) {
    Write-Err 'Cannot detect a usable local IPv4 address.'
    exit 1
}

$id = 'ip-' + ($ip -replace '\.', '-')
$keyName = 'exam-' + $id
if ([string]::IsNullOrWhiteSpace($AllowedRemote)) {
    $octets = $ip.Split('.')
    $AllowedRemote = $octets[0] + '.' + $octets[1] + '.' + $octets[2] + '.0/24'
}

Write-Step ('Local IP      : ' + $ip + ' (' + $reason + ')')
Write-Step ('Device ID     : ' + $id)
Write-Step ('Key name      : ' + $keyName)
Write-Step ('Download from : ' + $Source)

# ---------- 5. fetch credentials ----------
$veyonData = Join-Path $env:ProgramData 'Veyon'
$pubDir = Join-Path $veyonData ('keys\public\' + $keyName)
$wapiDir = Join-Path $veyonData 'wapi'
$pubPath = Join-Path $pubDir 'key'
$certPath = Join-Path $wapiDir 'server.crt'
$tlsKeyPath = Join-Path $wapiDir 'server.key'

New-Item -ItemType Directory -Force -Path $pubDir | Out-Null
New-Item -ItemType Directory -Force -Path $wapiDir | Out-Null

$keyUrl = $base + '/by-ip/' + $ip + '/key'

try {
    if ($isHttp) {
        Invoke-WebRequest -Uri $keyUrl -OutFile $pubPath -UseBasicParsing
        if ($scheme -eq 'https') {
            Invoke-WebRequest -Uri ($base + '/tls/server.crt') -OutFile $certPath -UseBasicParsing
            Invoke-WebRequest -Uri ($base + '/tls/server.key') -OutFile $tlsKeyPath -UseBasicParsing
        }
    }
    else {
        Copy-Item -LiteralPath (Join-Path $base ('by-ip\' + $ip + '\key')) -Destination $pubPath -Force
        if ($scheme -eq 'https') {
            Copy-Item -LiteralPath (Join-Path $base 'tls\server.crt') -Destination $certPath -Force
            Copy-Item -LiteralPath (Join-Path $base 'tls\server.key') -Destination $tlsKeyPath -Force
        }
    }
}
catch {
    Write-Err ('Download failed: ' + $_.Exception.Message)
    Write-Host ('    Tried: ' + $keyUrl)
    Write-Host ('    Local adapters: ' + ((Get-LocalIpv4) -join ', '))
    Write-Host ''
    Write-Host '    The OJ server has no credentials for the selected IP.'
    Write-Host ('    Check ' + $base + '/ips.txt, or re-run with:')
    Write-Host '      powershell -ExecutionPolicy Bypass -File student-setup.ps1 -LocalIp 192.168.3.101'
    exit 1
}
Write-Ok 'Credentials downloaded.'

# ---------- 6. tighten permissions ----------
& icacls $pubPath /inheritance:r /grant:r 'SYSTEM:(R)' 'Administrators:(F)' | Out-Null
if (Test-Path -LiteralPath $certPath) {
    & icacls $certPath /inheritance:r /grant:r 'SYSTEM:(R)' 'Administrators:(F)' 'Users:(R)' | Out-Null
}
if (Test-Path -LiteralPath $tlsKeyPath) {
    & icacls $tlsKeyPath /inheritance:r /grant:r 'SYSTEM:(R)' 'Administrators:(F)' | Out-Null
}
Write-Ok 'File permissions set.'

# ---------- 7. configure WebAPI ----------
& $cli config set WebAPI/HttpServerEnabled true | Out-Null
& $cli config set WebAPI/HttpServerPort $Port | Out-Null
if ($scheme -eq 'https') {
    & $cli config set WebAPI/HttpsEnabled true | Out-Null
    & $cli config set WebAPI/TlsCertificateFile $certPath | Out-Null
    & $cli config set WebAPI/TlsPrivateKeyFile $tlsKeyPath | Out-Null
    Write-Ok ('WebAPI enabled on port ' + $Port + ' with HTTPS.')
}
else {
    & $cli config set WebAPI/HttpsEnabled false | Out-Null
    Write-Ok ('WebAPI enabled on port ' + $Port + ' with HTTP (TLS disabled by server).')
}

# key-file authentication (AuthKeys) must be enabled, otherwise the server
# only offers logon authentication and rejects our key based requests.
#
# IMPORTANT: Authentication/Method is an enum. `veyon-cli config set` stores
# the value as a REG_SZ string ("1"), which Veyon cannot convert back to the
# enum, so the service silently keeps using Logon authentication. Veyon
# itself stores enums as DWORD (see Configuration::LocalStore), therefore we
# write the registry value directly and let the WebAPI self-check verify it.
$authKey = 'HKLM:\SOFTWARE\Veyon Solutions\Veyon\Authentication'
try {
    if (-not (Test-Path -LiteralPath $authKey)) {
        New-Item -Path $authKey -Force | Out-Null
    }
    New-ItemProperty -LiteralPath $authKey -Name 'Method' -Value 1 -PropertyType DWord -Force | Out-Null
    $authNow = (Get-ItemProperty -LiteralPath $authKey -Name 'Method').Method
    Write-Host ('    Authentication/Method -> ' + $authNow + ' (1 = key file)')
}
catch {
    Write-Host ('    [!] Could not set Authentication/Method: ' + $_.Exception.Message) -ForegroundColor Yellow
    Write-Host '        Set it by hand: Veyon Configurator -> General -> Authentication -> Method -> Key file'
}

# ---------- 8. firewall ----------
$ruleName = 'Veyon WebAPI ' + $Port
Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Out-Null
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -RemoteAddress $AllowedRemote -Profile Any | Out-Null
Write-Ok ('Firewall rule added for TCP ' + $Port + ' from ' + $AllowedRemote)

# ---------- 9. restart service ----------
& $cli service restart | Out-Null
Start-Sleep -Seconds 2
& $cli service status

Write-Host ''
if ($scheme -eq 'http') {
    Write-Step 'Self-check: local WebAPI authentication methods'
    $selfUrl = 'http://127.0.0.1:' + $Port + '/api/v1/authentication/localhost'
    $methods = $null
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            $methods = [string](Invoke-WebRequest -Uri $selfUrl -UseBasicParsing -TimeoutSec 3).Content
            break
        }
        catch { Start-Sleep -Seconds 2 }
    }
    if ($methods -match '0c69b301-81b4-42d6-8fae-128cdd113314') {
        Write-Ok 'Self-check OK: key-file authentication (AuthKeys) is active.'
    }
    elseif ($methods) {
        Write-Err 'Self-check FAILED: AuthKeys is still not offered by this PC.'
        Write-Host ('    WebAPI says: ' + $methods)
        Write-Host '    Set it by hand: Veyon Configurator -> General -> Authentication -> Method -> Key file -> Apply'
        Write-Host '    Then run: "C:\Program Files\Veyon\veyon-cli.exe" service restart'
        exit 2
    }
    else {
        Write-Err ('Self-check FAILED: cannot reach the local WebAPI on port ' + $Port)
        Write-Host '    Check: veyon-cli service status / WebAPI/HttpServerEnabled / firewall'
        exit 3
    }
}
else {
    Write-Step 'Self-check skipped in https mode (server-side probe is authoritative).'
}

# ---------- 11. process watchdog ----------
# A foreground PowerShell window that samples windowed processes and reports
# them to the exam server. Closing it stops reporting and the monitor page
# then shows "agent stopped", so students are told to keep it open.
$agentDir = Join-Path $env:ProgramData 'ExamMonitor'
$watchPath = Join-Path $agentDir 'watch.ps1'
$tokenPath = Join-Path $agentDir 'token.txt'
New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
$watchReady = $false
try {
    if ($isHttp) {
        Invoke-WebRequest -Uri ($base + '/watch.ps1') -OutFile $watchPath -UseBasicParsing
        Invoke-WebRequest -Uri ($base + '/by-ip/' + $ip + '/token') -OutFile $tokenPath -UseBasicParsing
    }
    else {
        Copy-Item -LiteralPath (Join-Path $base 'watch.ps1') -Destination $watchPath -Force
        Copy-Item -LiteralPath (Join-Path $base ('by-ip\' + $ip + '\token')) -Destination $tokenPath -Force
    }
    & icacls $watchPath /inheritance:r /grant:r 'SYSTEM:(R)' 'Administrators:(F)' 'Users:(R)' | Out-Null
    & icacls $tokenPath /inheritance:r /grant:r 'SYSTEM:(R)' 'Administrators:(F)' 'Users:(R)' | Out-Null
    $watchReady = $true
    Write-Ok 'Process watchdog installed.'
}
catch {
    Write-Host ('    [!] Could not install the process watchdog: ' + $_.Exception.Message) -ForegroundColor Yellow
}

if ($watchReady) {
    $serverBase = 'http://' + $serverHost
    $agentArgs = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $watchPath + '" -Server ' + $serverBase
    try {
        $startup = [Environment]::GetFolderPath('Startup')
        $lnkPath = Join-Path $startup 'ExamMonitor.lnk'
        $ws = New-Object -ComObject WScript.Shell
        $lnk = $ws.CreateShortcut($lnkPath)
        $lnk.TargetPath = 'powershell.exe'
        $lnk.Arguments = $agentArgs
        $lnk.WorkingDirectory = $agentDir
        $lnk.WindowStyle = 1
        $lnk.Description = 'Exam monitor agent'
        $lnk.Save()
        Write-Ok 'Watchdog will start automatically at logon.'
        Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '*watch.ps1*' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 600
        Start-Process -FilePath 'powershell.exe' -ArgumentList $agentArgs
        Write-Host '    A console window will open and must stay open during the exam.' -ForegroundColor Yellow
    }
    catch {
        Write-Host ('    [!] Could not start the process watchdog: ' + $_.Exception.Message) -ForegroundColor Yellow
    }
}

# ---------- 10. login hint ----------
# Keep the password in sync with the HydroOJ accounts (tutorial section 9.2).
$seat = $ip.Split('.')[-1]
$account = 'seat' + $seat
Write-Host ''
Write-Host '============================================================'
Write-Host (' Exam system : http://' + $serverHost + '/')
if ([int]$seat -ge 101 -and [int]$seat -le 200) {
    Write-Host (' Account     : ' + $account + '   Password: Exam@2026')
}
else {
    Write-Host ' Account     : ask your teacher (this IP has no seat account)'
}
Write-Host ' If the teacher gave you another account, use that one instead.'
Write-Host ' Keep the black "Exam monitor" window open during the exam.'
Write-Host (' Details     : http://' + $serverHost + ':8080/login.html')
Write-Host '============================================================'

Write-Host ''
Write-Ok 'Done on this PC.'
Write-Host ('    Server-side check: /opt/exam-system/tools/probe-device.sh ' + $id) -ForegroundColor Yellow
