// A minimal Chrome DevTools Protocol client over a single browser WebSocket.
//
// Pages are attached with `flatten: true`, so every page shares the browser
// connection and is addressed by its `sessionId`. Only the handful of commands
// the Maps collector needs are wrapped; anything else goes through `send`.

import WebSocket from "ws";

export class CdpError extends Error {
  override name = "CdpError";
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string };
type Handler = (params: any, sessionId?: string) => void;

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<Handler>>();
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => this.dispatch(String(data)));
    socket.on("close", () => this.shutdown());
    socket.on("error", () => this.shutdown());
  }

  /** Opens the browser-level DevTools WebSocket (`ws://127.0.0.1:<port>/devtools/browser/<id>`). */
  static connect(wsUrl: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      // Page snapshots and response bodies can be large; lift ws's 100 MiB default cap.
      const socket = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
      const onError = (error: Error) => {
        socket.removeAllListeners();
        // Bun's ws emits "error" twice for a dropped handshake. With no
        // listener left, the second one is thrown as an uncaught exception
        // and takes the whole process down, so keep one that ignores it.
        socket.on("error", () => {});
        socket.terminate();
        reject(new CdpError(`cannot connect to the browser at ${wsUrl}: ${error.message}`));
      };
      socket.once("error", onError);
      socket.once("open", () => {
        socket.off("error", onError);
        resolve(new CdpConnection(socket));
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send<T>(method: string, params?: object, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError("connection lost"));
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
      this.socket.send(message, (error) => {
        if (!error || !this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new CdpError("connection lost"));
      });
    });
  }

  /** Subscribes to a CDP event; returns the unsubscribe function. */
  on(method: string, handler: Handler): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  close(): void {
    if (this.closed) return;
    this.shutdown();
    this.socket.close();
  }

  private dispatch(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown; sessionId?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // The browser only sends JSON; ignore anything else rather than crash the run.
    }
    if (typeof msg.id === "number") {
      const call = this.pending.get(msg.id);
      if (!call) return;
      this.pending.delete(msg.id);
      if (msg.error) call.reject(new CdpError(`${call.method}: ${msg.error.message ?? "unknown error"}`));
      else call.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method !== "string") return;
    const set = this.handlers.get(msg.method);
    if (!set) return;
    for (const handler of [...set]) handler(msg.params ?? {}, msg.sessionId);
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new CdpError("connection lost");
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
  }
}

export type NetworkHandlers = {
  request(id: string, url: string): void;
  /** Called once the response body has fully arrived, so `responseBody(id)` is safe to call. */
  response(id: string, url: string, status: number, mimeType: string): void;
  failed(id: string): void;
};

const LOAD_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One tab in its own browser context: separate cookies and cache from every other page. */
export class CdpPage {
  private readonly unsubscribers = new Set<() => void>();
  private closed = false;

  private constructor(
    private readonly conn: CdpConnection,
    private readonly browserContextId: string,
    private readonly targetId: string,
    private readonly sessionId: string,
  ) {}

  static async open(conn: CdpConnection, opts: { userAgent: string; lang: string }): Promise<CdpPage> {
    const { browserContextId } = await conn.send<{ browserContextId: string }>("Target.createBrowserContext", {
      disposeOnDetach: true,
    });
    const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
      browserContextId,
    });
    const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const page = new CdpPage(conn, browserContextId, targetId, sessionId);
    try {
      await Promise.all([
        page.cmd("Page.enable"),
        page.cmd("Runtime.enable"),
        page.cmd("Network.enable"),
        page.cmd("Network.setUserAgentOverride", { userAgent: opts.userAgent, acceptLanguage: opts.lang }),
      ]);
    } catch (error) {
      await page.close();
      throw error;
    }
    return page;
  }

  /** Navigates and waits for the load event (at most 30 s; callers wait for their own readiness signal). */
  async navigate(url: string): Promise<void> {
    let loaded!: () => void;
    const load = new Promise<void>((resolve) => (loaded = resolve));
    const off = this.subscribe("Page.loadEventFired", () => loaded());
    try {
      const result = await this.cmd<{ errorText?: string; loaderId?: string }>("Page.navigate", { url });
      if (result.errorText) throw new CdpError(`navigation to ${url} failed: ${result.errorText}`);
      // Same-document navigations (hash changes) have no loader and fire no load event.
      if (!result.loaderId) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([load, new Promise<void>((resolve) => (timer = setTimeout(resolve, LOAD_TIMEOUT_MS)))]);
      clearTimeout(timer);
    } finally {
      off();
    }
  }

  /** Evaluates an expression in the page and returns its JSON value; awaits returned promises. */
  async eval<T>(expr: string): Promise<T> {
    const result = await this.cmd<{
      result: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "exception";
      throw new CdpError(`page script failed: ${detail}`);
    }
    return result.result.value as T;
  }

  /**
   * Polls `expr` until it is truthy. Evaluation errors count as "not yet": the
   * page's script context is torn down and rebuilt during navigations.
   */
  async waitFor(expr: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (await this.eval<unknown>(expr)) return true;
      } catch (error) {
        if (this.conn.isClosed) throw error;
      }
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await sleep(Math.min(POLL_INTERVAL_MS, left));
    }
  }

  /** The page's current URL, read from the target so it is valid mid-navigation too. */
  async url(): Promise<string> {
    const { targetInfo } = await this.conn.send<{ targetInfo: { url: string } }>("Target.getTargetInfo", {
      targetId: this.targetId,
    });
    return targetInfo.url;
  }

  async setCookie(name: string, value: string, domain: string): Promise<void> {
    const { success } = await this.cmd<{ success?: boolean }>("Network.setCookie", {
      name,
      value,
      domain,
      path: "/",
      secure: true,
    });
    // Older browsers return no `success` field; only an explicit false is a failure.
    if (success === false) throw new CdpError(`the browser refused cookie ${name} for ${domain}`);
  }

  onNetwork(h: NetworkHandlers): () => void {
    const responses = new Map<string, { url: string; status: number; mimeType: string }>();
    const offs = [
      this.subscribe("Network.requestWillBeSent", (p: { requestId: string; request: { url: string } }) =>
        h.request(p.requestId, p.request.url),
      ),
      this.subscribe(
        "Network.responseReceived",
        (p: { requestId: string; response: { url: string; status: number; mimeType: string } }) =>
          responses.set(p.requestId, { url: p.response.url, status: p.response.status, mimeType: p.response.mimeType }),
      ),
      this.subscribe("Network.loadingFinished", (p: { requestId: string }) => {
        const r = responses.get(p.requestId);
        if (!r) return;
        responses.delete(p.requestId);
        h.response(p.requestId, r.url, r.status, r.mimeType);
      }),
      this.subscribe("Network.loadingFailed", (p: { requestId: string }) => {
        responses.delete(p.requestId);
        h.failed(p.requestId);
      }),
    ];
    return () => {
      for (const off of offs) off();
      responses.clear();
    };
  }

  async responseBody(requestId: string): Promise<string> {
    const { body, base64Encoded } = await this.cmd<{ body: string; base64Encoded: boolean }>(
      "Network.getResponseBody",
      { requestId },
    );
    return base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
  }

  /** Closes the tab and discards its browser context. Safe to call twice or after the browser exited. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.unsubscribers) off();
    this.unsubscribers.clear();
    if (this.conn.isClosed) return;
    await this.conn.send("Target.closeTarget", { targetId: this.targetId }).catch(() => undefined);
    // The target is gone either way; a context that cannot be disposed dies with the browser.
    await this.conn
      .send("Target.disposeBrowserContext", { browserContextId: this.browserContextId })
      .catch(() => undefined);
  }

  private cmd<T>(method: string, params?: object): Promise<T> {
    return this.conn.send<T>(method, params, this.sessionId);
  }

  /** Subscribes to an event for this page's session only. */
  private subscribe(method: string, handler: (params: any) => void): () => void {
    const off = this.conn.on(method, (params, sessionId) => {
      if (sessionId === this.sessionId) handler(params);
    });
    const remove = () => {
      off();
      this.unsubscribers.delete(remove);
    };
    this.unsubscribers.add(remove);
    return remove;
  }
}
