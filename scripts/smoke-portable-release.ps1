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

function Get-Sha256Hex {
    param([string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $algorithm.ComputeHash($stream)
        return ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

$expectedHash = ((Get-Content -LiteralPath $checksumPath -Raw).Trim() -split "\s+")[0]
$actualHash = Get-Sha256Hex -Path $archive
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

try {
    New-Item -ItemType Directory -Path $smokeRoot, $dshHome -Force | Out-Null
    Write-Host "[portable-smoke] Extracting $archive"
    & tar.exe -xf $archive -C $smokeRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to extract portable archive with tar.exe (exit $LASTEXITCODE)"
    }

    $portableRoot = Join-Path $smokeRoot $portableName
    $appPath = Join-Path $portableRoot "DeepSeek Harness.exe"
    $nodePath = Join-Path $portableRoot "runtime\node.exe"
    $harnessRoot = Join-Path $portableRoot "runtime\harness"
    $launcherPath = Join-Path $harnessRoot "lib\bin.js"
    $requiredFiles = @(
        $appPath
        $nodePath
        (Join-Path $harnessRoot "package.json")
        $launcherPath
        (Join-Path $harnessRoot "node_modules\@deepseek-ai\dsh-web-frontend\dist\index.html")
        (Join-Path $harnessRoot "desktop-plugins\desktop-bridge\lib\index.mjs")
        (Join-Path $harnessRoot "plugins\dsh-attachments\lib\index.mjs")
        (Join-Path $harnessRoot "plugins\dsh-attachments\lib\client.js")
        (Join-Path $harnessRoot "plugins\dsh-attachments\cordis.patch.yml")
        (Join-Path $harnessRoot "plugins\dsh-model-capabilities\lib\index.mjs")
        (Join-Path $harnessRoot "plugins\dsh-model-capabilities\lib\client.js")
        (Join-Path $harnessRoot "plugins\dsh-model-capabilities\cordis.patch.yml")
    )
    foreach ($path in $requiredFiles) {
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Portable release is missing $path"
        }
        if ((Get-Item -LiteralPath $path).Length -eq 0) {
            throw "Portable release contains an empty file: $path"
        }
    }
    if (!(Test-Path -LiteralPath $harnessRoot -PathType Container)) {
        throw "Portable release is missing expanded Harness runtime: $harnessRoot"
    }
    $obsoleteArchivePath = Join-Path $portableRoot "runtime\harness.tar.gz"
    if (Test-Path -LiteralPath $obsoleteArchivePath) {
        throw "Portable release still contains the obsolete compressed runtime: $obsoleteArchivePath"
    }

    $legacyCachePath = Join-Path $env:LOCALAPPDATA (
        "ai.deepseek.harness.desktop\runtime\{0}" -f $package.version
    )
    $legacyCacheExistedBefore = Test-Path -LiteralPath $legacyCachePath

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
    if ($response.Content -notmatch "data-dsh-desktop-theme-bridge") {
        throw "Packaged Harness HTML is missing the desktop theme bridge"
    }
    if ($response.Content -notmatch "dsh-attachments") {
        throw "Packaged Harness HTML is missing the desktop attachment plugin manifest"
    }
    if ($response.Content -notmatch "dsh-model-capabilities") {
        throw "Packaged Harness HTML is missing the model capabilities plugin manifest"
    }
    $attachmentBundle = Invoke-WebRequest `
        -Uri "http://127.0.0.1:$($listener.LocalPort)/desktop-plugin-bundles/dsh-attachments/client.js" `
        -UseBasicParsing `
        -TimeoutSec 5
    if (
        $attachmentBundle.StatusCode -ne 200 -or
        $attachmentBundle.Content -notmatch "dsh-attachments"
    ) {
        throw "Packaged Harness did not serve the desktop attachment browser bundle"
    }
    $capabilitiesBundle = Invoke-WebRequest `
        -Uri "http://127.0.0.1:$($listener.LocalPort)/desktop-plugin-bundles/dsh-model-capabilities/client.js" `
        -UseBasicParsing `
        -TimeoutSec 5
    if (
        $capabilitiesBundle.StatusCode -ne 200 -or
        $capabilitiesBundle.Content -notmatch "dsh-model-capabilities"
    ) {
        throw "Packaged Harness did not serve the model capabilities browser bundle"
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
    $expectedLauncher = [IO.Path]::GetFullPath($launcherPath)
    if (
        [string]::IsNullOrWhiteSpace($nodeProcess.CommandLine) -or
        $nodeProcess.CommandLine -notmatch [regex]::Escape($expectedLauncher)
    ) {
        throw "Portable application did not launch the expanded adjacent runtime: $($nodeProcess.CommandLine)"
    }
    if (
        !$legacyCacheExistedBefore -and
        (Test-Path -LiteralPath $legacyCachePath)
    ) {
        throw "Portable application unexpectedly copied its runtime to AppData: $legacyCachePath"
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
                $candidate.Name -eq "msedgewebview2.exe"
            ) {
                $webviewProcess = $candidate
                break
            }
        }
    } while ($null -eq $webviewProcess -and (Get-Date) -lt $webviewDeadline)
    if ($null -eq $webviewProcess) {
        $portConnections = @(
            Get-NetTCPConnection `
                -RemotePort $listener.LocalPort `
                -ErrorAction SilentlyContinue
        )
        throw (
            "Desktop WebView did not expose an observable Harness connection. " +
            "Port connections: {0}; window: {1}" -f
                $portConnections.Count,
                $app.MainWindowTitle
        )
    }

    $harnessUrl = "http://127.0.0.1:$($listener.LocalPort)"
    $evidencePath = Join-Path $repositoryRoot "dist\portable-smoke-result.txt"
    @(
        "archive=$archive"
        "sha256=$($actualHash.ToLowerInvariant())"
        "portable_exe=$appPath"
        "node_executable=$($nodeProcess.ExecutablePath)"
        "runtime_layout=expanded"
        "harness_runtime=$harnessRoot"
        "harness_launcher=$expectedLauncher"
        "appdata_runtime_copy=absent"
        "window_title=$($app.MainWindowTitle)"
        "harness_url=$harnessUrl"
        "http_status=$([int]$response.StatusCode)"
        "html_bytes=$($response.RawContentLength)"
        "theme_bridge=present"
        "desktop_attachments=present"
        "webview_process=$($webviewProcess.ProcessId)"
        "webview_connection=established"
    ) | Set-Content -LiteralPath $evidencePath -Encoding utf8

    Write-Host "[portable-smoke] Window: $($app.MainWindowTitle)"
    Write-Host "[portable-smoke] Harness: $harnessUrl (HTTP $($response.StatusCode))"
    Write-Host "[portable-smoke] Expanded adjacent runtime launched directly"
    Write-Host "[portable-smoke] No AppData runtime copy was created"
    Write-Host "[portable-smoke] Desktop theme bridge present"
    Write-Host "[portable-smoke] Desktop attachment plugin present"
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
