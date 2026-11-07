<#
  Diagnostic for Veyon WebAPI on a student PC. ASCII only.
#>
param(
    [int]$Port = 11080
)

$ErrorActionPreference = 'Continue'

function Sec([string]$t) { Write-Host '' ; Write-Host ('===== ' + $t + ' =====') -ForegroundColor Cyan }

$cli = 'C:\Program Files\Veyon\veyon-cli.exe'
if (-not (Test-Path $cli)) { $cli = 'C:\Program Files (x86)\Veyon\veyon-cli.exe' }

Sec 'Veyon CLI'
Write-Host ('path: ' + $cli)
if (Test-Path $cli) {
    $vi = (Get-Item $cli).VersionInfo
    Write-Host ('file version   : ' + $vi.FileVersion)
    Write-Host ('product version: ' + $vi.ProductVersion)
}

Sec 'WebAPI config'
if (Test-Path $cli) {
    $keys = @(
        'WebAPI/HttpServerEnabled',
        'WebAPI/HttpServerPort',
        'WebAPI/HttpsEnabled',
        'WebAPI/TlsCertificateFile',
        'WebAPI/TlsPrivateKeyFile',
        'WebAPI/ConnectionLimit'
    )
    foreach ($k in $keys) {
        $v = & $cli config get $k 2>&1
        Write-Host ($k + ' = ' + ($v -join ' '))
    }
}

Sec 'Service status'
if (Test-Path $cli) { & $cli service status }

Sec 'Listener'
try {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    foreach ($c in $conns) {
        $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        $name = 'unknown'
        $session = ''
        if ($p) { $name = $p.ProcessName; $session = $p.SessionId }
        Write-Host ('listen ' + $c.LocalAddress + ':' + $c.LocalPort + '  pid=' + $c.OwningProcess + '  proc=' + $name + '  session=' + $session)
    }
}
catch {
    Write-Host ('no listener on port ' + $Port)
}

Sec 'TLS files'
$files = @(
    (Join-Path $env:ProgramData 'Veyon\wapi\server.crt'),
    (Join-Path $env:ProgramData 'Veyon\wapi\server.key')
)
foreach ($f in $files) {
    Write-Host ('--- ' + $f)
    if (Test-Path -LiteralPath $f) {
        $item = Get-Item -LiteralPath $f
        Write-Host ('    size=' + $item.Length + '  mtime=' + $item.LastWriteTime)
        Write-Host ('    first line: ' + ((Get-Content -LiteralPath $f -TotalCount 1)))
        & icacls $f
    }
    else {
        Write-Host '    MISSING'
    }
}

Sec 'Local HTTPS test (127.0.0.1)'
$oldCb = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
try {
    $r = Invoke-WebRequest -Uri ('https://127.0.0.1:' + $Port + '/api/v1/authentication/localhost') -UseBasicParsing -TimeoutSec 5
    Write-Host ('OK  HTTP ' + $r.StatusCode + ' body: ' + $r.Content)
}
catch {
    Write-Host ('FAILED: ' + $_.Exception.Message)
    if ($_.Exception.InnerException) { Write-Host ('inner : ' + $_.Exception.InnerException.Message) }
}
[System.Net.ServicePointManager]::ServerCertificateValidationCallback = $oldCb

Sec 'Config page hint'
Write-Host 'If HttpsEnabled=true but the test fails, open Veyon Configurator -> WebAPI'
Write-Host 'and re-select the TLS certificate/key files, then Apply.'

Sec 'Logs'
$dirs = @($env:TEMP, 'C:\Windows\Temp', (Join-Path $env:ProgramData 'Veyon\Log'))
foreach ($d in $dirs) {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    Get-ChildItem -LiteralPath $d -Filter 'Veyon*.log' -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host ('--- ' + $_.FullName + ' (' + $_.Length + ' bytes)')
        Get-Content -LiteralPath $_.FullName -Tail 20 -ErrorAction SilentlyContinue
    }
}

Sec 'Done'
