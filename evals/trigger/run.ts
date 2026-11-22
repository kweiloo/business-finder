// Trigger eval: does Codex pick the business-finder skill for plain requests?
//
// Each prompt runs as one `codex exec` session in a throwaway home folder that
// holds only the installed skill (at ~\.agents\skills\business-finder, where
// install.ps1 puts it), a throwaway CODEX_HOME, and a stub `business-finder`
// on PATH that logs its arguments instead of searching Google Maps.
// A session counts as triggered when the stub was called or a shell command
// touched the skill (reading its SKILL.md or calling business-finder).
//
// Usage (Windows, signed in to Codex):
//   bun evals/trigger/run.ts --label baseline [--skill <SKILL.md>] [--only T01,N04] [--concurrency 3]
//
// It never writes to the real ~\.codex, ~\.agents or ~\.claude: auth.json is
// copied read-only into the throwaway CODEX_HOME, and the user and machine PATH
// are hashed before and after to show they were not changed.

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// "link" prompts carry the repository link and a task, with Business Finder not
// installed: the session must install it and then search, in the same session.
type Prompt = { id: string; set: "dev" | "heldout" | "negative" | "link"; expect: boolean; lang: string; text: string };
type Result = Prompt & { triggered: boolean; evidence: string; webSearches: number; exitCode: number | null; seconds: number };

const here = import.meta.dirname;
const repo = resolve(here, "..", "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const label = arg("label") ?? "run";
const skillPath = resolve(arg("skill") ?? join(repo, "skills", "business-finder", "SKILL.md"));
const only = arg("only")?.split(",").map((s) => s.trim());
// --with-user-skills keeps the user's own ~\.agents\skills switched on (read
// only), as in their real Codex, so many skills compete for the skill list;
// only their installed business-finder is swapped for the one under test.
const withUserSkills = process.argv.includes("--with-user-skills");
const concurrency = Number(arg("concurrency") ?? "3");
const timeoutMs = Number(arg("timeout-sec") ?? "420") * 1000;
const linkTimeoutMs = Number(arg("link-timeout-sec") ?? "900") * 1000;
// Same model as the user's own Codex unless --model says otherwise.
const realConfig = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
const model =
  arg("model") ??
  (existsSync(realConfig) ? /^model\s*=\s*"([^"]+)"/m.exec(readFileSync(realConfig, "utf8"))?.[1] : undefined);

const all: Prompt[] = JSON.parse(readFileSync(join(here, "prompts.json"), "utf8")).prompts;
const adHoc = arg("ad-hoc");
const prompts: Prompt[] = adHoc
  ? [{ id: "ADHOC", set: "dev", expect: true, lang: "?", text: adHoc }]
  : only
    ? all.filter((p) => only.includes(p.id))
    : all;

/** SHA-256 of the user and machine PATH as stored in the registry. */
function pathSnapshot(): { user: string; machine: string; hash: string } {
  const read = (key: string) => {
    try {
      return execFileSync("reg", ["query", key, "/v", "Path"], { encoding: "utf8" });
    } catch {
      return "";
    }
  };
  const user = read("HKCU\\Environment");
  const machine = read("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment");
  return { user, machine, hash: createHash("sha256").update(user).update("\0").update(machine).digest("hex") };
}

const realCodexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const realAuth = join(realCodexHome, "auth.json");
if (!existsSync(realAuth)) throw new Error(`No Codex login found at ${realAuth}. Sign in to Codex first.`);
const authHashBefore = createHash("sha256").update(readFileSync(realAuth)).digest("hex");

/** Every SKILL.md under the real ~\.agents\skills, resolved through links. */
function findRealUserSkills(): string[] {
  const rootDir = join(homedir(), ".agents", "skills");
  const found = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) walk(full, depth + 1);
      else if (entry.name === "SKILL.md") {
        found.add(full);
        try {
          found.add(realpathSync(full));
        } catch {
          /* broken link */
        }
      }
    }
  };
  walk(rootDir, 0);
  return [...found];
}
const realUserSkills = findRealUserSkills();

/** Hash of every path, size and modified time under the real ~\.agents. */
function agentsTreeHash(): string {
  const h = createHash("sha256");
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
      else {
        try {
          const st = statSync(full);
          h.update(`${full}|${st.size}|${st.mtimeMs};`);
        } catch {
          h.update(`${full}|broken;`);
        }
      }
    }
  };
  walk(join(homedir(), ".agents"));
  return h.digest("hex");
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const root = join(tmpdir(), `bf-trigger-${label}-${stamp}`);
// install.ps1 writes the user PATH to this HKCU key instead of Environment.
const evalEnvKey = `Software\\BusinessFinderTriggerEval\\${stamp}`;

/** PATH without any installed business-finder or leadscout launcher folder. */
function pathWithoutBusinessFinder(): string {
  return (process.env.PATH ?? "")
    .split(";")
    .filter((e) => e && !/[\\/](business-finder|leadscout)[\\/]/i.test(`${e}\\`))
    .join(";");
}

let mirror: { gitConfig: string } | undefined;
/**
 * A local mirror of this checkout's HEAD for the link prompts to install from:
 * git URLs for the GitHub repository resolve to it, and its src/cli/main.ts is
 * cli-stub.ts, which logs calls and searches nothing.
 */
function buildMirror(): { gitConfig: string } {
  if (mirror) return mirror;
  const src = join(root, "mirror-src");
  const bare = join(root, "mirror.git");
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" });
  git(root, "clone", "--quiet", "--no-hardlinks", repo, src);
  git(src, "mv", "src/cli/main.ts", "src/cli/main.real.ts");
  copyFileSync(join(here, "cli-stub.ts"), join(src, "src", "cli", "main.ts"));
  git(src, "add", "-A");
  git(src, "-c", "user.name=trigger-eval", "-c", "user.email=trigger-eval@localhost", "commit", "--quiet", "-m", "Stub the CLI for the trigger eval");
  git(src, "branch", "-M", "main");
  git(root, "clone", "--quiet", "--bare", src, bare);
  const url = "file:///" + bare.replace(/\\/g, "/");
  const gitConfig = join(root, "gitconfig");
  const sources = ["kweiloo/business-finder", "kweiloo/leadscout"].flatMap((slug) => [
    `https://github.com/${slug}.git`,
    `https://github.com/${slug}`,
    `git@github.com:${slug}.git`,
  ]);
  writeFileSync(gitConfig, [`[url "${url}"]`, ...sources.map((u) => `\tinsteadOf = ${u}`), "[safe]", "\tdirectory = *", ""].join("\n"));
  mirror = { gitConfig };
  return mirror;
}

/** Stops the Business Finder server a link session's install started, if any. */
function stopSessionServer(localApp: string, base: string) {
  const record = join(localApp, "business-finder", "server.json");
  if (!existsSync(record)) return;
  try {
    const pid = Number(JSON.parse(readFileSync(record, "utf8")).pid);
    if (!pid) return;
    // Only stop it when its command line points into this session's folder.
    const line = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: "utf8" },
    );
    if (line.toLowerCase().includes(base.toLowerCase())) spawnSyncKill(pid);
  } catch {
    /* not running */
  }
}

/** Builds one isolated home + CODEX_HOME + stub for a single session. */
function sandbox(id: string, link: boolean) {
  const base = join(root, id);
  const home = join(base, "home");
  const localApp = join(home, "AppData", "Local");
  const roaming = join(home, "AppData", "Roaming");
  const codexHome = join(base, "codex-home");
  const bin = join(base, "bin");
  const work = join(base, "work");
  const log = join(base, "business-finder-calls.log");
  for (const d of [home, localApp, roaming, codexHome, bin, work]) mkdirSync(d, { recursive: true });

  // Codex finds ~\.agents\skills through the Windows profile folder, not
  // USERPROFILE, so the eval skill goes in the throwaway CODEX_HOME's own
  // user-scope skills folder and every skill in the real ~\.agents\skills is
  // switched off by path in the throwaway config (the real folder is only read).
  if (!link) {
    const skillDir = join(codexHome, "skills", "business-finder");
    mkdirSync(skillDir, { recursive: true });
    copyFileSync(skillPath, join(skillDir, "SKILL.md"));
  }

  copyFileSync(realAuth, join(codexHome, "auth.json"));
  const cfg = [
    model ? `model = "${model}"` : "",
    `model_reasoning_effort = "high"`,
    `web_search = "live"`,
    `approval_policy = "never"`,
    // Codex's Windows sandbox rejects every shell command in exec mode, which
    // blocks the skill read itself. The session runs unsandboxed, with home,
    // app-data and PATH pointed at the throwaway folders and the stub.
    `sandbox_mode = "danger-full-access"`,
    ...realUserSkills
      .filter((path) => !withUserSkills || /[\\/]business-finder[\\/]SKILL\.md$/i.test(path))
      .flatMap((path) => ["", "[[skills.config]]", `path = ${JSON.stringify(path)}`, "enabled = false"]),
  ].filter((l) => l !== undefined && l !== null);
  writeFileSync(join(codexHome, "config.toml"), cfg.join("\n") + "\n");

  if (link) return { base, home, localApp, roaming, codexHome, bin, work, log };
  const stubPs1 = join(here, "stub.ps1");
  const cmd = `@powershell -NoProfile -ExecutionPolicy Bypass -File "${stubPs1}" %*\r\n@exit /b %ERRORLEVEL%\r\n`;
  writeFileSync(join(bin, "business-finder.cmd"), cmd);
  // The skill also names the installed launcher path; put the stub there too.
  const appBin = join(localApp, "business-finder", "bin");
  mkdirSync(appBin, { recursive: true });
  writeFileSync(join(appBin, "business-finder.cmd"), cmd);

  return { base, home, localApp, roaming, codexHome, bin, work, log };
}

function runOne(p: Prompt): Promise<Result> {
  const link = p.set === "link";
  const sb = sandbox(p.id, link);
  // Sessions run unsandboxed with live web search, so they get only the
  // variables Windows and Codex need: none of the caller's tokens or keys.
  const keep = /^(SystemRoot|SystemDrive|windir|ComSpec|PATHEXT|TEMP|TMP|OS|NUMBER_OF_PROCESSORS|PROCESSOR_\w+|ProgramFiles(\(x86\))?|ProgramW6432|ProgramData|CommonProgramFiles(\(x86\))?|PSModulePath)$/i;
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.test(k))),
    CODEX_HOME: sb.codexHome,
    USERPROFILE: sb.home,
    HOME: sb.home,
    LOCALAPPDATA: sb.localApp,
    APPDATA: sb.roaming,
    BF_TRIGGER_LOG: sb.log,
    PATH: link ? pathWithoutBusinessFinder() : `${sb.bin};${pathWithoutBusinessFinder()}`,
    ...(link
      ? {
          GIT_CONFIG_GLOBAL: buildMirror().gitConfig,
          GIT_TERMINAL_PROMPT: "0",
          BUSINESS_FINDER_USER_ENV_KEY: `${evalEnvKey}\\${p.id}`,
          BUSINESS_FINDER_NO_OPEN: "1",
        }
      : {}),
  };
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn("codex", ["exec", "--json", "--skip-git-repo-check", "-C", sb.work, p.text], {
      env,
      cwd: sb.work,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b.toString("utf8")));
    child.stderr.on("data", (b) => (err += b.toString("utf8")));
    const timer = setTimeout(() => {
      // Only ever stop the process tree this runner started.
      if (child.pid) spawnSyncKill(child.pid);
    }, link ? linkTimeoutMs : timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(join(sb.base, "transcript.jsonl"), out);
      writeFileSync(join(sb.base, "stderr.txt"), err);
      rmSync(join(sb.codexHome, "auth.json"), { force: true }); // the login copy lives only for this session
      if (link) stopSessionServer(sb.localApp, sb.base);
      const calls = existsSync(sb.log) ? readFileSync(sb.log, "utf8").trim() : "";
      const commands: string[] = [];
      let webSearches = 0;
      for (const line of out.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const ev = JSON.parse(line);
          const item = ev.item ?? {};
          if (ev.type === "item.completed" || ev.type === "item.started") {
            if (item.type === "command_execution" && typeof item.command === "string") commands.push(item.command);
            if (item.type === "web_search" && ev.type === "item.completed") webSearches++;
          }
        } catch {
          /* not an event line */
        }
      }
      // A command Codex refused to run never reaches the JSON transcript; its
      // log line in stderr still shows the attempt.
      const refused = err.split("\n").find((l) => /exec_command failed/.test(l) && /business-finder/i.test(l));
      const touched = commands.find((c) => /business-finder/i.test(c)) ?? (refused ? `refused: ${refused}` : undefined);
      if (link) {
        // Install, then a search in the same session: install.ps1 ran, and after
        // it the installed (stubbed) command was called for lists or scrape.
        const installed = commands.some((c) => /install\.ps1/i.test(c));
        const calledArgs = calls ? calls.split("\n").map((l) => l.split("\t")[1] ?? "") : [];
        const searched = calledArgs.some((a) => /^(lists|scrape)\b/.test(a));
        done({
          ...p,
          triggered: installed && searched,
          evidence: `install.ps1 ${installed ? "ran" : "did not run"}; calls: ${calledArgs.join(" -> ") || "none"}`,
          webSearches,
          exitCode: code,
          seconds: Math.round((Date.now() - started) / 1000),
        });
        return;
      }
      const evidence = calls
        ? `called: ${calls.split("\n")[0]!.split("\t")[1] ?? ""}`.trim()
        : touched
          ? `command: ${touched.slice(0, 120)}`
          : "";
      done({
        ...p,
        triggered: Boolean(calls || touched),
        evidence,
        webSearches,
        exitCode: code,
        seconds: Math.round((Date.now() - started) / 1000),
      });
    });
  });
}

function spawnSyncKill(pid: number) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

async function main() {
  const pathBefore = pathSnapshot();
  const agentsBefore = agentsTreeHash();
  mkdirSync(root, { recursive: true });
  console.log(`Trigger eval "${label}": ${prompts.length} prompts, skill ${skillPath}`);
  console.log(`sandbox: ${root}`);
  console.log(`PATH snapshot before: ${pathBefore.hash}`);

  const queue = [...prompts];
  const results: Result[] = [];
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const r = await runOne(p);
        results.push(r);
        console.log(`${r.id} ${r.triggered ? "TRIGGERED" : "not triggered"} (${r.seconds}s, exit ${r.exitCode}) ${r.evidence}`);
      }
    }),
  );
  results.sort((a, b) => all.findIndex((p) => p.id === a.id) - all.findIndex((p) => p.id === b.id));

  const pathAfter = pathSnapshot();
  const agentsAfter = agentsTreeHash();
  const authHashAfter = createHash("sha256").update(readFileSync(realAuth)).digest("hex");

  const rows = results.map(
    (r) =>
      `| ${r.id} | ${r.set} | ${r.lang} | ${r.text} | ${r.expect ? "yes" : "no"} | ${r.triggered ? "**triggered**" : "not triggered"} | ${r.triggered === r.expect ? "ok" : "MISS"} | ${r.webSearches} |`,
  );
  const score = (set: Prompt["set"]) => {
    const s = results.filter((r) => r.set === set);
    return `${s.filter((r) => r.triggered).length}/${s.length}`;
  };
  const shouldTrigger = results.filter((r) => r.expect && r.set !== "link");
  const summary = [
    `## Trigger eval: ${label}`,
    "",
    `Skill: \`${skillPath}\`${withUserSkills ? `, alongside the user's own ${realUserSkills.length} skill files` : ", alone"}`,
    "",
    "| id | set | lang | prompt | should trigger | result | | web searches |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    ...results.filter((r) => r.set === "link").map((r) => `- ${r.id}: ${r.evidence}`),
    "",
    ...(results.some((r) => r.set === "link")
      ? [`Link plus task, install then search in one session: ${score("link")}.`, ""]
      : []),
    `Should trigger: ${shouldTrigger.filter((r) => r.triggered).length}/${shouldTrigger.length} (dev ${score("dev")}, held-out ${score("heldout")}). False triggers: ${score("negative")}.`,
    `User+machine PATH hash before ${pathBefore.hash.slice(0, 16)}, after ${pathAfter.hash.slice(0, 16)}: ${pathBefore.hash === pathAfter.hash ? "unchanged" : "CHANGED"}.`,
    `Real Codex auth.json: ${authHashBefore === authHashAfter ? "unchanged" : "CHANGED"}. Real ~\\.agents tree: ${agentsBefore === agentsAfter ? "unchanged" : "CHANGED"}.`,
  ].join("\n");

  const outDir = join(here, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${label}-${stamp}.md`), summary + "\n");
  writeFileSync(join(outDir, `${label}-${stamp}.json`), JSON.stringify({ label, skillPath, sandbox: root, results }, null, 2));
  console.log("\n" + summary);
  if (pathBefore.hash !== pathAfter.hash) process.exitCode = 3;
  try {
    execFileSync("reg", ["delete", `HKCU\\${evalEnvKey}`, "/f"], { stdio: "ignore" });
  } catch {
    /* no link prompt ran */
  }
  if (process.argv.includes("--clean")) rmSync(root, { recursive: true, force: true });
}

await main();
