import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { CdpConnection, CdpError, CdpPage } from "../src/core/sources/browser/cdp.js";

type Incoming = { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
type Reply = { result?: unknown; error?: { code: number; message: string } } | "hold";

/**
 * A scripted stand-in for the browser's DevTools endpoint. `answer` decides the
 * reply to each command; returning "hold" leaves the command unanswered.
 */
async function fakeBrowser(answer: (msg: Incoming, socket: WebSocket) => Reply = () => ({ result: {} })) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const received: Incoming[] = [];
  const sockets: WebSocket[] = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => {
      const msg = JSON.parse(String(data)) as Incoming;
      received.push(msg);
      const reply = answer(msg, socket);
      if (reply === "hold") return;
      socket.send(JSON.stringify({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), ...reply }));
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/test`,
    received,
    emit(method: string, params: unknown, sessionId?: string) {
      for (const s of sockets) s.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
    },
    async stop() {
      for (const s of sockets) s.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(answer?: Parameters<typeof fakeBrowser>[0]) {
  const browser = await fakeBrowser(answer);
  cleanups.push(() => browser.stop());
  const conn = await CdpConnection.connect(browser.url);
  cleanups.push(() => conn.close());
  return { browser, conn };
}

describe("CdpConnection", () => {
  it("resolves send with the result whose id matches the command", async () => {
    const { conn } = await setup((msg) => ({ result: { echo: msg.method, id: msg.id } }));
    const [a, b] = await Promise.all([
      conn.send<{ echo: string }>("Browser.getVersion"),
      conn.send<{ echo: string }>("Target.getTargets"),
    ]);
    expect(a.echo).toBe("Browser.getVersion");
    expect(b.echo).toBe("Target.getTargets");
  });

  it("sends params and sessionId with the command", async () => {
    const { browser, conn } = await setup();
    await conn.send("Runtime.evaluate", { expression: "1" }, "S1");
    expect(browser.received[0]).toMatchObject({ method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "S1" });
  });

  it("rejects send with a CdpError when the browser answers with an error", async () => {
    const { conn } = await setup(() => ({ error: { code: -32000, message: "No target with given id" } }));
    await expect(conn.send("Target.closeTarget", { targetId: "x" })).rejects.toThrow(/No target with given id/);
    await expect(conn.send("Target.closeTarget", { targetId: "x" })).rejects.toBeInstanceOf(CdpError);
  });

  it("delivers events to `on` handlers with their sessionId, until unsubscribed", async () => {
    const { browser, conn } = await setup();
    const seen: [unknown, string | undefined][] = [];
    const off = conn.on("Network.requestWillBeSent", (params, sessionId) => seen.push([params, sessionId]));
    browser.emit("Network.requestWillBeSent", { requestId: "1" }, "S1");
    browser.emit("Page.loadEventFired", {});
    await conn.send("Browser.getVersion"); // round-trip so earlier events have arrived
    off();
    browser.emit("Network.requestWillBeSent", { requestId: "2" });
    await conn.send("Browser.getVersion");
    expect(seen).toEqual([[{ requestId: "1" }, "S1"]]);
  });

  it("rejects a pending send with 'connection lost' when the browser goes away", async () => {
    const { browser, conn } = await setup(() => "hold");
    const pending = conn.send("Page.navigate", { url: "https://example.com" });
    await browser.stop();
    await expect(pending).rejects.toBeInstanceOf(CdpError);
    await expect(pending).rejects.toThrow("connection lost");
  });

  it("rejects pending and later sends after close()", async () => {
    const { conn } = await setup(() => "hold");
    const pending = conn.send("Page.navigate");
    conn.close();
    await expect(pending).rejects.toThrow("connection lost");
    await expect(conn.send("Browser.getVersion")).rejects.toThrow("connection lost");
  });

  it("fails to connect with a CdpError when nothing listens", async () => {
    const browser = await fakeBrowser();
    const url = browser.url;
    await browser.stop();
    await expect(CdpConnection.connect(url)).rejects.toBeInstanceOf(CdpError);
  });

  it("rejects with a CdpError and raises nothing else when the handshake drops, under Bun", () => {
    // Vitest runs on Node, where ws emits one "error". Bun's ws emits a second
    // one, which crashed `serve` when no listener was left to take it.
    const dir = mkdtempSync(path.join(tmpdir(), "business-finder-cdp-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const script = path.join(dir, "dropped-handshake.ts");
    const cdpModule = new URL("../src/core/sources/browser/cdp.ts", import.meta.url).href;
    writeFileSync(
      script,
      [
        `import { createServer } from "node:net";`,
        `import { CdpConnection, CdpError } from ${JSON.stringify(cdpModule)};`,
        `process.on("uncaughtException", (e) => { console.log("uncaught: " + String(e?.message ?? e)); process.exitCode = 4; });`,
        `process.on("unhandledRejection", (e) => { console.log("unhandled: " + String(e)); process.exitCode = 4; });`,
        `const server = createServer((socket) => socket.destroy());`,
        `await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));`,
        `try {`,
        `  await CdpConnection.connect("ws://127.0.0.1:" + server.address().port + "/devtools/browser/x");`,
        `  console.log("connected");`,
        `} catch (e) {`,
        `  console.log(e instanceof CdpError ? "CdpError" : "other: " + e);`,
        `}`,
        `await new Promise((resolve) => setTimeout(resolve, 300));`,
        `server.close();`,
      ].join("\n"),
    );
    const r = spawnSync("bun", [script], { encoding: "utf8", timeout: 30_000 });
    expect(r.stdout.trim()).toBe("CdpError");
    expect(r.status).toBe(0);
  });
});

/** Answers the commands CdpPage.open issues, plus a few per-test extras. */
function pageAnswers(extra: (msg: Incoming) => Reply | undefined = () => undefined) {
  return (msg: Incoming): Reply => {
    const custom = extra(msg);
    if (custom) return custom;
    switch (msg.method) {
      case "Target.createBrowserContext":
        return { result: { browserContextId: "CTX" } };
      case "Target.createTarget":
        return { result: { targetId: "T1" } };
      case "Target.attachToTarget":
        return { result: { sessionId: "S1" } };
      default:
        return { result: {} };
    }
  };
}

describe("CdpPage", () => {
  const opts = { userAgent: "Mozilla/5.0 Chrome/131.0.0.0", lang: "en" };

  it("opens a page in its own browser context with the user agent and language applied", async () => {
    const { browser, conn } = await setup(pageAnswers());
    await CdpPage.open(conn, opts);
    const methods = browser.received.map((m) => m.method);
    expect(methods.slice(0, 3)).toEqual(["Target.createBrowserContext", "Target.createTarget", "Target.attachToTarget"]);
    expect(browser.received[1]!.params).toMatchObject({ browserContextId: "CTX" });
    expect(browser.received[2]!.params).toMatchObject({ targetId: "T1", flatten: true });
    const ua = browser.received.find((m) => m.method === "Network.setUserAgentOverride")!;
    expect(ua.sessionId).toBe("S1");
    expect(ua.params).toMatchObject({ userAgent: opts.userAgent, acceptLanguage: "en" });
    expect(browser.received.find((m) => m.method === "Network.enable")?.sessionId).toBe("S1");
  });

  it("evaluates expressions by value and surfaces page exceptions as CdpError", async () => {
    const { conn } = await setup(
      pageAnswers((msg) => {
        if (msg.method !== "Runtime.evaluate") return undefined;
        if (msg.params?.expression === "boom()")
          return { result: { result: { type: "object" }, exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: boom is not defined" } } } };
        return { result: { result: { type: "number", value: 42 } } };
      }),
    );
    const page = await CdpPage.open(conn, opts);
    expect(await page.eval<number>("6 * 7")).toBe(42);
    await expect(page.eval("boom()")).rejects.toThrow(/boom is not defined/);
  });

  it("waitFor returns true once the expression is truthy and false on timeout", async () => {
    let calls = 0;
    const { conn } = await setup(
      pageAnswers((msg) => {
        if (msg.method !== "Runtime.evaluate") return undefined;
        if (msg.params?.expression === "never") return { result: { result: { type: "boolean", value: false } } };
        calls++;
        return { result: { result: { type: "boolean", value: calls >= 3 } } };
      }),
    );
    const page = await CdpPage.open(conn, opts);
    expect(await page.waitFor("ready", 5_000)).toBe(true);
    const started = Date.now();
    expect(await page.waitFor("never", 300)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reports only its own session's network events, with the response once loading finished", async () => {
    const { browser, conn } = await setup(pageAnswers());
    const page = await CdpPage.open(conn, opts);
    const log: string[] = [];
    const off = page.onNetwork({
      request: (id, url) => log.push(`request ${id} ${url}`),
      response: (id, url, status, mime) => log.push(`response ${id} ${url} ${status} ${mime}`),
      failed: (id) => log.push(`failed ${id}`),
    });
    browser.emit("Network.requestWillBeSent", { requestId: "r1", request: { url: "https://a.test/x" } }, "S1");
    browser.emit("Network.requestWillBeSent", { requestId: "other", request: { url: "https://b.test/" } }, "S2");
    browser.emit("Network.responseReceived", { requestId: "r1", response: { url: "https://a.test/x", status: 429, mimeType: "text/html" } }, "S1");
    expect(log).toHaveLength(0); // nothing delivered synchronously
    browser.emit("Network.loadingFinished", { requestId: "r1" }, "S1");
    browser.emit("Network.requestWillBeSent", { requestId: "r2", request: { url: "https://a.test/y" } }, "S1");
    browser.emit("Network.loadingFailed", { requestId: "r2" }, "S1");
    await conn.send("Browser.getVersion");
    off();
    browser.emit("Network.requestWillBeSent", { requestId: "r3", request: { url: "https://a.test/z" } }, "S1");
    await conn.send("Browser.getVersion");
    expect(log).toEqual([
      "request r1 https://a.test/x",
      "response r1 https://a.test/x 429 text/html",
      "request r2 https://a.test/y",
      "failed r2",
    ]);
  });

  it("decodes base64 response bodies", async () => {
    const { conn } = await setup(
      pageAnswers((msg) =>
        msg.method === "Network.getResponseBody"
          ? { result: { body: Buffer.from(")]}'\n[1]", "utf8").toString("base64"), base64Encoded: true } }
          : undefined,
      ),
    );
    const page = await CdpPage.open(conn, opts);
    expect(await page.responseBody("r1")).toBe(")]}'\n[1]");
  });

  it("rejects navigate when the browser reports a navigation error", async () => {
    const { conn } = await setup(
      pageAnswers((msg) => (msg.method === "Page.navigate" ? { result: { frameId: "F", errorText: "net::ERR_NAME_NOT_RESOLVED" } } : undefined)),
    );
    const page = await CdpPage.open(conn, opts);
    await expect(page.navigate("https://nowhere.invalid/")).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
  });

  it("navigate resolves when the page's load event fires", async () => {
    const { browser, conn } = await setup(
      pageAnswers((msg) => {
        if (msg.method !== "Page.navigate") return undefined;
        setTimeout(() => browser.emit("Page.loadEventFired", { timestamp: 1 }, "S1"), 20);
        return { result: { frameId: "F", loaderId: "L" } };
      }),
    );
    const page = await CdpPage.open(conn, opts);
    await page.navigate("https://example.com/");
  });

  it("close disposes the target and its browser context", async () => {
    const { browser, conn } = await setup(pageAnswers());
    const page = await CdpPage.open(conn, opts);
    await page.close();
    const methods = browser.received.map((m) => m.method);
    expect(methods).toContain("Target.closeTarget");
    expect(methods.at(-1)).toBe("Target.disposeBrowserContext");
    expect(browser.received.at(-1)!.params).toMatchObject({ browserContextId: "CTX" });
  });
});
