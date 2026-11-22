import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseCli } from "../src/cli/main.js";
import { isOwnedSkillDir, removePathEntry, uninstallBusinessFinder } from "../src/cli/uninstall.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "business-finder-uninstall-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PATH entry removal", () => {
  it("removes the matching entry and leaves the rest of PATH unchanged", () => {
    const entry = "C:\\Users\\Ada\\AppData\\Local\\business-finder\\bin";
    const original = `C:\\Windows\\System32;${entry};C:\\Tools`;
    expect(removePathEntry(original, entry, true)).toBe("C:\\Windows\\System32;C:\\Tools");
    expect(removePathEntry(`${entry};C:\\Tools`, entry, true)).toBe("C:\\Tools");
    expect(removePathEntry(`C:\\Tools;${entry}`, entry, true)).toBe("C:\\Tools");
    expect(removePathEntry(entry, entry, true)).toBe("");
    expect(removePathEntry("C:\\Windows\\System32;C:\\Tools", entry, true)).toBe("C:\\Windows\\System32;C:\\Tools");
  });
});

describe("parseCli bare and uninstall", () => {
  it("starts serve when called with no arguments", () => {
    expect(parseCli([])).toEqual({ command: "serve", port: 8080, open: true, reuse: true });
  });

  it("prints help for --help", () => {
    expect(parseCli(["--help"])).toEqual({ command: "help" });
  });

  it("parses uninstall with and without --delete-lists", () => {
    expect(parseCli(["uninstall"])).toEqual({ command: "uninstall", deleteLists: false });
    expect(parseCli(["uninstall", "--delete-lists"])).toEqual({ command: "uninstall", deleteLists: true });
  });
});

describe("uninstallBusinessFinder", () => {
  function setupInstall(opts: { withLegacy?: boolean } = {}) {
    const local = path.join(dir, "local");
    const home = path.join(dir, "home");
    const dataDir = path.join(local, "business-finder");
    const appDir = path.join(dataDir, "app");
    const binDir = path.join(dataDir, "bin");
    const jobsDir = path.join(dataDir, "jobs");
    const skillDir = path.join(home, ".agents", "skills", "business-finder");
    const otherSkillDir = path.join(home, ".agents", "skills", "other-skill");
    const claudeSkillDir = path.join(home, ".claude", "skills", "business-finder");
    const claudeOtherSkillDir = path.join(home, ".claude", "skills", "other-skill");
    const claudeRules = path.join(home, ".claude", "CLAUDE.md");

    mkdirSync(appDir, { recursive: true });
    writeFileSync(path.join(appDir, "package.json"), "{}");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, "business-finder.cmd"), "@echo off\r\n");
    writeFileSync(path.join(binDir, "leadscout.cmd"), "@echo off\r\n");
    mkdirSync(path.join(jobsDir, "job-1"), { recursive: true });
    writeFileSync(path.join(jobsDir, "job-1", "job.json"), "{}");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: business-finder\n---\n# Business Finder\n");
    mkdirSync(otherSkillDir, { recursive: true });
    writeFileSync(path.join(otherSkillDir, "SKILL.md"), "# other\n");
    mkdirSync(claudeSkillDir, { recursive: true });
    writeFileSync(path.join(claudeSkillDir, "SKILL.md"), "---\nname: business-finder\n---\n# Business Finder\n");
    mkdirSync(claudeOtherSkillDir, { recursive: true });
    writeFileSync(path.join(claudeOtherSkillDir, "SKILL.md"), "# other\n");
    writeFileSync(claudeRules, "# user rules\n");

    const oldDataDir = path.join(local, "leadscout");
    const oldAppDir = path.join(oldDataDir, "app");
    const oldBinDir = path.join(oldDataDir, "bin");
    const oldSkillDir = path.join(home, ".agents", "skills", "leadscout");
    const oldClaudeSkillDir = path.join(home, ".claude", "skills", "leadscout");
    if (opts.withLegacy) {
      mkdirSync(oldAppDir, { recursive: true });
      writeFileSync(path.join(oldAppDir, "package.json"), "{}");
      mkdirSync(oldBinDir, { recursive: true });
      writeFileSync(path.join(oldBinDir, "leadscout.cmd"), "@echo off\r\n");
      mkdirSync(oldSkillDir, { recursive: true });
      writeFileSync(path.join(oldSkillDir, "SKILL.md"), "# leadscout\n");
      mkdirSync(oldClaudeSkillDir, { recursive: true });
      writeFileSync(path.join(oldClaudeSkillDir, "SKILL.md"), "---\nname: leadscout\n---\n# leadscout\n");
    }

    const env = { ...process.env, LOCALAPPDATA: local, XDG_DATA_HOME: local, USERPROFILE: home };
    return {
      env,
      dataDir,
      appDir,
      binDir,
      jobsDir,
      skillDir,
      otherSkillDir,
      claudeSkillDir,
      claudeOtherSkillDir,
      claudeRules,
      oldDataDir,
      oldAppDir,
      oldBinDir,
      oldSkillDir,
      oldClaudeSkillDir,
      home,
    };
  }

  it("removes both new and old app, shim, PATH entry, and owned skills, while keeping other skills, user rules, and saved lists by default", async () => {
    const s = setupInstall({ withLegacy: true });
    const out: string[] = [];
    const removeUserPath = vi.fn(() => true);
    const stopServer = vi.fn(async () => true);

    const code = await uninstallBusinessFinder({
      env: s.env,
      platform: "win32",
      home: s.home,
      out: (line) => out.push(line),
      confirm: async () => false,
      removeUserPath,
      stopServer,
    });

    expect(code).toBe(0);
    expect(stopServer).toHaveBeenCalledWith(s.dataDir);
    expect(stopServer).toHaveBeenCalledWith(s.oldDataDir);
    expect(removeUserPath).toHaveBeenCalledWith(s.binDir);
    expect(removeUserPath).toHaveBeenCalledWith(s.oldBinDir);
    expect(existsSync(s.appDir)).toBe(false);
    expect(existsSync(s.binDir)).toBe(false);
    expect(existsSync(s.oldAppDir)).toBe(false);
    expect(existsSync(s.oldBinDir)).toBe(false);
    expect(existsSync(s.skillDir)).toBe(false);
    expect(existsSync(s.oldSkillDir)).toBe(false);
    expect(existsSync(s.otherSkillDir)).toBe(true);
    expect(existsSync(s.claudeSkillDir)).toBe(false);
    expect(existsSync(s.oldClaudeSkillDir)).toBe(false);
    expect(existsSync(s.claudeOtherSkillDir)).toBe(true);
    expect(readFileSync(s.claudeRules, "utf8")).toBe("# user rules\n");
    expect(existsSync(path.join(s.jobsDir, "job-1", "job.json"))).toBe(true);
    expect(out.join("\n")).toContain("Kept saved lists");
  });

  it("never removes a leadscout skill folder it did not install", async () => {
    const s = setupInstall();
    const customSkillDir = s.oldSkillDir;
    mkdirSync(customSkillDir, { recursive: true });
    writeFileSync(path.join(customSkillDir, "SKILL.md"), "---\nname: leadscout\n---\n# custom\n");
    writeFileSync(path.join(customSkillDir, "notes.txt"), "do not delete");
    expect(isOwnedSkillDir(customSkillDir, "leadscout")).toBe(false);

    const unrelatedSkillDir = s.oldClaudeSkillDir;
    mkdirSync(unrelatedSkillDir, { recursive: true });
    writeFileSync(path.join(unrelatedSkillDir, "SKILL.md"), "---\nname: other\n---\n# unrelated\n");
    expect(isOwnedSkillDir(unrelatedSkillDir, "leadscout")).toBe(false);

    const code = await uninstallBusinessFinder({
      env: s.env,
      platform: "win32",
      home: s.home,
      out: () => {},
      confirm: async () => false,
      removeUserPath: () => false,
      stopServer: async () => false,
    });

    expect(code).toBe(0);
    expect(existsSync(path.join(customSkillDir, "notes.txt"))).toBe(true);
    expect(existsSync(path.join(unrelatedSkillDir, "SKILL.md"))).toBe(true);
  });

  it("deletes saved lists only when confirmed", async () => {
    const s = setupInstall();
    const out: string[] = [];

    const code = await uninstallBusinessFinder({
      env: s.env,
      platform: "win32",
      home: s.home,
      out: (line) => out.push(line),
      confirm: async () => true,
      removeUserPath: () => false,
      stopServer: async () => false,
    });

    expect(code).toBe(0);
    expect(existsSync(s.jobsDir)).toBe(false);
    expect(out.join("\n")).toContain("Deleted saved lists");
  });

  it("works through main() with --delete-lists without prompting", async () => {
    const s = setupInstall();
    const out: string[] = [];
    const confirm = vi.fn(async () => false);
    const code = await main(["uninstall", "--delete-lists"], {
      out: (line) => out.push(line),
      err: () => {},
      env: { ...s.env, BUSINESS_FINDER_PATH_SCOPE: "Process" },
      cwd: dir,
      now: () => new Date(),
      confirm,
    });
    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(existsSync(s.jobsDir)).toBe(false);
  });

  it("keeps saved lists when main(['uninstall']) receives default decline", async () => {
    const s = setupInstall();
    const out: string[] = [];
    const code = await main(["uninstall"], {
      out: (line) => out.push(line),
      err: () => {},
      env: { ...s.env, BUSINESS_FINDER_PATH_SCOPE: "Process" },
      cwd: dir,
      now: () => new Date(),
      confirm: async () => false,
    });
    expect(code).toBe(0);
    expect(existsSync(s.jobsDir)).toBe(true);
    expect(readFileSync(path.join(s.jobsDir, "job-1", "job.json"), "utf8")).toBe("{}");
  });

  it("names both jobs folders in the delete prompt when both exist, keeping both on 'n' and deleting both on 'y'", async () => {
    const keepCase = setupInstall({ withLegacy: true });
    const oldJobsKeep = path.join(keepCase.oldDataDir, "jobs");
    mkdirSync(path.join(oldJobsKeep, "old-1"), { recursive: true });
    writeFileSync(path.join(oldJobsKeep, "old-1", "job.json"), "{}");

    const promptsKeep: string[] = [];
    const codeKeep = await uninstallBusinessFinder({
      env: keepCase.env,
      platform: "win32",
      home: keepCase.home,
      out: () => {},
      confirm: async (q) => {
        promptsKeep.push(q);
        return false;
      },
      removeUserPath: () => false,
      stopServer: async () => false,
    });
    expect(codeKeep).toBe(0);
    expect(promptsKeep).toEqual([`Delete saved lists in ${keepCase.jobsDir} and ${oldJobsKeep}? [y/N] `]);
    expect(existsSync(path.join(keepCase.jobsDir, "job-1", "job.json"))).toBe(true);
    expect(existsSync(path.join(oldJobsKeep, "old-1", "job.json"))).toBe(true);

    rmSync(keepCase.oldDataDir, { recursive: true, force: true });
    rmSync(keepCase.dataDir, { recursive: true, force: true });

    const delCase = setupInstall({ withLegacy: true });
    const oldJobsDel = path.join(delCase.oldDataDir, "jobs");
    mkdirSync(path.join(oldJobsDel, "old-2"), { recursive: true });
    writeFileSync(path.join(oldJobsDel, "old-2", "job.json"), "{}");

    const promptsDel: string[] = [];
    const codeDel = await uninstallBusinessFinder({
      env: delCase.env,
      platform: "win32",
      home: delCase.home,
      out: () => {},
      confirm: async (q) => {
        promptsDel.push(q);
        return true;
      },
      removeUserPath: () => false,
      stopServer: async () => false,
    });
    expect(codeDel).toBe(0);
    expect(promptsDel).toEqual([`Delete saved lists in ${delCase.jobsDir} and ${oldJobsDel}? [y/N] `]);
    expect(existsSync(delCase.jobsDir)).toBe(false);
    expect(existsSync(oldJobsDel)).toBe(false);
  });
});
