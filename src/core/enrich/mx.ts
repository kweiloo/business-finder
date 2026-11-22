// DNS MX lookup (falling back to A when there is no MX) to tell whether an
// email domain can receive mail. Never connects to the mail server or sends
// anything, and never deletes an email when no mail server is found.

import { resolve4, resolveMx } from "node:dns/promises";

export type EmailMxStatus = "ok" | "no mail server" | "unknown";

export type MxRecord = { exchange: string; priority?: number };

export type MxResolver = {
  resolveMx(domain: string): Promise<MxRecord[]>;
  resolve4(domain: string): Promise<string[]>;
};

export const DEFAULT_MX_TIMEOUT_MS = 3_000;

export const systemDnsResolver: MxResolver = {
  resolveMx: (domain) => resolveMx(domain),
  resolve4: (domain) => resolve4(domain),
};

/** Non-network stub resolver used by default when tests supply a fake `fetchSite`. */
export const NOOP_MX_RESOLVER: MxResolver = {
  resolveMx: async () => [{ exchange: "mail.test", priority: 10 }],
  resolve4: async () => [],
};

const MISSING_DNS_CODES = new Set(["ENODATA", "ENOTFOUND", "ENOENT"]);

function isMissingRecordError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && MISSING_DNS_CODES.has(code);
}

/** Extracts and normalizes the domain part of an email address, or `""`. */
export function emailDomain(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return "";
  return trimmed.slice(at + 1).replace(/\.+$/, "");
}

class LookupTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new LookupTimeoutError());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LookupTimeoutError()), timeoutMs);
    timer.unref?.();
    const onAbort = () => reject(new LookupTimeoutError());
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function lookupDomainMx(domain: string, resolver: MxResolver): Promise<EmailMxStatus> {
  try {
    const mx = await resolver.resolveMx(domain);
    if (mx.length > 0) {
      // RFC 7505 null MX (`0 .`) explicitly declares the domain accepts no mail.
      return mx.some((r) => Boolean(r.exchange && r.exchange !== ".")) ? "ok" : "no mail server";
    }
  } catch (error) {
    if (!isMissingRecordError(error)) return "unknown";
  }

  try {
    const a = await resolver.resolve4(domain);
    return a.length > 0 ? "ok" : "no mail server";
  } catch (error) {
    return isMissingRecordError(error) ? "no mail server" : "unknown";
  }
}

export type CheckMxOptions = {
  resolver?: MxResolver;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** Checks whether `domain` has MX records (falling back to A) within `timeoutMs`. */
export async function checkDomainMx(domain: string, opts: CheckMxOptions = {}): Promise<EmailMxStatus> {
  const normalized = domain.trim().toLowerCase().replace(/\.+$/, "");
  if (!normalized || opts.signal?.aborted) return "unknown";
  const resolver = opts.resolver ?? systemDnsResolver;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MX_TIMEOUT_MS;
  try {
    return await withTimeout(lookupDomainMx(normalized, resolver), timeoutMs, opts.signal);
  } catch {
    return "unknown";
  }
}

/**
 * Per-run cache so each domain is resolved at most once, sharing the in-flight
 * promise across concurrent enrichment workers.
 */
export function createMxCache(opts: CheckMxOptions = {}): (domain: string) => Promise<EmailMxStatus> {
  const cache = new Map<string, Promise<EmailMxStatus>>();
  return (domain: string) => {
    const normalized = domain.trim().toLowerCase().replace(/\.+$/, "");
    if (!normalized) return Promise.resolve("unknown");
    let pending = cache.get(normalized);
    if (!pending) {
      pending = checkDomainMx(normalized, opts);
      cache.set(normalized, pending);
    }
    return pending;
  };
}
