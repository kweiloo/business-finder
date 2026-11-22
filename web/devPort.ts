// Ports for local development. Windows reserves blocks of 100 ports anywhere
// in its dynamic range (often 1024–15000, and 49152–65535 by default), and
// the blocks move between reboots, so a fixed port such as 5173 can fail with
// EACCES one day and work the next. These defaults sit between both ranges,
// and the Vite port is still probed because reservations differ per machine.

import { createServer } from "node:net";

/** The Vite dev server's first port. */
export const DEV_WEB_PORT = 15_173;
/** The port `bun run dev:serve` listens on; the Vite proxy sends `/api` there. */
export const DEV_API_PORT = 18_080;

export type PortState = "free" | "in_use" | "reserved";

/** Whether 127.0.0.1 can listen on `port`: EADDRINUSE is `in_use`, EACCES is `reserved`. */
export function probeLocalPort(port: number): Promise<PortState> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (e: NodeJS.ErrnoException) =>
      e.code === "EADDRINUSE" ? resolve("in_use") : e.code === "EACCES" ? resolve("reserved") : reject(e),
    );
    server.listen(port, "127.0.0.1", () => server.close(() => resolve("free")));
  });
}

/** The first port at or above `start` that `probe` reports free, trying `tries` ports. */
export async function firstBindablePort(
  start: number,
  probe: (port: number) => Promise<PortState> = probeLocalPort,
  tries = 50,
): Promise<number> {
  for (let port = start; port < start + tries && port <= 65_535; port++) {
    if ((await probe(port)) === "free") return port;
  }
  throw new Error(`No free port in the ${tries} ports from ${start}; free one of them or reboot.`);
}
