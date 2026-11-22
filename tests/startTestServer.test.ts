import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunningServer, ServerOptions } from "../src/server/serve.js";
import { FETCH_BAD_PORTS, startTestServer } from "./helpers/startTestServer.js";
import { RUN20_BATCH, RUN20_SITES_DIR } from "./fixtures/run20.js";

function fakeStarter(ports: number[]) {
  const closed: number[] = [];
  const requestedPorts: Array<number | undefined> = [];
  let index = 0;
  const start = async (opts: ServerOptions): Promise<RunningServer> => {
    requestedPorts.push(opts.port);
    const port = ports[index++];
    if (port === undefined) throw new Error("unexpected extra startServer call");
    return {
      url: `http://127.0.0.1:${port}`,
      port,
      address: "127.0.0.1",
      close: async () => {
        closed.push(port);
      },
    };
  };
  return { start, closed, requestedPorts };
}

const BASE_OPTS: Omit<ServerOptions, "port"> = { open: false, source: "fixture", fixtureFile: "unused.json" };

describe("startTestServer", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  it("retries when the first bound ports are on the Fetch bad-port list, closes them, and returns a good port", async () => {
    const { start, closed, requestedPorts } = fakeStarter([5060, 6667, 10080, 12_345]);
    const server = await startTestServer(BASE_OPTS, start);
    expect(server.port).toBe(12_345);
    expect(server.url).toBe("http://127.0.0.1:12345");
    expect(closed).toEqual([5060, 6667, 10080]);
    expect(requestedPorts).toEqual([0, 0, 0, 0]);
  });

  it("returns the first server without closing it when the bound port is safe", async () => {
    const { start, closed, requestedPorts } = fakeStarter([14_123]);
    const server = await startTestServer(BASE_OPTS, start);
    expect(server.port).toBe(14_123);
    expect(closed).toEqual([]);
    expect(requestedPorts).toEqual([0]);
  });

  it("gives up with a clear error after N bad-port attempts and closes every server it opened", async () => {
    const { start, closed } = fakeStarter([5060, 6000, 6669, 12_345]);
    await expect(startTestServer(BASE_OPTS, start, 3)).rejects.toThrow(
      "Could not start test server off the Fetch bad-port list after 3 attempts (got: 5060, 6000, 6669).",
    );
    expect(closed).toEqual([5060, 6000, 6669]);
  });

  it("rejects a non-positive attempt limit", async () => {
    const { start } = fakeStarter([]);
    await expect(startTestServer(BASE_OPTS, start, 0)).rejects.toThrow(/maxAttempts must be a positive integer/);
  });

  it("includes the full Fetch bad-port set boundaries and leaves normal ports allowed", () => {
    for (const bad of [0, 1, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]) {
      expect(FETCH_BAD_PORTS.has(bad)).toBe(true);
    }
    for (const good of [80, 443, 8080, 15_173, 18_080]) {
      expect(FETCH_BAD_PORTS.has(good)).toBe(false);
    }
    expect(FETCH_BAD_PORTS.size).toBe(83);
  });

  it("starts a real server on a Fetch-safe port that answers fetch", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "business-finder-test-server-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const fixtureFile = path.join(dir, "fixture.json");
    writeFileSync(
      fixtureFile,
      JSON.stringify({ geocode: { lat: 2.3, lon: 102.2, countryCode: "MY" }, batches: [RUN20_BATCH], sitesDir: RUN20_SITES_DIR }),
    );
    const server = await startTestServer({
      open: false,
      staticDir: path.join(dir, "no-web"),
      jobsDir: path.join(dir, "jobs"),
      source: "fixture",
      fixtureFile,
    });
    cleanups.push(() => server.close());
    expect(FETCH_BAD_PORTS.has(server.port)).toBe(false);
    const res = await fetch(`${server.url}/api/v1/health`);
    expect(res.status).toBe(200);
  });
});
