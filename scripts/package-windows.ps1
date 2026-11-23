param(
    [string]$NodeExe = (Get-Command node.exe -ErrorAction Stop).Source,
    [string]$OutputDir = "dist",
    [string]$NodeLicense = ""
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $repo
try {
    & bun run build:release
    if ($LASTEXITCODE -ne 0) { throw "Release build failed." }

    $node = (Resolve-Path -LiteralPath $NodeExe).Path
    $arch = & $node -p "process.arch"
    if ($LASTEXITCODE -ne 0 -or $arch -ne "x64") { throw "The Windows package requires a Windows x64 Node.js runtime." }
    if (-not $NodeLicense) { $NodeLicense = Join-Path (Split-Path -Parent $node) "LICENSE" }
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
    $out = (Resolve-Path -LiteralPath $OutputDir).Path
    $staging = Join-Path $out (".windows-package-" + [Guid]::NewGuid().ToString("N"))
    $app = Join-Path $staging "app"
    $runtime = Join-Path $app "runtime"
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    try {
        $dist = New-Item -ItemType Directory -Path (Join-Path $app "dist")
        Copy-Item -LiteralPath "dist\cli.js", "dist\checkChild.js", "dist\web", "dist\THIRD-PARTY-NOTICES.txt" -Destination $dist.FullName -Recurse
        Copy-Item -LiteralPath "package.json", "LICENSE" -Destination $app
        Copy-Item -LiteralPath "scripts\uninstall-windows.ps1" -Destination (Join-Path $app "uninstall.ps1")
        Copy-Item -LiteralPath $node -Destination (Join-Path $runtime "node.exe")
        Copy-Item -LiteralPath $NodeLicense -Destination (Join-Path $runtime "LICENSE")
        $skill = New-Item -ItemType Directory -Path (Join-Path $app "skills\business-finder") -Force
        Copy-Item -LiteralPath "skills\business-finder\SKILL.md" -Destination $skill.FullName

        $asset = Join-Path $out "business-finder-windows-x64.zip"
        Compress-Archive -LiteralPath $app -DestinationPath $asset -Force
        (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToLowerInvariant() |
            Set-Content -LiteralPath "$asset.sha256" -Encoding Ascii
        Write-Output "Built $asset"
    } finally {
        $resolved = (Resolve-Path -LiteralPath $staging).Path
        if ((Split-Path -Parent $resolved) -eq $out -and (Split-Path -Leaf $resolved) -like ".windows-package-*") {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
} finally {
    Pop-Location
}
