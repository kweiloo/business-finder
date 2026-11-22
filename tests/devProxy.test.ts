import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobStore } from "../src/jobs/store.js";
import type { Runner } from "../src/jobs/worker.js";
import { createApp } from "../src/server/app.js";
import { dropOwnOrigin } from "../web/devProxy.js";

/** The outgoing proxy request: headers as `http-proxy` copies them from the browser's request. */
function proxyRequest(headers: Record<string, string>) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    getHeader: (name: string) => h.get(name.toLowerCase()),
    removeHeader: (name: string) => void h.delete(name.toLowerCase()),
    headers: () => Object.fromEntries(h),
  };
}

let dir: string;
let store: JobStore;
const idle: Runner = () => new Promise(() => {});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "business-finder-proxy-"));
  store = new JobStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Sends a POST as the browser would to the dev server at `devHost`, applies
 * the proxy hook, and replays what the proxy forwards to the API.
 * `changeOrigin` sets the forwarded Host to the API's own address.
 */
async function forward(origin: string | undefined, devHost = "localhost:5173") {
  const browser = { host: devHost, "content-type": "application/json", ...(origin ? { origin } : {}) };
  const out = proxyRequest({ ...browser, host: "127.0.0.1:8080" });
  dropOwnOrigin(out, { headers: browser });
  const res = await createApp({ store, runner: idle }).request("/api/v1/jobs", {
    method: "POST",
    headers: out.headers(),
    body: JSON.stringify({ keyword: "cafe", city: "Ipoh" }),
  });
  return { status: res.status, sent: out.headers() };
}

describe("dev proxy Origin handling", () => {
  it.each([
    ["http://localhost:5173", "localhost:5173"],
    ["http://127.0.0.1:5173", "127.0.0.1:5173"],
    ["HTTP://LOCALHOST:5173", "localhost:5173"],
    ["http://localhost:5190", "localhost:5190"], // Vite on another port
  ])("drops the dev server's own Origin %s so the web UI reaches the API", async (origin, devHost) => {
    const { status, sent } = await forward(origin, devHost);
    expect(sent.origin).toBeUndefined();
    expect(status).toBe(201);
  });

  it.each([
    ["https://evil.test", "localhost:5173"],
    ["http://localhost:5174", "localhost:5173"],
    ["http://127.0.0.1:5173", "localhost:5173"],
    ["http://localhost:8080.evil.test", "localhost:5173"],
    ["null", "localhost:5173"],
    ["https://localhost:5173", "localhost:5173"],
    // DNS rebinding: a page on evil.test whose name now resolves to 127.0.0.1.
    ["http://evil.test:5173", "evil.test:5173"],
  ])("passes a foreign Origin %s (dev Host %s) through, and the API refuses it with 403", async (origin, devHost) => {
    const { status, sent } = await forward(origin, devHost);
    expect(sent.origin).toBe(origin);
    expect(status).toBe(403);
    expect(store.list()).toHaveLength(0);
  });

  it("leaves a request without an Origin alone", async () => {
    const { status, sent } = await forward(undefined);
    expect(sent.origin).toBeUndefined();
    expect(status).toBe(201);
  });
});
