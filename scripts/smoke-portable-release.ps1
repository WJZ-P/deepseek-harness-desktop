param(
    [string]$ArchivePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $repositoryRoot "package.json") -Raw |
    ConvertFrom-Json
$portableName = "DeepSeek-Harness-Desktop-{0}-windows-x64-portable" -f $package.version
if ([string]::IsNullOrWhiteSpace($ArchivePath)) {
    $ArchivePath = Join-Path $repositoryRoot "dist\$portableName.zip"
}
$archive = (Resolve-Path -LiteralPath $ArchivePath).Path
$checksumPath = "$archive.sha256"
if (!(Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
    throw "Missing portable archive checksum: $checksumPath"
}

$expectedHash = ((Get-Content -LiteralPath $checksumPath -Raw).Trim() -split "\s+")[0]
$actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
if (![string]::Equals($expectedHash, $actualHash, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Portable archive SHA-256 does not match $checksumPath"
}

$smokeRoot = Join-Path ([IO.Path]::GetTempPath()) (
    "dsh-desktop-portable-smoke-{0}" -f [guid]::NewGuid().ToString("N")
)
$dshHome = Join-Path $smokeRoot "home"
$app = $null
$originalDshHome = [Environment]::GetEnvironmentVariable("DSH_HOME", "Process")
$originalTelemetry = [Environment]::GetEnvironmentVariable(
    "DSH_TELEMETRY_DISABLED",
    "Process"
)

function Test-ProcessDescendant {
    param(
        [int]$ProcessId,
        [int]$AncestorId
    )

    $visited = @{}
    while ($ProcessId -gt 0 -and !$visited.ContainsKey($ProcessId)) {
        if ($ProcessId -eq $AncestorId) {
            return $true
        }
        $visited[$ProcessId] = $true
        $process = Get-CimInstance Win32_Process -Filter (
            "ProcessId = {0}" -f $ProcessId
        )
        if ($null -eq $process) {
            return $false
        }
        $ProcessId = $process.ParentProcessId
    }
    return $false
}

try {
    New-Item -ItemType Directory -Path $smokeRoot, $dshHome -Force | Out-Null
    Write-Host "[portable-smoke] Extracting $archive"
    Expand-Archive -LiteralPath $archive -DestinationPath $smokeRoot

    $portableRoot = Join-Path $smokeRoot $portableName
    $appPath = Join-Path $portableRoot "DeepSeek Harness.exe"
    $nodePath = Join-Path $portableRoot "runtime\node.exe"
    $harnessArchivePath = Join-Path $portableRoot "runtime\harness.tar.gz"
    foreach ($path in @($appPath, $nodePath, $harnessArchivePath)) {
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Portable release is missing $path"
        }
        if ((Get-Item -LiteralPath $path).Length -eq 0) {
            throw "Portable release contains an empty file: $path"
        }
    }

    $env:DSH_HOME = $dshHome
    $env:DSH_TELEMETRY_DISABLED = "1"
    $app = Start-Process -FilePath $appPath `
        -WorkingDirectory $portableRoot `
        -PassThru

    $deadline = (Get-Date).AddSeconds(90)
    $nodeProcess = $null
    $listener = $null
    $response = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $app.Refresh()
        if ($app.HasExited) {
            throw "Portable desktop application exited with code $($app.ExitCode)"
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
        throw "Portable desktop application did not expose the Harness page within 90 seconds"
    }
    if (
        ![string]::Equals(
            [IO.Path]::GetFullPath($nodePath),
            [IO.Path]::GetFullPath($nodeProcess.ExecutablePath),
            [StringComparison]::OrdinalIgnoreCase
        )
    ) {
        throw "Portable application used an external Node executable: $($nodeProcess.ExecutablePath)"
    }

    $windowDeadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 250
        $app.Refresh()
    } while (
        $app.MainWindowHandle -eq [IntPtr]::Zero -and
        (Get-Date) -lt $windowDeadline
    )
    if ($app.MainWindowHandle -eq [IntPtr]::Zero) {
        throw "Portable desktop application did not create a main window"
    }

    $webviewProcess = $null
    $webviewDeadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        $connections = Get-NetTCPConnection `
            -RemoteAddress "127.0.0.1" `
            -RemotePort $listener.LocalPort `
            -State Established `
            -ErrorAction SilentlyContinue
        foreach ($connection in $connections) {
            $candidate = Get-CimInstance Win32_Process -Filter (
                "ProcessId = {0}" -f $connection.OwningProcess
            )
            if (
                $null -ne $candidate -and
                $candidate.Name -eq "msedgewebview2.exe" -and
                (Test-ProcessDescendant `
                    -ProcessId $candidate.ProcessId `
                    -AncestorId $app.Id)
            ) {
                $webviewProcess = $candidate
                break
            }
        }
    } while ($null -eq $webviewProcess -and (Get-Date) -lt $webviewDeadline)
    if ($null -eq $webviewProcess) {
        throw "Desktop WebView did not load the Harness loopback page"
    }

    $harnessUrl = "http://127.0.0.1:$($listener.LocalPort)"
    $evidencePath = Join-Path $repositoryRoot "dist\portable-smoke-result.txt"
    @(
        "archive=$archive"
        "sha256=$($actualHash.ToLowerInvariant())"
        "portable_exe=$appPath"
        "node_executable=$($nodeProcess.ExecutablePath)"
        "window_title=$($app.MainWindowTitle)"
        "harness_url=$harnessUrl"
        "http_status=$([int]$response.StatusCode)"
        "html_bytes=$($response.RawContentLength)"
        "webview_process=$($webviewProcess.ProcessId)"
        "webview_connection=established"
    ) | Set-Content -LiteralPath $evidencePath -Encoding utf8

    Write-Host "[portable-smoke] Window: $($app.MainWindowTitle)"
    Write-Host "[portable-smoke] Harness: $harnessUrl (HTTP $($response.StatusCode))"
    Write-Host "[portable-smoke] WebView iframe connection established"

    $nodePid = $nodeProcess.ProcessId
    if (!$app.CloseMainWindow()) {
        throw "Portable desktop application did not accept a normal window close"
    }
    if (!$app.WaitForExit(15000)) {
        throw "Portable desktop application did not exit after its window closed"
    }
    $nodeDeadline = (Get-Date).AddSeconds(10)
    while (
        $null -ne (Get-Process -Id $nodePid -ErrorAction SilentlyContinue) -and
        (Get-Date) -lt $nodeDeadline
    ) {
        Start-Sleep -Milliseconds 250
    }
    if ($null -ne (Get-Process -Id $nodePid -ErrorAction SilentlyContinue)) {
        throw "Harness Node process remained after the desktop window closed"
    }
    Add-Content -LiteralPath $evidencePath -Encoding utf8 -Value "shutdown=graceful"
    $app = $null
    Write-Host "[portable-smoke] Graceful shutdown passed"
    Write-Host "[portable-smoke] Passed; evidence: $evidencePath"
} finally {
    if ($null -ne $app) {
        $app.Refresh()
        if (!$app.HasExited) {
            taskkill.exe /PID $app.Id /T /F | Out-Null
            Wait-Process -Id $app.Id -Timeout 15 -ErrorAction SilentlyContinue
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
