param(
    [string]$DshPackage = "@deepseek-ai/dsh@0.1.0-rc.7",
    [string]$AttachmentPackage = "dsh-attachment@1.0.1",
    [string]$CapabilityPackage = "dsh-model-capability@1.0.1"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$node = (Get-Command node.exe).Source
$pnpm = (Get-Command pnpm.cmd).Source
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = [IO.Path]::GetFullPath((Join-Path $tempBase (
    "dsh-npm-e2e-{0}" -f [guid]::NewGuid().ToString("N")
)))
if (
    !$testRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -or
    $testRoot -eq $tempBase
) {
    throw "Unsafe test root: $testRoot"
}

$store = Join-Path $testRoot "pnpm-store"
$consumer = Join-Path $testRoot "consumer"
$launcher = Join-Path $consumer "node_modules\@deepseek-ai\dsh\lib\bin.js"
$stdout = Join-Path $testRoot "web.stdout.log"
$stderr = Join-Path $testRoot "web.stderr.log"
$originalDshHome = [Environment]::GetEnvironmentVariable("DSH_HOME", "Process")
$originalTelemetry = [Environment]::GetEnvironmentVariable(
    "DSH_TELEMETRY_DISABLED",
    "Process"
)
$app = $null

try {
    New-Item -ItemType Directory -Path $testRoot, $store, $consumer -Force | Out-Null
    $env:DSH_HOME = $testRoot
    $env:DSH_TELEMETRY_DISABLED = "1"
    Write-Host "[npm-e2e] Isolated DSH_HOME: $testRoot"

    '{"name":"dsh-npm-e2e-consumer","private":true}' |
        Set-Content -LiteralPath (Join-Path $consumer "package.json") -Encoding utf8
    & $pnpm `
        --dir $consumer `
        add $DshPackage `
        --store-dir $store `
        --config.node-linker=hoisted `
        --config.auto-install-peers=true `
        --ignore-scripts
    if ($LASTEXITCODE -ne 0) {
        throw "Native DSH install exited with code $LASTEXITCODE"
    }
    if (!(Test-Path -LiteralPath $launcher -PathType Leaf)) {
        throw "Native DSH launcher is missing: $launcher"
    }
    Write-Host "[npm-e2e] Installed native $DshPackage from npm"

    & $node $launcher plugin --profile web add $AttachmentPackage --store-dir $store
    if ($LASTEXITCODE -ne 0) {
        throw "Attachment install exited with code $LASTEXITCODE"
    }
    & $node $launcher plugin --profile web add $CapabilityPackage --store-dir $store
    if ($LASTEXITCODE -ne 0) {
        throw "Model capability install exited with code $LASTEXITCODE"
    }

    $profilePath = Join-Path $testRoot "profiles\web\package.json"
    $profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
    foreach ($name in @("dsh-attachment", "dsh-model-capability")) {
        if ($profile.dependencies.PSObject.Properties.Name -notcontains $name) {
            throw "Profile dependency missing $name"
        }
        if ($profile.dsh.profile.bundles -notcontains $name) {
            throw "Profile bundle list missing $name"
        }
    }
    Write-Host "[npm-e2e] Profile dependencies and bundle list verified"

    $dump = & $node $launcher --profile web --dump-config
    if ($LASTEXITCODE -ne 0) {
        throw "Config dump exited with code $LASTEXITCODE"
    }
    $dumpText = $dump -join "`n"
    foreach ($name in @("dsh-attachment", "dsh-model-capability")) {
        if (!$dumpText.Contains("name: $name")) {
            throw "Composed config missing $name"
        }
    }
    Write-Host "[npm-e2e] Composed Cordis config verified"

    $app = Start-Process `
        -FilePath $node `
        -ArgumentList @($launcher, "web", "--host", "127.0.0.1", "--port", "0") `
        -WorkingDirectory $consumer `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru

    $deadline = (Get-Date).AddSeconds(90)
    $readyUrl = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 400
        $app.Refresh()
        if ($app.HasExited) {
            $errorText = Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue
            throw "DSH web exited with code $($app.ExitCode): $errorText"
        }
        if (Test-Path -LiteralPath $stdout) {
            $outputText = Get-Content -LiteralPath $stdout -Raw
            if ($null -ne $outputText) {
                $match = [regex]::Match(
                    $outputText,
                    "dsh web: (http://127\.0\.0\.1:\d+)"
                )
                if ($match.Success) {
                    $readyUrl = $match.Groups[1].Value
                    break
                }
            }
        }
    }
    if ($null -eq $readyUrl) {
        throw "DSH web readiness timeout"
    }

    $html = Invoke-WebRequest -Uri $readyUrl -UseBasicParsing -TimeoutSec 10
    if ($html.StatusCode -ne 200) {
        throw "Root returned HTTP $($html.StatusCode)"
    }
    foreach ($name in @("dsh-attachment", "dsh-model-capability")) {
        if (!$html.Content.Contains($name)) {
            throw "Boot manifest missing $name"
        }
        $bundle = Invoke-WebRequest `
            -Uri "$readyUrl/plugins/$name/client.js" `
            -UseBasicParsing `
            -TimeoutSec 10
        if ($bundle.StatusCode -ne 200 -or !$bundle.Content.Contains($name)) {
            throw "Client bundle check failed for $name"
        }
        Write-Host "[npm-e2e] $name client bundle HTTP 200"
    }
    Write-Host "[npm-e2e] Native DSH web ready: $readyUrl"
    Write-Host "[npm-e2e] PASS"
}
finally {
    if ($null -ne $app) {
        try {
            $app.Refresh()
        } catch {
            # The process may have exited between the prior check and cleanup.
        }
        if (!$app.HasExited) {
            Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $app.Id -Timeout 10 -ErrorAction SilentlyContinue
        }
    }
    [Environment]::SetEnvironmentVariable("DSH_HOME", $originalDshHome, "Process")
    [Environment]::SetEnvironmentVariable(
        "DSH_TELEMETRY_DISABLED",
        $originalTelemetry,
        "Process"
    )

    $resolved = [IO.Path]::GetFullPath($testRoot)
    if (
        !$resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -or
        $resolved -eq $tempBase
    ) {
        throw "Cleanup target escaped the temporary directory: $resolved"
    }
    if (Test-Path -LiteralPath $resolved) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    if (Test-Path -LiteralPath $resolved) {
        throw "Temporary DSH_HOME remains: $resolved"
    }
    Write-Host "[npm-e2e] Removed isolated DSH_HOME: $resolved"
}
