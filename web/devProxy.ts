// The API answers only requests whose Origin matches its own host. In
// development the page comes from the Vite server, a different origin, so the
// proxy drops the header for the dev server's own pages and nothing else: a
// request started by any other site keeps its Origin and gets the API's 403.

import type { ClientRequest, IncomingMessage } from "node:http";

const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/**
 * Removes `Origin` from the outgoing proxy request when the page that sent it
 * was served by this dev server: the Origin is exactly `http://<Host>` and the
 * Host is localhost or 127.0.0.1 (a DNS-rebinding name never qualifies). The
 * dev server's port is read from `Host`, so this holds on whichever port Vite
 * listens. Any other Origin is left alone.
 */
export function dropOwnOrigin(
  proxyReq: Pick<ClientRequest, "getHeader" | "removeHeader">,
  req: Pick<IncomingMessage, "headers">,
): void {
  const origin = req.headers.origin?.trim().toLowerCase();
  const host = req.headers.host?.trim().toLowerCase();
  if (!origin || !host || !LOCAL_HOST.test(host)) return;
  if (origin === `http://${host}`) proxyReq.removeHeader("origin");
}
