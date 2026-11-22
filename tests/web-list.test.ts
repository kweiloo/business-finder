// The web UI's list logic: the URL as the page state, past searches as lists,
// which state a list is in, what its header says, and which way a row is
// contacted. Pure functions; the browser flows are covered in tests/e2e.

import { describe, expect, it, vi } from "vitest";
import { usesWholeCityGrid } from "../src/core/searchSize.js";
import type { Job, LeadRow } from "../web/src/types.js";
import { chatHref, hasWhatsApp, websiteLink, whatsappLink } from "../web/src/lib/contact.js";
import { websiteLabel } from "../web/src/lib/links.js";
import { refreshOnFocus } from "../web/src/lib/focus.js";
import { collapseLists, finished, listCount, listTitle, railDetail, railWhen, searchText, afterDelete } from "../web/src/lib/lists.js";
import { fromWeb, searchable, toLeadRow } from "../web/src/lib/source.js";
import { jobIdFromSearch, listQueryFromSearch, startList, urlForJob } from "../web/src/lib/route.js";
import { aroundLine, cancelledLine, deleteConfirmMessage, endOfListLine, expectedTimeLine, listFacts, markerContext, markerDay, rowMarker, stageLine, viewOf, when } from "../web/src/lib/view.js";

function job(over: Partial<Job> & { keyword?: string; city?: string } = {}): Job {
  const { keyword = "dentist", city = "Lisbon, Portugal", ...rest } = over;
  return {
    id: "job-1",
    status: "done",
    options: { keyword, city, depth: 2, lang: "en", emails: true, socials: true, deep: false, maxSeconds: 600 },
    progress: { stage: "done", places: 5, message: "Found 5 leads in Lisbon, Portugal." },
    reconciliation: { found: 5, kept: 5, filtered: 0, duplicates: 0, toCheck: 3, fetched: 1, unreachable: 2, mismatched: 0, skipped: 0 },
    createdAt: "2026-11-19T17:42:00.000Z",
    ...rest,
  };
}

function lead(over: Partial<LeadRow> = {}): LeadRow {
  return {
    title: "Clínica Dentária São João",
    phone: null,
    whatsapp: null,
    emails: null,
    email_types: null,
    email_mx: null,
    website: null,
    category: null,
    address: null,
    review_rating: null,
    review_count: null,
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

describe("the URL is the state", () => {
  it("reads the open list from ?job=", () => {
    expect(jobIdFromSearch("?job=abc-123")).toBe("abc-123");
    expect(jobIdFromSearch("?other=1&job=abc")).toBe("abc");
  });

  it("is a new list without a job, or with an empty one", () => {
    expect(jobIdFromSearch("")).toBeNull();
    expect(jobIdFromSearch("?job=")).toBeNull();
    expect(jobIdFromSearch("?job=%20")).toBeNull();
  });

  it("writes a list's URL and round-trips it", () => {
    expect(urlForJob(null)).toBe("/");
    expect(urlForJob("abc-123")).toBe("/?job=abc-123");
    const odd = "a b&c";
    expect(jobIdFromSearch(urlForJob(odd).slice(1))).toBe(odd);
  });

  it("keeps filters and sort next to ?job= and restores them", () => {
    const query = {
      whatsapp: true,
      email: false,
      emailType: "generic" as const,
      website: true,
      phone: false,
      minRating: 4,
      minReviews: 10,
      hiddenCategories: ["Arena"],
      onlyNew: false,
      hideNotFound: true,
      sort: "rating" as const,
    };
    const url = urlForJob("abc-123", query);
    expect(jobIdFromSearch(url.slice(1))).toBe("abc-123");
    expect(listQueryFromSearch(url.slice(1))).toEqual(query);
  });
});

describe("a search always makes a new list", () => {
  it("creates a job and opens its own URL, even when it repeats or edits an open list", async () => {
    const create = vi.fn(async () => "job-2");
    const go = vi.fn();
    await startList({ keyword: "dentist", city: "Porto" }, { create, go });
    expect(create).toHaveBeenCalledWith({ keyword: "dentist", city: "Porto" });
    expect(go).toHaveBeenCalledWith("/?job=job-2");
  });

  it("stays on the form when the job cannot be created", async () => {
    const go = vi.fn();
    const failing = async (): Promise<string> => {
      throw new Error("Enter a city.");
    };
    await expect(startList({ keyword: "dentist", city: "" }, { create: failing, go })).rejects.toThrow("Enter a city.");
    expect(go).not.toHaveBeenCalled();
  });
});

describe("lists", () => {
  it("are titled by their search, with the first part of the place", () => {
    expect(listTitle({ keyword: "dentist", city: "Lisbon, Portugal" })).toBe("Dentist in Lisbon");
    expect(listTitle({ keyword: "event venue", city: "Melaka" })).toBe("Event venue in Melaka");
    // Scripts without capitals are left as typed.
    expect(listTitle({ keyword: "歯医者", city: "東京" })).toBe("歯医者 in 東京");
    expect(listTitle({ keyword: "  hotel ", city: " , Ipoh" })).toBe("Hotel in , Ipoh");
  });

  it("made only by `business-finder add` have no city and take their title from --title, as written", () => {
    const web = job({ keyword: "event agencies (web)", city: "", source: "web" });
    expect(listTitle(web.options)).toBe("event agencies (web)");
    expect(listTitle({ keyword: "  KL wedding planners ", city: " " })).toBe("KL wedding planners");
    expect(collapseLists([web])[0]?.title).toBe("event agencies (web)");
    // The rail's hover hint names the list without a dangling "in".
    expect(searchText(web.options)).toBe("event agencies (web)");
    expect(searchText(job().options)).toBe("dentist in Lisbon, Portugal");
    // Not a search that can run again, so the page offers no Search again or Try again for it.
    expect(searchable(web)).toBe(false);
    expect(searchable(job())).toBe(true);
  });

  it("made by `business-finder add` with the same title stay separate: each holds different places", () => {
    const a = job({ id: "a", keyword: "Event agencies", city: "", source: "web", createdAt: "2026-11-19T10:00:00Z" });
    const b = job({ id: "b", keyword: "event agencies", city: "", source: "web", createdAt: "2026-11-18T10:00:00Z" });
    expect(collapseLists([a, b]).map((l) => [l.id, l.title])).toEqual([
      ["a", "Event agencies"],
      ["b", "event agencies"],
    ]);
  });

  it("show a repeated search once, as its newest run", () => {
    const old = job({ id: "a", createdAt: "2026-11-18T10:00:00Z" });
    const again = job({ id: "b", createdAt: "2026-11-19T10:00:00Z", keyword: " Dentist ", city: "lisbon,  portugal" });
    const other = job({ id: "c", createdAt: "2026-11-19T09:00:00Z", keyword: "hotel", city: "Melaka" });
    expect(collapseLists([old, other, again]).map((j) => j.id)).toEqual(["b", "c"]);
  });

  it("title a repeated search as it was first typed", () => {
    const first = job({ id: "a", createdAt: "2026-11-18T10:00:00Z", keyword: "dentist", city: "Lisbon, Portugal" });
    const again = job({ id: "b", createdAt: "2026-11-19T10:00:00Z", keyword: "Dentist", city: "lisbon, portugal" });
    const [listed] = collapseLists([again, first]);
    expect(listed).toMatchObject({ id: "b", title: "Dentist in Lisbon" });
    // Runs made in the same instant keep the order they came in.
    const twin = job({ id: "c", createdAt: "2026-11-19T10:00:00Z", keyword: "dentist", city: "Lisbon, Portugal" });
    expect(collapseLists([again, twin]).map((j) => j.id)).toEqual(["b"]);
  });

  it("show the finished run, not a cancelled re-run of the same search", () => {
    const done = job({ id: "done", status: "done", createdAt: "2026-11-19T10:00:00Z" });
    const cancelled = job({ id: "cancelled", status: "cancelled", reconciliation: undefined, createdAt: "2026-11-19T11:00:00Z" });
    const other = job({ id: "other", keyword: "hotel", city: "Melaka", createdAt: "2026-11-19T10:30:00Z" });
    const listed = collapseLists([done, other, cancelled]);
    expect(listed.map((l) => l.id)).toEqual(["done", "other"]);
    expect(listCount(listed[0]!)).toBe(5);
    // A failed or running re-run still replaces the finished one: only a cancelled run steps aside.
    const failed = job({ id: "failed", status: "failed", createdAt: "2026-11-19T12:00:00Z" });
    expect(collapseLists([done, cancelled, failed]).map((l) => l.id)).toEqual(["failed"]);
  });

  it("show a search whose runs were all cancelled as its newest run", () => {
    const first = job({ id: "a", status: "cancelled", reconciliation: undefined, createdAt: "2026-11-19T10:00:00Z" });
    const again = job({ id: "b", status: "cancelled", reconciliation: undefined, createdAt: "2026-11-19T11:00:00Z" });
    expect(collapseLists([first, again]).map((l) => l.id)).toEqual(["b"]);
  });

  it("count the places kept, and nothing while running or when none were read", () => {
    expect(listCount(job())).toBe(5);
    expect(listCount(job({ status: "running", reconciliation: undefined, saved: 12 }))).toBeNull();
    expect(listCount(job({ status: "failed", reconciliation: undefined }))).toBeNull();
    expect(listCount(job({ status: "cancelled", reconciliation: undefined }))).toBeNull();
  });

  it("count the rows saved: a cancelled or failed search keeps what it found, and saved rows win over the old count", () => {
    expect(listCount(job({ status: "cancelled", reconciliation: undefined, saved: 12 }))).toBe(12);
    expect(listCount(job({ status: "failed", reconciliation: undefined, saved: 7 }))).toBe(7);
    // Rows added later (add --into) are in saved, not in the search's reconciliation.
    expect(listCount(job({ saved: 9 }))).toBe(9);
  });

  it("are finished once done, failed or cancelled", () => {
    expect(["queued", "running", "done", "failed", "cancelled"].map((status) => finished(job({ status } as Partial<Job>)))).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  it("tell apart two runs that share a title by the typed city and when each ran", () => {
    // Different places after the comma, so the duplicate rule keeps both; the rail cuts both titles the same way.
    const a = job({ id: "a", keyword: "event management", city: "Kuala Lumpur", createdAt: "2026-11-19T09:10:00Z" });
    const b = job({ id: "b", keyword: "event management", city: "Kuala Lumpur, Malaysia", createdAt: "2026-11-18T17:42:00Z" });
    const unique = job({ id: "u", keyword: "dentist", city: "Lisbon, Portugal", createdAt: "2026-11-18T08:00:00Z" });
    const listed = collapseLists([a, b, unique]);
    expect(listed.slice(0, 2).map((l) => l.title)).toEqual(["Event management in Kuala Lumpur", "Event management in Kuala Lumpur"]);
    expect(listed.map((l) => railDetail(l, listed))).toEqual(["Kuala Lumpur", "Kuala Lumpur, Malaysia", null]);
    const now = new Date("2026-11-19T20:00:00Z");
    const lines = listed.slice(0, 2).map((l) => railWhen(l, now, "en-GB", "UTC"));
    expect(lines).toEqual(["Today, 9:10", "Yesterday, 17:42"]);
    expect(new Set(lines).size).toBe(2);
  });

  it("show run count when same-title entries have no differing city", () => {
    const a = { ...job({ id: "a", keyword: "Event agencies", city: "", source: "web" }), runs: 2 };
    const b = { ...job({ id: "b", keyword: "Event agencies", city: "", source: "web" }), runs: 1 };
    const listed = collapseLists([a, b]);
    expect(listed.map((l) => railDetail(l, listed))).toEqual(["2 runs", null]);
  });
});

describe("the state of the open list", () => {
  it("is the new-list form without a job", () => {
    expect(viewOf({ jobId: null, job: null, missing: false, leads: null })).toEqual({ kind: "new" });
  });

  it("is unknown when the server does not have the job", () => {
    expect(viewOf({ jobId: "gone", job: null, missing: true, leads: null })).toEqual({ kind: "unknown" });
  });

  it("is loading until the open job's own answer arrives", () => {
    expect(viewOf({ jobId: "b", job: null, missing: false, leads: null }).kind).toBe("loading");
    // A previous list's job is never shown under another URL.
    expect(viewOf({ jobId: "b", job: job({ id: "a" }), missing: false, leads: null }).kind).toBe("loading");
  });

  it("is running while the job is queued or running", () => {
    expect(viewOf({ jobId: "job-1", job: job({ status: "queued" }), missing: false, leads: null }).kind).toBe("running");
    expect(viewOf({ jobId: "job-1", job: job({ status: "running" }), missing: false, leads: null }).kind).toBe("running");
  });

  it("is empty when a finished search kept no places", () => {
    const none = job({ reconciliation: { ...job().reconciliation!, found: 0, kept: 0, toCheck: 0, fetched: 0, unreachable: 0 } });
    expect(viewOf({ jobId: "job-1", job: none, missing: false, leads: [] }).kind).toBe("empty");
    expect(viewOf({ jobId: "job-1", job: none, missing: false, leads: null }).kind).toBe("empty");
  });

  it("is done with its rows once they load", () => {
    const rows = [lead()];
    expect(viewOf({ jobId: "job-1", job: job(), missing: false, leads: null })).toMatchObject({ kind: "done", leads: null });
    expect(viewOf({ jobId: "job-1", job: job(), missing: false, leads: rows })).toMatchObject({ kind: "done", leads: rows });
  });

  it("is cancelled when the person stopped the search, with the places it kept", () => {
    const stopped = job({ status: "cancelled", reconciliation: undefined, saved: 2 });
    const rows = [lead(), lead({ title: "Second", unchecked: true })];
    expect(viewOf({ jobId: "job-1", job: stopped, missing: false, leads: null })).toEqual({ kind: "cancelled", job: stopped, leads: null });
    expect(viewOf({ jobId: "job-1", job: stopped, missing: false, leads: rows })).toEqual({ kind: "cancelled", job: stopped, leads: rows });
    expect(cancelledLine(2)).toBe("You stopped this search early. It kept the 2 places it had found; the list may be missing some.");
    expect(cancelledLine(1)).toBe("You stopped this search early. It kept the 1 place it had found; the list may be missing some.");
    expect(cancelledLine(0)).toBe("You stopped this search early, before it found any places.");
  });

  it("shows the rows saved so far while the search runs", () => {
    const rows = [lead({ unchecked: true })];
    const running = job({ status: "running", reconciliation: undefined, saved: 1 });
    expect(viewOf({ jobId: "job-1", job: running, missing: false, leads: rows })).toEqual({ kind: "running", job: running, leads: rows });
  });

  it("is done, not empty, when rows were added to a search that found none", () => {
    const none = job({ saved: 3, reconciliation: { ...job().reconciliation!, found: 0, kept: 0, toCheck: 0, fetched: 0, unreachable: 0 } });
    expect(viewOf({ jobId: "job-1", job: none, missing: false, leads: null }).kind).toBe("done");
  });


  it("is failed, with any places it kept before it stopped", () => {
    const failed = job({ status: "failed", error: "City not found: Atlantis", reconciliation: undefined });
    expect(viewOf({ jobId: "job-1", job: failed, missing: false, leads: null })).toMatchObject({ kind: "failed", leads: null });
    const blocked = job({ status: "failed", error: "Google is limiting this computer." });
    expect(viewOf({ jobId: "job-1", job: blocked, missing: false, leads: [lead()] })).toMatchObject({ kind: "failed", leads: [lead()] });
  });
});

describe("the running line", () => {
  const running = (progress: Job["progress"], status: Job["status"] = "running") => job({ status, progress, reconciliation: undefined });

  it("says each stage in plain words", () => {
    expect(stageLine(running({ stage: "geocoding", places: 0, message: "" }, "queued"))).toBe("Waiting to start…");
    expect(stageLine(running({ stage: "geocoding", places: 0, message: "" }))).toBe("Finding Lisbon, Portugal on the map…");
    expect(stageLine(running({ stage: "searching", places: 0, message: "" }))).toBe("Searching Google Maps…");
    expect(stageLine(running({ stage: "searching", places: 12, message: "" }))).toBe("Searching Google Maps… 12 places so far");
    expect(stageLine(running({ stage: "searching", places: 1, message: "" }))).toBe("Searching Google Maps… 1 place so far");
    expect(stageLine(running({ stage: "searching", places: 40, cell: 2, cells: 8, message: "" }))).toBe(
      "Searching Google Maps (area 2 of 8)… 40 places so far",
    );
    expect(
      stageLine(running({ stage: "searching", places: 40, retryInSeconds: 30, retry: 1, retries: 2, message: "Google Maps stopped answering searches from this computer for now. Trying again in 30 s (1 of 2)…" })),
    ).toBe("Google Maps stopped answering searches from this computer for now. Trying again in 30 s (1 of 2)…");
    expect(stageLine(running({ stage: "checking_websites", places: 12, message: "" }))).toBe("Looking for emails on websites…");
    expect(stageLine(running({ stage: "checking_websites", places: 12, checked: 3, toCheck: 12, message: "" }))).toBe(
      "Looking for emails on websites: 3 of 12",
    );
  });

  it("says where the search looks once the place is found", () => {
    const place = { name: "Petaling Jaya", type: "city", label: "Petaling Jaya, Selangor, Malaysia" };
    expect(aroundLine(job({ status: "running", place, reconciliation: undefined }))).toBe("Searching around Petaling Jaya, Selangor, Malaysia");
    expect(aroundLine(job({ status: "running", place: { name: "Ipoh", type: "city" }, reconciliation: undefined }))).toBe("Searching around Ipoh");
    expect(aroundLine(job({ status: "running", reconciliation: undefined }))).toBeNull();
  });

  it("shows expected time on a single search and omits it on a whole-city grid", () => {
    expect(expectedTimeLine(job({ options: { ...job().options, depth: 1 } }))).toBe("Usually 15–25 seconds");
    expect(expectedTimeLine(job({ options: { ...job().options, depth: 10, limit: 120 } }))).toBe("Usually 1–2 minutes");
    expect(expectedTimeLine(job({ options: { ...job().options, depth: 10, wholeCity: true } }))).toBeNull();
    expect(expectedTimeLine(job({ options: { ...job().options, depth: 10, limit: 200 } }))).toBeNull();
  });
});

describe("the properties line", () => {
  it("counts places, WhatsApp and email, then says when and where", () => {
    const rows = [
      lead({ whatsapp: "https://wa.me/351912345678", emails: ["a@b.test"] }),
      lead({ whatsapp: "https://wa.me/819012345678" }),
      lead(),
    ];
    const now = new Date("2026-11-19T20:00:00Z");
    const facts = listFacts(job({ place: { name: "Lisboa", type: "city" } }), rows, now, "en-GB", "UTC");
    expect(facts).toEqual([
      { value: "3", label: "places" },
      { value: "2", label: "on WhatsApp" },
      { value: "1", label: "with email" },
      { label: "Today, 17:42" },
      { label: "Lisboa" },
    ]);
  });

  it("says one place, and leaves out the place when the job does not know it", () => {
    const facts = listFacts(job(), [lead()], new Date("2026-11-19T20:00:00Z"), "en-GB", "UTC");
    expect(facts.slice(0, 3)).toEqual([
      { value: "1", label: "place" },
      { value: "0", label: "on WhatsApp" },
      { value: "0", label: "with email" },
    ]);
    expect(facts).toHaveLength(4);
  });

  it("adds how many places came from web search, only when there are any", () => {
    const now = new Date("2026-11-19T20:00:00Z");
    const mixed = [lead(), lead({ source: "web" }), lead({ source: "web", emails: ["a@b.test"] }), lead({ source: null })];
    expect(listFacts(job(), mixed, now, "en-GB", "UTC")).toEqual([
      { value: "4", label: "places" },
      { value: "0", label: "on WhatsApp" },
      { value: "1", label: "with email" },
      { value: "2", label: "from web search" },
      { label: "Today, 17:42" },
    ]);
    const maps = listFacts(job(), [lead(), lead({ source: "fixture" }), lead({ source: null })], now, "en-GB", "UTC");
    expect(maps.map((f) => f.label)).not.toContain("from web search");
  });

  it("dates older lists", () => {
    const at = new Date("2026-11-19T17:42:00Z");
    expect(when(at, new Date("2026-11-20T08:00:00Z"), "en-GB", "UTC")).toBe("Yesterday, 17:42");
    expect(when(at, new Date("2026-11-25T08:00:00Z"), "en-GB", "UTC")).toBe("19 Nov, 17:42");
  });
});

describe("Contact icons", () => {
  it("give every row a website link and a WhatsApp link, each only when the row has it", () => {
    const both = lead({ whatsapp: "https://wa.me/351912345678", phone: "912 345 678", website: "https://clinica.test/" });
    expect(websiteLink(both)).toMatchObject({ href: "https://clinica.test/", hint: "clinica.test" });
    expect(whatsappLink(both)).toMatchObject({ href: "https://wa.me/351912345678", hint: "WhatsApp" });
    expect(websiteLink({ ...both, website: null })).toBeNull();
    expect(whatsappLink({ ...both, whatsapp: null })).toBeNull();
    // A phone number alone links nothing: the number stays as text, with no Call button.
    const phoneOnly = lead({ phone: "912 345 678" });
    expect(websiteLink(phoneOnly)).toBeNull();
    expect(whatsappLink(phoneOnly)).toBeNull();
  });

  it("name the place in each link's accessible name", () => {
    expect(websiteLink(lead({ website: "https://a.test/" }))?.name).toBe("Open Clínica Dentária São João's website");
    expect(whatsappLink(lead({ whatsapp: "https://wa.me/1" }))?.name).toBe("WhatsApp Clínica Dentária São João");
  });

  it("treat a chat link in the website field as WhatsApp, not a website", () => {
    const chat = lead({ website: "https://wa.me/971501234567" });
    expect(websiteLink(chat)).toBeNull();
    expect(whatsappLink(chat)?.href).toBe("https://wa.me/971501234567");
  });

  it("keep a social profile as the website, and say which network it is", () => {
    const facebook = websiteLink(lead({ website: "https://www.facebook.com/tokyo.dental.test" }));
    expect(facebook).toMatchObject({ hint: "Facebook", name: "Open Clínica Dentária São João on Facebook" });
  });

  it("never link anything but WhatsApp chats and web addresses", () => {
    expect(whatsappLink(lead({ whatsapp: "javascript:alert(1)" }))).toBeNull();
    expect(whatsappLink(lead({ whatsapp: "https://wa.me.evil.test/1" }))).toBeNull();
    expect(websiteLink(lead({ website: "javascript:alert(1)" }))).toBeNull();
  });
});

describe("which links open a WhatsApp chat", () => {
  it("accepts https and http links to WhatsApp's own hosts", () => {
    for (const url of [
      "https://wa.me/60120000001",
      "http://wa.me/60120000001",
      "https://api.whatsapp.com/send?phone=60120000001",
      "http://api.whatsapp.com/send?phone=60120000001",
      "https://whatsapp.com/send?phone=60120000001",
      "https://www.whatsapp.com/send?phone=60120000001",
      "https://www.wa.me/60120000001",
      "https://WA.ME/60120000001",
    ]) {
      expect(chatHref(url), url).not.toBeNull();
    }
  });

  it("rejects look-alike hosts, other schemes and text that is not a link", () => {
    for (const url of [
      "https://wa.me.evil.com/1",
      "https://evilwa.me/1",
      "https://whatsapp.com.evil.test/send",
      "https://api.whatsapp.com.evil.test/send",
      "https://notwhatsapp.com/1",
      "ftp://wa.me/1",
      "javascript:alert(1)",
      "wa.me/60120000001",
      "+60 12-000 0001",
      "",
      null,
    ]) {
      expect(chatHref(url), String(url)).toBeNull();
    }
  });

  it("agrees with the website label on every host, so a website named WhatsApp is always the WhatsApp icon", () => {
    const urls = [
      "https://wa.me/1",
      "https://api.whatsapp.com/send?phone=1",
      "https://whatsapp.com/send?phone=1",
      "https://www.whatsapp.com/send?phone=1",
      "https://m.whatsapp.com/send?phone=1",
      "https://www.wa.me/1",
      "https://wa.me.evil.com/1",
      "https://www.facebook.com/page",
      "https://clinica.test/",
    ];
    for (const url of urls) {
      expect(chatHref(url) !== null, url).toBe(websiteLabel(url).network === "WhatsApp");
    }
  });

  it("shows a whatsapp.com website as the WhatsApp icon, not the globe", () => {
    const row = lead({ website: "https://whatsapp.com/send?phone=60120000001" });
    expect(websiteLink(row)).toBeNull();
    expect(whatsappLink(row)?.href).toBe("https://whatsapp.com/send?phone=60120000001");
  });
});

describe("the WhatsApp count", () => {
  it("counts exactly the rows that show a WhatsApp link", () => {
    const leads = [
      lead({ whatsapp: "https://wa.me/1" }),
      lead({ whatsapp: "not a link" }),
      lead({ whatsapp: "+351 912 345 678" }),
      lead({ website: "https://wa.me/2" }),
      lead({ website: "https://clinica.test/" }),
    ];
    expect(leads.map(hasWhatsApp)).toEqual(leads.map((l) => whatsappLink(l) !== null));
    expect(listFacts(job(), leads, new Date("2026-11-19T20:00:00Z"), "en-GB", "UTC")[1]).toEqual({ value: "2", label: "on WhatsApp" });
  });
});

describe("endOfListLine", () => {
  it("says Google Maps showed everything for one search on a done single search", () => {
    expect(endOfListLine(job({ status: "done", reason: "end-of-list" }))).toBe(
      "That's everything Google Maps shows for one search.",
    );
  });

  it("says nothing for non-done lists, other stop reasons, or a whole-city grid", () => {
    expect(endOfListLine(job({ status: "done", reason: "depth" }))).toBeNull();
    expect(endOfListLine(job({ status: "done", reason: "timeout" }))).toBeNull();
    expect(endOfListLine(job({ status: "done" }))).toBeNull();
    expect(endOfListLine(job({ status: "done", reason: "end-of-list", options: { ...job().options, wholeCity: true } }))).toBeNull();
    expect(endOfListLine(job({ status: "done", reason: "end-of-list", options: { ...job().options, limit: 200 } }))).toBeNull();
    expect(endOfListLine(job({ status: "failed", reason: "end-of-list" }))).toBeNull();
    expect(endOfListLine(job({ status: "cancelled", reason: "end-of-list" }))).toBeNull();
  });
});

describe("where a place came from", () => {
  it("is web search only for rows with source web; Maps rows carry no label", () => {
    expect(fromWeb(lead({ source: "web" }))).toBe(true);
    expect(fromWeb(lead({ source: "browser" }))).toBe(false);
    expect(fromWeb(lead({ source: "fixture" }))).toBe(false);
    expect(fromWeb(lead({ source: null }))).toBe(false);
  });

  it("is read from the full export, keeping only the fields a row shows", () => {
    const full = { ...lead({ title: "Acme Events", source: "web" }), user_reviews_extended: "[...]", images: "[...]", place_id: "p1" };
    const row = toLeadRow(full);
    expect(row).toEqual(lead({ title: "Acme Events", source: "web" }));
    expect(Object.keys(row)).not.toContain("user_reviews_extended");
  });

  it("reads as Maps when the export has no source or an unknown one", () => {
    const { source: _, ...noSource } = lead();
    expect(toLeadRow(noSource).source).toBeNull();
    expect(toLeadRow({ ...lead(), source: "carrier pigeon" }).source).toBeNull();
    expect(toLeadRow({ ...lead(), source: 7 }).source).toBeNull();
  });
});

describe("the rail on window focus", () => {
  it("re-reads the lists each time the window regains focus, and stops when asked", () => {
    const window = new EventTarget();
    const refresh = vi.fn();
    const stop = refreshOnFocus(window, refresh);
    window.dispatchEvent(new Event("blur"));
    expect(refresh).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("a list that combines runs of one search", () => {
  it("reads the new and not-found markers from the rows", () => {
    expect(toLeadRow({ ...lead(), new: true, not_found_last_time: false })).toMatchObject({ fresh: true, gone: false });
    expect(toLeadRow({ ...lead(), new: false, not_found_last_time: true })).toMatchObject({ fresh: false, gone: true });
    expect(toLeadRow({ ...lead() })).toMatchObject({ fresh: false, gone: false });
  });

  it("words each marker without a date when every run was on the same day, keeps the date when days differ, and shows none on one run", () => {
    const day = markerDay("2026-11-19T10:00:00Z", "en-GB", "UTC");
    expect(day).toBe("19 Nov");
    const sameDay = markerContext("2026-11-19T15:00:00Z", ["2026-11-19T10:00:00Z", "2026-11-19T15:00:00Z"], 2, "en-GB", "UTC");
    expect(rowMarker(lead({ fresh: true }), sameDay)).toBe("New since the last search");
    expect(rowMarker(lead({ gone: true }), sameDay)).toBe("Not in the last search");
    expect(rowMarker(lead(), sameDay)).toBeNull();

    const diffDay = markerContext("2026-11-19T10:00:00Z", ["2026-11-18T10:00:00Z", "2026-11-19T10:00:00Z"], 2, "en-GB", "UTC");
    expect(rowMarker(lead({ fresh: true }), diffDay)).toBe("New on 19 Nov");
    expect(rowMarker(lead({ gone: true }), diffDay)).toBe("Not in the 19 Nov search");

    expect(markerContext("2026-11-19T10:00:00Z", ["2026-11-19T10:00:00Z"], 1, "en-GB", "UTC")).toBeNull();
    expect(rowMarker(lead({ fresh: true }), null)).toBeNull();
  });

  it("counts the new places on the properties line, only when there are some", () => {
    const facts = listFacts(job(), [lead({ fresh: true }), lead({ fresh: true }), lead()]);
    expect(facts).toContainEqual({ value: "2", label: "new since the last search" });
    expect(listFacts(job(), [lead()]).some((f) => f.label === "new since the last search")).toBe(false);
  });

  it("shows how many of how many when a filter is active", () => {
    const facts = listFacts(job(), [lead(), lead()], new Date("2026-11-19T20:00:00Z"), "en-GB", "UTC", 19);
    expect(facts[0]).toEqual({ value: "2", label: "of 19 shown" });
  });

  it("is not empty when the newest run found nothing but earlier runs did", () => {
    const none = job({ reconciliation: { found: 0, kept: 0, filtered: 0, duplicates: 0, toCheck: 0, fetched: 0, unreachable: 0, mismatched: 0, skipped: 0 } });
    expect(viewOf({ jobId: "job-1", job: none, missing: false, leads: null }).kind).toBe("empty");
    expect(viewOf({ jobId: "job-1", job: { ...none, runs: 2 }, missing: false, leads: null }).kind).toBe("done");
  });

  it("counts the rail entry by the combined count from the server", () => {
    expect(listCount({ ...job({ saved: 5 }), count: 12 })).toBe(12);
    expect(listCount({ ...job({ status: "running" }), count: 12 })).toBeNull();
    expect(listCount({ ...job({ status: "cancelled" }), count: 0 })).toBeNull();
  });

  it("enables the geo-grid for whole-city searches or exact limits above 120", () => {
    expect(usesWholeCityGrid({})).toBe(false);
    expect(usesWholeCityGrid({ limit: 120 })).toBe(false);
    expect(usesWholeCityGrid({ limit: 121 })).toBe(true);
    expect(usesWholeCityGrid({ wholeCity: true, limit: 20 })).toBe(true);
  });
});

describe("state after deleting a list", () => {
  const entry = (id: string, keyword: string, city = "Lisbon, Portugal") => ({
    ...job({ id, keyword, city }),
    title: listTitle({ keyword, city }),
  });

  it("removes the list from the rail and opens the next list, or previous when last, or New list when empty", () => {
    const a = entry("a", "dentist");
    const b = entry("b", "florist");
    const c = entry("c", "bakery");

    expect(afterDelete([a, b, c], a)).toEqual({ lists: [b, c], nextId: "b", url: "/?job=b" });
    expect(afterDelete([a, b, c], b)).toEqual({ lists: [a, c], nextId: "c", url: "/?job=c" });
    expect(afterDelete([a, b, c], c)).toEqual({ lists: [a, b], nextId: "b", url: "/?job=b" });
    expect(afterDelete([a], a)).toEqual({ lists: [], nextId: null, url: "/" });
  });

  it("matches a combined search even when deleted from an older run's id, and keeps separate add --title lists apart", () => {
    const newest = entry("new-1", "Dentist", "lisbon, portugal");
    const other = entry("other", "florist");
    const olderRun = job({ id: "old-1", keyword: "dentist", city: "Lisbon, Portugal" });
    expect(afterDelete([newest, other], olderRun)).toEqual({ lists: [other], nextId: "other", url: "/?job=other" });

    const webA = entry("web-a", "Agencies", "");
    const webB = entry("web-b", "Agencies", "");
    expect(afterDelete([webA, webB], webA)).toEqual({ lists: [webB], nextId: "web-b", url: "/?job=web-b" });
  });
});

describe("delete confirmation wording", () => {
  it("names the list and places for one run, and names the run count only when more than one", () => {
    expect(deleteConfirmMessage({ title: "Event management in Kuala Lumpur", runs: 1, places: 19 })).toEqual({
      heading: 'Delete "Event management in Kuala Lumpur"?',
      description: "Its 19 places will be removed from this computer. This can't be undone.",
    });
    expect(deleteConfirmMessage({ title: "Dentist in Lisbon", runs: 1, places: 1 })).toEqual({
      heading: 'Delete "Dentist in Lisbon"?',
      description: "Its 1 place will be removed from this computer. This can't be undone.",
    });
    expect(deleteConfirmMessage({ title: "Button shop in Melaka", runs: 1, places: 0 })).toEqual({
      heading: 'Delete "Button shop in Melaka"?',
      description: "It will be removed from this computer. This can't be undone.",
    });
    expect(deleteConfirmMessage({ title: "Event management in Kuala Lumpur", runs: 3, places: 42 })).toEqual({
      heading: 'Delete "Event management in Kuala Lumpur"?',
      description: "Its 3 searches and 42 places will be removed from this computer. This can't be undone.",
    });
  });

  it("states that deleting from a filtered view removes the whole list, not only the shown rows", () => {
    expect(deleteConfirmMessage({ title: "Dentist in Lisbon", runs: 1, places: 19, shownPlaces: 4 })).toEqual({
      heading: 'Delete "Dentist in Lisbon"?',
      description:
        "Its 19 places will be removed from this computer. This deletes the whole list, not only the 4 places shown. This can't be undone.",
    });
  });
});

describe("multi-keyword web helpers", () => {
  it("shows keyword X of Y in plain words during running, and full keywords on the properties line", () => {
    const multi = job({
      status: "running",
      options: { keyword: "souvenir shop", keywords: ["souvenir shop", "纪念品店", "kedai cenderamata"], city: "Melaka", depth: 10, lang: "en", emails: true, socials: true, deep: true, maxSeconds: 600 },
      progress: { stage: "searching", places: 25, keywordIndex: 2, keywordsTotal: 3, currentKeyword: "纪念品店", message: "" },
    });
    expect(stageLine(multi)).toBe("Searching Google Maps (keyword 2 of 3)… 25 places so far");

    const gridMulti = job({
      status: "running",
      options: { ...multi.options, wholeCity: true },
      progress: { stage: "searching", places: 42, keywordIndex: 2, keywordsTotal: 3, cell: 3, cells: 12, message: "" },
    });
    expect(stageLine(gridMulti)).toBe("Searching Google Maps (keyword 2 of 3, area 3 of 12)… 42 places so far");

    const facts = listFacts(multi, [lead()], new Date("2026-11-19T20:00:00Z"), "en-GB", "UTC");
    expect(facts.at(-1)).toEqual({ label: "souvenir shop, 纪念品店, kedai cenderamata" });
  });

  it("round-trips multi-keyword searches through queryOf and toRequest for every size choice", async () => {
    const { queryOf, readQuery, toRequest } = await import("../web/src/lib/search.js");
    for (const size of ["about20", "oneSearch", "wholeCity"] as const) {
      const req = toRequest({
        keyword: "souvenir shop, 纪念品店, kedai cenderamata",
        city: "Melaka",
        size,
        exact: "",
        emails: true,
        lang: "en",
        country: "MY",
      });
      expect(req.keyword).toBe("souvenir shop");
      expect(req.keywords).toEqual(["souvenir shop", "纪念品店", "kedai cenderamata"]);
      const roundTripped = queryOf({ ...req });
      expect(roundTripped).toMatchObject({
        keyword: "souvenir shop, 纪念品店, kedai cenderamata",
        city: "Melaka",
        size,
        exact: "",
      });
      expect(toRequest(roundTripped)).toEqual(req);
      expect(readQuery(roundTripped)).toEqual(roundTripped);
    }
    // oneSearch with multiple keywords leaves limit undefined so later keywords are not cut off at 120 total.
    const oneSearchMulti = toRequest({
      keyword: "souvenir shop, 纪念品店",
      city: "Melaka",
      size: "oneSearch",
      exact: "",
      emails: true,
      lang: "en",
      country: "",
    });
    expect(oneSearchMulti.limit).toBeUndefined();
    expect(queryOf(oneSearchMulti).size).toBe("oneSearch");
  });
});

describe("phone country list", () => {
  it("lists every region Intl.DisplayNames can name, sorted by display name, including Brazil and Mexico", async () => {
    const { COUNTRY_CODES, countryName } = await import("../web/src/lib/search.js");
    expect(COUNTRY_CODES.length).toBeGreaterThan(200);
    expect(COUNTRY_CODES).toContain("BR");
    expect(COUNTRY_CODES).toContain("MX");
    expect(COUNTRY_CODES).toContain("MY");
    expect(countryName("BR")).toBe("Brazil");
    expect(countryName("MX")).toBe("Mexico");
    const names = COUNTRY_CODES.map((c) => countryName(c));
    expect(new Set(names).size).toBe(names.length);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
    expect(COUNTRY_CODES).not.toContain("ZZ");
    expect(COUNTRY_CODES).not.toContain("XA");
  });
});
