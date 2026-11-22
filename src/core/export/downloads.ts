// Resolves the user's Downloads folder via the OS known-folder API (Windows
// FOLDERID_Downloads; XDG DOWNLOAD elsewhere) so redirected Downloads folders
// are followed, and builds the default CLI export path under "Business Finder".

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { defaultFileName } from "./filename.js";

export const EXPORT_SUBFOLDER = "Business Finder";
export const FOLDERID_DOWNLOADS = "374DE290-123F-4565-9164-39C4925E467B";

export type DownloadsDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Windows known-folder lookup (returns null if unavailable). */
  windowsKnownFolder?: (folderId: string) => string | null;
  /** XDG user-dir lookup for `"DOWNLOAD"` (returns null if unavailable). */
  xdgUserDir?: (kind: "DOWNLOAD") => string | null;
  /** Reads `user-dirs.dirs` when `xdg-user-dir` is not available. */
  readFile?: (file: string) => string;
};

function queryWindowsKnownFolder(folderId: string): string | null {
  if (!/^[0-9a-fA-F-]{36}$/.test(folderId)) return null;
  const script = `
$guid = [Guid]'${folderId}'
Add-Type -Namespace Win32 -Name BusinessFinderKnownFolder -MemberDefinition @'
[DllImport("shell32.dll", CharSet = CharSet.Unicode)]
public static extern int SHGetKnownFolderPath(ref Guid rfid, uint dwFlags, IntPtr hToken, out IntPtr ppszPath);
'@
$ptr = [IntPtr]::Zero
$hr = [Win32.BusinessFinderKnownFolder]::SHGetKnownFolderPath([ref]$guid, 0, [IntPtr]::Zero, [ref]$ptr)
try {
  if ($hr -ne 0 -or $ptr -eq [IntPtr]::Zero) { exit 2 }
  $p = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($ptr)
  if ([string]::IsNullOrWhiteSpace($p)) { exit 2 }
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p)))
} finally {
  if ($ptr -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeCoTaskMem($ptr) }
}
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (res.status !== 0 || !res.stdout?.trim()) return null;
  try {
    const decoded = Buffer.from(res.stdout.trim(), "base64").toString("utf8").trim();
    return decoded || null;
  } catch {
    return null;
  }
}

function queryXdgUserDir(kind: "DOWNLOAD"): string | null {
  const res = spawnSync("xdg-user-dir", [kind], { encoding: "utf8", timeout: 5_000 });
  if (res.status !== 0) return null;
  const line = res.stdout.trim();
  return line || null;
}

function expandHome(value: string, home: string): string {
  if (value === "$HOME" || value === "${HOME}") return home;
  if (value.startsWith("$HOME/")) return path.posix.join(home, value.slice("$HOME/".length));
  if (value.startsWith("${HOME}/")) return path.posix.join(home, value.slice("${HOME}/".length));
  return value;
}

/** Parses `XDG_DOWNLOAD_DIR="..."` from an XDG `user-dirs.dirs` file. */
export function parseXdgDownloadsFromConfig(text: string, home: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^XDG_DOWNLOAD_DIR\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(line);
    if (!match) continue;
    const unescaped = match[1]!.replace(/\\(["\\])/g, "$1").trim();
    if (!unescaped) return null;
    return expandHome(unescaped, home);
  }
  return null;
}

/**
 * Resolves the user's Downloads folder using the OS known-folder API on Windows
 * (`FOLDERID_Downloads`) and XDG `DOWNLOAD` elsewhere.
 */
export function resolveDownloadsDir(deps: DownloadsDeps = {}): string {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();

  const override = env.BUSINESS_FINDER_DOWNLOADS_DIR?.trim();
  if (override) return override;

  if (platform === "win32") {
    const known = (deps.windowsKnownFolder ?? queryWindowsKnownFolder)(FOLDERID_DOWNLOADS)?.trim();
    if (known) return known;
    return path.win32.join(env.USERPROFILE?.trim() || home, "Downloads");
  }

  const xdgEnv = env.XDG_DOWNLOAD_DIR?.trim();
  if (xdgEnv) return expandHome(xdgEnv, home);

  const xdgCmd = (deps.xdgUserDir ?? queryXdgUserDir)("DOWNLOAD")?.trim();
  if (xdgCmd) return expandHome(xdgCmd, home);

  const configHome = env.XDG_CONFIG_HOME?.trim() || path.posix.join(home, ".config");
  const userDirsFile = path.posix.join(configHome, "user-dirs.dirs");
  try {
    const content = (deps.readFile ?? ((f: string) => readFileSync(f, "utf8")))(userDirsFile);
    const configured = parseXdgDownloadsFromConfig(content, home);
    if (configured) return configured;
  } catch {
    // No user-dirs.dirs file; fall through to ~/Downloads.
  }

  return path.posix.join(home, "Downloads");
}

/** Full default path for CLI exports: `<Downloads>/Business Finder/business-finder-<keyword>-<city>-<stamp>.<ext>`. */
export function defaultOutPath(
  keyword: string,
  city: string,
  now: Date,
  ext: "csv" | "json",
  deps: DownloadsDeps = {},
): string {
  const platform = deps.platform ?? process.platform;
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(resolveDownloadsDir(deps), EXPORT_SUBFOLDER, defaultFileName(keyword, city, now, ext));
}
