import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Job, LeadRow } from "@/api";
import {
  INTERRUPTED_EMPTY_MESSAGE,
  INTERRUPTED_MESSAGE,
  isInterruptedMessage,
  LEGACY_INTERRUPTED_MESSAGE,
} from "../../../src/core/errors";
import { FilterBar } from "./FilterBar";
import { LeadRows } from "./LeadRows";
import { ListPage } from "./ListPage";
import { ListsNav } from "./ListsNav";
import { DEFAULT_LIST_QUERY } from "../../../src/jobs/filter";

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    status: "done",
    options: { keyword: "cafe", city: "Melaka", depth: 1, lang: "en", emails: true, socials: true, deep: true, maxSeconds: 600 },
    progress: { stage: "done", places: 0, message: "Done" },
    reconciliation: { found: 0, kept: 0, filtered: 0, duplicates: 0, toCheck: 0, fetched: 0, unreachable: 0, mismatched: 0, skipped: 0 },
    createdAt: "2026-11-20T10:00:00.000Z",
    ...over,
  };
}

function makeLead(over: Partial<LeadRow> = {}): LeadRow {
  return {
    title: "Kopi Melaka",
    phone: "+60 6-123 4567",
    whatsapp: null,
    emails: ["hello@kopi.test"],
    email_types: ["generic"],
    email_mx: ["ok"],
    website: "https://kopi.test/",
    category: "Cafe",
    address: "10 Jonker Walk, Melaka",
    review_rating: 4.6,
    review_count: 120,
    instagram: null,
    facebook: null,
    linkedin: null,
    tiktok: null,
    youtube: null,
    x: null,
    source: "browser",
    unchecked: false,
    fresh: false,
    gone: false,
    ...over,
  };
}

const noopActions = {
  title: "Cafe in Melaka",
  readError: null,
  focusTitle: false,
  downloading: null,
  downloadError: null,
  onDownload: () => {},
  onEdit: () => {},
  onRetry: () => {},
  canSearch: true,
  retrying: false,
  retryError: null,
  onCancel: () => {},
  cancelling: false,
  cancelError: null,
  onDelete: () => {},
  deleting: false,
  deleteError: null,
  onWholeCity: () => {},
  expanding: false,
  expandError: null,
};

/** Text nodes outside `<b>0</b>` inside `<Facts>`, so any stray standalone `"0"` (e.g. `{0 && ...}`) stands out. */
function renderedTexts(html: string): string[] {
  return html
    .replace(/<b[^>]*>\d+<\/b>/g, "")
    .split(/<[^>]+>/)
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("ListPage with 0 places", () => {
  it("renders no stray '0' on a stopped (failed) list with 0 places", () => {
    const html = renderToStaticMarkup(
      <ListPage
        {...noopActions}
        view={{ kind: "failed", job: makeJob({ status: "failed", error: "The search stopped." }), leads: [] }}
      />,
    );
    expect(renderedTexts(html)).not.toContain("0");
  });

  it("renders no stray '0' on a done list with 0 places", () => {
    const html = renderToStaticMarkup(
      <ListPage {...noopActions} view={{ kind: "done", job: makeJob({ status: "done" }), leads: [] }} />,
    );
    expect(renderedTexts(html)).not.toContain("0");
  });

  it("renders no stray '0' on a cancelled list with 0 places", () => {
    const html = renderToStaticMarkup(
      <ListPage {...noopActions} view={{ kind: "cancelled", job: makeJob({ status: "cancelled" }), leads: [] }} />,
    );
    expect(renderedTexts(html)).not.toContain("0");
  });
});

describe("ListPage find-more block", () => {
  const leads = [makeLead()];

  it("shows the find-more block on a done single search that reached the end of Google's list", () => {
    const html = renderToStaticMarkup(
      <ListPage {...noopActions} view={{ kind: "done", job: makeJob({ status: "done", reason: "end-of-list" }), leads }} />,
    );
    expect(html).toContain("That&#x27;s everything Google Maps shows for one search.");
    expect(html).toContain("Search the whole city (5–15 min)");
    expect(html).toContain("Change the search");
  });

  it("never shows the find-more block on grid, failed, stopped, or non-end-of-list lists", () => {
    const cases: Parameters<typeof ListPage>[0]["view"][] = [
      { kind: "done", job: makeJob({ status: "done", reason: "end-of-list", options: { ...makeJob().options, wholeCity: true } }), leads },
      { kind: "done", job: makeJob({ status: "done", reason: "end-of-list", options: { ...makeJob().options, limit: 200 } }), leads },
      { kind: "done", job: makeJob({ status: "done", reason: "depth" }), leads },
      { kind: "failed", job: makeJob({ status: "failed", reason: "end-of-list", error: "Stopped" }), leads },
      { kind: "cancelled", job: makeJob({ status: "cancelled", reason: "end-of-list" }), leads },
    ];
    for (const view of cases) {
      const html = renderToStaticMarkup(<ListPage {...noopActions} view={view} />);
      expect(html).not.toContain("Search the whole city (5–15 min)");
      expect(html).not.toContain("Change the search");
    }
  });
});

describe("ListPage stopped vs failed messages", () => {
  it("shows one plain line for an interrupted list with 0 places, and keeps Nothing is lost when places were saved", () => {
    const emptyStopped = renderToStaticMarkup(
      <ListPage
        {...noopActions}
        view={{ kind: "failed", job: makeJob({ status: "failed", error: INTERRUPTED_MESSAGE }), leads: [] }}
      />,
    );
    expect(emptyStopped).toContain(INTERRUPTED_EMPTY_MESSAGE);
    expect(emptyStopped).toContain(`text-muted">${INTERRUPTED_EMPTY_MESSAGE}`);
    expect(emptyStopped).not.toContain("Nothing is lost");
    expect(emptyStopped).not.toContain(`text-danger">${INTERRUPTED_EMPTY_MESSAGE}`);
    expect(emptyStopped).not.toContain(">Nothing was saved before it stopped.</p>");

    const partialStopped = renderToStaticMarkup(
      <ListPage
        {...noopActions}
        view={{ kind: "failed", job: makeJob({ status: "failed", error: INTERRUPTED_MESSAGE }), leads: [makeLead()] }}
      />,
    );
    expect(partialStopped).toContain(INTERRUPTED_MESSAGE);
    expect(partialStopped).toContain("These are the place it read before it stopped");
    expect(partialStopped).not.toContain("Nothing was saved before it stopped.");
  });

  it("keeps red text for real failures and never renders any technical cause field", () => {
    const jobWithCause = {
      ...makeJob({ status: "failed", error: "The search stopped because something went wrong. Try again." }),
      cause: "CdpError: target closed",
    } as Job;
    const failed = renderToStaticMarkup(
      <ListPage
        {...noopActions}
        view={{ kind: "failed", job: jobWithCause, leads: [] }}
      />,
    );
    expect(failed).toContain("text-danger");
    expect(failed).toContain("The search stopped because something went wrong. Try again.");
    expect(failed).not.toContain("CdpError");
    expect(failed).not.toContain("target closed");
  });

  it("shows legacy interrupted jobs in muted text with the new wording and Stopped in the rail", () => {
    const priorLeadscoutInterrupted =
      "This search was interrupted because leadscout was closed or restarted. Nothing is lost; try again to finish it.";
    expect(isInterruptedMessage(INTERRUPTED_MESSAGE)).toBe(true);
    expect(isInterruptedMessage(LEGACY_INTERRUPTED_MESSAGE)).toBe(true);
    expect(isInterruptedMessage(priorLeadscoutInterrupted)).toBe(true);
    expect(isInterruptedMessage("City not found: Atlantis")).toBe(false);
    expect(isInterruptedMessage(undefined)).toBe(false);

    const legacyJob = makeJob({ status: "failed", error: LEGACY_INTERRUPTED_MESSAGE, reconciliation: undefined });
    const html = renderToStaticMarkup(<ListPage {...noopActions} view={{ kind: "failed", job: legacyJob, leads: [] }} />);
    expect(html).toContain(`text-muted">${INTERRUPTED_EMPTY_MESSAGE}`);
    expect(html).not.toContain(`text-danger">${INTERRUPTED_EMPTY_MESSAGE}`);
    expect(html).not.toContain("Nothing is lost");
    expect(html).not.toContain(LEGACY_INTERRUPTED_MESSAGE);
    expect(html).not.toContain("this run");

    const priorHtml = renderToStaticMarkup(
      <ListPage
        {...noopActions}
        view={{ kind: "failed", job: makeJob({ status: "failed", error: priorLeadscoutInterrupted, reconciliation: undefined }), leads: [makeLead()] }}
      />,
    );
    expect(priorHtml).toContain(`text-muted">${INTERRUPTED_MESSAGE}`);
    expect(priorHtml).not.toContain("leadscout");

    const railHtml = renderToStaticMarkup(
      <ListsNav lists={[{ ...legacyJob, title: "Event management in Kuala Lumpur", runs: 1 }]} openId={legacyJob.id} go={() => {}} />,
    );
    expect(railHtml).toContain("Stopped");
  });
});

describe("ListPage running state", () => {
  it("shows area X of Y in lowercase on a grid search with an indeterminate bar", () => {
    const html = renderToStaticMarkup(
      <ListPage
        {...noopActions}
        view={{
          kind: "running",
          job: makeJob({
            status: "running",
            options: { ...makeJob().options, wholeCity: true },
            progress: { stage: "searching", places: 42, cell: 3, cells: 12, message: "" },
          }),
          leads: null,
        }}
      />,
    );
    expect(html).toContain("(area 3 of 12)");
    expect(html).not.toContain("Area 3 of 12");
    expect(html).not.toContain("cell 3");
    expect(html).toContain('data-state="indeterminate"');
  });

  it("shows expected time on a single search and never lets the bar reach 100% while running", () => {
    const singleSearching = renderToStaticMarkup(
      <ListPage
        {...noopActions}
        view={{
          kind: "running",
          job: makeJob({
            status: "running",
            options: { ...makeJob().options, depth: 10, limit: 120 },
            progress: { stage: "searching", places: 15, message: "" },
          }),
          leads: null,
        }}
      />,
    );
    expect(singleSearching).toContain("Usually 1–2 minutes");
    expect(singleSearching).toContain('data-state="indeterminate"');

    const checkingAll = renderToStaticMarkup(
      <ListPage
        {...noopActions}
        view={{
          kind: "running",
          job: makeJob({
            status: "running",
            options: { ...makeJob().options, depth: 1 },
            progress: { stage: "checking_websites", places: 10, checked: 10, toCheck: 10, message: "" },
          }),
          leads: null,
        }}
      />,
    );
    expect(checkingAll).toContain("Usually 15–25 seconds");
    expect(checkingAll).toContain('aria-valuenow="99"');
  });
});

describe("ListsNav", () => {
  it("shows Stopped and Cancelled in sentence case for empty stopped/cancelled lists and allows 2-line titles", () => {
    const stoppedJob = {
      ...makeJob({ status: "failed", error: INTERRUPTED_MESSAGE, reconciliation: undefined }),
      title: "Event management in Kuala Lumpur",
      runs: 1,
    };
    const cancelledJob = {
      ...makeJob({ id: "job-2", status: "cancelled", reconciliation: undefined }),
      title: "Bakery in Melaka",
      runs: 1,
    };
    const html = renderToStaticMarkup(<ListsNav lists={[stoppedJob, cancelledJob]} openId={null} go={() => {}} />);
    expect(html).toContain(">Stopped<");
    expect(html).toContain(">Cancelled<");
    expect(html).not.toContain(">cancelled<");
    expect(html).not.toContain(">–<");
    expect(html).toContain("line-clamp-2");
  });
});

describe("LeadRows email wording", () => {
  it("shows user-friendly email type and mail status words", () => {
    const html = renderToStaticMarkup(
      <LeadRows
        labelledBy="title"
        leads={[
          makeLead({ title: "A", emails: ["info@a.test"], email_types: ["generic"], email_mx: ["ok"] }),
          makeLead({ title: "B", emails: ["alice@b.test"], email_types: ["personal"], email_mx: ["no mail server"] }),
          makeLead({ title: "C", emails: ["team@c.test"], email_types: ["generic"], email_mx: ["unknown"] }),
          makeLead({ title: "D", emails: ["event2026@d.test"], email_types: ["not_sure"], email_mx: ["ok"] }),
        ]}
      />,
    );
    expect(html).toContain("shared inbox · address can receive mail");
    expect(html).toContain("a person&#x27;s address · cannot receive mail");
    expect(html).toContain("shared inbox · could not check mail");
    expect(html).toContain("not sure · address can receive mail");
  });
});

describe("FilterBar desktop single row and More filters count", () => {
  it("renders only contact chips, More filters (with count), and Sort on desktop", () => {
    const html = renderToStaticMarkup(
      <FilterBar
        query={{ ...DEFAULT_LIST_QUERY, emailType: "personal", minRating: 4 }}
        categories={[{ name: "Cafe", count: 3 }]}
        showNewFilter
        showHideNotFoundFilter
        shownCount={3}
        onChange={() => {}}
        onClearFilters={() => {}}
      />,
    );
    expect(html).toContain("Has WhatsApp");
    expect(html).toContain("Has email");
    expect(html).toContain("Has website");
    expect(html).toContain("Has phone");
    expect(html).toContain("More filters (2)");
    expect(html).toContain("Sort by");
    expect(html.replace(/<[^>]+>/g, "")).toContain("Sort: Default");
    expect(html).toContain('role="combobox"');
    expect(html).not.toMatch(/<select(?![^>]*aria-hidden="true")/);
    expect(html).not.toContain("Rating at least");
    expect(html).not.toContain("Reviews at least");
    expect(html).not.toContain("Any email type");
    expect(html).not.toContain("Only new since the last search");
  });
});
