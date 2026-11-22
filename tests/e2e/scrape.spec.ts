// The web UI against the fixture servers (scripts/e2e-serve.ts). The main
// port replays the synthetic 20-place Malaysian fixture (tests/fixtures/run20.ts):
// 20 places, one duplicate, so 19 leads; ZZMARK-1..12 have mobile numbers,
// ZZMARK-13..18 landlines. The next port replays dentists in Lisbon
// (tests/fixtures/world.ts). Every test shares the servers, so jobs pile up.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, test, type Page } from "@playwright/test";
import { E2E_PORT } from "../../playwright.config";
import { makeBatch } from "../fixtures/batch";

const BOM = [0xef, 0xbb, 0xbf];
const LIST_URL = /\/\?job=[0-9a-f-]+$/;

/** Collects console errors and uncaught page errors for the test's duration. */
function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

/** Hides the server's jobs, so the page looks like a first visit. */
async function hideJobs(page: Page) {
  await page.route(/\/api\/v1\/lists$/, (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: { lists: [] } }) : route.fallback(),
  );
}

async function search(page: Page, what: string, where: string) {
  await page.getByLabel("What").fill(what);
  await page.getByLabel("Where").fill(where);
  await page.getByRole("button", { name: "Find", exact: true }).click();
}

/** Waits until a search has finished, website checks included: Download for Excel replaces Cancel then. */
async function finished(page: Page, count: number) {
  await expect(rows(page)).toHaveCount(count);
  await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible();
}

/** Rewrites every read of a job, e.g. to hold it mid-run or make it fail. */
async function rewriteJob(page: Page, change: (job: Record<string, unknown>) => void) {
  await page.route(/\/api\/v1\/lists\/[^/?]+$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const job = await response.json();
    change(job);
    await route.fulfill({ response, json: job });
  });
}

const rows = (page: Page) => page.getByRole("main").getByRole("list").first().locator(":scope > li");

test("a first visit asks what to find and where, with examples", async ({ page }) => {
  const errors = watchConsole(page);
  await hideJobs(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Find businesses to contact" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Example searches" })).toBeVisible();
  await expect(page.getByText("Your searches will be kept here.")).toBeVisible();
  // One filled button on the page: Find. No CSV wording anywhere.
  await expect(page.getByRole("button", { name: "Find", exact: true })).toBeVisible();
  await expect(page.getByText(/CSV/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a search becomes a list with its own URL, 19 places, website and WhatsApp icons and an Excel download with a BOM", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await search(page, "souvenir shop", "Melaka");

  await expect(page).toHaveURL(LIST_URL);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Souvenir shop in Melaka");
  await expect(rows(page)).toHaveCount(19);
  await expect(page.getByText("19 places", { exact: true })).toBeVisible();
  await expect(page.getByText("12 on WhatsApp", { exact: true })).toBeVisible();
  // The searched place, as the job reports it.
  await expect(page.getByRole("main").getByText("Melaka", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Looked for emails on 10 websites: /)).toBeVisible();

  // Every row: Website, then WhatsApp. Present ones open in a new tab; missing ones are not links.
  const site = page.getByRole("link", { name: "Open ZZMARK-1's website", exact: true });
  await expect(site).toHaveAttribute("href", "https://shop-1.test/");
  const chat = page.getByRole("link", { name: "WhatsApp ZZMARK-1", exact: true });
  await expect(chat).toHaveAttribute("href", "https://wa.me/60120000001");
  for (const link of [site, chat]) {
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  // ZZMARK-11: a mobile but no website. ZZMARK-13: a landline and no website, so neither.
  const only = rows(page).filter({ has: page.getByText("ZZMARK-11", { exact: true }) });
  await expect(only.getByRole("link")).toHaveCount(1);
  await expect(only.getByRole("img", { name: "No website" })).toBeVisible();
  const neither = rows(page).filter({ has: page.getByText("ZZMARK-13", { exact: true }) });
  await expect(neither.getByRole("link")).toHaveCount(0);
  await expect(neither.getByRole("img", { name: "No website" })).toHaveAttribute("title", "No website");
  await expect(neither.getByRole("img", { name: "No WhatsApp" })).toHaveAttribute("title", "No WhatsApp");
  // No Call button: the number stays as text.
  await expect(page.getByRole("link", { name: /^Call / })).toHaveCount(0);
  // The header's WhatsApp count matches the rows that link to WhatsApp.
  await expect(page.getByRole("link", { name: /^WhatsApp ZZMARK-/ })).toHaveCount(12);
  // The fixture search ends at the end of Google's results, so the find-more block sits at the bottom.
  await expect(page.getByText("That's everything Google Maps shows for one search.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Search the whole city (5–15 min)" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Change the search" })).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download for Excel" }).click()]);
  expect([...readFileSync(await download.path()).subarray(0, 3)]).toEqual(BOM);
  expect(download.suggestedFilename()).toMatch(/\.csv$/);

  // JSON lives in the ··· menu.
  await page.getByRole("button", { name: "More actions" }).click();
  const [json] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Download for developers (JSON)" }).click(),
  ]);
  expect(JSON.parse(readFileSync(await json.path(), "utf8"))).toHaveLength(19);
  expect(errors).toEqual([]);
});

test("reload stays on the list, an older list opens from the rail, and Edit search makes a new list", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await search(page, "souvenir shop", "Melaka");
  await expect(rows(page)).toHaveCount(19);
  const older = page.url();

  await page.getByRole("link", { name: "New list" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel("What")).toBeFocused();
  await search(page, "batik shop", "Melaka");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Batik shop in Melaka");
  await expect(rows(page)).toHaveCount(19);
  const newer = page.url();
  expect(newer).not.toBe(older);

  await page.reload();
  await expect(page).toHaveURL(newer);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Batik shop in Melaka");
  await expect(rows(page)).toHaveCount(19);

  // The rail shows each search once, newest first, with the open one marked.
  const lists = page.getByRole("navigation", { name: "Lists" });
  await expect(lists.getByRole("link", { name: /Souvenir shop in Melaka/ })).toHaveCount(1);
  await expect(lists.locator("[aria-current=page]")).toContainText("Batik shop in Melaka");
  await lists.getByRole("link", { name: /Souvenir shop in Melaka/ }).click();
  await expect(page).toHaveURL(older);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Souvenir shop in Melaka");
  await expect(rows(page)).toHaveCount(19);

  // Back and Forward land where the person was.
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Batik shop in Melaka");
  await page.goForward();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Souvenir shop in Melaka");

  // Edit search: the form starts from this list's search; submitting makes a new list.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Search again" }).click();
  await expect(page.getByLabel("What")).toHaveValue("souvenir shop");
  await expect(page.getByLabel("Where")).toHaveValue("Melaka");
  await expect(page.getByRole("main").getByRole("list")).toHaveCount(0);
  await page.getByLabel("What").fill("gift shop");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Gift shop in Melaka");
  await expect(page).toHaveURL(LIST_URL);
  expect([older, newer]).not.toContain(page.url());
  expect(errors).toEqual([]);
});

test("a job list that answers late does not wipe what is being typed", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/v1\/lists$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await held;
    await route.fallback();
  });
  await page.goto("/");
  await page.getByLabel("What").fill("florist");
  await page.getByLabel("Where").pressSequentially("Ipo");
  release();
  await expect(page.getByRole("navigation", { name: "Lists" }).getByRole("listitem").first()).toBeVisible();
  await page.getByLabel("Where").pressSequentially("h");
  await expect(page.getByLabel("What")).toHaveValue("florist");
  await expect(page.getByLabel("Where")).toHaveValue("Ipoh");
  await expect(page.getByLabel("Where")).toBeFocused();
});

test("submitting without a city says 'Enter a city' next to Find", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("What").fill("souvenir shop");
  const button = page.getByRole("button", { name: "Find", exact: true });
  await button.click();
  const describedBy = await button.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText("Enter a city.");
  await expect(page.getByLabel("Where")).toHaveAttribute("aria-invalid", "true");
  await expect(page).toHaveURL(/\/$/);
});

test("an empty field looks empty: its example text starts with 'e.g.' and is lighter than typed text", async ({ page }) => {
  await page.goto("/");
  const what = page.getByRole("textbox", { name: "What" });
  for (const label of ["What", "Where"]) {
    expect(await page.getByRole("textbox", { name: label }).getAttribute("placeholder")).toMatch(/^e\.g\. /);
  }
  const placeholder = await what.evaluate((el) => getComputedStyle(el, "::placeholder").color);
  const typed = await what.evaluate((el) => getComputedStyle(el).color);
  expect(placeholder).not.toBe(typed);
});

test("a failed search says why and offers Try again, which starts a new list", async ({ page }) => {
  const errors = watchConsole(page);
  let fail = true;
  await rewriteJob(page, (job) => {
    if (!fail || job.status !== "done") return;
    job.status = "failed";
    job.error = "City not found: Melaka";
    delete job.reconciliation;
    // A city that is not found fails before any row is saved.
    delete job.saved;
  });
  await page.goto("/");
  // A search no other test runs: a list that combines earlier runs keeps their places next to the error.
  await search(page, "lantern shop", "Melaka");
  await expect(page.getByText("City not found: Melaka")).toBeVisible();
  const failed = page.url();
  await expect(page.getByRole("button", { name: "Edit search" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download for Excel" })).toHaveCount(0);

  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(rows(page)).toHaveCount(19);
  expect(page.url()).not.toBe(failed);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Lantern shop in Melaka");
  expect(errors).toEqual([]);
});

test("a search Google limited part-way keeps its places next to the reason", async ({ page }) => {
  await rewriteJob(page, (job) => {
    if (job.status !== "done") return;
    job.status = "failed";
    job.error = "Google Maps stopped answering searches from this computer for now. Wait a few minutes, then try again.";
  });
  await page.goto("/");
  await search(page, "souvenir shop", "Melaka");
  await expect(page.getByText("Google Maps stopped answering searches from this computer for now. Wait a few minutes, then try again.")).toBeVisible();
  await expect(page.getByText("These are the 19 places it read before it stopped; the list may be missing some.")).toBeVisible();
  await expect(rows(page)).toHaveCount(19);
  await expect(page.getByRole("button", { name: "Download for Excel" })).toBeEnabled();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  // A job read still being rewritten when the test ends must not fail it.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a search that found nothing says so and offers Edit search", async ({ page }) => {
  await rewriteJob(page, (job) => {
    if (job.status !== "done") return;
    job.reconciliation = { found: 0, kept: 0, filtered: 0, duplicates: 0, toCheck: 0, fetched: 0, unreachable: 0, mismatched: 0, skipped: 0 };
    delete job.saved;
  });
  await page.goto("/");
  // A search no other test runs: a list with earlier runs is never empty.
  await search(page, "button shop", "Melaka");
  await expect(page.getByText("No places found for this search.")).toBeVisible();
  await page.getByRole("button", { name: "Edit search" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel("What")).toHaveValue("button shop");
});

test("an unknown list says it is no longer available", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?job=00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("heading", { level: 1, name: "This list is no longer available." })).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: "＋ New list" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Find businesses to contact" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a running list says its stage in plain words, and reduced motion stops the bar", async ({ page }) => {
  await rewriteJob(page, (job) => {
    job.status = "running";
    delete job.reconciliation;
    job.progress = { stage: "checking_websites", places: 19, checked: 4, toCheck: 10, message: "Checking websites… 4/10" };
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await search(page, "souvenir shop", "Melaka");
  await expect(page.getByRole("status")).toHaveText("Looking for emails on websites: 4 of 10");
  await expect(page.getByRole("button", { name: "Download for Excel" })).toHaveCount(0);
  const indicator = page.getByRole("progressbar").locator("[data-slot=progress-indicator]");
  const motion = await indicator.evaluate((el) => {
    const s = getComputedStyle(el);
    return { transition: s.transitionProperty, animation: s.animationName };
  });
  expect(motion).toEqual({ transition: "none", animation: "none" });
});

test("a running search says where it looks, with the state and country it found", async ({ page }) => {
  await rewriteJob(page, (job) => {
    job.status = "running";
    delete job.reconciliation;
    job.progress = { stage: "searching", places: 7, message: "Searching Melaka… 7 places" };
  });
  await page.goto("/");
  await search(page, "batik shop", "Melaka");
  await expect(page.getByText("Searching around Melaka, Malaysia", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Searching Google Maps… 7 places so far");
});

test("a place found in another country than the phone country stops, naming what it found", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await page.getByText("More options", { exact: true }).click();
  await page.getByLabel("Country for phone numbers").click();
  await page.getByRole("option", { name: "Portugal" }).click();
  // A search no other test runs, so no earlier run's places sit next to the error.
  await search(page, "kite shop", "Melaka");
  await expect(page.getByText("Melaka matched Melaka in Malaysia, not Portugal. Write the full place name with its region and country.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit search" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download for Excel" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a list opened while another runs shows its own state, and the running one gets its count when it ends", async ({ page }) => {
  await page.goto("/");
  await search(page, "souvenir shop", "Melaka");
  await expect(rows(page)).toHaveCount(19);
  const done = page.url();

  // Hold the next search mid-run while it is open, then open the finished list.
  let hold = true;
  await rewriteJob(page, (job) => {
    if (!hold || job.status !== "done" || (job.options as { keyword: string }).keyword !== "kite shop") return;
    job.status = "running";
    delete job.reconciliation;
    job.progress = { stage: "searching", places: 7, message: "" };
  });
  // The rail reads the job list, so the held search looks running there too.
  await page.route(/\/api\/v1\/lists$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as { lists: Record<string, unknown>[] };
    for (const job of body.lists) {
      if (hold && (job.options as { keyword: string }).keyword === "kite shop") {
        job.status = "running";
        delete job.reconciliation;
      }
    }
    await route.fulfill({ response, json: body });
  });
  await page.getByRole("link", { name: "New list" }).click();
  await search(page, "kite shop", "Melaka");
  await expect(page.getByRole("status")).toHaveText("Searching Google Maps… 7 places so far");
  const lists = page.getByRole("navigation", { name: "Lists" });
  await expect(lists.getByRole("link", { name: /Kite shop in Melaka/ })).toContainText("searching");

  await page.goto(done);
  await expect(rows(page)).toHaveCount(19);
  await expect(page.getByRole("status")).toHaveCount(0);
  hold = false;
  await page.unroute(/\/api\/v1\/lists\/[^/?]+$/);
  // The rail re-reads the lists while another search runs.
  await expect(lists.getByRole("link", { name: /Kite shop in Melaka/ })).toContainText("19");
});

test("the keyboard reaches New list, every list, the fields, Find, then Download and each row's present links", async ({ page }) => {
  await page.goto("/");
  await search(page, "souvenir shop", "Melaka");
  await expect(rows(page)).toHaveCount(19);
  // A fresh load of the form: nothing is focused, so Tab starts at the top.
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Lists" }).getByRole("listitem").first()).toBeVisible();

  const order = async (count: number) => {
    const seen: string[] = [];
    for (let i = 0; i < count; i++) {
      await page.keyboard.press("Tab");
      seen.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          return (el.getAttribute("aria-label") ?? el.textContent ?? "").trim() || el.id;
        }),
      );
    }
    return seen;
  };
  const listCount = await page.getByRole("navigation", { name: "Lists" }).getByRole("listitem").count();
  const form = await order(listCount + 6);
  expect(form[0]).toBe("New list");
  // How many places is one stop for the radio group, then the closed More options (which holds Exact number).
  expect(form.slice(listCount + 1)).toEqual(["what", "where", "size-oneSearch", "More options", "Find"]);

  await page.getByLabel("What").fill("tea shop");
  await page.getByLabel("Where").fill("Melaka");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await finished(page, 19);
  // Opening a list moves focus to its title; Tab goes through Download, More actions, the filter/sort controls, and the rows.
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Download for Excel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "More actions" })).toBeFocused();
  for (const label of [
    "Has WhatsApp",
    "Has email",
    "Has website",
    "Has phone",
    "More filters",
    "Sort by",
  ]) {
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      return (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
    });
    expect(active).toBe(label);
  }
  // Each row's website, then its WhatsApp; a missing one is skipped.
  const expected = [
    ...Array.from({ length: 10 }, (_, i) => [`Open ZZMARK-${i + 1}'s website`, `WhatsApp ZZMARK-${i + 1}`]).flat(),
    "WhatsApp ZZMARK-11",
    "WhatsApp ZZMARK-12",
  ];
  const seen: string[] = [];
  for (const _ of expected) {
    await page.keyboard.press("Tab");
    seen.push(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""));
  }
  expect(seen).toEqual(expected);
  // Past the last present link, focus leaves the rows: the missing ones are never stops.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.closest("ul")?.getAttribute("aria-labelledby") ?? null)).toBeNull();
});

test.describe("on a 375 px phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("search, reload, open an older list from the Lists sheet and edit it, all without sideways scrolling", async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto("/");
    await expect(page.getByRole("complementary")).toBeHidden();
    await search(page, "souvenir shop", "Melaka");
    await expect(rows(page)).toHaveCount(19);
    const older = page.url();

    // Each row stacks name, phone and email, then its two icons, each a touch target of at least 44 px.
    for (const name of ["Open ZZMARK-1's website", "WhatsApp ZZMARK-1"]) {
      const box = (await page.getByRole("link", { name, exact: true }).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await expect(rows(page).first().getByText("012-000 0001")).toBeVisible();
    await expect(rows(page).first().getByText("zzmark1@shop-1.test")).toBeVisible();

    await page.getByRole("link", { name: "New list" }).click();
    await search(page, "craft shop", "Melaka");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Craft shop in Melaka");
    await expect(rows(page)).toHaveCount(19);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Craft shop in Melaka");

    const trigger = page.getByRole("button", { name: "Lists" });
    await trigger.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    // Escape closes the sheet and focus returns to the button that opened it.
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.click();
    await sheet.getByRole("link", { name: /Souvenir shop in Melaka/ }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(older);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Souvenir shop in Melaka");

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Search again" }).click();
    await expect(page.getByLabel("What")).toHaveValue("souvenir shop");
    await page.getByLabel("What").fill("toy shop");
    await page.getByRole("button", { name: "Find", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Toy shop in Melaka");
    expect(page.url()).not.toBe(older);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
    expect(errors).toEqual([]);
  });
});

// Dentists in Lisbon, served on the next port: names in several scripts and
// numbers from Portugal, Japan, the UAE and Germany.
test.describe("a search in another country", () => {
  test.use({ baseURL: `http://127.0.0.1:${E2E_PORT + 1}` });

  const WHATSAPP = [
    ["Clínica Dentária São João", "https://wa.me/351912345678"],
    ["東京デンタルクリニック", "https://wa.me/819012345678"],
    ["عيادة النور لطب الأسنان", "https://wa.me/971501234567"],
  ] as const;

  test("shows every script, each number's own country, and website and WhatsApp icons that tell links apart", async ({ page, context }) => {
    const errors = watchConsole(page);
    await page.goto("/");
    await search(page, "dentist", "Lisbon, Portugal");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dentist in Lisbon");
    await expect(rows(page)).toHaveCount(6);
    await expect(page.getByText("Lisbon, Portugal", { exact: true })).toBeVisible();
    await expect(page.getByText("No email found")).toHaveCount(5);

    for (const [name, href] of WHATSAPP) {
      await expect(page.getByRole("link", { name: `WhatsApp ${name}`, exact: true })).toHaveAttribute("href", href);
    }
    // A website, a Facebook page listed as the website, and a chat link listed as the website (WhatsApp only).
    await expect(page.getByRole("link", { name: "Open Clínica Dentária São João's website" })).toHaveAttribute("href", "https://clinica-sao-joao.test/");
    await expect(page.getByRole("link", { name: "Open 東京デンタルクリニック on Facebook" })).toHaveAttribute("title", "Facebook");
    const arabicRow = rows(page).filter({ hasText: "عيادة" });
    await expect(arabicRow.getByRole("link")).toHaveCount(1);
    await expect(arabicRow.getByRole("img", { name: "No website" })).toBeVisible();
    // Landlines: no links at all, and the number keeps its own country code as text.
    const landline = rows(page).filter({ hasText: "Zahnarztpraxis Müller" });
    await expect(landline.getByRole("link")).toHaveCount(0);
    await expect(landline.getByText("+49 30 1234567")).toBeVisible();
    // A landline with a website: the globe links out, WhatsApp is the grey slash.
    const siteOnly = rows(page).filter({ hasText: "Clínica Sorriso" });
    await expect(siteOnly.getByRole("link")).toHaveCount(1);
    await expect(siteOnly.getByRole("link", { name: "Open Clínica Sorriso's website", exact: true })).toHaveAttribute(
      "href",
      "https://clinica-sorriso.test/",
    );
    await expect(siteOnly.getByRole("img", { name: "No WhatsApp" })).toBeVisible();
    await expect(siteOnly.getByRole("img", { name: "No website" })).toHaveCount(0);

    // Right-to-left names read right to left, but start at the left edge, in line with their address.
    const arabic = rows(page).filter({ hasText: "عيادة" }).locator("[dir=auto]").first();
    expect(await arabic.evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
    expect(await arabic.evaluate((el) => getComputedStyle(el).textAlign)).toBe("left");
    const long = rows(page).filter({ hasText: "Centro de Medicina" }).locator("p[title]").first();
    await expect(long).toHaveAttribute("title", "Centro de Medicina Dentária Integrada e Ortodontia Avançada do Parque das Nações");
    expect(await long.evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe("2");

    await context.route("https://wa.me/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>chat</title>" }));
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page.getByRole("link", { name: "WhatsApp 東京デンタルクリニック", exact: true }).click(),
    ]);
    expect(popup.url()).toBe("https://wa.me/819012345678");
    expect(errors).toEqual([]);
  });
});

// The Lisbon search after a long wait (scripts/e2e-serve.ts, the third port),
// so it is still running when the test cancels it.
test.describe("cancelling a running search", () => {
  test.use({ baseURL: `http://127.0.0.1:${E2E_PORT + 2}` });

  // This server waits a minute before its first batch, so a cancel comes before any place is found.
  const CANCELLED = "You stopped this search early, before it found any places.";

  test("Cancel asks first; Keep searching leaves it running; confirming shows the cancelled state, which a reload keeps", async ({ page }) => {
    const errors = watchConsole(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await search(page, "dentist", "Lisbon, Portugal");
    await expect(page).toHaveURL(LIST_URL);
    const job = new URL(page.url()).searchParams.get("job");
    // Cancel is the header's one action, and it is not filled: there is no Download while it runs.
    const cancel = page.getByRole("button", { name: "Cancel search" });
    await expect(cancel).toBeVisible();
    await expect(page.getByRole("button", { name: "Download for Excel" })).toHaveCount(0);

    // Dismissing the dialog leaves the search running, and focus goes back to Cancel.
    await cancel.click();
    const dialog = page.getByRole("alertdialog", { name: "Cancel this search?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("The places it has found so far stay in this list.");
    await expect(dialog.getByRole("button", { name: "Keep searching" })).toBeFocused();
    // Focus stays inside the dialog.
    for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await dialog.getByRole("button", { name: "Keep searching" }).click();
    await expect(dialog).toBeHidden();
    await expect(cancel).toBeFocused();
    await page.waitForTimeout(1_000);
    await expect(page.getByRole("progressbar")).toBeVisible();
    expect((await (await page.request.get(`/api/v1/jobs/${job}`)).json()).status).toBe("running");

    // Escape is a dismiss too.
    await cancel.click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(cancel).toBeFocused();

    // Confirming stops it: the cancelled state shows within a second.
    await cancel.click();
    const started = Date.now();
    await dialog.getByRole("button", { name: "Cancel search" }).click();
    await expect(page.getByRole("status")).toHaveText(CANCELLED, { timeout: 1_000 });
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel search" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Download for Excel" })).toHaveCount(0);
    expect((await (await page.request.get(`/api/v1/jobs/${job}`)).json()).status).toBe("cancelled");
    // The rail says Cancelled where the count goes.
    const current = page.getByRole("navigation", { name: "Lists" }).locator("[aria-current=page]");
    await expect(current).toContainText("Cancelled");

    // Reload keeps it.
    await page.reload();
    await expect(page.getByRole("status")).toHaveText(CANCELLED);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dentist in Lisbon");

    // Edit search starts from the same search, as a new list.
    await page.getByRole("button", { name: "Edit search" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByLabel("What")).toHaveValue("dentist");
    await expect(page.getByLabel("Where")).toHaveValue("Lisbon, Portugal");
    expect(errors).toEqual([]);
  });

  test.describe("on a 375 px phone", () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

    test("the same, with 44 px buttons and no sideways scrolling", async ({ page }) => {
      const errors = watchConsole(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await search(page, "dentist", "Lisbon, Portugal");
      await expect(page).toHaveURL(LIST_URL);
      const cancel = page.getByRole("button", { name: "Cancel search" });
      await expect(cancel).toBeVisible();
      const box = (await cancel.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
      await cancel.tap();
      const dialog = page.getByRole("alertdialog", { name: "Cancel this search?" });
      await expect(dialog).toBeVisible();
      for (const name of ["Keep searching", "Cancel search"]) {
        const b = (await dialog.getByRole("button", { name }).boundingBox())!;
        expect(b.height).toBeGreaterThanOrEqual(44);
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(375);
      }
      await dialog.getByRole("button", { name: "Keep searching" }).tap();
      await expect(dialog).toBeHidden();
      await page.waitForTimeout(1_000);
      await expect(page.getByRole("progressbar")).toBeVisible();

      await cancel.tap();
      await dialog.getByRole("button", { name: "Cancel search" }).tap();
      await expect(page.getByRole("status")).toHaveText(CANCELLED, { timeout: 1_000 });
      await page.reload();
      await expect(page.getByRole("status")).toHaveText(CANCELLED);
      await expect(page.getByRole("button", { name: "Edit search" })).toBeVisible();
      await page.getByRole("button", { name: "Lists" }).tap();
      await expect(page.getByRole("dialog").locator("[aria-current=page]")).toContainText("Cancelled");
      await page.keyboard.press("Escape");

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBe(0);
      expect(errors).toEqual([]);
    });
  });
});

/** Dates one search's runs a day earlier in the job list, so the rail shows two different days. */
async function ageRun(page: Page, keyword: string, city: string) {
  await page.route(/\/api\/v1\/lists$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as { lists: { options: { keyword: string; city: string }; createdAt: string }[] };
    for (const job of body.lists) {
      if (job.options.keyword === keyword && job.options.city === city) {
        job.createdAt = new Date(Date.parse(job.createdAt) - 86_400_000).toISOString();
      }
    }
    await route.fulfill({ response, json: body });
  });
}

/**
 * WCAG contrast of a text element against the first opaque background behind
 * it (its own or an ancestor's). Every rail background is opaque.
 */
async function contrast(text: Locator): Promise<number> {
  return text.evaluate((el) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = ([r, g, b]: number[]) => {
      const [R, G, B] = [r!, g!, b!].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * R! + 0.7152 * G! + 0.0722 * B!;
    };
    let node: Element | null = el;
    let background = "rgb(255, 255, 255)";
    while (node) {
      const c = rgb(getComputedStyle(node).backgroundColor);
      if (c.length >= 3 && (c.length === 3 || c[3] === 1)) {
        background = getComputedStyle(node).backgroundColor;
        break;
      }
      node = node.parentElement;
    }
    const [a, b] = [luminance(rgb(getComputedStyle(el).color)), luminance(rgb(background))];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

/** Two runs titled the same: one in "Lisbon" (dated yesterday), then one in "Lisbon, Portugal". */
async function twoRuns(page: Page, keyword: string) {
  await ageRun(page, keyword, "Lisbon");
  await page.goto("/");
  await search(page, keyword, "Lisbon");
  await expect(rows(page)).toHaveCount(6);
  await page.getByRole("link", { name: "New list" }).click();
  await search(page, keyword, "Lisbon, Portugal");
  await expect(rows(page)).toHaveCount(6);
}

test.describe("two runs that share a title", () => {
  test.use({ baseURL: `http://127.0.0.1:${E2E_PORT + 1}` });

  test("each rail entry says what differs and when it ran, so they can be told apart without opening them", async ({ page }) => {
    await twoRuns(page, "florist");
    const entries = page.getByRole("navigation", { name: "Lists" }).getByRole("link", { name: /^Florist in Lisbon/ });
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(0)).toContainText("Lisbon, Portugal");
    await expect(entries.nth(0)).toContainText(/Today, /);
    await expect(entries.nth(1).getByText("Lisbon", { exact: true })).toBeVisible();
    await expect(entries.nth(1)).toContainText(/Yesterday, /);
    const names = await entries.evaluateAll((els) => els.map((el) => el.textContent));
    expect(new Set(names).size).toBe(2);
    // The hover hint names the whole search and when it ran.
    await expect(entries.nth(1)).toHaveAttribute("title", /^florist in Lisbon · Yesterday, /);

    // The date line is small text, so it needs 4.5:1 on the open entry's tint and on the rail, in both schemes.
    await expect(entries.nth(0)).toHaveAttribute("aria-current", "page");
    await page.mouse.move(0, 0);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      for (const entry of [entries.nth(0), entries.nth(1)]) {
        const ratio = await contrast(entry.getByText(/^(Today|Yesterday), /));
        expect(ratio, `${colorScheme}, ${await entry.getAttribute("aria-current") ? "open" : "other"} entry`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test.describe("on a 375 px phone", () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

    test("the Lists sheet tells them apart too", async ({ page }) => {
      await twoRuns(page, "bakery");
      await page.getByRole("button", { name: "Lists" }).tap();
      const entries = page.getByRole("dialog").getByRole("link", { name: /^Bakery in Lisbon/ });
      await expect(entries).toHaveCount(2);
      await expect(entries.nth(0)).toContainText("Lisbon, Portugal");
      await expect(entries.nth(0)).toContainText(/Today, /);
      await expect(entries.nth(1).getByText("Lisbon", { exact: true })).toBeVisible();
      await expect(entries.nth(1)).toContainText(/Yesterday, /);
      for (const entry of await entries.all()) {
        expect((await entry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
    });

    test("tapping a grey slashed icon shows what it means in words", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await search(page, "dentist", "Lisbon, Portugal");
      await expect(rows(page)).toHaveCount(6);
      const landline = rows(page).filter({ hasText: "Zahnarztpraxis Müller" });
      const noSite = landline.getByRole("button", { name: "No website" });
      const noChat = landline.getByRole("button", { name: "No WhatsApp" });
      for (const slot of [noSite, noChat]) {
        const box = (await slot.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      await noSite.tap();
      await expect(page.getByRole("dialog").filter({ hasText: "No website" })).toBeVisible();
      await page.keyboard.press("Escape");
      await noChat.tap();
      await expect(page.getByRole("dialog").filter({ hasText: "No WhatsApp" })).toBeVisible();
      // Still not a link: a tap only shows the words.
      await expect(landline.getByRole("link")).toHaveCount(0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBe(0);
    });
  });
});

// The Lisbon server starts with two lists an agent made (scripts/e2e-serve.ts):
// "orthodontist" in Lisbon, the six Maps places plus Shop A Florist and Shop D
// Bakery added from web search, and a list made only from those two websites.
test.describe("where each place came from", () => {
  test.use({ baseURL: `http://127.0.0.1:${E2E_PORT + 1}` });
  const MIXED = "Orthodontist in Lisbon";
  const WEB_ONLY = "Florists and bakers found on the web";
  const label = (row: Locator) => row.getByText("From web search", { exact: true });

  async function open(page: Page, title: string) {
    await page.goto("/");
    await page.getByRole("navigation", { name: "Lists" }).getByRole("link", { name: new RegExp(`^${title}`) }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  }

  test("a mixed list labels only its web-search rows, and the properties line counts them", async ({ page }) => {
    const errors = watchConsole(page);
    await open(page, MIXED);
    await expect(rows(page)).toHaveCount(8);
    for (const name of ["Shop A Florist", "Shop D Bakery"]) {
      await expect(label(rows(page).filter({ hasText: name }))).toBeVisible();
    }
    // Maps is the default: its rows carry nothing.
    for (const name of ["Clínica Sorriso", "Zahnarztpraxis Müller", "Clínica Dentária São João"]) {
      await expect(label(rows(page).filter({ hasText: name }))).toHaveCount(0);
    }
    await expect(page.getByRole("main").getByText("From web search", { exact: true })).toHaveCount(2);
    await expect(page.getByText("8 places", { exact: true })).toBeVisible();
    await expect(page.getByText("2 from web search", { exact: true })).toBeVisible();
    // The label is muted small text: still 4.5:1 on the page in both schemes.
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      expect(await contrast(label(rows(page).filter({ hasText: "Shop A Florist" }))), colorScheme).toBeGreaterThanOrEqual(4.5);
    }
    // A web row keeps its website and WhatsApp links.
    await expect(page.getByRole("link", { name: "Open Shop A Florist's website", exact: true })).toHaveAttribute("href", "https://shop-a.test/");
    await expect(page.getByRole("link", { name: "WhatsApp Shop A Florist", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("a Maps-only list shows no web-search label or count", async ({ page }) => {
    await page.goto("/");
    await search(page, "periodontist", "Lisbon, Portugal");
    await expect(rows(page)).toHaveCount(6);
    await expect(page.getByText("From web search")).toHaveCount(0);
    await expect(page.getByText(/from web search/)).toHaveCount(0);
  });

  test("a list made only by add is titled by its --title and offers no search to run again", async ({ page }) => {
    await open(page, WEB_ONLY);
    await expect(page).toHaveTitle(`${WEB_ONLY} · Business Finder`);
    const entry = page.getByRole("navigation", { name: "Lists" }).getByRole("link", { name: new RegExp(`^${WEB_ONLY}`) });
    await expect(entry).toHaveAttribute("title", new RegExp(`^${WEB_ONLY} · Today, `));
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByRole("main").getByText("From web search", { exact: true })).toHaveCount(2);
    await expect(page.getByText("2 from web search", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Download for developers (JSON)" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Search again" })).toHaveCount(0);
  });

  test("a list made after the page opened appears in the rail when the window regains focus, without a reload", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Lists" });
    await expect(nav.getByRole("link", { name: new RegExp(`^${MIXED}`) })).toBeVisible();
    await page.evaluate(() => ((window as unknown as { kept: boolean }).kept = true));

    // An agent makes a list in a terminal while the page sits in the background.
    const res = await page.request.post("/api/v1/jobs", { data: { keyword: "hatter", city: "Lisbon, Portugal" } });
    expect(res.ok()).toBe(true);
    const fresh = nav.getByRole("link", { name: /^Hatter in Lisbon/ });
    // Nothing else re-reads the lists: no list was running when the page loaded.
    await page.waitForTimeout(2_500);
    await expect(fresh).toHaveCount(0);

    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(fresh).toBeVisible();
    // Same document: the page was not reloaded.
    expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);
  });

  test.describe("on a 375 px phone", () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

    test("the label sits under the name, and the list opens from the Lists sheet without sideways scrolling", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Lists" }).tap();
      await page.getByRole("dialog").getByRole("link", { name: new RegExp(`^${MIXED}`) }).tap();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(MIXED);
      const row = rows(page).filter({ hasText: "Shop D Bakery" });
      const name = (await row.getByText("Shop D Bakery", { exact: true }).boundingBox())!;
      const tag = (await label(row).boundingBox())!;
      expect(tag.y).toBeGreaterThan(name.y);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBe(0);
    });
  });
});

// The slow server starts with finished Lisbon searches for "milliner" and
// "cobbler" (scripts/e2e-serve.ts); running one again there stays in progress
// long enough to cancel.
test.describe("a cancelled re-run", () => {
  test.use({ baseURL: `http://127.0.0.1:${E2E_PORT + 2}` });

  /**
   * Runs the finished search again and cancels the re-run before it saves a
   * row. The re-run's URL opens the search's one list, which goes back to the
   * finished run; returns that URL.
   */
  async function rerunAndCancel(page: Page, keyword: string, tap: boolean): Promise<string> {
    await page.goto("/");
    await search(page, keyword, "Lisbon, Portugal");
    await expect(page).toHaveURL(LIST_URL);
    const cancel = page.getByRole("button", { name: "Cancel search" });
    await (tap ? cancel.tap() : cancel.click());
    const confirm = page.getByRole("alertdialog").getByRole("button", { name: "Cancel search" });
    await (tap ? confirm.tap() : confirm.click());
    await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(rows(page)).toHaveCount(6);
    return page.url();
  }

  async function expectFinished(page: Page, title: string, cancelledUrl: string) {
    await expect(page).toHaveURL(LIST_URL);
    // The rail opens the list by the run it follows, the finished one.
    expect(page.url()).not.toBe(cancelledUrl);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(rows(page)).toHaveCount(6);
    await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible();
  }

  test("does not hide the finished list: the rail still opens it", async ({ page }) => {
    const errors = watchConsole(page);
    const cancelledUrl = await rerunAndCancel(page, "milliner", false);
    const entries = page.getByRole("navigation", { name: "Lists" }).getByRole("link", { name: /^Milliner in Lisbon/ });
    await expect(entries).toHaveCount(1);
    await expect(entries).toContainText("6");
    await entries.click();
    await expectFinished(page, "Milliner in Lisbon", cancelledUrl);
    expect(errors).toEqual([]);
  });

  test.describe("on a 375 px phone", () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

    test("the Lists sheet still opens the finished list", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const cancelledUrl = await rerunAndCancel(page, "cobbler", true);
      await page.getByRole("button", { name: "Lists" }).tap();
      const entries = page.getByRole("dialog").getByRole("link", { name: /^Cobbler in Lisbon/ });
      await expect(entries).toHaveCount(1);
      await expect(entries).toContainText("6");
      await entries.tap();
      await expectFinished(page, "Cobbler in Lisbon", cancelledUrl);
    });
  });
});

test.describe("rows arrive batch by batch", () => {
  // Three batches of the 20-place fixture (7, 7, then 6 with the duplicate), 2.5 s apart.
  test.use({ baseURL: `http://127.0.0.1:${E2E_PORT + 3}` });

  const live = (page: Page) => page.getByTestId("live-facts");

  // Each test runs its own search: a search run again joins the list of its earlier runs.
  async function rowsArriveThenCancel(page: Page, tap: boolean, keyword: string) {
    const errors = watchConsole(page);
    const sent: Record<string, unknown>[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/v1/jobs")) sent.push(r.postDataJSON());
    });
    await page.goto("/");
    await search(page, keyword, "Melaka");
    await expect(page).toHaveURL(LIST_URL);
    // Everything one search finds is the default: depth 10, limit 120, single search.
    expect(sent[0]).toMatchObject({ keyword, city: "Melaka", depth: 10, maxSeconds: 600, limit: 120, emails: true });

    // The first batch shows while the search goes on; the progress line stays.
    await expect(rows(page)).toHaveCount(7);
    await expect(live(page)).toContainText("7 places");
    await expect(page.getByRole("button", { name: "Cancel search" })).toBeVisible();
    await expect(page.getByRole("status")).toBeVisible();
    // The count rises with the next batch.
    await expect(rows(page)).toHaveCount(14, { timeout: 5_000 });
    await expect(live(page)).toContainText("14 places");
    await expect(page.getByRole("button", { name: "Cancel search" })).toBeVisible();

    const cancel = page.getByRole("button", { name: "Cancel search" });
    await (tap ? cancel.tap() : cancel.click());
    const confirm = page.getByRole("alertdialog").getByRole("button", { name: "Cancel search" });
    await (tap ? confirm.tap() : confirm.click());
    const stopped = "You stopped this search early. It kept the 14 places it had found; the list may be missing some.";
    await expect(page.getByRole("status")).toHaveText(stopped);
    await expect(rows(page)).toHaveCount(14);
    await expect(page.getByRole("button", { name: "Download for Excel" })).toBeEnabled();
    // Nothing more arrives after the cancel, and a reload keeps the rows.
    await page.waitForTimeout(3_000);
    await expect(rows(page)).toHaveCount(14);
    await page.reload();
    await expect(page.getByRole("status")).toHaveText(stopped);
    await expect(rows(page)).toHaveCount(14);
    // The rail counts the places it kept.
    const id = new URL(page.url()).searchParams.get("job")!;
    if (!tap) await expect(page.getByRole("navigation", { name: "Lists" }).locator(`a[href="/?job=${id}"]`)).toContainText("14");
    expect(errors).toEqual([]);
  }

  test("rows show before the search ends, the count rises, and Cancel keeps them", async ({ page }) => {
    await rowsArriveThenCancel(page, false, "souvenir shop");
  });

  test("a search left to finish fills in every row in place, with no duplicates", async ({ page }) => {
    await page.goto("/");
    await search(page, "batik shop", "Melaka");
    await expect(rows(page)).toHaveCount(7);
    await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible({ timeout: 15_000 });
    await expect(rows(page)).toHaveCount(19);
    await expect(page.getByText("19 places", { exact: true })).toBeVisible();
    // Every website was checked: no row still says it is waiting for one.
    await expect(page.getByText("Checking website…")).toHaveCount(0);
    await expect(page.getByText("Website not checked")).toHaveCount(0);
  });

  test("More options opens and closes with the keyboard, and a chosen size and options are sent", async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/v1/jobs")) sent.push(r.postDataJSON());
    });
    await page.goto("/");
    const more = page.getByText("More options", { exact: true });
    const emails = page.getByLabel("Look for emails on websites");
    await expect(emails).toBeHidden();
    await page.getByLabel("Where").focus();
    // Where → How many places → More options.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("radio", { name: /Everything one search finds/ })).toBeFocused();
    await expect(page.getByRole("radio", { name: /Everything one search finds/ })).toBeChecked();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("radio", { name: /The whole city/ })).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(more).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(emails).toBeVisible();
    await expect(emails).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Exact number (optional)")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(emails).toBeFocused();
    await page.keyboard.press("Space");
    await expect(emails).not.toBeChecked();
    // The phone country must be the place's: a Melaka search with another country stops before searching.
    await page.getByLabel("Country for phone numbers").click();
    await page.getByRole("option", { name: "Malaysia" }).click();
    await more.focus();
    await page.keyboard.press("Space");
    await expect(emails).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(emails).toBeVisible();
    await expect(emails).not.toBeChecked();

    await search(page, "paper shop", "Melaka");
    await expect(page).toHaveURL(LIST_URL);
    expect(sent[0]).toMatchObject({ depth: 10, maxSeconds: 1800, wholeCity: true, emails: false, socials: false, deep: false, country: "MY", lang: "en" });
    // Edit search brings the same choices back.
    await page.getByRole("button", { name: "Cancel search" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel search" }).click();
    await page.getByRole("button", { name: "Edit search" }).click();
    await expect(page.getByRole("radio", { name: /The whole city/ })).toBeChecked();
    await expect(page.getByLabel("Look for emails on websites")).toBeVisible();
    await expect(page.getByLabel("Look for emails on websites")).not.toBeChecked();
    await expect(page.getByLabel("Country for phone numbers")).toContainText("Malaysia");
  });

  test.describe("on a 375 px phone", () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

    test("the same, without sideways scrolling", async ({ page }) => {
      await rowsArriveThenCancel(page, true, "craft shop");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    });

    test("More options opens with the keyboard and fits the screen", async ({ page }) => {
      await page.goto("/");
      const more = page.getByText("More options", { exact: true });
      await more.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Look for emails on websites")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
      const box = (await more.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Look for emails on websites")).toBeHidden();
    });
  });
});

test("an old-shape saved job in a legacy leadscout data folder migrates and shows cleaned addresses, emails, count and CSV without touching disk", async ({ page }) => {
  const errors = watchConsole(page);
  const temp = mkdtempSync(path.join(tmpdir(), "business-finder-old-e2e-"));
  const jobId = "11111111-2222-4333-8444-555555555555";
  const jobDir = path.join(temp, "leadscout", "jobs", jobId);
  const migratedJobDir = path.join(temp, "business-finder", "jobs", jobId);
  mkdirSync(jobDir, { recursive: true });
  const jobFile = path.join(jobDir, "job.json");
  const leadsFile = path.join(jobDir, "leads.jsonl");

  writeFileSync(
    jobFile,
    JSON.stringify({
      id: jobId,
      status: "done",
      options: { keyword: "event company", city: "Kuala Lumpur", depth: 1, lang: "en", emails: true, socials: true, deep: true, maxSeconds: 600 },
      progress: { stage: "done", places: 2, message: "Found 2 leads in Kuala Lumpur." },
      reconciliation: { found: 2, kept: 2, filtered: 0, duplicates: 0, toCheck: 2, fetched: 2, unreachable: 0, mismatched: 0, skipped: 0 },
      saved: 2,
      createdAt: "2026-11-18T10:00:00.000Z",
    }),
  );
  writeFileSync(
    leadsFile,
    [
      JSON.stringify({
        title: "Old Shop A",
        address: "Old Shop A, 10 Jalan Bunga, 50000 KL",
        website: "https://shop-a.test/",
        source: "browser",
        query: "event company",
        city: "Kuala Lumpur",
        whatsapp: "",
        emails: ["you@company.com"],
        email_source_url: "https://shop-a.test/",
        email_status: "found",
        website_status: "found",
        instagram: "",
        facebook: "",
        linkedin: "",
        tiktok: "",
        youtube: "",
        x: "",
        fetched_at: "2026-11-18T10:00:00.000Z",
      }),
      JSON.stringify({
        title: "Old Shop B",
        address: "Old Shop B - Branch 2, 22 Jalan Bukit",
        website: "https://shop-b.test/",
        source: "browser",
        query: "event company",
        city: "Kuala Lumpur",
        whatsapp: "",
        emails: ["name@yourcompany.com", "alice.tan@shop-b.test"],
        email_source_url: "https://shop-b.test/",
        email_status: "found",
        website_status: "found",
        instagram: "",
        facebook: "",
        linkedin: "",
        tiktok: "",
        youtube: "",
        x: "",
        fetched_at: "2026-11-18T10:00:00.000Z",
      }),
    ].join("\n") + "\n",
  );
  const jobBefore = readFileSync(jobFile);
  const leadsBefore = readFileSync(leadsFile);

  const proc = spawn("bun", ["src/cli/main.ts", "serve", "--no-open", "--port", "0"], {
    env: { ...process.env, LOCALAPPDATA: temp, XDG_DATA_HOME: temp },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const serverUrl = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`serve timed out: ${out}`)), 15_000);
      proc.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const match = /running at (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`serve exited ${code}: ${out}`));
      });
    });

    await page.goto(`${serverUrl}/?job=${jobId}`);
    await expect(page).toHaveTitle("Event company in Kuala Lumpur · Business Finder");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Event company in Kuala Lumpur");
    await expect(page.getByText("1 with email", { exact: true })).toBeVisible();
    await expect(page.getByText("10 Jalan Bunga, 50000 KL", { exact: true })).toBeVisible();
    await expect(page.getByText("Branch 2, 22 Jalan Bukit", { exact: true })).toBeVisible();
    await expect(page.getByText("alice.tan@shop-b.test", { exact: true })).toBeVisible();
    await expect(page.getByText("a person's address", { exact: true })).toBeVisible();
    await expect(page.getByText(/mail server/)).toHaveCount(0);
    await expect(page.getByText("Old Shop A, 10 Jalan Bunga")).toHaveCount(0);
    await expect(page.getByText("Old Shop B - Branch 2")).toHaveCount(0);
    await expect(page.getByText("you@company.com")).toHaveCount(0);
    await expect(page.getByText("name@yourcompany.com")).toHaveCount(0);

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download for Excel" }).click()]);
    const csv = readFileSync(await download.path(), "utf8");
    expect(csv).toContain("10 Jalan Bunga, 50000 KL");
    expect(csv).toContain("Branch 2, 22 Jalan Bukit");
    expect(csv).toContain("alice.tan@shop-b.test");
    expect(csv).not.toContain("Old Shop A, 10 Jalan Bunga");
    expect(csv).not.toContain("Old Shop B - Branch 2");
    expect(csv).not.toContain("you@company.com");
    expect(csv).not.toContain("name@yourcompany.com");

    expect(readFileSync(path.join(migratedJobDir, "job.json"))).toEqual(jobBefore);
    expect(readFileSync(path.join(migratedJobDir, "leads.jsonl"))).toEqual(leadsBefore);
    expect(errors).toEqual([]);
  } finally {
    proc.kill();
    rmSync(temp, { recursive: true, force: true });
  }
});

test.describe("a search run again", () => {
  // Seeded by scripts/e2e-serve.ts: "gift shop" in Melaka ran once and found
  // ZZMARK-1..15; this server finds ZZMARK-6..19 and reaches the end of the list.
  test.use({ baseURL: `http://127.0.0.1:${E2E_PORT + 4}` });

  /** Runs the search a second time from the page, typed differently, unless an earlier test already did. */
  async function runAgain(page: Page) {
    const { lists } = (await (await page.request.get("/api/v1/lists")).json()) as { lists: { id: string; runs: number }[] };
    expect(lists).toHaveLength(1);
    if (lists[0]!.runs === 1) {
      await page.goto("/");
      await search(page, "Gift  Shop", "melaka");
      await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible();
    } else {
      await page.goto(`/?job=${lists[0]!.id}`);
    }
  }

  /** One rail entry for both runs, counting each place once. */
  async function expectOneEntry(lists: Locator) {
    await expect(lists.getByRole("listitem")).toHaveCount(1);
    await expect(lists.getByRole("link", { name: /Gift shop in Melaka/ })).toContainText("19");
  }

  async function expectCombined(page: Page) {
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Gift shop in Melaka");
    // Title and properties line use the same spelling from the first run even when the re-run typed "melaka".
    await expect(page.getByRole("main").getByText("Melaka", { exact: true })).toBeVisible();
    await expect(rows(page)).toHaveCount(19);
    await expect(page.getByText("19 places", { exact: true })).toBeVisible();
    await expect(page.getByText("4 new since the last search", { exact: true })).toBeVisible();
    const markers = page.getByTestId("row-marker");
    await expect(markers.filter({ hasText: "New since the last search" })).toHaveCount(4);
    await expect(markers.filter({ hasText: "Not in the last search" })).toHaveCount(5);
    const gone = rows(page).filter({ has: page.getByText("ZZMARK-1", { exact: true }) });
    await expect(gone.getByTestId("row-marker")).toHaveText("Not in the last search");
    const fresh = rows(page).filter({ has: page.getByText("ZZMARK-19", { exact: true }) });
    await expect(fresh.getByTestId("row-marker")).toHaveText("New since the last search");
  }

  test("shows one list with each place once, the new and not-found markers, and a CSV that matches", async ({ page }) => {
    const errors = watchConsole(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await runAgain(page);
    await expectOneEntry(page.getByRole("complementary").getByRole("navigation", { name: "Lists" }));
    await expectCombined(page);

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download for Excel" }).click()]);
    const csv = readFileSync(await download.path(), "utf8").trim().split("\r\n");
    // A header and one line per place, with Email type and Can receive mail after emails.
    expect(csv).toHaveLength(20);
    expect(csv[0]!.replace(/^﻿/, "")).toBe("title,phone,whatsapp,emails,Email type,Can receive mail,website,category,address,review_rating,review_count,instagram,facebook,linkedin,tiktok,youtube,x");

    // Combined-list filters: Only new since the last search and Hide not found last time (behind More filters).
    await page.getByRole("button", { name: "More filters" }).click();
    await page.getByRole("button", { name: "Only new since the last search" }).click();
    await expect(page.getByRole("button", { name: "More filters (1)" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("4 of 19 shown", { exact: true })).toBeVisible();
    await expect(rows(page)).toHaveCount(4);
    const [newCsv] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download 4 for Excel" }).click()]);
    expect(readFileSync(await newCsv.path(), "utf8").trim().split("\r\n")).toHaveLength(5);

    await page.getByRole("button", { name: "More filters (1)" }).click();
    await page.getByRole("button", { name: "Only new since the last search" }).click();
    await page.getByRole("button", { name: "Hide not found last time" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "More filters (1)" })).toBeVisible();
    await expect(page.getByText("14 of 19 shown", { exact: true })).toBeVisible();
    await expect(rows(page)).toHaveCount(14);
    const [presentCsv] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download 14 for Excel" }).click()]);
    expect(readFileSync(await presentCsv.path(), "utf8").trim().split("\r\n")).toHaveLength(15);

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByText("19 places", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test.describe("on a 375 px phone", () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

    test("the same list from the Lists sheet, without sideways scrolling", async ({ page }) => {
      const errors = watchConsole(page);
      await runAgain(page);
      await page.getByRole("button", { name: "Lists" }).click();
      const sheet = page.getByRole("dialog");
      await expectOneEntry(sheet);
      await sheet.getByRole("link", { name: /Gift shop in Melaka/ }).click();
      await expectCombined(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBe(0);
      expect(errors).toEqual([]);
    });
  });
});

test.describe("filtering, sorting and downloading what is shown", () => {
  test("at 1280 px: filters, sorts, downloads matching CSV, keeps filters on reload, and clears them", async ({ page }) => {
    const errors = watchConsole(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await search(page, "ceramic shop", "Melaka");
    await expect(rows(page)).toHaveCount(19);

    // Turn on two filters + minimum reviews (behind More filters) + sort by name.
    await page.getByRole("button", { name: "Has WhatsApp" }).click();
    await expect(page.getByText("12 of 19 shown", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Has email" }).click();
    await expect(page.getByText("10 of 19 shown", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "More filters" }).click();
    await page.getByLabel("Reviews at least").click();
    await page.getByRole("option", { name: "10+ reviews" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "More filters (1)" })).toBeVisible();
    await expect(page.getByText("7 of 19 shown", { exact: true })).toBeVisible();
    await page.getByLabel("Sort by").click();
    await page.getByRole("option", { name: "Name" }).click();

    await expect(rows(page)).toHaveCount(7);
    await expect(rows(page).first()).toContainText("ZZMARK-10");
    await expect(rows(page).nth(1)).toContainText("ZZMARK-4");

    // Download CSV and verify row count and order match what is shown.
    const downloadBtn = page.getByRole("button", { name: "Download 7 for Excel" });
    await expect(downloadBtn).toBeVisible();
    const [csvDownload] = await Promise.all([page.waitForEvent("download"), downloadBtn.click()]);
    const csvLines = readFileSync(await csvDownload.path(), "utf8").trim().split("\r\n");
    expect(csvLines).toHaveLength(8);
    expect(csvLines.slice(1).map((line) => line.split(",")[0])).toEqual([
      "ZZMARK-10",
      "ZZMARK-4",
      "ZZMARK-5",
      "ZZMARK-6",
      "ZZMARK-7",
      "ZZMARK-8",
      "ZZMARK-9",
    ]);

    // Reload and check that filters and sort persist in the URL.
    await page.reload();
    await expect(page.getByRole("button", { name: "Has WhatsApp" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Has email" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "More filters (1)" })).toBeVisible();
    await page.getByRole("button", { name: "More filters (1)" }).click();
    await expect(page.getByLabel("Reviews at least")).toContainText("10+ reviews");
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Sort by")).toContainText("Sort: Name");
    await expect(page.getByText("7 of 19 shown", { exact: true })).toBeVisible();
    await expect(rows(page)).toHaveCount(7);
    await expect(page.getByRole("button", { name: "Download 7 for Excel" })).toBeVisible();

    // Clear filters.
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByText("19 places", { exact: true })).toBeVisible();
    await expect(rows(page)).toHaveCount(19);
    await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible();

    // Hiding the only category shows the plain empty state with one Clear filters action.
    await page.getByRole("button", { name: "More filters" }).click();
    await expect(page.getByText("Souvenir shop", { exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: /Souvenir shop/ }).uncheck();
    await page.keyboard.press("Escape");
    await expect(page.getByText("0 of 19 shown", { exact: true })).toBeVisible();
    await expect(page.getByText("No places match these filters.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear filters" })).toHaveCount(1);
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(rows(page)).toHaveCount(19);
    expect(errors).toEqual([]);
  });

  test.describe("on a 375 px phone", () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

    test("filters in a sheet, downloads matching CSV, keeps filters on reload, and clears without sideways scroll", async ({ page }) => {
      const errors = watchConsole(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await search(page, "spice shop", "Melaka");
      await expect(rows(page)).toHaveCount(19);

      const trigger = page.getByRole("button", { name: "Filters" });
      expect((await trigger.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await trigger.tap();
      const sheet = page.getByRole("dialog", { name: "Filters" });
      await expect(sheet).toBeVisible();

      for (const name of ["Has WhatsApp", "Has email"]) {
        const btn = sheet.getByRole("button", { name });
        expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await btn.tap();
      }
      await sheet.getByRole("button", { name: "Done" }).tap();
      await expect(sheet).toBeHidden();

      await expect(page.getByText("10 of 19 shown", { exact: true })).toBeVisible();
      await expect(rows(page)).toHaveCount(10);
      const [csvDownload] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "Download 10 for Excel" }).click(),
      ]);
      expect(readFileSync(await csvDownload.path(), "utf8").trim().split("\r\n")).toHaveLength(11);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

      await page.reload();
      await expect(page.getByText("10 of 19 shown", { exact: true })).toBeVisible();
      await expect(rows(page)).toHaveCount(10);
      await expect(page.getByRole("button", { name: "Download 10 for Excel" })).toBeVisible();

      await page.getByRole("button", { name: "Clear filters" }).tap();
      await expect(page.getByText("19 places", { exact: true })).toBeVisible();
      await expect(rows(page)).toHaveCount(19);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
      expect(errors).toEqual([]);
    });
  });
});

test.describe("whole-city geo-grid", () => {
  test.use({ baseURL: `http://127.0.0.1:${E2E_PORT + 5}` });

  test("searches the grid past 120 places at 1280 px", async ({ page }) => {
    const errors = watchConsole(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.getByText("The whole city", { exact: true }).click();
    await search(page, "event venue", "Kuala Lumpur");
    await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("135 places", { exact: true })).toBeVisible();
    await expect(rows(page)).toHaveCount(135);
    await expect(page.getByRole("button", { name: "Search the whole city (5–15 min)" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("turns on the grid automatically above 120 and stops at exact limit at 375 px, with mutual exclusivity", async ({ page }) => {
    const errors = watchConsole(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.getByText("More options", { exact: true }).click();
    const slider = page.getByRole("slider", { name: "Exact number (optional)" });
    await slider.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await expect(slider).toHaveAttribute("aria-valuenow", "3");
    await expect(page.getByText("About 250 places · about 8 minutes · searches the whole city")).toBeVisible();
    for (const label of [/A quick look/, /Everything one search finds/, /The whole city/]) {
      await expect(page.getByRole("radio", { name: label })).not.toBeChecked();
    }
    // Picking a choice resets the slider; moving the slider again deselects the choice.
    await page.getByText("A quick look", { exact: true }).click();
    await expect(page.getByRole("radio", { name: /A quick look/ })).toBeChecked();
    await expect(slider).toHaveAttribute("data-unset", "true");
    await slider.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await expect(slider).toHaveAttribute("aria-valuenow", "3");
    await expect(page.getByRole("radio", { name: /A quick look/ })).not.toBeChecked();

    await search(page, "conference hall", "Kuala Lumpur");
    await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("135 places", { exact: true })).toBeVisible();
    await expect(rows(page)).toHaveCount(135);

    // Search again opens the form with More options open and stop 250 preserved.
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Search again" }).click();
    await expect(page.getByRole("slider", { name: "Exact number (optional)" })).toBeVisible();
    await expect(page.getByRole("slider", { name: "Exact number (optional)" })).toHaveAttribute("aria-valuenow", "3");
    await expect(page.getByText("About 250 places · about 8 minutes · searches the whole city")).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
    expect(errors).toEqual([]);
  });

  test("find more at the end of a single search expands to the whole city and combines into the same list", async ({ page }) => {
    const errors = watchConsole(page);
    const sent: Record<string, unknown>[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/v1/jobs")) sent.push(r.postDataJSON());
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.getByText("More options", { exact: true }).click();
    await page.getByLabel("Look for emails on websites").uncheck();
    await page.getByLabel("Country for phone numbers").click();
    await page.getByRole("option", { name: "Malaysia" }).click();
    await search(page, "bridal shop", "Kuala Lumpur");
    await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible({ timeout: 15_000 });
    await expect(rows(page)).toHaveCount(35);
    await expect(page.getByText("That's everything Google Maps shows for one search.", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Search the whole city (5–15 min)" }).click();
    await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible({ timeout: 15_000 });
    await expect(rows(page)).toHaveCount(135);
    await expect(page.getByText("135 places", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Search the whole city (5–15 min)" })).toHaveCount(0);
    expect(sent[1]).toMatchObject({
      keyword: "bridal shop",
      city: "Kuala Lumpur",
      wholeCity: true,
      emails: false,
      socials: false,
      deep: false,
      country: "MY",
    });
    expect(sent[1]!.limit).toBeUndefined();

    // Change the search link on a fresh single search opens the form pre-filled.
    await page.getByRole("link", { name: "New list" }).click();
    await page.getByText("A quick look", { exact: true }).click();
    await search(page, "flower shop", "Kuala Lumpur");
    await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("link", { name: "Change the search" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByLabel("What")).toHaveValue("flower shop");
    await expect(page.getByLabel("Where")).toHaveValue("Kuala Lumpur");
    await expect(page.getByRole("radio", { name: /A quick look/ })).toBeChecked();
    expect(errors).toEqual([]);
  });

  test("Change the search on a whole-city list with a small limit keeps wholeCity when submitted unchanged", async ({ page }) => {
    const errors = watchConsole(page);
    const sent: Record<string, unknown>[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/v1/jobs")) sent.push(r.postDataJSON());
    });
    const created = await page.request.post("/api/v1/jobs", {
      data: { keyword: "bakery", city: "Kuala Lumpur", depth: 10, maxSeconds: 1800, wholeCity: true, limit: 50 },
    });
    const { id } = (await created.json()) as { id: string };
    await page.goto(`/?job=${id}`);
    await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible({ timeout: 15_000 });
    await expect(rows(page)).toHaveCount(50);

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Search again" }).click();
    await expect(page.getByRole("radio", { name: /The whole city/ })).toBeChecked();
    await expect(page.getByRole("slider", { name: "Exact number (optional)" })).toHaveAttribute("data-unset", "true");
    await expect(page.getByText("Saved limit: 50 places")).toBeVisible();

    await page.getByRole("button", { name: "Find", exact: true }).click();
    await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible({ timeout: 15_000 });
    expect(sent[0]).toMatchObject({ keyword: "bakery", city: "Kuala Lumpur", wholeCity: true, limit: 50 });
    expect(errors).toEqual([]);
  });
});

test.describe("deleting a list", () => {
  test("at 1280 px: Cancel and Esc keep it and return focus; Delete removes it from rail, history and GET /api/v1/jobs, and opening its URL shows the unavailable state", async ({ page }) => {
    const errors = watchConsole(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await search(page, "basket shop", "Melaka");
    await finished(page, 19);
    const keepUrl = page.url();
    const keepId = new URL(keepUrl).searchParams.get("job")!;

    await page.getByRole("link", { name: "New list" }).click();
    await search(page, "rattan shop", "Melaka");
    await finished(page, 19);
    const delUrl = page.url();
    const delId = new URL(delUrl).searchParams.get("job")!;

    const more = page.getByRole("button", { name: "More actions" });
    await more.click();
    await page.getByRole("menuitem", { name: "Delete list" }).click();
    const dialog = page.getByRole("alertdialog", { name: 'Delete "Rattan shop in Melaka"?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Its 19 places will be removed from this computer. This can't be undone.");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

    // Cancel keeps the list and returns focus to More actions.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(more).toBeFocused();
    await expect(page).toHaveURL(delUrl);

    // Escape also closes and returns focus to More actions.
    await more.click();
    await page.getByRole("menuitem", { name: "Delete list" }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(more).toBeFocused();

    // Filtering warns that deleting removes the whole list, not only the shown rows.
    await page.getByRole("button", { name: "Has WhatsApp" }).click();
    await expect(page.getByText("12 of 19 shown", { exact: true })).toBeVisible();
    await more.click();
    await page.getByRole("menuitem", { name: "Delete list" }).click();
    await expect(dialog).toContainText("This deletes the whole list, not only the 12 places shown.");

    // Confirming Delete removes it from the rail and API, replaces the URL, and leaves no deleted history entry.
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(keepUrl);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Basket shop in Melaka");
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    const nav = page.getByRole("navigation", { name: "Lists" });
    await expect(nav.getByRole("link", { name: /Rattan shop in Melaka/ })).toHaveCount(0);
    await expect(nav.locator(`a[href="/?job=${keepId}"]`)).toBeVisible();

    const jobsBody = (await (await page.request.get("/api/v1/jobs")).json()) as { jobs: { id: string }[] };
    expect(jobsBody.jobs.map((j) => j.id)).not.toContain(delId);

    // History entry was replaced, not pushed: Back goes to New list, not the deleted id.
    await page.goBack();
    await expect(page).not.toHaveURL(new RegExp(delId));

    // Opening the deleted id's URL directly shows the plain unavailable state with one link back.
    await page.goto(delUrl);
    await expect(page.getByRole("heading", { level: 1, name: "This list is no longer available." })).toBeVisible();
    await expect(page.getByText(/deleted or doesn't exist/i)).toBeVisible();
    await page.getByRole("main").getByRole("link", { name: "＋ New list" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Find businesses to contact" })).toBeVisible();
    expect(errors.filter((e) => !e.includes("404"))).toEqual([]);
  });

  test("keyboard delete failure (409 and 500) returns focus to More actions", async ({ page }) => {
    const errors = watchConsole(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await search(page, "pottery shop", "Melaka");
    await finished(page, 19);
    const listUrl = page.url();
    const listId = new URL(listUrl).searchParams.get("job")!;
    const more = page.getByRole("button", { name: "More actions" });
    const dialog = page.getByRole("alertdialog", { name: 'Delete "Pottery shop in Melaka"?' });

    for (const failure of [
      { status: 409, body: { error: "This search is still running. Cancel it first." } },
      { status: 500, body: { error: "2 of 2 searches could not be deleted. Try again.", remaining: [listId] } },
    ]) {
      await page.route(/\/api\/v1\/lists\/[^/?]+$/, (route) =>
        route.request().method() === "DELETE" ? route.fulfill({ status: failure.status, json: failure.body }) : route.fallback(),
      );
      await more.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Delete list" }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: "Delete" })).toBeFocused();
      await page.keyboard.press("Enter");

      await expect(dialog).toBeHidden();
      await expect(page.getByRole("alert").filter({ hasText: failure.body.error })).toBeVisible();
      await expect(more).toBeFocused();
      await page.unroute(/\/api\/v1\/lists\/[^/?]+$/);
    }
    expect(errors.filter((e) => !e.includes("409") && !e.includes("500"))).toEqual([]);
  });

  test("deleting a combined list removes every run so no older run reappears in the rail", async ({ page }) => {
    const errors = watchConsole(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await search(page, "bicycle shop", "Melaka");
    await finished(page, 19);
    const firstId = new URL(page.url()).searchParams.get("job")!;

    await page.getByRole("link", { name: "New list" }).click();
    await search(page, "Bicycle Shop", "melaka");
    await finished(page, 19);
    const secondId = new URL(page.url()).searchParams.get("job")!;
    expect(secondId).not.toBe(firstId);

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete list" }).click();
    const dialog = page.getByRole("alertdialog", { name: 'Delete "Bicycle shop in Melaka"?' });
    await expect(dialog).toContainText("Its 2 searches and 19 places will be removed from this computer.");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(dialog).toBeHidden();

    const nav = page.getByRole("navigation", { name: "Lists" });
    await expect(nav.getByRole("link", { name: /Bicycle shop in Melaka/ })).toHaveCount(0);
    const jobsBody = (await (await page.request.get("/api/v1/jobs")).json()) as { jobs: { id: string }[] };
    const remainingIds = jobsBody.jobs.map((j) => j.id);
    expect(remainingIds).not.toContain(firstId);
    expect(remainingIds).not.toContain(secondId);
    expect(errors).toEqual([]);
  });

  test("cannot delete while a search is running and shows the message next to the action", async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto(`http://127.0.0.1:${E2E_PORT + 2}/`);
    await search(page, "perfumer", "Lisbon, Portugal");
    await expect(page).toHaveURL(LIST_URL);
    const runningId = new URL(page.url()).searchParams.get("job")!;

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete list" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: "Cancel the search first." })).toBeVisible();
    expect((await (await page.request.get(`http://127.0.0.1:${E2E_PORT + 2}/api/v1/jobs/${runningId}`)).json()).status).toBe("running");

    // Clean up the slow search so it doesn't hold the worker.
    await page.getByRole("button", { name: "Cancel search" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel search" }).click();
    await expect(page.getByRole("button", { name: "Edit search" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test.describe("on a 375 px phone", () => {
    test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

    test("deletes a finished list, removes it from the Lists sheet and GET /api/v1/jobs, with no sideways scrolling", async ({ page }) => {
      const errors = watchConsole(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await search(page, "pewter shop", "Melaka");
      await finished(page, 19);
      const delId = new URL(page.url()).searchParams.get("job")!;

      await page.getByRole("button", { name: "More actions" }).tap();
      await page.getByRole("menuitem", { name: "Delete list" }).tap();
      const dialog = page.getByRole("alertdialog", { name: 'Delete "Pewter shop in Melaka"?' });
      await expect(dialog).toBeVisible();
      for (const name of ["Cancel", "Delete"]) {
        const box = (await dialog.getByRole("button", { name }).boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(375);
      }
      await dialog.getByRole("button", { name: "Delete" }).tap();
      await expect(dialog).toBeHidden();
      // The page leaves the deleted list once the server confirms; wait for it rather than reading the URL once.
      await expect(page).not.toHaveURL(new RegExp(delId));

      await page.getByRole("button", { name: "Lists" }).tap();
      const sheet = page.getByRole("dialog");
      await expect(sheet.getByRole("link", { name: /Pewter shop in Melaka/ })).toHaveCount(0);
      await page.keyboard.press("Escape");

      const jobsBody = (await (await page.request.get("/api/v1/jobs")).json()) as { jobs: { id: string }[] };
      expect(jobsBody.jobs.map((j) => j.id)).not.toContain(delId);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBe(0);
      expect(errors).toEqual([]);
    });
  });
});

test.describe("email type and MX check", () => {
  test("shows muted type and mail server status, filters by email type at 1280 and 375 px, and exports columns without real DNS", async ({ page }) => {
    const errors = watchConsole(page);
    const temp = mkdtempSync(path.join(tmpdir(), "business-finder-email-mx-e2e-"));
    const sitesDir = path.join(temp, "sites");
    mkdirSync(sitesDir, { recursive: true });
    writeFileSync(path.join(sitesDir, "generic-ok.test.html"), "<p>Florist. Contact Info+promo@generic-ok.test</p>");
    writeFileSync(path.join(sitesDir, "personal-dead.test.html"), "<p>Florist. Contact alice.tan@personal-dead.test</p>");
    writeFileSync(path.join(sitesDir, "generic-slow.test.html"), "<p>Florist. Contact sales@generic-slow.test</p>");

    const batch = makeBatch([
      { title: "Gen OK", category: "Florist", website: "https://generic-ok.test/", place_id: "PLACE-1", data_id: "0x1:0x1" },
      { title: "Pers Dead", category: "Florist", website: "https://personal-dead.test/", place_id: "PLACE-2", data_id: "0x1:0x2" },
      { title: "Gen Slow", category: "Florist", website: "https://generic-slow.test/", place_id: "PLACE-3", data_id: "0x1:0x3" },
    ]);
    const fixtureFile = path.join(temp, "fixture.json");
    writeFileSync(
      fixtureFile,
      JSON.stringify({
        geocode: { lat: 2.19, lon: 102.25, countryCode: "MY" },
        batches: [batch],
        sitesDir,
        mx: {
          "generic-ok.test": "ok",
          "personal-dead.test": "no mail server",
          "generic-slow.test": "unknown",
        },
      }),
    );

    const proc = spawn(
      "bun",
      [
        "-e",
        'import { startServer } from "./src/server/serve.js"; const s = await startServer({ port: 0, open: false, jobsDir: process.env.JOBS_DIR, source: "fixture", fixtureFile: process.env.BUSINESS_FINDER_FIXTURE }); console.log("running at " + s.url);',
      ],
      {
        env: { ...process.env, JOBS_DIR: path.join(temp, "jobs"), BUSINESS_FINDER_FIXTURE: fixtureFile },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      const serverUrl = await new Promise<string>((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => reject(new Error(`serve timed out: ${out}`)), 15_000);
        proc.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          const match = /running at (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
          if (match?.[1]) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
        proc.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`serve exited ${code}: ${out}`));
        });
      });

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(serverUrl);
      await search(page, "florist", "Melaka");
      await expect(rows(page)).toHaveCount(3);
      await expect(rows(page).filter({ hasText: "Gen OK" }).getByText("shared inbox · address can receive mail", { exact: true })).toBeVisible();
      await expect(rows(page).filter({ hasText: "Pers Dead" }).getByText("a person's address · cannot receive mail", { exact: true })).toBeVisible();
      await expect(rows(page).filter({ hasText: "Gen Slow" }).getByText("shared inbox · could not check mail", { exact: true })).toBeVisible();

      // Muted text meets WCAG 4.5:1 in both light and dark schemes.
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        expect(await contrast(rows(page).filter({ hasText: "Pers Dead" }).getByText("a person's address · cannot receive mail", { exact: true }))).toBeGreaterThanOrEqual(4.5);
      }

      // Filter by Email type at 1280 px (behind More filters).
      await page.getByRole("button", { name: "More filters" }).click();
      await page.getByLabel("Email type").click();
      await page.getByRole("option", { name: "A person's address" }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "More filters (1)" })).toBeVisible();
      await expect(page.getByText("1 of 3 shown", { exact: true })).toBeVisible();
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page).first()).toContainText("Pers Dead");
      await page.reload();
      await expect(page.getByRole("button", { name: "More filters (1)" })).toBeVisible();
      await page.getByRole("button", { name: "More filters (1)" }).click();
      await expect(page.getByLabel("Email type")).toContainText("A person's address");
      await expect(rows(page)).toHaveCount(1);

      await page.getByLabel("Email type").click();
      await page.getByRole("option", { name: "Shared inbox" }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByText("2 of 3 shown", { exact: true })).toBeVisible();
      await expect(rows(page)).toHaveCount(2);

      // Download for Excel (lean CSV) includes Email type and Can receive mail with plain-word values.
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Clear filters" }).click();
      await expect(rows(page)).toHaveCount(3);
      const [excelDownload] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "Download for Excel" }).click(),
      ]);
      const excelLines = readFileSync(await excelDownload.path(), "utf8").replace(/^﻿/, "").trim().split("\r\n");
      const excelHeaders = excelLines[0]!.split(",");
      expect(excelHeaders).toContain("Email type");
      expect(excelHeaders).toContain("Can receive mail");
      const typeCol = excelHeaders.indexOf("Email type");
      const mxCol = excelHeaders.indexOf("Can receive mail");
      const genOkCells = excelLines[1]!.split(",");
      expect(genOkCells[0]).toBe("Gen OK");
      expect(genOkCells[typeCol]).toBe("shared inbox");
      expect(genOkCells[mxCol]).toBe("yes");
      const persDeadCells = excelLines[2]!.split(",");
      expect(persDeadCells[0]).toBe("Pers Dead");
      expect(persDeadCells[typeCol]).toBe("a person's address");
      expect(persDeadCells[mxCol]).toBe("no");
      const genSlowCells = excelLines[3]!.split(",");
      expect(genSlowCells[0]).toBe("Gen Slow");
      expect(genSlowCells[typeCol]).toBe("shared inbox");
      expect(genSlowCells[mxCol]).toBe("");

      // Full CSV download stays consistent with the Excel file.
      const jobId = new URL(page.url()).searchParams.get("job")!;
      const fullCsv = await (await page.request.get(`${serverUrl}/api/v1/jobs/${jobId}/download?format=csv&columns=full`)).text();
      expect(fullCsv).toContain("Email type,Can receive mail");
      expect(fullCsv).toContain("shared inbox");
      expect(fullCsv).toContain("a person's address");
      expect(fullCsv).toContain(",yes,");
      expect(fullCsv).toContain(",no,");

      // Full JSON download keeps raw email_types and email_mx for developers.
      const fullJson = (await (await page.request.get(`${serverUrl}/api/v1/jobs/${jobId}/download?format=json&columns=full`)).json()) as Record<string, unknown>[];
      expect(fullJson).toHaveLength(3);
      expect(fullJson[0]).toMatchObject({ title: "Gen OK", email_types: ["generic"], email_mx: ["ok"] });
      expect(fullJson[1]).toMatchObject({ title: "Pers Dead", email_types: ["personal"], email_mx: ["no mail server"] });
      expect(fullJson[2]).toMatchObject({ title: "Gen Slow", email_types: ["generic"], email_mx: ["unknown"] });

      // 375 px phone: filter sheet works without sideways scrolling, and sticky header is opaque.
      await page.setViewportSize({ width: 375, height: 812 });
      const headerBg = await page.locator("header").first().evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(headerBg).not.toMatch(/rgba\([^)]+,\s*0\.\d+\)/);
      await expect(rows(page)).toHaveCount(3);
      await page.getByRole("button", { name: "Filters" }).click();
      const sheet = page.getByRole("dialog", { name: "Filters" });
      await sheet.getByLabel("Email type").click();
      await page.getByRole("option", { name: "A person's address" }).click();
      await sheet.getByRole("button", { name: "Done" }).click();
      await expect(rows(page)).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
      expect(errors).toEqual([]);
    } finally {
      proc.kill();
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

test.describe("several keywords in one search", () => {
  test("runs 3 keywords including non-Latin scripts into one deduped list, groups reordered repeats, round-trips Search again and CSV at 1280 and 375 px", async ({ page }) => {
    const errors = watchConsole(page);
    const temp = mkdtempSync(path.join(tmpdir(), "business-finder-multi-kw-e2e-"));
    const sitesDir = path.join(temp, "sites");
    mkdirSync(sitesDir, { recursive: true });

    const batch1 = makeBatch([
      { title: "Kedai Satu", place_id: "MK-1", phone: "012-000 0001", address: "1 Jalan Melaka" },
      { title: "Kedai Dua", place_id: "MK-2", phone: "012-000 0002", address: "2 Jalan Melaka" },
      { title: "Kedai Tiga", place_id: "MK-3", phone: "012-000 0003", address: "3 Jalan Melaka" },
    ]);
    const batch2 = makeBatch([
      { title: "Kedai Dua", place_id: "MK-2", phone: "012-000 0002", address: "2 Jalan Melaka" },
      { title: "马六甲纪念品 A", place_id: "MK-4", phone: "012-000 0004", address: "4 Jonker Walk" },
      { title: "马六甲纪念品 B", place_id: "MK-5", phone: "012-000 0005", address: "5 Jonker Walk" },
    ]);
    const batch3 = makeBatch([
      { title: "Kedai Satu", place_id: "MK-1", phone: "012-000 0001", address: "1 Jalan Melaka" },
      { title: "马六甲纪念品 B", place_id: "MK-5", phone: "012-000 0005", address: "5 Jonker Walk" },
      { title: "Cenderamata C", place_id: "MK-6", phone: "012-000 0006", address: "6 Jalan Hang Jebat" },
    ]);
    const fixtureFile = path.join(temp, "fixture.json");
    writeFileSync(
      fixtureFile,
      JSON.stringify({
        geocode: { lat: 2.19, lon: 102.25, countryCode: "MY" },
        batches: [batch1],
        keywordBatches: {
          "souvenir shop": [batch1],
          "纪念品店": [batch2],
          "kedai cenderamata": [batch3],
        },
        sitesDir,
      }),
    );

    const proc = spawn(
      "bun",
      [
        "-e",
        'import { startServer } from "./src/server/serve.js"; const s = await startServer({ port: 0, open: false, jobsDir: process.env.JOBS_DIR, source: "fixture", fixtureFile: process.env.BUSINESS_FINDER_FIXTURE }); console.log("running at " + s.url);',
      ],
      {
        env: { ...process.env, JOBS_DIR: path.join(temp, "jobs"), BUSINESS_FINDER_FIXTURE: fixtureFile },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      const serverUrl = await new Promise<string>((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => reject(new Error(`serve timed out: ${out}`)), 15_000);
        proc.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          const match = /running at (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
          if (match?.[1]) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
        proc.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`serve exited ${code}: ${out}`));
        });
      });

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(serverUrl);
      await search(page, "souvenir shop, 纪念品店, kedai cenderamata", "Melaka");

      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Souvenir shop +2 in Melaka");
      await expect(rows(page)).toHaveCount(6);
      await expect(page.getByText("6 places", { exact: true })).toBeVisible();
      await expect(page.getByText("souvenir shop, 纪念品店, kedai cenderamata", { exact: true })).toBeVisible();

      const navLink = page.getByRole("navigation", { name: "Lists" }).getByRole("link", { name: /Souvenir shop \+2 in Melaka/ });
      await expect(navLink).toHaveCount(1);
      await expect(navLink).toHaveAttribute("title", /^souvenir shop, 纪念品店, kedai cenderamata in Melaka · /);

      // Excel CSV download contains all 6 deduped rows and non-Latin titles.
      const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download for Excel" }).click()]);
      const csvBytes = readFileSync(await download.path());
      expect([...csvBytes.subarray(0, 3)]).toEqual(BOM);
      const csvText = csvBytes.subarray(3).toString("utf8");
      expect(csvText).toContain("马六甲纪念品 A");
      expect(csvText).toContain("Cenderamata C");

      // Search again round-trips the full comma-separated keyword set.
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: "Search again" }).click();
      await expect(page.getByLabel("What")).toHaveValue("souvenir shop, 纪念品店, kedai cenderamata");
      await expect(page.getByLabel("Where")).toHaveValue("Melaka");

      // Reordered keywords in the same city combine into the same list in the rail.
      await search(page, "kedai cenderamata, 纪念品店, souvenir shop", "melaka");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Souvenir shop +2 in Melaka");
      await expect(rows(page)).toHaveCount(6);
      await expect(page.getByRole("navigation", { name: "Lists" }).getByRole("link", { name: /Souvenir shop \+2 in Melaka/ })).toHaveCount(1);

      // 375 px phone: no horizontal overflow and readable layout.
      await page.setViewportSize({ width: 375, height: 812 });
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Souvenir shop +2 in Melaka");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
      expect(errors).toEqual([]);
    } finally {
      proc.kill();
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

test.describe("styled Radix selects and stepped slider", () => {
  test("keyboard open, arrow keys, type-ahead and Esc work on all six selects, and stepped slider moves across all stops with Clear", async ({ page }) => {
    const errors = watchConsole(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.getByText("More options", { exact: true }).click();

    // Slider stops: 20 / 60 / 120 / 250 / 500 / 1000 via keyboard arrows, plus Clear.
    const slider = page.getByRole("slider", { name: "Exact number (optional)" });
    await expect(slider).toHaveAttribute("data-unset", "true");
    await slider.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(slider).not.toHaveAttribute("data-unset", "true");
    await expect(slider).toHaveAttribute("aria-valuenow", "0");
    await expect(page.getByText("About 20 places · about 20 seconds")).toBeVisible();

    const stops = [
      "About 60 places · about 50 seconds",
      "About 120 places · about 2 minutes",
      "About 250 places · about 8 minutes · searches the whole city",
      "About 500 places · about 10 minutes · searches the whole city",
      "About 1000 places · about 15 minutes · searches the whole city",
    ];
    for (let i = 0; i < stops.length; i++) {
      await page.keyboard.press("ArrowRight");
      await expect(slider).toHaveAttribute("aria-valuenow", String(i + 1));
      await expect(page.getByText(stops[i]!)).toBeVisible();
    }

    await page.getByRole("button", { name: "Clear" }).click();
    await expect(slider).toHaveAttribute("data-unset", "true");
    await expect(page.getByRole("radio", { name: /Everything one search finds/ })).toBeChecked();

    // Form selects: Language and Country for phone numbers support keyboard open, arrows, type-ahead, Esc.
    const langTrigger = page.getByLabel("Language");
    await langTrigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(langTrigger).toBeFocused();
    await expect(langTrigger).toContainText("English");

    await page.keyboard.press("Space");
    await expect(page.getByRole("option", { name: "English" })).toBeFocused();
    await page.keyboard.type("Bahasa M");
    await expect(page.getByRole("option", { name: "Bahasa Melayu" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(langTrigger).toContainText("Bahasa Melayu");

    const countryTrigger = page.getByLabel("Country for phone numbers");
    await countryTrigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: "Automatic (from the place)" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(countryTrigger).toBeFocused();
    await expect(countryTrigger).toContainText("Automatic (from the place)");

    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: "Automatic (from the place)" })).toBeFocused();
    await page.keyboard.type("Brazil");
    await expect(page.getByRole("option", { name: "Brazil" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(countryTrigger).toContainText("Brazil");

    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: "Brazil" })).toBeFocused();
    await page.keyboard.type("Mexico");
    await expect(page.getByRole("option", { name: "Mexico" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(countryTrigger).toContainText("Mexico");

    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: "Mexico" })).toBeFocused();
    await page.keyboard.type("Malaysia");
    await expect(page.getByRole("option", { name: "Malaysia" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(countryTrigger).toContainText("Malaysia");

    // Search to reach the list page and verify FilterBar's 4 selects.
    await search(page, "tea shop", "Melaka");
    await expect(rows(page)).toHaveCount(19);

    const sortTrigger = page.getByLabel("Sort by");
    await expect(sortTrigger).toContainText("Sort: Default");
    await sortTrigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: "Default" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(sortTrigger).toBeFocused();
    await expect(sortTrigger).toContainText("Sort: Default");

    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: "Default" })).toBeFocused();
    await page.keyboard.type("Reviews");
    await expect(page.getByRole("option", { name: "Reviews" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(sortTrigger).toContainText("Sort: Reviews");

    await page.getByRole("button", { name: "More filters" }).click();
    const ratingTrigger = page.getByLabel("Rating at least");
    await ratingTrigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: "Any rating" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("option", { name: "3.5+ rating" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(ratingTrigger).toContainText("3.5+ rating");

    const reviewsTrigger = page.getByLabel("Reviews at least");
    await reviewsTrigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: "Any reviews" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("option", { name: "5+ reviews", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("option", { name: "10+ reviews", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(reviewsTrigger).toContainText("10+ reviews");

    const emailTypeTrigger = page.getByLabel("Email type");
    await emailTypeTrigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: "Any email type" })).toBeFocused();
    await page.keyboard.type("Shared");
    await expect(page.getByRole("option", { name: "Shared inbox" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(emailTypeTrigger).toContainText("Shared inbox");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "More filters (3)" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("on a 375 px phone: all six selects and slider touch targets are at least 44 px", async ({ page }) => {
    const errors = watchConsole(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.getByText("More options", { exact: true }).click();

    const sliderBox = (await page.locator('[data-slot="slider"]').boundingBox())!;
    expect(sliderBox.height).toBeGreaterThanOrEqual(44);
    expect((await page.getByLabel("Language").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await page.getByLabel("Country for phone numbers").boundingBox())!.height).toBeGreaterThanOrEqual(44);

    await page.getByLabel("Language").click();
    const firstLangOption = page.getByRole("option").first();
    expect((await firstLangOption.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Escape");

    await search(page, "tea shop", "Melaka");
    await expect(rows(page)).toHaveCount(19);
    expect((await page.getByLabel("Sort by").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.getByLabel("Sort by").click();
    expect((await page.getByRole("option", { name: "Rating" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Filters" }).click();
    const sheet = page.getByRole("dialog", { name: "Filters" });
    expect((await sheet.getByLabel("Rating at least").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await sheet.getByLabel("Reviews at least").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await sheet.getByLabel("Email type").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await sheet.getByLabel("Rating at least").click();
    expect((await page.getByRole("option", { name: "4.0+ rating" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });
});
