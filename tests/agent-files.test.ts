import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

/** Splits a Markdown file into its `key: value` frontmatter and its body. */
function readFrontmatter(relPath: string): { fields: Map<string, string>; body: string } {
  const text = readFileSync(join(root, relPath), "utf8").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${relPath} has no frontmatter block`);
  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    if (line.trim() === "") continue;
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`${relPath}: unparsable frontmatter line ${JSON.stringify(line)}`);
    fields.set(kv[1]!, kv[2]!.replace(/^"(.*)"$/, "$1"));
  }
  return { fields, body: match[2]! };
}

describe("/business-finder slash command", () => {
  const path = ".claude/commands/business-finder.md";

  it("exists", () => {
    expect(existsSync(join(root, path))).toBe(true);
  });

  it("has a description and an argument hint, and pre-approves no tools", () => {
    const { fields } = readFrontmatter(path);
    expect(fields.get("description")).toBeTruthy();
    expect(fields.get("argument-hint")).toBe("[business type] in [city]");
    expect(fields.has("allowed-tools")).toBe(false);
  });

  it("defers to the skill and keeps result files out of the agent's context", () => {
    const { body } = readFrontmatter(path);
    expect(body).toContain("$ARGUMENTS");
    expect(body).toContain("skills/business-finder/SKILL.md");
    expect(body).toContain("Never open the result file");
    expect(body).toContain("never ask the HTTP API for a job's rows");
  });
});

describe("skill frontmatter", () => {
  it("gives the same argument hint as the slash command and covers more than leads", () => {
    const { fields } = readFrontmatter("skills/business-finder/SKILL.md");
    expect(fields.get("name")).toBe("business-finder");
    expect(fields.get("argument-hint")).toBe("[business type] in [city]");
    const desc = fields.get("description") ?? "";
    expect(desc).toContain("customers");
    expect(desc).toContain("stockists");
    expect(desc).toContain("suppliers");
    expect(desc).toContain("venues");
  });
});

describe("skill description", () => {
  // Agent Skills spec: description is 1-1024 characters
  // (https://agentskills.io/specification). Claude Code cuts the listing at
  // 1,536 (https://code.claude.com/docs/en/skills); Codex checks only the name's
  // length and shortens descriptions when many skills are installed
  // (https://developers.openai.com/codex/skills).
  const desc = () => readFrontmatter("skills/business-finder/SKILL.md").fields.get("description") ?? "";

  it("stays within the 1024-character limit", () => {
    expect(desc().length).toBeGreaterThan(0);
    expect(desc().length).toBeLessThanOrEqual(1024);
  });

  it("leads with when to use it, prefers itself over web search, and ends with the install route", () => {
    expect(desc()).toMatch(/^Use whenever someone wants businesses/);
    expect(desc()).toContain("web search");
    expect(desc()).toContain("install.ps1");
    expect(desc().indexOf("install.ps1")).toBeGreaterThan(desc().indexOf("web search"));
  });

  it("has no YAML comment marker that would cut it short", () => {
    const raw = readFileSync(join(root, "skills/business-finder/SKILL.md"), "utf8");
    const line = raw.split(/\r?\n/).find((l) => l.startsWith("description:")) ?? "";
    expect(line).toMatch(/^description: ".*"$/);
    expect(line).not.toContain(" #");
  });
});

describe("installing from a clone the agent made", () => {
  for (const path of ["skills/business-finder/SKILL.md", "AGENTS.md"]) {
    it(`${path} says to install from that clone and then delete it`, () => {
      const body = readFileSync(join(root, path), "utf8").replace(/\s+/g, " ");
      expect(body).toContain(
        "If you cloned the repository yourself to inspect it, run `install.ps1` from that clone, then delete the clone.",
      );
      expect(body).toContain("carry on with the user's original request **in this same chat**");
      expect(body).toContain("Never tell the user to restart Codex or to open a new chat before using Business Finder.");
    });
  }
});

describe("lists and business-finder add", () => {
  for (const path of ["skills/business-finder/SKILL.md", "AGENTS.md"]) {
    // Whitespace collapsed, so a phrase may wrap across lines in the file.
    const body = () => readFileSync(join(root, path), "utf8").replace(/\s+/g, " ");

    it(`${path} sends a thin Maps trade to the agent's own web search and business-finder add`, () => {
      expect(body()).toContain("Adding businesses from your own web search");
      expect(body()).toMatch(/own web search/);
      expect(body()).toMatch(/"top 10" pages/);
      expect(body()).toContain("`business-finder add <file> --into <id>`");
      expect(body()).toContain("--title");
      expect(body()).toMatch(/`name,website`/);
    });

    it(`${path} has the agent write places out in full, confirm a state's towns, and check categories after a search`, () => {
      expect(body()).toContain("Turning what the person said into a search");
      expect(body()).toMatch(/works for \*\*any country\*\*/i);
      expect(body()).toContain("Examples");
      expect(body()).toContain("New York City, NY, US");
      expect(body()).toContain("California");
      expect(body()).toContain("Bangkok, Thailand");
      expect(body()).toContain("<place>, <state/region/prefecture>, <country>");
      expect(body()).toMatch(/for a country without regions.*middle part/i);
      expect(body()).toMatch(/always pass `--country <XX>`/);
      expect(body()).toMatch(/show them to the person and wait for them to confirm or change them/);
      expect(body()).toMatch(/Never retry with a guess on your own\./);
      expect(body()).toContain("After a search: check that the places fit");
      expect(body()).toMatch(/Nothing is hidden or removed without a yes\./);
    });

    it(`${path} fills one list with more searches when Google Maps reaches the end of its results`, () => {
      expect(body()).toContain("Getting more places than one search returns");
      expect(body()).toMatch(/about 100–120 places/);
      expect(body()).toContain("`business-finder scrape \"<other words>\" --city \"<city or nearby area>\" --into <id>`");
      expect(body()).toMatch(/nearby area/);
    });

    it(`${path} checks the saved lists before a search and asks before joining a list that only looks the same`, () => {
      expect(body()).toContain("Before running a search: check the saved lists");
      expect(body()).toContain("Run `business-finder lists` first");
      expect(body()).toContain("`business-finder lists --json`");
      expect(body()).toMatch(/The new run joins that list on its own/);
      expect(body()).toMatch(/ask the user whether to add to it with `--into <id>` or to start a new list\. Never decide this yourself\./);
      expect(body()).toMatch(/Report counts only/);
    });

    it(`${path} keeps rows out of the chat and points the user at the list page`, () => {
      expect(body()).toMatch(/never the rows|Never paste rows into the chat/);
      expect(body()).toMatch(/tell them to open the page to work with the list/);
    });
  }

  it("SKILL.md explains --whole-city when the user wants more than one search returns and warns it takes longer", () => {
    const body = readFileSync(join(root, "skills/business-finder/SKILL.md"), "utf8").replace(/\s+/g, " ");
    expect(body).toContain("--whole-city");
    expect(body).toMatch(/takes longer/);
  });

  it("SKILL.md proposes local-language synonyms, shows the list before running, and reports per-keyword counts", () => {
    const body = readFileSync(join(root, "skills/business-finder/SKILL.md"), "utf8").replace(/\s+/g, " ");
    expect(body).toContain("Chinese");
    expect(body).toContain("Malay");
    expect(body).toContain("Tamil");
    expect(body).toMatch(/before running/i);
    expect(body).toMatch(/each keyword added/i);
  });
});

describe("first-run bootstrap and plugin marketplace", () => {
  for (const relPath of ["skills/business-finder/SKILL.md", "AGENTS.md"]) {
    const raw = () => readFileSync(join(root, relPath), "utf8").replace(/\r\n/g, "\n");
    const body = () => raw().replace(/\s+/g, " ");

    it(`${relPath} starts with Installing as its first section and enforces the one-line announce user-level install`, () => {
      const firstHeading = raw().match(/^##\s+(.+)$/m)?.[1]?.trim();
      expect(firstHeading).toBe("Installing");

      const text = body();
      expect(text).not.toMatch(/do not search the disk for it or install it yourself/i);
      expect(text).not.toMatch(/tell the user so and stop/i);
      const installMatch = raw().match(/^## Installing\n([\s\S]*?)(?:\n## |\s*$)/m);
      const installSection = (installMatch?.[1] ?? "").replace(/\s+/g, " ");
      expect(installSection).not.toMatch(/wait for .*yes/i);
      expect(installSection).not.toMatch(/stop and ask first/i);
      expect(installSection).not.toMatch(/never install .* without one/i);
      expect(text).toContain(
        "Business Finder isn't installed yet. Installing it now (about a minute, only inside your user folder), then I'll carry on.",
      );
      expect(text).toContain("Never run more than the installer");
      expect(text).toMatch(/do not copy `SKILL\.md` by hand/i);
      expect(text).toContain("irm https://raw.githubusercontent.com/kweiloo/business-finder/main/install.ps1 | iex");
      expect(text).not.toContain('powershell -ExecutionPolicy Bypass -Command "try {');
      expect(text).toContain("https://github.com/kweiloo/business-finder.git");
      expect(text).toContain("business-finder-install");
      // The temporary clone is removed whether the install worked or not, and the
      // installer's exit code still reaches the agent after that cleanup.
      expect(text).toContain("finally { if (Test-Path $t) { Remove-Item -Recurse -Force $t } }");
      expect(text).toContain("$c = $LASTEXITCODE } finally");
      expect(text).toContain("if ($c) { exit $c }");
      expect(text).toMatch(/exits 0 only when Business Finder is installed and running/);
      expect(text).toContain("install.ps1");
      expect(text).toContain("business-finder doctor");
      expect(text).toContain("~\\.agents\\skills");
      expect(text).toContain("~\\.claude\\skills");
      expect(text).toMatch(/Never install it into the current workspace/);
      expect(text).toMatch(/Never run Business Finder from a clone/);
      expect(text).toMatch(/Windows-only/i);
    });
  }

  it("SKILL.md has no src/cli/main.ts dev-clone rule, no wait-for-yes rule, and forbids workspace installs", () => {
    const skill = readFileSync(join(root, "skills/business-finder/SKILL.md"), "utf8");
    expect(skill).not.toContain("src/cli/main.ts");
    expect(skill).not.toMatch(/current directory is a clone/i);
    expect(skill).not.toMatch(/wait for .*yes/i);
    expect(skill).toContain(
      "Business Finder isn't installed yet. Installing it now (about a minute, only inside your user folder), then I'll carry on.",
    );
    expect(skill).toMatch(/Never run more than the installer/);
    expect(skill).toMatch(/Never install it into the current workspace/);
    expect(skill).toMatch(/Never run Business Finder from a clone/);
  });

  it("AGENTS.md keeps the dev-clone rule only for developing Business Finder itself", () => {
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8").replace(/\s+/g, " ");
    expect(agents).toContain("Only when the user is developing Business Finder");
    expect(agents).toContain("bun src/cli/main.ts <command>");
  });

  it("README puts the one-sentence installer first with no Python/Node needed and moves developer routes under For developers", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8").replace(/\r\n/g, "\n");
    const opt1Idx = readme.indexOf("### Option 1:");
    const opt2Idx = readme.indexOf("### Option 2:");
    const devIdx = readme.indexOf("### For developers");
    expect(opt1Idx).toBeGreaterThan(-1);
    expect(opt2Idx).toBeGreaterThan(opt1Idx);
    expect(devIdx).toBeGreaterThan(opt2Idx);

    const opt1 = readme.slice(opt1Idx, opt2Idx);
    expect(opt1).toContain("Use github.com/kweiloo/business-finder to find event companies in Melaka");
    expect(opt1).toContain("in the same chat");
    expect(readme).not.toMatch(/restart(ing)? Codex once/i);
    expect(opt1).toMatch(/no Python or Node/i);
    expect(opt1).toContain(
      "Business Finder isn't installed yet. Installing it now (about a minute, only inside your user folder), then I'll carry on.",
    );
    expect(opt1).not.toMatch(/Say \*\*yes\*\*/i);

    const opt2 = readme.slice(opt2Idx, devIdx);
    expect(opt2).toContain("irm https://raw.githubusercontent.com/kweiloo/business-finder/main/install.ps1 | iex");

    const dev = readme.slice(devIdx);
    expect(dev).toContain("npx skills add kweiloo/business-finder");
    expect(dev).toContain("$skill-installer");
    expect(dev).toContain("/plugin install business-finder --marketplace kweiloo/business-finder");
  });

  it("ships a Claude Code plugin marketplace listing business-finder", () => {
    const raw = readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8");
    const manifest = JSON.parse(raw) as { name: string; plugins: Array<{ name: string; skills?: string[]; commands?: string[] }> };
    expect(manifest.name).toBe("business-finder");
    expect(manifest.plugins).toHaveLength(1);
    expect(manifest.plugins[0]?.name).toBe("business-finder");
    expect(manifest.plugins[0]?.skills).toContain("./skills/business-finder");
    expect(manifest.plugins[0]?.commands).toContain("./.claude/commands/business-finder.md");
  });
});

describe("agent permissions", () => {
  it("the repository tracks no Claude Code settings file", () => {
    const tracked = execFileSync("git", ["ls-files", ".claude"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(tracked).not.toContain(".claude/settings.json");
    expect(tracked).not.toContain(".claude/settings.local.json");
  });
});
