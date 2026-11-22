// The check process started by `checkWebsites`. It reads one `CheckRequest`
// line on stdin, checks the websites with `enrichLeads` and writes one JSON
// message per line on stdout: each check's steps, each lead as its check
// ends, and `end`. Messages are written synchronously, so when a check
// starves this process the parent has already read the step it froze in.
// It exits when its work is done or when stdin closes (the parent went
// away). Nothing else may be written to stdout.

import { writeSync } from "node:fs";
import { enrichLeads, fixtureFetcher } from "./enrich.js";
import type { CheckMessage, CheckRequest } from "./isolated.js";
import { NOOP_MX_RESOLVER, systemDnsResolver } from "./mx.js";
import { safeFetch, type SiteFetcher } from "./safeFetch.js";

function send(message: CheckMessage): void {
  const line = `${JSON.stringify(message)}\n`;
  try {
    writeSync(1, line);
  } catch {
    process.stdout.write(line);
  }
}

/** The request line. A stdin that closes, before or after it, means the parent is gone: exit. */
function readRequest(): Promise<CheckRequest> {
  return new Promise((resolve, reject) => {
    let text = "";
    let received = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      if (received) return;
      text += chunk;
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      received = true;
      try {
        resolve(JSON.parse(text.slice(0, newline)) as CheckRequest);
      } catch (error) {
        reject(error);
      }
    });
    process.stdin.on("end", () => process.exit(0));
    process.stdin.on("close", () => process.exit(0));
  });
}

async function main(): Promise<void> {
  const { leads, opts, fixture } = await readRequest();
  let fetchSite: SiteFetcher = safeFetch;
  let mxResolver = systemDnsResolver;
  let onRead: ((url: string) => void) | undefined;
  if (fixture) {
    // Loaded only for fixture runs, so a live check process starts on less code.
    const { fixtureMxResolver, stuckReader, withStuckSites } = await import("../sources/fixture-file.js");
    const files = fixtureFetcher(fixture.sitesDir);
    fetchSite = fixture.stuck ? withStuckSites(files, fixture.stuck) : files;
    mxResolver = fixture.mx ? fixtureMxResolver(fixture.mx) : NOOP_MX_RESOLVER;
    onRead = fixture.stuck ? stuckReader(fixture.stuck) : undefined;
  }
  await enrichLeads(leads, {
    ...opts,
    fetchSite,
    mxResolver,
    ...(onRead ? { onRead } : {}),
    onStep: (i, step) => send({ t: "step", i, step }),
    onLead: (i, lead) => send({ t: "lead", i, lead }),
  });
  send({ t: "end" });
  process.exit(0);
}

main().catch(() => process.exit(1));
