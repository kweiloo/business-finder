# Windows locks a running executable. Run the existing uninstaller with a
# temporary copy so it can remove the bundled runtime along with the app.
$ErrorActionPreference = "Stop"
$temp = (New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ("business-finder-uninstall-" + [Guid]::NewGuid().ToString("N")))).FullName
$node = Join-Path $temp "node.exe"
try {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "runtime\node.exe") -Destination $node
    & $node (Join-Path $PSScriptRoot "dist\cli.js") uninstall @args
    $code = $LASTEXITCODE
} finally {
    if (Test-Path -LiteralPath $node) { Remove-Item -LiteralPath $node -Force }
    Remove-Item -LiteralPath $temp -Force
}
exit $code
