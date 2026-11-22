// Opt-in diagnostics for a run that stops without finishing.
//
// Set BUSINESS_FINDER_DEBUG_LOG to a file path and every run appends one line per
// stage change and per website check to that file: the time, the event and
// key=value fields (durations, counts, outcomes and website hosts). Hosts
// stay out of stdout and stderr, which an AI agent may read; they only go to
// the file the user named. Nothing is written when the variable is unset.

import { appendFileSync } from "node:fs";

export type DebugFields = Record<string, string | number | boolean>;
export type DebugLog = (event: string, fields?: DebugFields) => void;

/** A logger that writes nothing. */
export const NO_DEBUG_LOG: DebugLog = () => {};

function formatValue(value: string | number | boolean): string {
  const text = String(value);
  return /^[^\s"=]*$/.test(text) && text !== "" ? text : JSON.stringify(text);
}

export function formatDebugLine(at: Date, event: string, fields: DebugFields = {}): string {
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${formatValue(value)}`);
  return [at.toISOString(), event, ...pairs].join(" ") + "\n";
}

/**
 * The logger named by BUSINESS_FINDER_DEBUG_LOG, or `NO_DEBUG_LOG`. A failing write
 * is dropped: diagnostics must never stop a run.
 */
export function debugLogFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  append: (file: string, line: string) => void = appendFileSync,
  now: () => Date = () => new Date(),
): DebugLog {
  const file = env.BUSINESS_FINDER_DEBUG_LOG?.trim();
  if (!file) return NO_DEBUG_LOG;
  return (event, fields) => {
    try {
      append(file, formatDebugLine(now(), event, fields));
    } catch {
      // Diagnostics are best effort.
    }
  };
}
