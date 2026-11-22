import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureFileError } from "../src/core/sources/fixture-file.js";
import { findFreePort, startServer, WEB_DIST_DIR } from "../src/server/serve.js";
import { VERSION } from "../src/version.js";
import { RUN20_BATCH, RUN20_SITES_DIR } from "./fixtures/run20.js";

let dir: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "business-finder-serve-"));
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  rmSync(dir, { recursive: true, force: true });
});

/** Holds `port` on 127.0.0.1 until the test ends; resolves false if it is already taken. */
function hold(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server: Server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
      resolve(true);
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

function fixtureFile(): string {
  const file = path.join(dir, "fixture.json");
  writeFileSync(
    file,
    JSON.stringify({ geocode: { lat: 2.3, lon: 102.2, countryCode: "MY" }, batches: [RUN20_BATCH], sitesDir: RUN20_SITES_DIR }),
  );
  return file;
}

async function start(opts: Partial<Parameters<typeof startServer>[0]> = {}) {
  const server = await startServer({
    open: false,
    staticDir: path.join(dir, "web"),
    jobsDir: path.join(dir, "jobs"),
    source: "fixture",
    fixtureFile: fixtureFile(),
    ...opts,
  });
  cleanups.push(() => server.close());
  return server;
}

describe("findFreePort", () => {
  it("returns 8081 when 8080 is held (or the next free port after it)", async () => {
    await hold(8080);
    const nextWasFree = await isFree(8081);
    const port = await findFreePort(8080);
    expect(port).toBeGreaterThan(8080);
    if (nextWasFree) expect(port).toBe(8081);
    expect(await isFree(port)).toBe(true);
  });

  it("returns the start port when it is free", async () => {
    const free = await findFreePort(18_000);
    expect(await findFreePort(free)).toBe(free);
  });
});

describe("startServer", () => {
  it("moves to the next free port when the asked one is taken, and answers there", async () => {
    const base = await findFreePort(18_100);
    expect(await hold(base)).toBe(true);
    const server = await start({ port: base });
    expect(server.port).toBeGreaterThan(base);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    const res = await fetch(`${server.url}/api/v1/health`);
    expect(await res.json()).toEqual({ ok: true, version: VERSION, pid: process.pid });
  });

  it("closes twice without an error and frees the port", async () => {
    const server = await startServer({
      port: await findFreePort(18_150),
      open: false,
      staticDir: path.join(dir, "web"),
      jobsDir: path.join(dir, "jobs"),
      source: "fixture",
      fixtureFile: fixtureFile(),
    });
    await fetch(`${server.url}/api/v1/health`);
    await expect(server.close()).resolves.toBeUndefined();
    await expect(server.close()).resolves.toBeUndefined();
    expect(await isFree(server.port)).toBe(true);
  });

  it("closes twice without an error under Bun", () => {
    // Vitest runs on Node; Bun stops the listener inside closeAllConnections(),
    // so the double close is checked in a spawned Bun process too.
    mkdirSync(path.join(dir, "web"));
    const script = path.join(dir, "close-twice.ts");
    const serveModule = new URL("../src/server/serve.ts", import.meta.url).href;
    writeFileSync(
      script,
      [
        `import { findFreePort, startServer } from ${JSON.stringify(serveModule)};`,
        `const server = await startServer({ port: await findFreePort(18_160), open: false,`,
        `  staticDir: ${JSON.stringify(path.join(dir, "web"))}, jobsDir: ${JSON.stringify(path.join(dir, "jobs"))},`,
        `  source: "fixture", fixtureFile: ${JSON.stringify(fixtureFile())} });`,
        `const res = await fetch(server.url + "/api/v1/health");`,
        `if (res.status !== 200) process.exit(3);`,
        `await server.close();`,
        `await server.close();`,
        `console.log("closed twice");`,
      ].join("\n"),
    );
    const r = spawnSync("bun", [script], { encoding: "utf8", timeout: 30_000 });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("closed twice");
    expect(r.status).toBe(0);
  });

  it("listens on 127.0.0.1 only", async () => {
    const server = await start({ port: await findFreePort(18_200) });
    expect(server.address).toBe("127.0.0.1");
  });

  it("rejects a request whose Host is not localhost", async () => {
    const server = await start({ port: await findFreePort(18_300) });
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: server.port, path: "/api/v1/health", headers: { Host: "evil.test" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("serves the web UI from the static folder", async () => {
    const web = path.join(dir, "web");
    mkdirSync(web);
    writeFileSync(path.join(web, "index.html"), "<!doctype html><title>Business Finder</title>");
    const server = await start({ port: await findFreePort(18_400), staticDir: web });
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Business Finder</title>");
  });

  it("says how to build the web UI when the static folder has no page", async () => {
    const server = await start({ port: await findFreePort(18_450), staticDir: path.join(dir, "not-built") });
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("bun run build:web");
    // The API is unaffected.
    expect((await fetch(`${server.url}/api/v1/health`)).status).toBe(200);
  });

  it("defaults the static folder to the built web UI in web/dist", () => {
    expect(path.relative(process.cwd(), WEB_DIST_DIR)).toBe(path.join("web", "dist"));
  });

  it("opens the browser on the chosen port when asked", async () => {
    const opened: string[] = [];
    const server = await start({ port: await findFreePort(18_500), open: true, openUrl: async (url) => void opened.push(url) });
    expect(opened).toEqual([server.url]);
  });

  it("fails at startup when the fixture file cannot be read", async () => {
    await expect(
      startServer({
        open: false,
        staticDir: dir,
        jobsDir: path.join(dir, "jobs"),
        source: "fixture",
        fixtureFile: path.join(dir, "missing.json"),
      }),
    ).rejects.toBeInstanceOf(FixtureFileError);
  });

  it("runs a job end to end over HTTP", async () => {
    const server = await start({ port: await findFreePort(18_600) });
    const created = await fetch(`${server.url}/api/v1/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.url },
      body: JSON.stringify({ keyword: "souvenir shop", city: "Melaka" }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const deadline = Date.now() + 20_000;
    let status = "";
    while (Date.now() < deadline) {
      status = ((await (await fetch(`${server.url}/api/v1/jobs/${id}`)).json()) as { status: string }).status;
      if (status === "done" || status === "failed") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(status).toBe("done");
    const csv = new Uint8Array(await (await fetch(`${server.url}/api/v1/jobs/${id}/download`)).arrayBuffer());
    expect([...csv.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});
