// Lists made outside this page (by an agent running `business-finder scrape` or
// `business-finder add`) appear when the person comes back to the window.

type Target = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * Calls `refresh` each time the window regains focus. Returns the function
 * that stops listening.
 */
export function refreshOnFocus(window: Target, refresh: () => void): () => void {
  const onFocus = () => refresh();
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
}
