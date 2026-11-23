// Errors the pipeline raises on purpose. Callers print `message` as-is.

/**
 * A problem the user can act on (unknown city, no internet). The message is a
 * complete plain-English sentence; the CLI and the web UI show it without a
 * stack trace.
 */
export class UserFacingError extends Error {
  override name = "UserFacingError";
}

/**
 * Thrown when Business Finder cannot create or write to its data folder
 * (for example when a sandbox blocks writes to `%LOCALAPPDATA%`).
 */
export class DataDirWriteError extends UserFacingError {
  override name = "DataDirWriteError";
}

const OS_REASONS: Record<string, string> = {
  EACCES: "access denied",
  EPERM: "access denied",
  EROFS: "read-only file system",
  ENOSPC: "no space left on disk",
  ENOTDIR: "path is not a folder",
  EEXIST: "path is not a folder",
  ENOENT: "folder does not exist",
  EBUSY: "file or folder is in use",
};

/** Plain-English OS reason for a filesystem error, falling back to its code or message. */
export function plainOsReason(error: unknown): string {
  const err = error as NodeJS.ErrnoException | undefined;
  if (err?.code && OS_REASONS[err.code]) return OS_REASONS[err.code]!;
  if (err?.code) return err.message ? `${err.code}: ${err.message}` : err.code;
  return error instanceof Error && error.message ? error.message : "unknown error";
}

/** True when `error` is a Node/OS error with a standard uppercase errno code. */
export function isFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code);
}

/** Plain message when Business Finder cannot create or write to a folder or file. */
export function formatWriteError(targetPath: string, error: unknown): string {
  return `Business Finder can't write to ${targetPath} (${plainOsReason(error)}). Choose a writable folder with BUSINESS_FINDER_DATA_DIR, or run Business Finder in PowerShell outside the restricted environment.`;
}

/**
 * A run whose counts do not add up (spec: reconciliation). This is a bug in
 * Business Finder, never in the user's input, so the run fails loudly instead of
 * returning leads that cannot be accounted for.
 */
export class ReconciliationError extends Error {
  override name = "ReconciliationError";
}

export const CANCELLED_MESSAGE = "Search cancelled.";

export const INTERRUPTED_MESSAGE =
  "This search was interrupted because Business Finder was closed or restarted. Nothing is lost; try again to finish it.";

export const INTERRUPTED_EMPTY_MESSAGE =
  "This search was interrupted because Business Finder was closed or restarted. Nothing was saved before it stopped. Try again to run this search.";

// Saved error text from older versions; used only to recognise old job files and never shown.
export const LEGACY_INTERRUPTED_MESSAGE =
  "leadscout was stopped before this run finished. Start the search again.";

const PRIOR_INTERRUPTED_MESSAGES = new Set([
  LEGACY_INTERRUPTED_MESSAGE,
  "This search was interrupted because leadscout was closed or restarted. Nothing is lost; try again to finish it.",
]);

/** True for the current or pre-rewrite interruption text saved on stopped job files. */
export function isInterruptedMessage(error: string | null | undefined): boolean {
  return error === INTERRUPTED_MESSAGE || (error != null && PRIOR_INTERRUPTED_MESSAGES.has(error));
}

/** The user cancelled the run. A run saved as a list keeps the rows it saved before it stopped. */
export class CancelledError extends Error {
  override name = "CancelledError";
  constructor() {
    super(CANCELLED_MESSAGE);
  }
}
