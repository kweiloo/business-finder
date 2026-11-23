param([Parameter(Mandatory)][string]$PackagePath)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$package = (Resolve-Path -LiteralPath $PackagePath).Path
$root = Join-Path $repo ("dist\package test " + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $root | Out-Null
$env:LOCALAPPDATA = Join-Path $root "local"
$env:USERPROFILE = $root
$env:BUSINESS_FINDER_PATH_SCOPE = "Process"
$env:PATH = "$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
if (Get-Command bun.exe, node.exe -ErrorAction SilentlyContinue) { throw "Smoke test PATH must not contain a runtime." }
$data = Join-Path $env:LOCALAPPDATA "business-finder"
$shim = Join-Path $data "bin\business-finder.cmd"
$recordPath = Join-Path $data "server.json"
$installer = Join-Path $repo "install.ps1"
$fixture = Join-Path $root "fixture.json"
$export = Join-Path $root "export.csv"
$debug = Join-Path $root "debug.jsonl"

# One synthetic business and website. No browser or public network is used by the search.
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "fixtures\windows-package.json") -Destination $fixture
Set-Content -LiteralPath (Join-Path $root "example.test.html") -Value '<a href="mailto:team@example.test">Contact</a>' -Encoding Ascii

function Install-TestPackage {
    $env:BUSINESS_FINDER_FIXTURE = $fixture
    # Only doctor checks this in fixture mode. Use a known executable for that presence check.
    $env:BUSINESS_FINDER_CHROME = Join-Path $env:SystemRoot "System32\cmd.exe"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -PackagePath $package -NoOpen
    if ($LASTEXITCODE -ne 0) { throw "Package installer exited $LASTEXITCODE." }
    $server = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    $page = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($server.port)/"
    if ($page.StatusCode -ne 200 -or $page.Content -notmatch '/assets/[^"]+\.js') {
        throw "The installed server did not serve the built page."
    }
}

try {
    Install-TestPackage
    & $shim doctor
    if ($LASTEXITCODE -ne 0) { throw "Installed doctor failed." }

    $env:BUSINESS_FINDER_DEBUG_LOG = $debug
    & $shim scrape "event companies" --city "Melaka" --country MY --source fixture --out $export
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $export)) { throw "Fixture search did not export." }
    if ((Get-Content -LiteralPath $debug -Raw) -notmatch 'checks_child_exit .*ending=ended') {
        throw "The packaged CLI did not finish its website checks in a child process."
    }
    $lists = & $shim lists --json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $lists.places -ne 1) { throw "Fixture search did not save a one-place list." }

    $env:BUSINESS_FINDER_DATA_DIR = Join-Path $root "separate data"
    $otherLists = & $shim lists --json
    if ($LASTEXITCODE -ne 0 -or $otherLists -ne "[]") { throw "Explicit data directory was ignored." }
    Remove-Item Env:BUSINESS_FINDER_DATA_DIR
    $listId = $lists.id
    $running = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    $badPackage = Join-Path $root "broken.zip"
    Set-Content -LiteralPath $badPackage -Value "Not a ZIP"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -PackagePath $badPackage -NoOpen
    if ($LASTEXITCODE -ne 1) { throw "The installer accepted a damaged package." }
    & $shim --version
    if ($LASTEXITCODE -ne 0) { throw "A failed upgrade broke the installed CLI." }
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($running.port)/api/v1/health"
    if ($health.pid -ne $running.pid) { throw "A damaged package stopped the running app." }

    Install-TestPackage
    $lists = & $shim lists --json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $lists.id -ne $listId -or $lists.places -ne 1) {
        throw "Reinstallation did not preserve the saved list."
    }

    "" | & $shim uninstall
    if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $shim) -or (Test-Path -LiteralPath (Join-Path $data "app"))) {
        throw "The installed command did not remove its app and runtime."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $data "jobs"))) { throw "Uninstall removed the saved lists." }
    Write-Output "Windows package smoke test passed."
} finally {
    if (Test-Path -LiteralPath $recordPath) {
        $server = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
        $proc = Get-Process -Id ([int]$server.pid) -ErrorAction SilentlyContinue
        if ($proc -and $proc.Path -eq (Join-Path $data "app\runtime\node.exe")) {
            Stop-Process -Id $proc.Id -Force
            $proc.WaitForExit()
        }
    }
    $parent = (Resolve-Path -LiteralPath (Join-Path $repo "dist")).Path
    $resolved = (Resolve-Path -LiteralPath $root).Path
    if ((Split-Path -Parent $resolved) -eq $parent -and (Split-Path -Leaf $resolved) -like "package test *") {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
