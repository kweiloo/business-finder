# Pester 3.4 (ships with Windows PowerShell 5.1): Invoke-Pester -Script .\tests\install.Tests.ps1
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$installScript = Join-Path $repoRoot "install.ps1"

# install.ps1 runs as soon as it is loaded, so the pure helpers are lifted out of it by name.
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installScript, [ref]$null, [ref]$null)
$helpers = $ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -in @(
            "Normalize-BusinessFinderPathSegment",
            "Add-BusinessFinderPathEntry",
            "Remove-BusinessFinderPathEntry",
            "Test-OwnedBusinessFinderSkillDir",
            "Test-BusinessFinderInteractiveHost"
        )
    }, $true)
foreach ($helper in $helpers) { . ([scriptblock]::Create($helper.Extent.Text)) }

Describe "install.ps1 PATH entry helpers" {
    It "adds an entry once" {
        $entry = "C:\Users\Ada\AppData\Local\business-finder\bin"
        $result = Add-BusinessFinderPathEntry -PathValue "C:\Windows\System32;C:\Tools" -Entry $entry
        $result | Should Be "C:\Windows\System32;C:\Tools;$entry"
    }

    It "does not duplicate an existing entry even with different casing or trailing slash" {
        $entry = "C:\Users\Ada\AppData\Local\business-finder\bin"
        $initial = "C:\Windows\System32;$entry;C:\Tools"
        (Add-BusinessFinderPathEntry -PathValue $initial -Entry $entry) | Should Be $initial
        (Add-BusinessFinderPathEntry -PathValue $initial -Entry "c:\users\ada\appdata\local\business-finder\bin\") | Should Be $initial
    }

    It "handles an empty PATH when adding" {
        $entry = "C:\Users\Ada\AppData\Local\business-finder\bin"
        (Add-BusinessFinderPathEntry -PathValue "" -Entry $entry) | Should Be $entry
    }

    It "removes the entry and leaves the rest of PATH unchanged" {
        $entry = "C:\Users\Ada\AppData\Local\business-finder\bin"
        (Remove-BusinessFinderPathEntry -PathValue "C:\Windows\System32;$entry;C:\Tools" -Entry $entry) | Should Be "C:\Windows\System32;C:\Tools"
        (Remove-BusinessFinderPathEntry -PathValue "$entry;C:\Tools" -Entry $entry) | Should Be "C:\Tools"
        (Remove-BusinessFinderPathEntry -PathValue "C:\Tools;$entry" -Entry "c:\users\ada\appdata\local\business-finder\bin\") | Should Be "C:\Tools"
        (Remove-BusinessFinderPathEntry -PathValue $entry -Entry $entry) | Should Be ""
        (Remove-BusinessFinderPathEntry -PathValue "C:\Windows\System32;C:\Tools" -Entry $entry) | Should Be "C:\Windows\System32;C:\Tools"
    }
}

# Runs the script text through `iex`, as `irm ... | iex` does, against a throwaway
# repository and a throwaway registry key standing in for the user PATH.
Describe "install.ps1 exit host detection" {
    It "treats a window a person types into as interactive" {
        Test-BusinessFinderInteractiveHost -CommandLineArgs @() -HostName "ConsoleHost" | Should Be $true
        Test-BusinessFinderInteractiveHost -CommandLineArgs @("-NoLogo", "-NoProfile") -HostName "ConsoleHost" | Should Be $true
        Test-BusinessFinderInteractiveHost -CommandLineArgs @("-ExecutionPolicy", "Bypass", "-NoProfile") -HostName "ConsoleHost" | Should Be $true
        Test-BusinessFinderInteractiveHost -CommandLineArgs @("-NoExit", "-Command", "Set-Location C:\") -HostName "ConsoleHost" | Should Be $true
        Test-BusinessFinderInteractiveHost -CommandLineArgs @("-NoLogo", "-NonInteractive", "-Command", "Import-Module x") -HostName "Visual Studio Code Host" | Should Be $true
        Test-BusinessFinderInteractiveHost -CommandLineArgs @() -HostName "Windows PowerShell ISE Host" | Should Be $true
    }

    It "treats a PowerShell started to run one command as not interactive" {
        Test-BusinessFinderInteractiveHost -CommandLineArgs @("-Command", "irm x | iex") -HostName "ConsoleHost" | Should Be $false
        Test-BusinessFinderInteractiveHost -CommandLineArgs @("-NoProfile", "-c", "irm x | iex") -HostName "ConsoleHost" | Should Be $false
        Test-BusinessFinderInteractiveHost -CommandLineArgs @("-ExecutionPolicy", "Bypass", "irm x | iex") -HostName "ConsoleHost" | Should Be $false
        Test-BusinessFinderInteractiveHost -CommandLineArgs @("-EncodedCommand", "aQByAG0A") -HostName "ConsoleHost" | Should Be $false
        Test-BusinessFinderInteractiveHost -CommandLineArgs @("-NonInteractive") -HostName "ConsoleHost" | Should Be $false
    }
}

Describe "install.ps1 under iex" {
    $root = Join-Path ([System.IO.Path]::GetTempPath()) ("business-finder-pester-" + [Guid]::NewGuid().ToString("N"))
    $fakeKey = "Software\business-finder-pester-" + [Guid]::NewGuid().ToString("N")
    $sentinel = "C:\Pester\One;%USERPROFILE%\Pester\Two"
    $saved = @{}
    foreach ($name in "LOCALAPPDATA", "USERPROFILE", "CODEX_HOME", "BUSINESS_FINDER_PATH_SCOPE", "BUSINESS_FINDER_REPO_URL", "BUSINESS_FINDER_BRANCH", "BUSINESS_FINDER_USER_ENV_KEY", "BUSINESS_FINDER_NO_EXIT", "BUSINESS_FINDER_NO_OPEN", "FAKE_SERVE_FAIL", "PATH") {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    }
    $realKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment")
    $realPathBefore = [string]$realKey.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $realPathKind = $realKey.GetValueKind("Path")
    $realKey.Close()

    # A tiny app: `doctor` exits 2, so the installer stops right after the PATH and skill steps.
    $repo = Join-Path $root "repo"
    New-Item -ItemType Directory -Force -Path (Join-Path $repo "src\cli") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $repo "skills\business-finder") | Out-Null
    Set-Content -Path (Join-Path $repo "package.json") -Encoding ASCII -Value '{ "name": "fake-business-finder", "private": true, "scripts": { "build:web": "bun --version" } }'
    $mainJs = @'
if (process.env.BUSINESS_FINDER_ALIASED_FROM === "leadscout") console.log("leadscout is now called business-finder");
if (process.argv[2] === "--version") { console.log("business-finder 0.1.0"); process.exit(0); }
console.log("fake doctor");
process.exit(2);
'@
    Set-Content -Path (Join-Path $repo "src\cli\main.ts") -Encoding ASCII -Value $mainJs
    Set-Content -Path (Join-Path $repo "skills\business-finder\SKILL.md") -Encoding ASCII -Value "---`nname: business-finder`n---`n# business-finder v1`n"
    & git -C $repo init -q -b main 2>$null
    & git -C $repo -c user.name=test -c user.email=test@example.com add -A 2>$null
    & git -C $repo -c user.name=test -c user.email=test@example.com commit -q -m init 2>$null

    # Points every folder at a fresh temp run and resets the fake user PATH.
    function Set-InstallRun([string]$Scope, [string]$InitialUserPath = $sentinel) {
        $run = Join-Path $root ("run-" + [Guid]::NewGuid().ToString("N"))
        $env:LOCALAPPDATA = Join-Path $run "LocalAppData"
        $env:USERPROFILE = Join-Path $run "Profile"
        $env:CODEX_HOME = Join-Path $run "Profile\.codex"
        $env:BUSINESS_FINDER_REPO_URL = $repo
        $env:BUSINESS_FINDER_BRANCH = "main"
        $env:BUSINESS_FINDER_USER_ENV_KEY = $fakeKey
        # In this process `exit` would end the test run; the code is read from $LASTEXITCODE instead.
        $env:BUSINESS_FINDER_NO_EXIT = "1"
        $env:BUSINESS_FINDER_NO_OPEN = "1"
        Remove-Item Env:FAKE_SERVE_FAIL -ErrorAction SilentlyContinue
        if ($Scope) { $env:BUSINESS_FINDER_PATH_SCOPE = $Scope } else { Remove-Item Env:BUSINESS_FINDER_PATH_SCOPE -ErrorAction SilentlyContinue }
        $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($fakeKey)
        $k.SetValue("Path", $InitialUserPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        $k.Close()
        return (Join-Path $env:LOCALAPPDATA "business-finder\bin")
    }

    # A tiny app whose `doctor` passes and whose `serve` stays running like the real one:
    # it answers /api/v1/health with its pid and records itself in server.json.
    $serverRepo = Join-Path $root "server-repo"
    New-Item -ItemType Directory -Force -Path (Join-Path $serverRepo "src\cli") | Out-Null
    Set-Content -Path (Join-Path $serverRepo "package.json") -Encoding ASCII -Value '{ "name": "fake-business-finder", "private": true, "scripts": { "build:web": "bun --version" } }'
    $serverMain = @'
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const cmd = process.argv[2];
if (cmd === "doctor") { console.log("fake doctor ok"); process.exit(0); }
if (cmd !== "serve") process.exit(2);
if (process.env.FAKE_SERVE_FAIL === "1") { console.error("fake serve could not start"); process.exit(3); }
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true, pid: process.pid }) });
const dir = join(process.env.LOCALAPPDATA!, "business-finder");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "server.json"), JSON.stringify({ pid: process.pid, port: server.port }));
console.log(`fake server running at ${server.port}`);
'@
    Set-Content -Path (Join-Path $serverRepo "src\cli\main.ts") -Encoding ASCII -Value $serverMain
    # A repository whose package.json `bun install` cannot read.
    $brokenRepo = Join-Path $root "broken-repo"
    New-Item -ItemType Directory -Force -Path (Join-Path $brokenRepo "src\cli") | Out-Null
    Set-Content -Path (Join-Path $brokenRepo "package.json") -Encoding ASCII -Value '{ this is not json'
    Set-Content -Path (Join-Path $brokenRepo "src\cli\main.ts") -Encoding ASCII -Value 'process.exit(0);'
    foreach ($r in $serverRepo, $brokenRepo) {
        & git -C $r init -q -b main 2>$null
        & git -C $r -c user.name=test -c user.email=test@example.com add -A 2>$null
        & git -C $r -c user.name=test -c user.email=test@example.com commit -q -m init 2>$null
    }

    # Runs a child Windows PowerShell and reads its stdout through a pipe until EOF, as an
    # agent's shell tool does, noting when "running at" arrived and when the pipe closed.
    # A child whose pipe stays open is given up on 30 s after "running at".
    function Invoke-PipedPowerShell([string]$Arguments, [int]$TimeoutSec = 240) {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "powershell.exe"
        $psi.Arguments = $Arguments
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $errTask = $p.StandardError.ReadToEndAsync()
        $lines = New-Object System.Collections.ArrayList
        $deadline = (Get-Date).AddSeconds($TimeoutSec)
        $runningAt = $null
        $eofAt = $null
        while ($true) {
            $left = [int][Math]::Max(0, ($deadline - (Get-Date)).TotalMilliseconds)
            $task = $p.StandardOutput.ReadLineAsync()
            if ($left -eq 0 -or -not $task.Wait($left)) { break }
            if ($null -eq $task.Result) { $eofAt = Get-Date; break }
            [void]$lines.Add($task.Result)
            if ($null -eq $runningAt -and $task.Result -match "Business Finder is running at") {
                $runningAt = Get-Date
                $deadline = $runningAt.AddSeconds(30)
            }
        }
        $exited = $p.WaitForExit(10000)
        return @{
            Lines = @($lines)
            Text = (@($lines) -join "`n")
            RunningAt = $runningAt
            EofAt = $eofAt
            ExitCode = if ($exited) { $p.ExitCode } else { $null }
            Stderr = if ($errTask.Wait(1000)) { $errTask.Result } else { "" }
        }
    }

    function Get-EncodedCommand([string]$Command) {
        return [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($Command))
    }

    # Stops the fake server this test started, and nothing else.
    function Stop-FakeServer {
        $record = Join-Path $env:LOCALAPPDATA "business-finder\server.json"
        if (-not (Test-Path $record)) { return }
        $rec = Get-Content -Raw $record | ConvertFrom-Json
        $p = Get-Process -Id ([int]$rec.pid) -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq "bun") {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }

    function Get-FakeUserPath {
        $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($fakeKey)
        try { return [string]$k.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } finally { $k.Close() }
    }

    try {
        It "keeps PATH changes to the process when BUSINESS_FINDER_PATH_SCOPE=Process, and leaves the caller's session alone" {
            Set-InstallRun "Process" | Out-Null
            $ErrorActionPreference = "Continue"
            # Run in this scope, as `irm | iex` runs in the user's prompt.
            $out = (Get-Content -Raw $installScript | Invoke-Expression) -join "`n"
            $eapAfter = $ErrorActionPreference
            $ErrorActionPreference = "Stop"
            $out | Should Match "Adding the business-finder command"
            $out | Should Match "needs Microsoft Edge or Google Chrome"
            $codeAfter = $global:LASTEXITCODE
            $codeAfter | Should Be 2
            Get-FakeUserPath | Should BeExactly $sentinel
            $eapAfter | Should Be "Continue"
            (Get-Command Invoke-BusinessFinderInstall -ErrorAction SilentlyContinue) | Should BeNullOrEmpty
            (Test-Path Variable:PathScope) | Should Be $false
        }

        It "adds the command folder to the user PATH exactly once without the variable" {
            $binDir = Set-InstallRun ""
            Get-Content -Raw $installScript | Invoke-Expression | Out-Null
            Get-FakeUserPath | Should BeExactly "$sentinel;$binDir"
        }

        It "installs skills for both Codex and Claude Code, and re-runs overwrite only those files" {
            Set-InstallRun "Process" | Out-Null
            $otherCodexSkill = Join-Path $env:USERPROFILE ".agents\skills\other\SKILL.md"
            $otherClaudeSkill = Join-Path $env:USERPROFILE ".claude\skills\other\SKILL.md"
            $claudeRules = Join-Path $env:USERPROFILE ".claude\CLAUDE.md"
            New-Item -ItemType Directory -Force -Path (Split-Path $otherCodexSkill) | Out-Null
            New-Item -ItemType Directory -Force -Path (Split-Path $otherClaudeSkill) | Out-Null
            Set-Content -Path $otherCodexSkill -Encoding ASCII -Value "# keep codex"
            Set-Content -Path $otherClaudeSkill -Encoding ASCII -Value "# keep claude"
            Set-Content -Path $claudeRules -Encoding ASCII -Value "# keep rules"

            Get-Content -Raw $installScript | Invoke-Expression | Out-Null
            $codexSkill = Join-Path $env:USERPROFILE ".agents\skills\business-finder\SKILL.md"
            $claudeSkill = Join-Path $env:USERPROFILE ".claude\skills\business-finder\SKILL.md"
            (Test-Path $codexSkill) | Should Be $true
            (Test-Path $claudeSkill) | Should Be $true
            (Get-Content -Raw $codexSkill) | Should Match "business-finder v1"
            (Get-Content -Raw $claudeSkill) | Should Match "business-finder v1"

            Set-Content -Path (Join-Path $repo "skills\business-finder\SKILL.md") -Encoding ASCII -Value "---`nname: business-finder`n---`n# business-finder v2`n"
            & git -C $repo -c user.name=test -c user.email=test@example.com add -A 2>$null
            & git -C $repo -c user.name=test -c user.email=test@example.com commit -q -m v2 2>$null
            Get-Content -Raw $installScript | Invoke-Expression | Out-Null

            (Get-Content -Raw $codexSkill) | Should Match "business-finder v2"
            (Get-Content -Raw $claudeSkill) | Should Match "business-finder v2"
            (Get-Content -Raw $otherCodexSkill).Trim() | Should Be "# keep codex"
            (Get-Content -Raw $otherClaudeSkill).Trim() | Should Be "# keep claude"
            (Get-Content -Raw $claudeRules).Trim() | Should Be "# keep rules"
        }

        It "upgrades over an old leadscout install: migrates lists, replaces shim and owned skills, keeps unowned leadscout skill and other skills, deduplicates PATH, and keeps leadscout alias working" {
            $binDir = Set-InstallRun ""
            $oldDataDir = Join-Path $env:LOCALAPPDATA "leadscout"
            $oldBinDir = Join-Path $oldDataDir "bin"
            $oldAppDir = Join-Path $oldDataDir "app"
            $oldJobDir = Join-Path $oldDataDir "jobs\11111111-2222-4333-8444-555555555555"
            New-Item -ItemType Directory -Force -Path $oldBinDir, $oldAppDir, $oldJobDir | Out-Null
            Set-Content -Path (Join-Path $oldBinDir "leadscout.cmd") -Encoding ASCII -Value "@echo old shim"
            Set-Content -Path (Join-Path $oldJobDir "job.json") -Encoding ASCII -Value '{"id":"11111111-2222-4333-8444-555555555555"}'
            Set-Content -Path (Join-Path $oldDataDir "geocode-cache.json") -Encoding ASCII -Value '{"version":2,"entries":{}}'

            # Seed fake registry PATH with the old leadscout\bin entry
            $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($fakeKey, $true)
            $k.SetValue("Path", "$sentinel;$oldBinDir", [Microsoft.Win32.RegistryValueKind]::ExpandString)
            $k.Close()

            # Owned old Codex skill (only SKILL.md with leadscout frontmatter) -> should be removed
            $ownedOldCodex = Join-Path $env:USERPROFILE ".agents\skills\leadscout"
            New-Item -ItemType Directory -Force -Path $ownedOldCodex | Out-Null
            Set-Content -Path (Join-Path $ownedOldCodex "SKILL.md") -Encoding ASCII -Value "---`nname: leadscout`n---`n# leadscout old`n"

            # Unowned old Claude skill (has an extra custom file) -> must NEVER be removed
            $unownedOldClaude = Join-Path $env:USERPROFILE ".claude\skills\leadscout"
            New-Item -ItemType Directory -Force -Path $unownedOldClaude | Out-Null
            Set-Content -Path (Join-Path $unownedOldClaude "SKILL.md") -Encoding ASCII -Value "---`nname: leadscout`n---`n# custom`n"
            Set-Content -Path (Join-Path $unownedOldClaude "my-notes.txt") -Encoding ASCII -Value "keep me"

            Get-Content -Raw $installScript | Invoke-Expression | Out-Null

            # Data migrated, old folder gone, jobs + cache survived
            (Test-Path $oldDataDir) | Should Be $false
            (Test-Path (Join-Path $env:LOCALAPPDATA "business-finder\jobs\11111111-2222-4333-8444-555555555555\job.json")) | Should Be $true
            (Test-Path (Join-Path $env:LOCALAPPDATA "business-finder\geocode-cache.json")) | Should Be $true

            # PATH updated: old entry removed, new entry present exactly once
            Get-FakeUserPath | Should BeExactly "$sentinel;$binDir"

            # Owned old skill removed, unowned old skill kept, new skills installed
            (Test-Path $ownedOldCodex) | Should Be $false
            (Test-Path (Join-Path $unownedOldClaude "my-notes.txt")) | Should Be $true
            (Test-Path (Join-Path $env:USERPROFILE ".agents\skills\business-finder\SKILL.md")) | Should Be $true
            (Test-Path (Join-Path $env:USERPROFILE ".claude\skills\business-finder\SKILL.md")) | Should Be $true

            # New shim and leadscout alias both exist and work (banner on stderr, stdout clean)
            (Test-Path (Join-Path $binDir "business-finder.cmd")) | Should Be $true
            (Test-Path (Join-Path $binDir "leadscout.cmd")) | Should Be $true
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = (Join-Path $binDir "leadscout.cmd")
            $psi.Arguments = "--version"
            $psi.UseShellExecute = $false
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            $p = [System.Diagnostics.Process]::Start($psi)
            $aliasStdout = $p.StandardOutput.ReadToEnd()
            $aliasStderr = $p.StandardError.ReadToEnd()
            $p.WaitForExit()
            $p.ExitCode | Should Be 0
            $aliasStderr | Should Match "leadscout is now called business-finder"
            $aliasStdout.Trim() | Should BeExactly "business-finder 0.1.0"
        }

        It "installs when run via -File from an unzipped folder with no .git" {
            $unzipped = Join-Path $root "unzipped"
            New-Item -ItemType Directory -Force -Path (Join-Path $unzipped "src\cli") | Out-Null
            New-Item -ItemType Directory -Force -Path (Join-Path $unzipped "skills\business-finder") | Out-Null
            Copy-Item $installScript -Destination (Join-Path $unzipped "install.ps1")
            Set-Content -Path (Join-Path $unzipped "package.json") -Encoding ASCII -Value '{ "name": "fake-business-finder", "private": true, "scripts": { "build:web": "bun --version" } }'
            Set-Content -Path (Join-Path $unzipped "src\cli\main.ts") -Encoding ASCII -Value 'console.log("fake doctor"); process.exit(2);'
            Set-Content -Path (Join-Path $unzipped "skills\business-finder\SKILL.md") -Encoding ASCII -Value "---`nname: business-finder`n---`n# unzipped`n"

            Set-InstallRun "Process" | Out-Null
            Remove-Item Env:BUSINESS_FINDER_REPO_URL -ErrorAction SilentlyContinue
            $out = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $unzipped "install.ps1") -PathScope Process) -join "`n"
            $code = $LASTEXITCODE
            $out | Should Match "Copying Business Finder from this folder"
            $out | Should Match "needs Microsoft Edge or Google Chrome"
            # Installed, but not ready to search: exit code 2, with the plain message last.
            $code | Should Be 2
            ($out -split "`n")[-1] | Should Match "needs Microsoft Edge or Google Chrome"
            (Test-Path (Join-Path $env:LOCALAPPDATA "business-finder\app\.git")) | Should Be $false
            (Get-Content -Raw (Join-Path $env:USERPROFILE ".claude\skills\business-finder\SKILL.md")) | Should Match "unzipped"
        }

        It "returns within 30 s of 'running at' when its output is piped through ForEach-Object under iex, and leaves the server running" {
            Set-InstallRun "Process" | Out-Null
            $env:BUSINESS_FINDER_REPO_URL = $serverRepo
            Remove-Item Env:BUSINESS_FINDER_NO_EXIT
            try {
                $cmd = "Get-Content -Raw '$installScript' | Invoke-Expression | ForEach-Object { `$_ }"
                $r = Invoke-PipedPowerShell "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $(Get-EncodedCommand $cmd)"
                $r.RunningAt | Should Not BeNullOrEmpty
                $r.EofAt | Should Not BeNullOrEmpty
                ($r.EofAt - $r.RunningAt).TotalSeconds | Should BeLessThan 30
                $r.ExitCode | Should Be 0
                $rec = Get-Content -Raw (Join-Path $env:LOCALAPPDATA "business-finder\server.json") | ConvertFrom-Json
                $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($rec.port)/api/v1/health" -TimeoutSec 2
                $health.pid | Should Be $rec.pid
                $r.Text | Should Match "Business Finder is running at http://127\.0\.0\.1:$($rec.port)\."
                (Get-Content -Raw (Join-Path $env:LOCALAPPDATA "business-finder\server.out.log")) | Should Match "fake server running at $($rec.port)"
                (Test-Path (Join-Path $env:LOCALAPPDATA "business-finder\server.err.log")) | Should Be $true
            } finally {
                Stop-FakeServer
            }
        }

        It "returns within 30 s of 'running at' when run with -File and its output read through a pipe" {
            Set-InstallRun "Process" | Out-Null
            $env:BUSINESS_FINDER_REPO_URL = $serverRepo
            try {
                $r = Invoke-PipedPowerShell "-NoProfile -ExecutionPolicy Bypass -File `"$installScript`" -PathScope Process -NoOpen"
                $r.RunningAt | Should Not BeNullOrEmpty
                $r.EofAt | Should Not BeNullOrEmpty
                ($r.EofAt - $r.RunningAt).TotalSeconds | Should BeLessThan 30
                $r.ExitCode | Should Be 0
            } finally {
                Stop-FakeServer
            }
        }

        It "exits 1 with the plain message last when the download fails" {
            Set-InstallRun "Process" | Out-Null
            $env:BUSINESS_FINDER_REPO_URL = Join-Path $root "no-such-repo"
            $r = Invoke-PipedPowerShell "-NoProfile -ExecutionPolicy Bypass -File `"$installScript`" -PathScope Process"
            $r.ExitCode | Should Be 1
            $r.Text | Should Match "The install stopped"
            $r.Text | Should Match "Business Finder could not be downloaded"
            $r.Lines[-1] | Should Be "Run the same install command again. Your saved lists are not affected."
        }

        It "exits 1 with the plain message last when bun install fails" {
            Set-InstallRun "Process" | Out-Null
            $env:BUSINESS_FINDER_REPO_URL = $brokenRepo
            $r = Invoke-PipedPowerShell "-NoProfile -ExecutionPolicy Bypass -File `"$installScript`" -PathScope Process"
            $r.ExitCode | Should Be 1
            $r.Text | Should Match "install --frozen-lockfile"
            $r.Text | Should Match "Setting up Business Finder's files failed"
            $r.Lines[-1] | Should Be "Run the same install command again. Your saved lists are not affected."
        }

        It "exits 1 and passes on the server's own words when the server stops while starting" {
            Set-InstallRun "Process" | Out-Null
            $env:BUSINESS_FINDER_REPO_URL = $serverRepo
            $env:FAKE_SERVE_FAIL = "1"
            $r = Invoke-PipedPowerShell "-NoProfile -ExecutionPolicy Bypass -File `"$installScript`" -PathScope Process"
            $r.ExitCode | Should Be 1
            $r.Text | Should Match "Business Finder stopped while starting\. It said: fake serve could not start"
            $r.Lines[-1] | Should Be "Run the same install command again. Your saved lists are not affected."
        }

        It "under iex in this session, leaves exit code 1 in LASTEXITCODE instead of ending the session" {
            Set-InstallRun "Process" | Out-Null
            $env:BUSINESS_FINDER_REPO_URL = Join-Path $root "no-such-repo"
            $global:LASTEXITCODE = 0
            $out = @(Get-Content -Raw $installScript | Invoke-Expression)
            $code = $global:LASTEXITCODE
            $code | Should Be 1
            $out[-1] | Should Be "Run the same install command again. Your saved lists are not affected."
        }

        It "never touches the real user PATH" {
            $realKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment")
            $now = [string]$realKey.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $realKey.Close()
            $now | Should BeExactly $realPathBefore
        }
    } finally {
        # Safety net: put the real user PATH back if anything above changed it.
        $realKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
        if ([string]$realKey.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $realPathBefore) {
            $realKey.SetValue("Path", $realPathBefore, $realPathKind)
            Write-Warning "The real user PATH was changed by the test and has been restored."
        }
        $realKey.Close()
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], "Process") }
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($fakeKey, $false)
        Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
    }
}
