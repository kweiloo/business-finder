// Runs the website checks in a child process, so no website can stop a run.
//
// A check that never yields (a parser spinning on one page, a stream that
// keeps the event loop busy) starves every timer in its process, the page
// timeouts included. The watchdog therefore lives in this process and the
// checks in another one that it can always stop. A worker thread is not
// enough: on Bun 1.3 on Windows, `worker.terminate()` never returns for a
// thread caught in a busy loop, while killing a child process takes about
// 20 ms whatever the child is doing.
//
// When the child stops making progress, the check it froze in is the one
// whose last step was a `*_start`. That website is given up; the child is
// replaced and the other unfinished websites are checked again. The run then
// ends normally: every row is kept, the rows whose check never ended read
// `not_checked`, and `counts.notChecked` says how many.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { debugLogFromEnv, type DebugLog } from "../debugLog.js";
import type { StuckSite } from "../sources/fixture-file.js";
import type { FieldStatus, Lead } from "../types.js";
import {
  enrichLeads,
  noWebsite,
  websiteNotChecked,
  websiteUrl,
  type CheckStep,
  type EnrichCounts,
  type EnrichOptions,
  type EnrichProgress,
} from "./enrich.js";
import type { EmailMxStatus } from "./mx.js";

/** No page and no site finished for this long: the checks are stuck. */
export const STALL_MS = 60_000;

/** Fixture websites for a check process: files instead of the network. */
export type FixtureSites = { sitesDir: string; mx?: Record<string, EmailMxStatus>; stuck?: Record<string, StuckSite> };

export type CheckOptions = EnrichOptions & {
  /** Stops the checks still running after this long; their rows read `not_checked`. */
  budgetMs?: number;
  /** A check process with no page and no site finished for this long is stopped. Default `STALL_MS`. */
  stallMs?: number;
  /** Aborted to stop the checks now and keep what is done, e.g. on Ctrl-C in the CLI. Unlike `signal`, the run still finishes. */
  finish?: AbortSignal;
  /** Fixture mode: the check process reads these files instead of the network. */
  fixture?: FixtureSites;
};

export type CheckProgress = EnrichProgress & {
  /** Set once the checks ended early: how many websites were not checked. */
  notChecked?: number;
};

/** The shape of `checkWebsites`; tests and fixture runs pass their own. */
export type WebsiteChecker = (
  leads: Lead[],
  opts: CheckOptions,
  onProgress?: (p: CheckProgress) => void,
) => Promise<{ leads: Lead[]; counts: EnrichCounts }>;

/** What the parent sends a check process, as one JSON line on its stdin. */
export type CheckRequest = {
  leads: Lead[];
  opts: Pick<EnrichOptions, "emails" | "socials" | "deep" | "country" | "mxTimeoutMs" | "pendingReportMs">;
  fixture?: FixtureSites;
};

/** What a check process writes, one JSON object per line on its stdout; `i` is the lead's place in its request. */
export type CheckMessage = { t: "step"; i: number; step: CheckStep } | { t: "lead"; i: number; lead: Lead } | { t: "end" };

/** How the checks ended: all of them did, or why they were stopped. */
type Ending = "ended" | "stalled" | "deadline" | "finished_early" | "child_exited" | "cancelled";

const CHILD_ENTRY = fileURLToPath(new URL("./checkChild.ts", import.meta.url));
/** How long a killed check process may take to be gone before the run goes on without waiting. */
const EXIT_WAIT_MS = 5_000;

const OUTCOME: Partial<Record<FieldStatus, Exclude<keyof EnrichCounts, "toCheck" | "notChecked">>> = {
  found: "fetched",
  site_unreachable: "unreachable",
  website_mismatch: "mismatched",
  skipped_by_option: "skipped",
};

/** The Bun executable: this process when it runs on Bun, else `bun` on the PATH. */
function bunPath(): string {
  return process.versions.bun ? process.execPath : "bun";
}

/**
 * Checks every lead's website like `enrichLeads`, in a child process watched
 * from here. A check the child freezes in is given up after `stallMs`
 * without progress and the rest go on in a new child. All remaining checks
 * stop, keeping every row, when `budgetMs` runs out or `finish` aborts.
 * Aborting `signal` cancels: the child is stopped and the cut-off checks are
 * neither counted nor reported, as in `enrichLeads`. No child is left
 * running when this returns.
 *
 * Without Bun on the PATH (a Node run), without the check script (a bundled
 * build) or with a caller's own fetcher, the checks run in this process
 * under the same deadline and stop rules, which hold unless a check starves
 * this process's event loop.
 */
export const checkWebsites: WebsiteChecker = async (leads, opts, onProgress = () => {}) => {
  const debug = opts.debug ?? debugLogFromEnv();
  const out: Lead[] = leads.map((lead) => ({ ...lead }));
  const settled = new Array<boolean>(leads.length).fill(false);
  const settle = (index: number, lead: Lead) => {
    out[index] = lead;
    settled[index] = true;
    try {
      opts.onLead?.(index, lead);
    } catch {
      // A failing listener must not stop the run.
    }
  };
  const report = (p: CheckProgress) => {
    try {
      onProgress(p);
    } catch {
      // A failing progress listener must not stop the run.
    }
  };

  // Leads with no website are settled here; only websites go to the checks.
  const queue: number[] = [];
  leads.forEach((lead, index) => {
    if (websiteUrl(lead.website) === "") settle(index, noWebsite(lead, opts.emails));
    else queue.push(index);
  });
  const counts: EnrichCounts = { toCheck: queue.length, fetched: 0, unreachable: 0, mismatched: 0, skipped: 0 };
  let checked = 0;
  if (queue.length === 0 || opts.signal?.aborted) return { leads: out, counts };

  /** One check that ended, by the lead's index. */
  const onChecked = (index: number, lead: Lead) => {
    if (settled[index] || opts.signal?.aborted) return;
    const outcome = OUTCOME[lead.website_status];
    if (!outcome) return;
    counts[outcome] += 1;
    checked += 1;
    settle(index, lead);
    report({ checked, toCheck: counts.toCheck });
  };

  const stops = watch(opts);
  const givenUp = new Set<number>();
  let ending: Ending = "ended";
  try {
    // Functions cannot cross to another process: a caller's own fetcher or resolver keeps the checks here.
    const ownFunctions = !opts.fixture && Boolean(opts.fetchSite || opts.mxResolver || opts.pacer || opts.now);
    let useChild = existsSync(CHILD_ENTRY) && !ownFunctions;
    for (;;) {
      const round = queue.filter((index) => !settled[index] && !givenUp.has(index));
      if (round.length === 0) {
        ending = givenUp.size > 0 ? "stalled" : "ended";
        break;
      }
      if (!useChild) {
        ending = await inProcess(round, leads, opts, onChecked, stops, debug);
        break;
      }
      const result = await inChild(round, leads, opts, onChecked, stops, debug);
      if (result.ending === "unavailable") {
        useChild = false;
        continue;
      }
      if (result.ending !== "stalled" || result.stuck.length === 0) {
        ending = result.ending;
        break;
      }
      for (const index of result.stuck) givenUp.add(index);
      debug("checks_restart", { givenUp: givenUp.size, left: round.length - result.stuck.length });
      stops.restart();
    }
  } finally {
    stops.dispose();
  }

  if (ending === "cancelled") {
    debug("checks_cancelled", { checked });
    return { leads: out, counts };
  }
  // Every check that did not end keeps its row, marked not checked.
  let notChecked = 0;
  for (const index of queue) {
    if (settled[index]) continue;
    notChecked += 1;
    settle(index, websiteNotChecked(leads[index]!, opts.emails));
  }
  if (notChecked === 0) {
    debug("checks_end", { checked });
    return { leads: out, counts };
  }
  counts.notChecked = notChecked;
  debug("checks_stopped", { reason: ending === "ended" ? "stalled" : ending, checked, notChecked });
  report({ checked, toCheck: counts.toCheck, notChecked });
  return { leads: out, counts };
};

/**
 * The reasons to stop, watched from this process: no progress for
 * `stallMs`, the `budgetMs` deadline, `finish` and the cancel `signal`.
 * `stopped()` resolves with the first one; `progress()` resets the stall
 * clock, and `restart()` re-arms it for a new check process.
 */
function watch(opts: CheckOptions) {
  const stallMs = opts.stallMs ?? STALL_MS;
  let last = performance.now();
  let final: Ending | null = null;
  let stall: { resolve: (e: Ending) => void; promise: Promise<Ending> };
  const listeners = new Set<(e: Ending) => void>();
  const arm = () => {
    let resolve!: (e: Ending) => void;
    const promise = new Promise<Ending>((r) => (resolve = r));
    stall = { resolve, promise };
    listeners.add(resolve);
  };
  arm();
  const end = (reason: Ending) => {
    final ??= reason;
    for (const resolve of listeners) resolve(final);
  };
  const watchdog = setInterval(() => {
    if (performance.now() - last >= stallMs) stall.resolve("stalled");
  }, Math.max(50, Math.min(1000, Math.floor(stallMs / 4))));
  const deadline = opts.budgetMs !== undefined ? setTimeout(() => end("deadline"), Math.max(0, opts.budgetMs)) : undefined;
  const onFinish = () => end("finished_early");
  const onCancel = () => end("cancelled");
  opts.finish?.addEventListener("abort", onFinish, { once: true });
  opts.signal?.addEventListener("abort", onCancel, { once: true });
  if (opts.signal?.aborted) onCancel();
  else if (opts.finish?.aborted) onFinish();
  return {
    stopped: () => stall.promise,
    progress: () => {
      last = performance.now();
    },
    restart: () => {
      listeners.delete(stall.resolve);
      last = performance.now();
      arm();
      if (final) stall.resolve(final);
    },
    dispose: () => {
      clearInterval(watchdog);
      clearTimeout(deadline);
      opts.finish?.removeEventListener("abort", onFinish);
      opts.signal?.removeEventListener("abort", onCancel);
    },
  };
}

type Stops = ReturnType<typeof watch>;

/**
 * One check process for the leads at `round`. `unavailable` when it cannot
 * be started. On a stall, `stuck` names the check it froze in: the one whose
 * last step, of all, was a `*_start`, or every check in flight when none is.
 */
async function inChild(
  round: number[],
  leads: Lead[],
  opts: CheckOptions,
  onChecked: (index: number, lead: Lead) => void,
  stops: Stops,
  debug: DebugLog,
): Promise<{ ending: Ending | "unavailable"; stuck: number[] }> {
  const child = spawn(bunPath(), [CHILD_ENTRY], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: process.env });
  let heard = false;
  let spawnFailed = false;
  // `close` comes after the child's stdout is read to the end, so its last lines are never lost.
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => {
      spawnFailed = !heard;
      resolve();
    });
  });
  // A CLI that exits mid-run (a second Ctrl-C) takes the check process with it.
  const killOnExit = () => child.kill();
  process.once("exit", killOnExit);
  debug("checks_child_start", { pid: child.pid ?? 0, toCheck: round.length });

  const request: CheckRequest = {
    leads: round.map((index) => leads[index]!),
    opts: {
      emails: opts.emails,
      socials: opts.socials,
      deep: opts.deep,
      ...(opts.country ? { country: opts.country } : {}),
      ...(opts.mxTimeoutMs ? { mxTimeoutMs: opts.mxTimeoutMs } : {}),
      ...(opts.pendingReportMs ? { pendingReportMs: opts.pendingReportMs } : {}),
    },
    ...(opts.fixture ? { fixture: opts.fixture } : {}),
  };
  // stdin stays open: the child ends itself when this process goes away.
  child.stdin.on("error", () => {});
  child.stdin.write(`${JSON.stringify(request)}\n`);
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
  });

  // Per check in flight: its last step and when that step came.
  const inFlight = new Map<number, { step: CheckStep; seq: number }>();
  let seq = 0;
  let resolveEnd!: () => void;
  const end = new Promise<void>((resolve) => (resolveEnd = resolve));
  const onMessage = (message: CheckMessage) => {
    if (message.t === "end") {
      resolveEnd();
      return;
    }
    const index = round[message.i];
    if (index === undefined) return;
    if (message.t === "lead") {
      inFlight.delete(index);
      stops.progress();
      onChecked(index, message.lead);
      return;
    }
    inFlight.set(index, { step: message.step, seq: ++seq });
    if (!message.step.endsWith("_start")) stops.progress();
  };
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    heard = true;
    buffered += text;
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      try {
        onMessage(JSON.parse(line) as CheckMessage);
      } catch {
        // Not a message.
      }
    }
  });

  let ending: Ending;
  try {
    ending = await Promise.race([end.then(() => "ended" as const), closed.then(() => "child_exited" as const), stops.stopped()]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([closed, new Promise<void>((resolve) => (timer = setTimeout(resolve, EXIT_WAIT_MS)))]);
    clearTimeout(timer);
    process.off("exit", killOnExit);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
  if (stderrBytes > 0) debug("checks_child_stderr", { bytes: stderrBytes });
  if (spawnFailed) {
    debug("checks_child_unavailable", {});
    return { ending: "unavailable", stuck: [] };
  }
  debug("checks_child_exit", { pid: child.pid ?? 0, ending });
  if (ending !== "stalled") return { ending, stuck: [] };
  return { ending, stuck: frozen(inFlight, seq) };
}

/**
 * The checks to give up after a stall. Reading a page is synchronous, so
 * when the child's very last message was a `parse_start`, nothing else could
 * run after it and that check is the one that froze. Any other open step
 * (a page fetch) can be overtaken by other checks before the child stops
 * answering, so every check with an open step is given up. With no open
 * step, every check in flight is. The rows given up read `not_checked`.
 */
export function frozen(inFlight: ReadonlyMap<number, { step: CheckStep; seq: number }>, lastSeq: number): number[] {
  const open = [...inFlight].filter(([, s]) => s.step.endsWith("_start"));
  const last = open.find(([, s]) => s.seq === lastSeq);
  if (last && last[1].step === "parse_start") return [last[0]];
  return open.length > 0 ? open.map(([index]) => index) : [...inFlight.keys()];
}

/** The checks in this process, stopped by the same rules through an abort signal. */
async function inProcess(
  round: number[],
  leads: Lead[],
  opts: CheckOptions,
  onChecked: (index: number, lead: Lead) => void,
  stops: Stops,
  debug: DebugLog,
): Promise<Ending> {
  debug("checks_in_process", { toCheck: round.length });
  const controller = new AbortController();
  let ending: Ending = "ended";
  void stops.stopped().then((reason) => {
    ending = reason;
    controller.abort();
  });
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  const { fixture: _fixture, ...rest } = opts;
  await enrichLeads(
    round.map((index) => leads[index]!),
    {
      ...rest,
      signal,
      onStep: (_i, step) => {
        if (step.endsWith("_done")) stops.progress();
      },
      onLead: (i, lead) => {
        stops.progress();
        if (!controller.signal.aborted) onChecked(round[i]!, lead);
      },
    },
  );
  return ending;
}
