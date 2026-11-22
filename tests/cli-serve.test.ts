import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, parseCli } from "../src/cli/main.js";
import { findFreePort } from "../src/server/serve.js";
import { VERSION } from "../src/version.js";

const MAIN = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const RUNNING = /^✓ Business Finder running at http:\/\/127\.0\.0\.1:(\d+)$/m;

let dir: string;
let env: NodeJS.ProcessEnv;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "business-finder-cli-serve-"));
  // Job folders go under the per-user data folder; point it at the test folder.
  env = { ...process.env, LOCALAPPDATA: dir, XDG_DATA_HOME: dir };
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  rmSync(dir, { recursive: true, force: true });
});

/** Holds `port` on 127.0.0.1 until the test ends. */
function hold(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
      resolve();
    });
  });
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** Spawns a Bun process and resolves with its port once it prints the running line. */
function spawnUntilRunning(args: string[]): Promise<{ child: ChildProcess; port: number; output: () => string; exited: Promise<number | null> }> {
  const child = spawn("bun", args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  cleanups.push(async () => {
    // Windows keeps the test folder locked until the child has exited.
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no running line within 30 s:\n${out}\n${err}`)), 30_000);
    child.stderr!.on("data", (d) => (err += String(d)));
    child.stdout!.on("data", (d) => {
      out += String(d);
      const m = out.match(RUNNING);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]), output: () => out + err, exited });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code} before the running line:\n${out}\n${err}`));
    });
  });
}

describe("parseCli serve", () => {
  it("defaults to port 8080 and opening the browser", () => {
    expect(parseCli(["serve"])).toEqual({ command: "serve", port: 8080, open: true });
  });

  it("starts the page on a bare business-finder, reusing a running server", () => {
    expect(parseCli([])).toEqual({ command: "serve", port: 8080, open: true, reuse: true });
  });

  it("still prints usage on --help", async () => {
    const out: string[] = [];
    const code = await main(["--help"], { out: (l) => out.push(l), err: () => {}, env, cwd: dir, now: () => new Date() });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Usage:");
  });

  it("reads --port and --no-open", () => {
    expect(parseCli(["serve", "--port", "9000", "--no-open"])).toEqual({ command: "serve", port: 9000, open: false });
    expect(parseCli(["serve", "--port", "0"])).toEqual({ command: "serve", port: 0, open: true });
  });

  it.each([[["serve", "--port", "http"]], [["serve", "--port", "70000"]], [["serve", "extra"]], [["serve", "--bogus"]]])(
    "rejects %j with the usage and exit 2",
    async (argv) => {
      const err: string[] = [];
      const code = await main(argv, { out: () => {}, err: (l) => err.push(l), env, cwd: dir, now: () => new Date() });
      expect(code).toBe(2);
      expect(err.join("\n")).toContain("Usage:");
    },
  );
});

describe("business-finder serve", () => {
  it("a bare business-finder opens the page of the server already running instead of starting another", async () => {
    const { port } = await spawnUntilRunning([MAIN, "serve", "--no-open", "--port", String(await findFreePort(18_650))]);
    const out: string[] = [];
    const opened: string[] = [];
    const code = await main([], {
      out: (l) => out.push(l),
      err: () => {},
      env,
      cwd: dir,
      now: () => new Date(),
      openUrl: async (url) => {
        opened.push(url);
      },
      untilStopped: () => Promise.reject(new Error("must not start a second server")),
    });
    expect(code).toBe(0);
    expect(out).toEqual([`✓ Business Finder is already running at http://127.0.0.1:${port}`]);
    expect(opened).toEqual([`http://127.0.0.1:${port}`]);
  });

  it("moves to the next free port when the asked one is held and answers health there", async () => {
    const held = await findFreePort(18_600);
    await hold(held);
    const { port, output } = await spawnUntilRunning([MAIN, "serve", "--no-open", "--port", String(held)]);
    expect(port).toBeGreaterThan(held);
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, version: VERSION, pid: expect.any(Number) });
    expect(output()).toMatch(new RegExp(`port ${held} was in use`));
  });

  it("stops cleanly, exits 0 and frees the port when asked to stop", async () => {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    const out: string[] = [];
    const err: string[] = [];
    const exit = main(["serve", "--no-open", "--port", String(await findFreePort(18_700))], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env,
      cwd: dir,
      now: () => new Date(),
      untilStopped: () => stopped,
    });
    while (!out.some((l) => RUNNING.test(l))) await new Promise((r) => setTimeout(r, 20));
    const port = Number(out.find((l) => RUNNING.test(l))!.match(RUNNING)![1]);
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status).toBe(200);
    stop();
    expect(await exit).toBe(0);
    expect(err).toEqual([]);
    expect(out.at(-1)).toBe("  stopped");
    expect(await isFree(port)).toBe(true);
  });

  it("exits 1 with a plain message when the server cannot start", async () => {
    // A file where the per-user data folder should be stops the job store.
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "");
    const err: string[] = [];
    const code = await main(["serve", "--no-open", "--port", String(await findFreePort(18_800))], {
      out: () => {},
      err: (l) => err.push(l),
      env: { ...env, LOCALAPPDATA: blocker, XDG_DATA_HOME: blocker },
      cwd: dir,
      now: () => new Date(),
      untilStopped: () => new Promise(() => {}),
    });
    expect(code).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^Could not start the server: \S+/);
  });

  it("says how to build the web UI when it is missing", async () => {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    const out: string[] = [];
    const exit = main(["serve", "--no-open", "--port", String(await findFreePort(18_750))], {
      out: (l) => out.push(l),
      err: () => {},
      env,
      cwd: dir,
      now: () => new Date(),
      untilStopped: () => stopped,
      webDir: path.join(dir, "not-built"),
    });
    while (!out.some((l) => RUNNING.test(l))) await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(await exit).toBe(0);
    expect(out.join("\n")).toContain("bun run build:web");
  });

  it("exits 0 on SIGINT with no unhandled rejection under Bun", async () => {
    // Ctrl-C reaches the process as SIGINT. Windows cannot deliver a catchable
    // SIGINT to another process, so the child raises it on itself.
    const script = path.join(dir, "serve-sigint.ts");
    writeFileSync(
      script,
      [
        `import { main } from ${JSON.stringify(new URL("../src/cli/main.ts", import.meta.url).href)};`,
        `process.on("unhandledRejection", (e) => { console.error("unhandled rejection", e); process.exit(9); });`,
        `const code = main(["serve", "--no-open", "--port", "0"], {`,
        `  out: (l) => { console.log(l); if (l.startsWith("✓ Business Finder running")) setTimeout(() => process.emit("SIGINT"), 50); },`,
        `  err: (l) => console.error(l), env: process.env, cwd: process.cwd(), now: () => new Date() });`,
        `process.exitCode = await code;`,
      ].join("\n"),
    );
    const { exited, output } = await spawnUntilRunning([script]);
    expect(await exited).toBe(0);
    expect(output()).toContain("  stopped");
    expect(output()).not.toContain("unhandled");
  });

  it.skipIf(process.platform === "win32")("exits 0 when the serve process receives SIGINT", async () => {
    const { child, exited, output } = await spawnUntilRunning([MAIN, "serve", "--no-open", "--port", "0"]);
    child.kill("SIGINT");
    expect(await exited).toBe(0);
    expect(output()).toContain("  stopped");
  });
});
