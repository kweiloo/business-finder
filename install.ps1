# Business Finder installer for Windows 10/11 (Windows PowerShell 5.1).
#
#   irm https://raw.githubusercontent.com/kweiloo/business-finder/main/install.ps1 | iex
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 [-PathScope Process] [-RepoUrl <url>] [-Branch <name>] [-PackagePath <zip>] [-NoOpen]
#
# Everything runs inside one script block, so under `irm | iex` the caller's
# session keeps its own $ErrorActionPreference, variables and functions.
# Settings that `iex` cannot pass as parameters come from the environment:
#   BUSINESS_FINDER_PATH_SCOPE=Process  keep PATH changes to this process (tests)
#   BUSINESS_FINDER_REPO_URL, BUSINESS_FINDER_BRANCH  install from another repository or branch
#   BUSINESS_FINDER_PACKAGE_PATH  install a locally downloaded release ZIP
#   BUSINESS_FINDER_NO_OPEN=1  do not open the browser at the end
#   BUSINESS_FINDER_USER_ENV_KEY  HKCU registry key that holds the user PATH (tests; default Environment)
#   BUSINESS_FINDER_NO_EXIT=1  under `irm | iex`, leave the exit code in $LASTEXITCODE instead of calling exit (tests)
#
# Exit codes: 0 installed and running; 1 the install stopped; 2 installed, but
# this machine is not ready to search (no Edge or Chrome). The plain message is
# always the last line printed.
& {
param(
    [ValidateSet("User", "Process")]
    [string]$PathScope = "User",
    [string]$RepoUrl = "",
    [string]$Branch = "",
    [string]$PackagePath = "",
    [switch]$NoOpen
)

$ErrorActionPreference = "Stop"

# Single constant for the GitHub repository slug while the repo rename is pending.
$RepoSlug = "kweiloo/business-finder"
$DefaultRepoUrl = "https://github.com/$RepoSlug.git"

# The environment wins over the parameter: under `irm | iex` it is the only input.
$hasExplicitRepo = (-not [string]::IsNullOrWhiteSpace($RepoUrl)) -or (-not [string]::IsNullOrWhiteSpace($env:BUSINESS_FINDER_REPO_URL))
if ($env:BUSINESS_FINDER_PATH_SCOPE -eq "Process") { $PathScope = "Process" }
if (-not $RepoUrl) { $RepoUrl = if ($env:BUSINESS_FINDER_REPO_URL) { $env:BUSINESS_FINDER_REPO_URL } else { $DefaultRepoUrl } }
if (-not $Branch) { $Branch = if ($env:BUSINESS_FINDER_BRANCH) { $env:BUSINESS_FINDER_BRANCH } else { "main" } }
if (-not $PackagePath) { $PackagePath = $env:BUSINESS_FINDER_PACKAGE_PATH }
if ($env:BUSINESS_FINDER_NO_OPEN -eq "1") { $NoOpen = [switch]$true }

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.ServicePointManager]::SecurityProtocol
} catch {
}

function Normalize-BusinessFinderPathSegment {
    param([string]$Segment)
    if ($null -eq $Segment) { return "" }
    $t = $Segment.Trim()
    while ($t.Length -gt 1 -and ($t.EndsWith('\') -or $t.EndsWith('/'))) {
        if ($t -match '^[A-Za-z]:\\$') { break }
        $t = $t.Substring(0, $t.Length - 1)
    }
    return $t
}

function Add-BusinessFinderPathEntry {
    param(
        [string]$PathValue,
        [string]$Entry
    )
    if ([string]::IsNullOrWhiteSpace($Entry)) { return $PathValue }
    $cleanEntry = $Entry.Trim()
    $target = Normalize-BusinessFinderPathSegment $cleanEntry
    $parts = @()
    if (-not [string]::IsNullOrEmpty($PathValue)) {
        $parts = @($PathValue -split ';' | Where-Object { $_ -ne '' })
    }
    foreach ($p in $parts) {
        if ((Normalize-BusinessFinderPathSegment $p) -ieq $target) {
            return $PathValue
        }
    }
    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        return $cleanEntry
    }
    if ($PathValue.EndsWith(';')) {
        return "$PathValue$cleanEntry"
    }
    return "$PathValue;$cleanEntry"
}

function Remove-BusinessFinderPathEntry {
    param(
        [string]$PathValue,
        [string]$Entry
    )
    if ([string]::IsNullOrWhiteSpace($PathValue) -or [string]::IsNullOrWhiteSpace($Entry)) {
        return $PathValue
    }
    $target = Normalize-BusinessFinderPathSegment $Entry
    $parts = @($PathValue -split ';' | Where-Object { $_ -ne '' })
    $kept = @($parts | Where-Object { (Normalize-BusinessFinderPathSegment $_) -ine $target })
    if ($kept.Count -eq $parts.Count) {
        return $PathValue
    }
    return ($kept -join ';')
}

function Publish-BusinessFinderEnv {
    if (-not ("Win32.BusinessFinderEnv" -as [Type])) {
        Add-Type -Namespace Win32 -Name BusinessFinderEnv -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@
    }
    $result = [UIntPtr]::Zero
    [Win32.BusinessFinderEnv]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result) | Out-Null
}

function Update-BusinessFinderUserPath {
    param(
        [Parameter(Mandatory)][string]$AddEntry,
        [string]$RemoveEntry = ""
    )
    $keyName = if ($env:BUSINESS_FINDER_USER_ENV_KEY) { $env:BUSINESS_FINDER_USER_ENV_KEY } else { "Environment" }
    $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyName, $true)
    if ($null -eq $envKey) {
        $envKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyName)
    }
    try {
        $current = [string]$envKey.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $updated = $current
        if ($RemoveEntry) {
            $updated = Remove-BusinessFinderPathEntry -PathValue $updated -Entry $RemoveEntry
        }
        $updated = Add-BusinessFinderPathEntry -PathValue $updated -Entry $AddEntry
        if ($updated -ne $current) {
            $kind = if ($updated.Contains('%')) {
                [Microsoft.Win32.RegistryValueKind]::ExpandString
            } else {
                try { $envKey.GetValueKind("Path") } catch { [Microsoft.Win32.RegistryValueKind]::String }
            }
            $envKey.SetValue("Path", $updated, $kind)
            Publish-BusinessFinderEnv
        }
    } finally {
        $envKey.Close()
    }
}

function Invoke-BusinessFinderQuiet {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$WorkingDirectory = ""
    )
    $prevDir = Get-Location
    $prevEap = $ErrorActionPreference
    try {
        if ($WorkingDirectory) { Set-Location $WorkingDirectory }
        $ErrorActionPreference = "Continue"
        $output = & $FilePath @ArgumentList 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
        Set-Location $prevDir
    }
    if ($code -ne 0) {
        $text = ($output | ForEach-Object { "$_" }) -join "`n"
        throw "Command failed ($FilePath $($ArgumentList -join ' ')):`n$text"
    }
}

function Get-BusinessFinderZipUrl {
    param(
        [string]$Url,
        [string]$BranchName
    )
    $base = $Url.TrimEnd('/')
    if ($base.EndsWith(".git", [StringComparison]::OrdinalIgnoreCase)) {
        $base = $base.Substring(0, $base.Length - 4)
    }
    return "$base/archive/refs/heads/$BranchName.zip"
}

function Install-BusinessFinderFromZip {
    param(
        [string]$ZipUrl,
        [string]$AppDir
    )
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("business-finder-zip-" + [Guid]::NewGuid().ToString("N"))
    $zipFile = Join-Path $tempRoot "repo.zip"
    $extractDir = Join-Path $tempRoot "extract"
    New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
    try {
        Invoke-WebRequest -Uri $ZipUrl -OutFile $zipFile -UseBasicParsing
        Expand-Archive -Path $zipFile -DestinationPath $extractDir -Force
        $children = @(Get-ChildItem -Path $extractDir -Directory)
        if ($children.Count -ne 1) {
            throw "Unexpected archive layout in $ZipUrl"
        }
        $sourceDir = $children[0].FullName
        if (Test-Path $AppDir) {
            Remove-Item -Path $AppDir -Recurse -Force
        }
        Move-Item -Path $sourceDir -Destination $AppDir
    } finally {
        if (Test-Path $tempRoot) {
            Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Install-BusinessFinderRelease {
    param([string]$DataDir, [string]$LegacyDataDir, [string]$AppDir, [string]$PackagePath)
    $localRoot = Split-Path -Parent $DataDir
    $stage = Join-Path $localRoot ("business-finder-install-" + [Guid]::NewGuid().ToString("N"))
    $backup = Join-Path $stage "previous"
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    try {
        if ($PackagePath) {
            $zip = (Resolve-Path -LiteralPath $PackagePath).Path
        } else {
            $url = "https://github.com/$RepoSlug/releases/latest/download/business-finder-windows-x64.zip"
            $zip = Join-Path $stage "release.zip"
            $hashFile = Join-Path $stage "release.sha256"
            $previousProgress = $ProgressPreference
            try {
                $ProgressPreference = "SilentlyContinue"
                Invoke-WebRequest -UseBasicParsing -Uri "$url.sha256" -OutFile $hashFile
                Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
            } finally {
                $ProgressPreference = $previousProgress
            }
            $expected = (Get-Content -LiteralPath $hashFile -Raw).Trim()
            if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ine $expected) {
                throw "Release download did not match its SHA-256 checksum."
            }
        }
        $unpacked = Join-Path $stage "unpacked"
        Expand-Archive -LiteralPath $zip -DestinationPath $unpacked
        $newApp = Join-Path $unpacked "app"
        foreach ($file in @("runtime\node.exe", "dist\cli.js", "dist\checkChild.js", "dist\web\index.html", "package.json", "uninstall.ps1", "skills\business-finder\SKILL.md")) {
            if (-not (Test-Path -LiteralPath (Join-Path $newApp $file) -PathType Leaf)) {
                throw "The release package is missing $file."
            }
        }
        Invoke-BusinessFinderQuiet -FilePath (Join-Path $newApp "runtime\node.exe") -ArgumentList @((Join-Path $newApp "dist\cli.js"), "--version")
        Initialize-BusinessFinderData -DataDir $DataDir -LegacyDataDir $LegacyDataDir
        if (Test-Path -LiteralPath $AppDir) {
            Move-Item -LiteralPath $AppDir -Destination $backup
        }
        try {
            Move-Item -LiteralPath $newApp -Destination $AppDir
        } catch {
            if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $AppDir }
            throw
        }
        $installed = $true
    } finally {
        $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
        $resolvedRoot = (Resolve-Path -LiteralPath $localRoot).Path
        # Keep the backup if restoring it failed.
        if (($installed -or -not (Test-Path -LiteralPath $backup)) -and
            (Split-Path -Parent $resolvedStage) -eq $resolvedRoot -and (Split-Path -Leaf $resolvedStage) -like "business-finder-install-*") {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Stop-BusinessFinderServer {
    # Stops the running `business-finder serve` for this data folder, only after its
    # health route confirms the recorded process id. Returns $true if one was stopped.
    param([string]$DataDir)
    $recordPath = Join-Path $DataDir "server.json"
    if (-not (Test-Path $recordPath)) { return $false }
    try {
        $rec = Get-Content $recordPath -Raw | ConvertFrom-Json
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($rec.port)/api/v1/health" -TimeoutSec 2
        if ($health.ok -ne $true -or $health.pid -ne $rec.pid) { return $false }
        Stop-Process -Id ([int]$rec.pid) -Force
        $deadline = (Get-Date).AddSeconds(5)
        while ((Get-Process -Id ([int]$rec.pid) -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 100
        }
        Remove-Item $recordPath -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        return $false
    }
}

function Initialize-BusinessFinderData {
    param([string]$DataDir, [string]$LegacyDataDir)
    $stoppedLegacy = Stop-BusinessFinderServer -DataDir $legacyDataDir
    $stoppedCurrent = Stop-BusinessFinderServer -DataDir $dataDir
    if ($stoppedLegacy -or $stoppedCurrent) {
        Write-Output "Stopped the Business Finder that was running, so it can be updated."
    }

    if ((Test-Path -LiteralPath $legacyDataDir) -and -not (Test-Path -LiteralPath $dataDir)) {
        Move-Item -LiteralPath $legacyDataDir -Destination $dataDir
    }
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
}

function Copy-BusinessFinderSource {
    param(
        [Parameter(Mandatory)][string]$SourceDir,
        [Parameter(Mandatory)][string]$AppDir
    )
    $sourceFull = [System.IO.Path]::GetFullPath($SourceDir).TrimEnd('\')
    if (Test-Path $AppDir) {
        Remove-Item -Path $AppDir -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
    $skipDirs = @(".git", "node_modules", "test-results", "playwright-report")
    Get-ChildItem -Force -Path $sourceFull | ForEach-Object {
        if ($_.PSIsContainer -and ($skipDirs -contains $_.Name)) { return }
        $destPath = Join-Path $AppDir $_.Name
        if ($_.PSIsContainer -and $_.Name -eq "web") {
            New-Item -ItemType Directory -Force -Path $destPath | Out-Null
            Get-ChildItem -Force -Path $_.FullName | ForEach-Object {
                if ($_.PSIsContainer -and ($_.Name -in @("node_modules", "dist"))) { return }
                Copy-Item -Path $_.FullName -Destination (Join-Path $destPath $_.Name) -Recurse -Force
            }
            return
        }
        Copy-Item -Path $_.FullName -Destination $destPath -Recurse -Force
    }
}

function Test-OwnedBusinessFinderSkillDir {
    # True only when $Dir is a plain directory containing solely our SKILL.md.
    param(
        [Parameter(Mandatory)][string]$Dir,
        [Parameter(Mandatory)][string]$SkillName
    )
    if (-not (Test-Path -LiteralPath $Dir)) { return $false }
    try {
        $item = Get-Item -LiteralPath $Dir -Force
        if (-not $item.PSIsContainer) { return $false }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
        $entries = @(Get-ChildItem -LiteralPath $Dir -Force)
        if ($entries.Count -ne 1 -or $entries[0].PSIsContainer -or $entries[0].Name -ne "SKILL.md") { return $false }
        if (($entries[0].Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
        $text = Get-Content -LiteralPath $entries[0].FullName -Raw -ErrorAction SilentlyContinue
        if ([string]::IsNullOrEmpty($text)) { return $false }
        $escaped = [regex]::Escape($SkillName)
        return ($text -match "(?ms)\A---\r?\n.*?^name:\s*$escaped\s*$") -or ($text -match "(?m)^#\s*$escaped\b")
    } catch {
        return $false
    }
}

function Write-BusinessFinderShim {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$BunExe,
        [string]$AliasedFrom = ""
    )
    $lines = @(
        '@echo off',
        'setlocal',
        'set "BUSINESS_FINDER_APP=%~dp0..\app"',
        'set "BUSINESS_FINDER_BUN="',
        'where /q bun && set "BUSINESS_FINDER_BUN=bun"',
        'if not defined BUSINESS_FINDER_BUN if defined BUN_INSTALL if exist "%BUN_INSTALL%\bin\bun.exe" set "BUSINESS_FINDER_BUN=%BUN_INSTALL%\bin\bun.exe"',
        'if not defined BUSINESS_FINDER_BUN if exist "%USERPROFILE%\.bun\bin\bun.exe" set "BUSINESS_FINDER_BUN=%USERPROFILE%\.bun\bin\bun.exe"',
        "if not defined BUSINESS_FINDER_BUN if exist `"$BunExe`" set `"BUSINESS_FINDER_BUN=$BunExe`"",
        'if not defined BUSINESS_FINDER_BUN (',
        '  echo Could not find bun. Re-run the business-finder installer. >&2',
        '  exit /b 2',
        ')'
    )
    if ($AliasedFrom) {
        $lines += "(echo $AliasedFrom is now called business-finder) 1>&2"
    }
    $lines += '(goto) 2>nul & "%BUSINESS_FINDER_BUN%" "%BUSINESS_FINDER_APP%\src\cli\main.ts" %*'
    $content = ($lines -join "`r`n") + "`r`n"
    [System.IO.File]::WriteAllText($Path, $content, [System.Text.Encoding]::ASCII)
}

function Write-BusinessFinderReleaseShim {
    param([string]$Path, [string]$AliasedFrom = "")
    $lines = @(
        '@echo off',
        'setlocal DisableDelayedExpansion',
        'set "BUSINESS_FINDER_APP=%~dp0..\app"'
    )
    if ($AliasedFrom) {
        $lines += "(echo $AliasedFrom is now called business-finder) 1>&2"
    }
    $lines += @(
        'if not exist "%BUSINESS_FINDER_APP%\runtime\node.exe" (',
        '  echo Business Finder runtime is missing. Re-run the installer. >&2',
        '  exit /b 2',
        ')',
        'if /i "%~1"=="uninstall" goto uninstall',
        '(goto) 2>nul & "%BUSINESS_FINDER_APP%\runtime\node.exe" "%BUSINESS_FINDER_APP%\dist\cli.js" %*',
        ':uninstall',
        'shift',
        '(goto) 2>nul & "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%BUSINESS_FINDER_APP%\uninstall.ps1" %1 %2 %3 %4 %5 %6 %7 %8 %9'
    )
    [System.IO.File]::WriteAllText($Path, ($lines -join [Environment]::NewLine) + [Environment]::NewLine, [System.Text.Encoding]::ASCII)
}

function Invoke-BusinessFinderInstall {
    param(
        [Parameter(Mandatory)][ValidateSet("User", "Process")][string]$PathScope,
        [Parameter(Mandatory)][string]$RepoUrl,
        [Parameter(Mandatory)][string]$Branch,
        [switch]$NoOpen,
        [string]$SourceDir = "",
        [string]$PackagePath = "",
        [switch]$ExplicitRepo,
        # Step names the failure message uses to pick its hint.
        [Parameter(Mandatory)][hashtable]$State
    )

    $userHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $userHome "AppData\Local" }
    $dataDir = Join-Path $localAppData "business-finder"
    $legacyDataDir = Join-Path $localAppData "leadscout"
    $appDir = Join-Path $dataDir "app"
    $binDir = Join-Path $dataDir "bin"
    $legacyBinDir = Join-Path $legacyDataDir "bin"
    $useUnzippedSource = $false
    if (-not $ExplicitRepo -and -not $PackagePath -and $SourceDir) {
        $hasAppEntry = (Test-Path (Join-Path $SourceDir "package.json")) -and (Test-Path (Join-Path $SourceDir "src\cli\main.ts"))
        $sourceHasGit = Test-Path (Join-Path $SourceDir ".git")
        if ($hasAppEntry -and -not $sourceHasGit) {
            $sourceNorm = [System.IO.Path]::GetFullPath($SourceDir).TrimEnd('\')
            $appNorm = [System.IO.Path]::GetFullPath($appDir).TrimEnd('\')
            if ($sourceNorm -ine $appNorm) {
                $useUnzippedSource = $true
            }
        }
    }
    $fromSource = -not $PackagePath -and ($ExplicitRepo -or $useUnzippedSource)
    if ($fromSource) {
        $bunRoot = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $userHome ".bun" }
        $bunBin = Join-Path $bunRoot "bin"
        $bunAtDefault = Join-Path $bunBin "bun.exe"

        # 1. Bun
        $State.Step = "bun"
        $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
        $bunExe = $null
        if ($bunCmd) {
            $bunExe = $bunCmd.Source
            Write-Output "Checking for Bun... ready"
        } elseif (Test-Path $bunAtDefault) {
            $bunExe = $bunAtDefault
            $env:PATH = Add-BusinessFinderPathEntry -PathValue $env:PATH -Entry $bunBin
            Write-Output "Checking for Bun... ready"
        } else {
            Write-Output "Checking for Bun... installing it (about 1 minute)"
            $env:BUN_INSTALL = $bunRoot
            $bunScript = Invoke-RestMethod -Uri "https://bun.sh/install.ps1"
            $bunBlock = [scriptblock]::Create($bunScript)
            $prevProg = $ProgressPreference
            $prevWarn = $WarningPreference
            $prevPath = $env:PATH
            try {
                $ProgressPreference = "SilentlyContinue"
                $WarningPreference = "SilentlyContinue"
                if ($PathScope -eq "Process") {
                    & $bunBlock -NoPathUpdate -NoRegisterInstallation -NoCompletions -DownloadWithoutCurl | Out-Null
                } else {
                    & $bunBlock -DownloadWithoutCurl | Out-Null
                }
            } finally {
                $env:PATH = $prevPath
                $ProgressPreference = $prevProg
                $WarningPreference = $prevWarn
            }
            $env:PATH = Add-BusinessFinderPathEntry -PathValue $env:PATH -Entry $bunBin
            if (Test-Path $bunAtDefault) {
                $bunExe = $bunAtDefault
            } else {
                $bunAfter = Get-Command bun -ErrorAction SilentlyContinue
                if ($bunAfter) { $bunExe = $bunAfter.Source }
            }
            if (-not $bunExe) {
                throw "Bun finished installing, but bun.exe could not be found."
            }
        }
    }

    $State.Step = "download"
    if (-not $fromSource) {
        Write-Output "Installing the Business Finder release..."
        if ($PackagePath) { $State.Step = "package" }
        Install-BusinessFinderRelease -DataDir $dataDir -LegacyDataDir $legacyDataDir -AppDir $appDir -PackagePath $PackagePath
        $runtimeExe = Join-Path $appDir "runtime\node.exe"
        $cliEntry = Join-Path $appDir "dist\cli.js"
    } else {
        Initialize-BusinessFinderData -DataDir $dataDir -LegacyDataDir $legacyDataDir
        $gitCmd = Get-Command git -ErrorAction SilentlyContinue
        $hasGitRepo = Test-Path (Join-Path $appDir ".git")
        if ($useUnzippedSource) {
            Write-Output "Copying Business Finder from this folder..."
            Copy-BusinessFinderSource -SourceDir $SourceDir -AppDir $appDir
        } elseif ($gitCmd -and $hasGitRepo) {
            Write-Output "Updating Business Finder..."
            Invoke-BusinessFinderQuiet -FilePath $gitCmd.Source -ArgumentList @("-C", $appDir, "pull", "--ff-only")
        } elseif ($gitCmd) {
            Write-Output "Downloading Business Finder..."
            if (Test-Path $appDir) {
                Remove-Item -Path $appDir -Recurse -Force
            }
            Invoke-BusinessFinderQuiet -FilePath $gitCmd.Source -ArgumentList @("clone", "--branch", $Branch, "--single-branch", $RepoUrl, $appDir)
        } else {
            if (Test-Path $appDir) {
                Write-Output "Updating Business Finder..."
            } else {
                Write-Output "Downloading Business Finder..."
            }
            $zipUrl = Get-BusinessFinderZipUrl -Url $RepoUrl -BranchName $Branch
            Install-BusinessFinderFromZip -ZipUrl $zipUrl -AppDir $appDir
        }

        # 3. Install dependencies and build web UI
        $State.Step = "build"
        Write-Output "Installing dependencies and building the app (about 1 minute)..."
        Invoke-BusinessFinderQuiet -FilePath $bunExe -ArgumentList @("install", "--frozen-lockfile") -WorkingDirectory $appDir
        Invoke-BusinessFinderQuiet -FilePath $bunExe -ArgumentList @("run", "build:web") -WorkingDirectory $appDir
        $runtimeExe = $bunExe
        $cliEntry = Join-Path $appDir "src\cli\main.ts"
    }

    # 4. Command shims (`business-finder` + `leadscout` alias) and PATH
    $State.Step = "command"
    Write-Output "Adding the business-finder command..."
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $shimPath = Join-Path $binDir "business-finder.cmd"
    $aliasShimPath = Join-Path $binDir "leadscout.cmd"
    if ($fromSource) {
        Write-BusinessFinderShim -Path $shimPath -BunExe $bunExe
        Write-BusinessFinderShim -Path $aliasShimPath -BunExe $bunExe -AliasedFrom "leadscout"
    } else {
        Write-BusinessFinderReleaseShim -Path $shimPath
        Write-BusinessFinderReleaseShim -Path $aliasShimPath -AliasedFrom "leadscout"
    }

    $env:PATH = Remove-BusinessFinderPathEntry -PathValue $env:PATH -Entry $legacyBinDir
    $env:PATH = Add-BusinessFinderPathEntry -PathValue $env:PATH -Entry $binDir
    if ($PathScope -eq "User") {
        Update-BusinessFinderUserPath -AddEntry $binDir -RemoveEntry $legacyBinDir
    }

    # 5. Global Codex and Claude Code skills (replace only the leadscout skill we installed)
    $skillSrc = Join-Path $appDir "skills\business-finder\SKILL.md"
    if (Test-Path $skillSrc) {
        Write-Output "Setting up Codex and Claude Code instructions..."
        foreach ($skillsRoot in @(
            (Join-Path $userHome ".agents\skills"),
            (Join-Path $userHome ".claude\skills")
        )) {
            $oldSkillDir = Join-Path $skillsRoot "leadscout"
            if (Test-OwnedBusinessFinderSkillDir -Dir $oldSkillDir -SkillName "leadscout") {
                Remove-Item -LiteralPath $oldSkillDir -Recurse -Force
            }
            $skillDstDir = Join-Path $skillsRoot "business-finder"
            New-Item -ItemType Directory -Force -Path $skillDstDir | Out-Null
            Copy-Item -Path $skillSrc -Destination (Join-Path $skillDstDir "SKILL.md") -Force
        }
    }

    # 6. Doctor check
    $State.Step = "start"
    Write-Output "Checking browser and port..."
    $prevEap = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $docOut = & $shimPath doctor 2>&1
        $docCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }
    if ($docCode -ne 0) {
        $docOut | ForEach-Object { Write-Output "$_" }
        if (-not $fromSource -and -not ($docOut -match "Edge|Chrome|browser")) {
            Write-Output "Business Finder is installed, but its check failed. Run business-finder doctor in a regular PowerShell window."
        } else {
            Write-Output "Business Finder is installed, but it needs Microsoft Edge or Google Chrome to search. Install one of them, then type business-finder in a terminal."
        }
        $State.ExitCode = 2
        return
    }

    # 7. Start business-finder serve in the background and report its real URL
    Write-Output "Starting Business Finder..."
    $serverOutLog = Join-Path $dataDir "server.out.log"
    $serverErrLog = Join-Path $dataDir "server.err.log"
    $serverJsonPath = Join-Path $dataDir "server.json"
    # cmd.exe writes the logs, so Start-Process needs no -Redirect* flags: with them,
    # Windows PowerShell starts the child with handle inheritance and the server keeps
    # the caller's stdout pipe open, so a piped `install.ps1 | ...` never reaches EOF.
    # /s strips only the outer quotes around the whole command line.
    $noOpenArg = if ($NoOpen) { " --no-open" } else { "" }
    $serveLine = "`"$runtimeExe`" `"$cliEntry`" serve$noOpenArg > `"$serverOutLog`" 2> `"$serverErrLog`""
    $cmdExe = if ($env:ComSpec) { $env:ComSpec } else { Join-Path $env:SystemRoot "System32\cmd.exe" }
    $startedAt = [DateTime]::UtcNow
    $proc = Start-Process -FilePath $cmdExe -ArgumentList "/d /s /c `"$serveLine`"" -WorkingDirectory $userHome -WindowStyle Hidden -PassThru

    # $proc is cmd.exe, not the server; the server is ready when a server.json
    # written after this start names a process whose health route answers with
    # that same pid. cmd.exe /c lives exactly as long as the server, so its exit
    # means the server stopped.
    $port = $null
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) {
            $reason = ""
            if (Test-Path $serverErrLog) {
                $reason = @(Get-Content $serverErrLog -ErrorAction SilentlyContinue | Where-Object { "$_".Trim() }) | Select-Object -Last 1
            }
            $detail = if ($reason) { " It said: $("$reason".Trim())" } else { "" }
            throw "Business Finder stopped while starting.$detail Details are in $serverErrLog."
        }
        if (Test-Path $serverJsonPath) {
            try {
                if ((Get-Item $serverJsonPath).LastWriteTimeUtc -ge $startedAt) {
                    $rec = Get-Content $serverJsonPath -Raw | ConvertFrom-Json
                    if ($rec.pid -and $rec.port) {
                        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($rec.port)/api/v1/health" -TimeoutSec 2
                        if ($health.ok -eq $true -and $health.pid -eq $rec.pid) {
                            $port = [int]$rec.port
                            break
                        }
                    }
                }
            } catch {
            }
        }
        Start-Sleep -Milliseconds 200
    }
    if ($null -eq $port) {
        throw "Timed out waiting for Business Finder to start. Run ``business-finder`` to see details."
    }

    $url = "http://127.0.0.1:$port"
    Write-Output "Business Finder is running at $url. To start it again later, type ``business-finder`` in a terminal or ask Codex to 'open Business Finder'."
}

function Test-BusinessFinderInteractiveHost {
    # True when this PowerShell is a window a person types into, where `exit`
    # under `irm | iex` would close it. False when it was started to run one
    # command (`powershell -Command ...`, as agents and scripts do), where exit
    # only ends that command and hands its code to the caller.
    param(
        [string[]]$CommandLineArgs,
        [string]$HostName
    )
    # The ISE and the VS Code console are always windows a person types into.
    if ($HostName -ne "ConsoleHost") { return $true }
    $valueFlags = @("executionpolicy", "ep", "windowstyle", "inputformat", "outputformat", "version", "psconsolefile", "configurationname", "settingsfile", "workingdirectory", "custompipename")
    for ($i = 0; $i -lt $CommandLineArgs.Count; $i++) {
        $arg = $CommandLineArgs[$i]
        # A bare word is a command: `powershell "irm ... | iex"`.
        if ($arg -notmatch '^[-/]') { return $false }
        $name = $arg.TrimStart('-', '/').ToLowerInvariant()
        if ($name -eq "") { return $false }
        if ($name.Length -ge 3 -and "noexit".StartsWith($name)) { return $true }
        if ($name.Length -ge 4 -and "noninteractive".StartsWith($name)) { return $false }
        if ($name -eq "e" -or $name -eq "ec" -or "command".StartsWith($name) -or "file".StartsWith($name) -or ($name.Length -ge 2 -and "encodedcommand".StartsWith($name))) {
            return $false
        }
        if (@($valueFlags | Where-Object { $_ -eq $name -or ($name.Length -ge 2 -and $_.StartsWith($name)) }).Count -gt 0) {
            $i++
        }
    }
    return $true
}

# Errors are reported in plain words. The exit code goes to the caller with
# `exit`, except under `irm | iex` in a window a person types into, where exit
# would close that window; there it is left in $LASTEXITCODE.
$state = @{ Step = "start"; ExitCode = 0 }
$previousDataDir = $env:BUSINESS_FINDER_DATA_DIR
try {
    $env:BUSINESS_FINDER_DATA_DIR = $null
    Invoke-BusinessFinderInstall -PathScope $PathScope -RepoUrl $RepoUrl -Branch $Branch -NoOpen:$NoOpen -SourceDir $PSScriptRoot -PackagePath $PackagePath -ExplicitRepo:$hasExplicitRepo -State $state
} catch {
    $hint = switch ($state.Step) {
        "bun" { "Bun could not be downloaded. Check your internet connection." }
        "package" { "Use an intact Business Finder Windows ZIP from GitHub Releases." }
        "download" { "Business Finder could not be downloaded. Check your internet connection." }
        "build" { "Setting up Business Finder's files failed; the lines above say why. If they mention the network, check your internet connection." }
        "start" { "Business Finder did not start. Type business-finder doctor in a new window to see what is missing." }
        default { "" }
    }
    Write-Output ""
    Write-Output "The install stopped: $($_.Exception.Message)"
    if ($hint) { Write-Output $hint }
    Write-Output "Run the same install command again. Your saved lists are not affected."
    $state.ExitCode = 1
} finally {
    $env:BUSINESS_FINDER_DATA_DIR = $previousDataDir
}
if ($state.ExitCode -ne 0) {
    $global:LASTEXITCODE = $state.ExitCode
    $fromScriptFile = -not [string]::IsNullOrEmpty($PSCommandPath)
    $mayExit = $fromScriptFile -or (
        $env:BUSINESS_FINDER_NO_EXIT -ne "1" -and
        -not (Test-BusinessFinderInteractiveHost -CommandLineArgs @([Environment]::GetCommandLineArgs() | Select-Object -Skip 1) -HostName $Host.Name)
    )
    if ($mayExit) { exit $state.ExitCode }
}
} @args
