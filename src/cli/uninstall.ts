import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { GEOCODE_CACHE_FILE } from "../core/geo/geocoder.js";
import { DataDirWriteError, formatWriteError, isFsError } from "../core/errors.js";
import {
  clearServerRecord,
  defaultDataDir,
  legacyDataDir,
  LEGACY_NOTICE_FILE,
  liveServerRecord,
  processAlive,
  SERVER_FILE,
} from "../jobs/store.js";

/** Trims whitespace and trailing path separators (preserving a drive root like `C:\` or `/`). */
function normalizeSegment(segment: string, caseInsensitive: boolean): string {
  let trimmed = segment.trim();
  while (trimmed.length > 1 && (trimmed.endsWith("\\") || trimmed.endsWith("/"))) {
    if (/^[A-Za-z]:\\$/.test(trimmed)) break;
    trimmed = trimmed.slice(0, -1);
  }
  return caseInsensitive ? trimmed.toLowerCase() : trimmed;
}

/** Removes matching `entry` from a `;`-separated PATH string, leaving everything else unchanged. */
export function removePathEntry(
  pathValue: string,
  entry: string,
  caseInsensitive: boolean = process.platform === "win32",
  delimiter = ";",
): string {
  const cleanEntry = entry.trim();
  if (!pathValue || !cleanEntry) return pathValue;
  const target = normalizeSegment(cleanEntry, caseInsensitive);
  const parts = pathValue.split(delimiter).filter((p) => p !== "");
  const kept = parts.filter((p) => normalizeSegment(p, caseInsensitive) !== target);
  if (kept.length === parts.length) return pathValue;
  return kept.join(delimiter);
}

/** Prompts for a yes/no answer on stdin; defaults to false (keep) on empty input or EOF. */
export function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer: boolean) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer);
    };
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.once("close", () => finish(false));
    rl.question(question, (answer) => finish(/^y(es)?$/i.test(answer.trim())));
  });
}

/** Stops the running `business-finder serve` for `dataDir` after confirming its PID via `/api/v1/health`. */
async function stopServerByRecord(dataDir: string): Promise<boolean> {
  const record = await liveServerRecord(dataDir);
  if (!record) return false;
  try {
    process.kill(record.pid);
  } catch {
    return false;
  }
  const deadline = Date.now() + 3000;
  while (processAlive(record.pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  clearServerRecord(dataDir, record.pid);
  return true;
}

/** Reads the user PATH from the registry as stored (unexpanded); null when unset or unreadable. */
const WIN_READ_PATH_PS = `
$keyName = if ($env:BUSINESS_FINDER_USER_ENV_KEY) { $env:BUSINESS_FINDER_USER_ENV_KEY } else { 'Environment' }
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyName)
if ($null -eq $key) { exit 3 }
try {
  $raw = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($null -eq $raw) { exit 3 }
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$raw)))
} finally { $key.Close() }
`;

/** Writes BUSINESS_FINDER_NEW_PATH (base64) as the user PATH, keeping its registry type, then tells Windows. */
const WIN_WRITE_PATH_PS = `
$keyName = if ($env:BUSINESS_FINDER_USER_ENV_KEY) { $env:BUSINESS_FINDER_USER_ENV_KEY } else { 'Environment' }
$value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BUSINESS_FINDER_NEW_PATH))
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyName, $true)
try {
  $kind = if ($value.Contains('%')) { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { $key.GetValueKind('Path') }
  $key.SetValue('Path', $value, $kind)
} finally { $key.Close() }
Add-Type -Namespace Win32 -Name BusinessFinderUninstallEnv -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
$r = [UIntPtr]::Zero
[Win32.BusinessFinderUninstallEnv]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r) | Out-Null
`;

function powershell(script: string, env: NodeJS.ProcessEnv) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env,
    encoding: "utf8",
    timeout: 15_000,
  });
}

/**
 * Removes `binDirs` from the user PATH in the registry; true when any was there.
 * BUSINESS_FINDER_PATH_SCOPE=Process (the installer's test mode) leaves the registry alone.
 */
function removeWindowsUserPath(binDirs: string[], env: NodeJS.ProcessEnv): boolean {
  if (env.BUSINESS_FINDER_PATH_SCOPE === "Process") return false;
  const read = powershell(WIN_READ_PATH_PS, env);
  if (read.status !== 0) return false;
  const current = Buffer.from(read.stdout.trim(), "base64").toString("utf8");
  let updated = current;
  for (const dir of binDirs) {
    updated = removePathEntry(updated, dir, true);
  }
  if (updated === current) return false;
  const write = powershell(WIN_WRITE_PATH_PS, { ...env, BUSINESS_FINDER_NEW_PATH: Buffer.from(updated, "utf8").toString("base64") });
  return write.status === 0;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * True only when `dir` is a regular directory holding solely our `SKILL.md`
 * (never a symlink or a folder with custom/extra files).
 */
export function isOwnedSkillDir(dir: string, skillName: "business-finder" | "leadscout"): boolean {
  if (!existsSync(dir)) return false;
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const entries = readdirSync(dir);
    if (entries.length !== 1 || entries[0] !== "SKILL.md") return false;
    const skillPath = path.join(dir, "SKILL.md");
    const fileStat = lstatSync(skillPath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return false;
    const text = readFileSync(skillPath, "utf8");
    const pattern =
      skillName === "leadscout"
        ? /^(?:---\r?\n[\s\S]*?^name:\s*leadscout\s*$|#\s*leadscout\b)/m
        : /^(?:---\r?\n[\s\S]*?^name:\s*business-finder\s*$|#\s*(?:business-finder|Business Finder)\b)/m;
    return pattern.test(text);
  } catch {
    return false;
  }
}

export type UninstallOptions = {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  confirm: (question: string) => Promise<boolean>;
  deleteLists?: boolean;
  platform?: NodeJS.Platform;
  home?: string;
  removeUserPath?: (binDir: string) => Promise<boolean> | boolean;
  stopServer?: (dataDir: string) => Promise<boolean>;
};

/** Removes both Business Finder and legacy leadscout installs (app, shims, PATH, owned skills); keeps saved lists unless confirmed. */
export async function uninstallBusinessFinder(opts: UninstallOptions): Promise<number> {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const dataDir = defaultDataDir(opts.env, platform, home);
  const oldDataDir = legacyDataDir(opts.env, platform, home);
  const jobsDir = path.join(dataDir, "jobs");
  const oldJobsDir = path.join(oldDataDir, "jobs");
  const appDir = path.join(dataDir, "app");
  const oldAppDir = path.join(oldDataDir, "app");
  const binDir = path.join(dataDir, "bin");
  const oldBinDir = path.join(oldDataDir, "bin");
  const userHome = platform === "win32" ? opts.env.USERPROFILE?.trim() || home : home;
  const skillDirs = [
    path.join(userHome, ".agents", "skills", "business-finder"),
    path.join(userHome, ".agents", "skills", "leadscout"),
  ];
  const claudeSkillDirs = [
    path.join(userHome, ".claude", "skills", "business-finder"),
    path.join(userHome, ".claude", "skills", "leadscout"),
  ];

  // Avoid Windows directory lock if the caller ran `uninstall` from inside `app` or `bin`.
  try {
    const cwd = process.cwd();
    if ([appDir, binDir, oldAppDir, oldBinDir].some((d) => isInside(cwd, d))) {
      process.chdir(userHome);
    }
  } catch {
    // Ignore if userHome does not exist; removal below will report or proceed.
  }

  const stop = opts.stopServer ?? stopServerByRecord;
  let stopped = false;
  for (const dir of [dataDir, oldDataDir]) {
    if (await stop(dir)) stopped = true;
  }
  if (stopped) {
    opts.out("Stopped running Business Finder server.");
  }

  let removedFromPath = false;
  if (opts.removeUserPath) {
    for (const dir of [binDir, oldBinDir]) {
      if (await opts.removeUserPath(dir)) removedFromPath = true;
    }
  } else if (platform === "win32") {
    removedFromPath = removeWindowsUserPath([binDir, oldBinDir], opts.env);
  }
  if (removedFromPath) {
    opts.out("Removed business-finder from your PATH.");
  }

  const removeDir = (target: string, optsRm: { recursive?: boolean; force?: boolean }) => {
    try {
      rmSync(target, optsRm);
    } catch (e) {
      if (isFsError(e)) throw new DataDirWriteError(formatWriteError(target, e));
      throw e;
    }
  };

  let removedShim = false;
  for (const dir of [binDir, oldBinDir]) {
    if (existsSync(dir)) {
      removeDir(dir, { recursive: true, force: true });
      removedShim = true;
    }
  }
  if (removedShim) {
    opts.out("Removed command shim.");
  }

  let removedApp = false;
  for (const dir of [appDir, oldAppDir]) {
    if (existsSync(dir)) {
      removeDir(dir, { recursive: true, force: true });
      removedApp = true;
    }
  }
  if (removedApp) {
    opts.out("Removed Business Finder app.");
  }

  const removeSkills = (dirs: string[], label: string) => {
    let removed = false;
    for (const [idx, dir] of dirs.entries()) {
      const kind = idx === 0 ? "business-finder" : "leadscout";
      if (isOwnedSkillDir(dir, kind)) {
        removeDir(dir, { recursive: true, force: true });
        removed = true;
      }
    }
    if (removed) opts.out(`Removed ${label} skill.`);
  };
  removeSkills(skillDirs, "Codex");
  removeSkills(claudeSkillDirs, "Claude Code");

  const existingJobs = [jobsDir, oldJobsDir].filter((d) => existsSync(d));
  if (existingJobs.length > 0) {
    const promptTargets = existingJobs.join(" and ");
    const shouldDelete = opts.deleteLists ? true : await opts.confirm(`Delete saved lists in ${promptTargets}? [y/N] `);
    if (shouldDelete) {
      for (const namedJobsDir of existingJobs) {
        const dir = path.dirname(namedJobsDir);
        removeDir(namedJobsDir, { recursive: true, force: true });
        removeDir(path.join(dir, GEOCODE_CACHE_FILE), { force: true });
        removeDir(path.join(dir, SERVER_FILE), { force: true });
        removeDir(path.join(dir, LEGACY_NOTICE_FILE), { force: true });
      }
      opts.out(`Deleted saved lists in ${promptTargets}.`);
    } else {
      opts.out(`Kept saved lists in ${promptTargets}.`);
    }
  }

  for (const dir of [dataDir, oldDataDir]) {
    if (existsSync(dir) && readdirSync(dir).length === 0) {
      removeDir(dir, { recursive: true, force: true });
    }
  }

  opts.out("✓ business-finder uninstalled");
  return 0;
}
