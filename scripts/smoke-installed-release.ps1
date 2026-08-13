param(
    [string]$InstallerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $repositoryRoot "package.json") -Raw |
    ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
    $InstallerPath = Join-Path $repositoryRoot (
        "dist\DeepSeek-Harness-Desktop-{0}-windows-x64-setup.exe" -f $package.version
    )
}
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$checksumPath = "$installer.sha256"
if (!(Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
    throw "Missing installer checksum: $checksumPath"
}

$expectedHash = ((Get-Content -LiteralPath $checksumPath -Raw).Trim() -split "\s+")[0]
$actualHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
if (![string]::Equals($expectedHash, $actualHash, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Installer SHA-256 does not match $checksumPath"
}

$smokeRoot = Join-Path ([IO.Path]::GetTempPath()) (
    "dsh-desktop-smoke-{0}" -f [guid]::NewGuid().ToString("N")
)
$installRoot = Join-Path $smokeRoot "install"
$dshHome = Join-Path $smokeRoot "home"
$app = $null
$uninstalled = $false
$originalDshHome = [Environment]::GetEnvironmentVariable("DSH_HOME", "Process")
$originalTelemetry = [Environment]::GetEnvironmentVariable(
    "DSH_TELEMETRY_DISABLED",
    "Process"
)

try {
    New-Item -ItemType Directory -Path $smokeRoot, $dshHome -Force | Out-Null
    Write-Host "[install-smoke] Installing $installer"
    $setup = Start-Process -FilePath $installer `
        -ArgumentList @("/S", "/D=$installRoot") `
        -WindowStyle Hidden `
        -Wait `
        -PassThru
    if ($setup.ExitCode -ne 0) {
        throw "NSIS installer exited with code $($setup.ExitCode)"
    }

    $appPath = Join-Path $installRoot "deepseek-harness-desktop.exe"
    $nodePath = Join-Path $installRoot "runtime\node.exe"
    $archivePath = Join-Path $installRoot "runtime\harness.tar.gz"
    foreach ($path in @($appPath, $nodePath, $archivePath)) {
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Installed release is missing $path"
        }
        if ((Get-Item -LiteralPath $path).Length -eq 0) {
            throw "Installed release contains an empty file: $path"
        }
    }

    $env:DSH_HOME = $dshHome
    $env:DSH_TELEMETRY_DISABLED = "1"
    $app = Start-Process -FilePath $appPath `
        -WorkingDirectory $installRoot `
        -WindowStyle Hidden `
        -PassThru

    $deadline = (Get-Date).AddSeconds(90)
    $nodeProcess = $null
    $listener = $null
    $response = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $app.Refresh()
        if ($app.HasExited) {
            throw "Installed desktop application exited with code $($app.ExitCode)"
        }

        $nodeProcess = Get-CimInstance Win32_Process -Filter (
            "ParentProcessId = {0} AND Name = 'node.exe'" -f $app.Id
        ) | Select-Object -First 1
        if ($null -eq $nodeProcess) {
            continue
        }

        $listeners = Get-NetTCPConnection `
            -State Listen `
            -OwningProcess $nodeProcess.ProcessId `
            -ErrorAction SilentlyContinue |
            Where-Object LocalAddress -In @("127.0.0.1", "0.0.0.0", "::1")
        foreach ($candidate in $listeners) {
            try {
                $candidateResponse = Invoke-WebRequest `
                    -Uri "http://127.0.0.1:$($candidate.LocalPort)" `
                    -UseBasicParsing `
                    -TimeoutSec 3
                if (
                    $candidateResponse.StatusCode -eq 200 -and
                    $candidateResponse.Content -match "<html"
                ) {
                    $listener = $candidate
                    $response = $candidateResponse
                    break
                }
            } catch {
                # The process can bind before the HTTP server accepts requests.
            }
        }
        if ($null -ne $response) {
            break
        }
    }

    if ($null -eq $response -or $null -eq $nodeProcess -or $null -eq $listener) {
        throw "Installed desktop application did not expose the Harness page within 90 seconds"
    }
    if (
        ![string]::Equals(
            [IO.Path]::GetFullPath($nodePath),
            [IO.Path]::GetFullPath($nodeProcess.ExecutablePath),
            [StringComparison]::OrdinalIgnoreCase
        )
    ) {
        throw "Desktop application used an external Node executable: $($nodeProcess.ExecutablePath)"
    }

    $windowDeadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 250
        $app.Refresh()
    } while (
        [string]::IsNullOrWhiteSpace($app.MainWindowTitle) -and
        (Get-Date) -lt $windowDeadline
    )

    $harnessUrl = "http://127.0.0.1:$($listener.LocalPort)"
    $evidencePath = Join-Path $repositoryRoot "dist\install-smoke-result.txt"
    @(
        "installer=$installer"
        "sha256=$($actualHash.ToLowerInvariant())"
        "installed_exe=$appPath"
        "node_executable=$($nodeProcess.ExecutablePath)"
        "window_title=$($app.MainWindowTitle)"
        "harness_url=$harnessUrl"
        "http_status=$([int]$response.StatusCode)"
        "html_bytes=$($response.RawContentLength)"
    ) | Set-Content -LiteralPath $evidencePath -Encoding utf8

    Write-Host "[install-smoke] Window: $($app.MainWindowTitle)"
    Write-Host "[install-smoke] Harness: $harnessUrl (HTTP $($response.StatusCode))"
    Write-Host "[install-smoke] Passed; evidence: $evidencePath"

    taskkill.exe /PID $app.Id /T /F | Out-Null
    Wait-Process -Id $app.Id -Timeout 15 -ErrorAction SilentlyContinue
    $app = $null

    $uninstaller = Get-ChildItem -LiteralPath $installRoot `
        -File `
        -Filter "*uninstall*.exe" |
        Select-Object -First 1
    if ($null -eq $uninstaller) {
        throw "Installed release does not contain an uninstaller"
    }
    $uninstall = Start-Process -FilePath $uninstaller.FullName `
        -ArgumentList "/S" `
        -WindowStyle Hidden `
        -Wait `
        -PassThru
    if ($uninstall.ExitCode -ne 0) {
        throw "NSIS uninstaller exited with code $($uninstall.ExitCode)"
    }
    $uninstalled = $true
} finally {
    if ($null -ne $app) {
        $app.Refresh()
        if (!$app.HasExited) {
            taskkill.exe /PID $app.Id /T /F | Out-Null
        }
    }
    if (!$uninstalled -and (Test-Path -LiteralPath $installRoot -PathType Container)) {
        $fallbackUninstaller = Get-ChildItem -LiteralPath $installRoot `
            -File `
            -Filter "*uninstall*.exe" `
            -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -ne $fallbackUninstaller) {
            Start-Process -FilePath $fallbackUninstaller.FullName `
                -ArgumentList "/S" `
                -WindowStyle Hidden `
                -Wait | Out-Null
        }
    }
    [Environment]::SetEnvironmentVariable("DSH_HOME", $originalDshHome, "Process")
    [Environment]::SetEnvironmentVariable(
        "DSH_TELEMETRY_DISABLED",
        $originalTelemetry,
        "Process"
    )
    if (Test-Path -LiteralPath $smokeRoot -PathType Container) {
        Remove-Item -LiteralPath $smokeRoot -Recurse -Force
    }
}
