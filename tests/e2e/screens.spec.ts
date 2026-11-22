// Screenshots of every page state at desktop and phone widths, for review,
// on the Lisbon fixture. Opt-in: `BUSINESS_FINDER_SCREENS=1 bunx playwright test screens`.
// Output goes to tests/e2e/__screens__/ (git-ignored).

import { expect, test, type Page } from "@playwright/test";
import { E2E_PORT } from "../../playwright.config";

test.skip(!process.env.BUSINESS_FINDER_SCREENS, "set BUSINESS_FINDER_SCREENS=1 to take screenshots");

const WIDTHS = [1280, 375] as const;
const SCHEMES = ["light", "dark"] as const;

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: `tests/e2e/__screens__/${name}.png`, fullPage: true });
}

async function search(page: Page) {
  await page.getByLabel("What").fill("dentist");
  await page.getByLabel("Where").fill("Lisbon, Portugal");
  await page.getByRole("button", { name: "Find", exact: true }).click();
}

async function rewriteJob(page: Page, change: (job: Record<string, unknown>) => void) {
  await page.route(/\/api\/v1\/lists\/[^/?]+$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const job = await response.json();
    change(job);
    await route.fulfill({ response, json: job });
  });
}

for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    test.describe(`${scheme} ${width}px`, () => {
      test.use({ baseURL: `http://127.0.0.1:${E2E_PORT + 1}`, viewport: { width, height: width > 600 ? 800 : 812 }, colorScheme: scheme });
      const tag = `${width}-${scheme}`;

      test("new list, done, lists sheet, unknown", async ({ page }) => {
        const errors: string[] = [];
        page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
        // A first visit: no lists yet, so the examples show.
        await page.route(/\/api\/v1\/lists$/, (route) =>
          route.request().method() === "GET" ? route.fulfill({ json: { lists: [] } }) : route.fallback(),
        );
        await page.goto("/");
        await expect(page.getByRole("group", { name: "Example searches" })).toBeVisible();
        await shoot(page, `new-${tag}`);
        await page.unrouteAll();

        await search(page);
        await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Search the whole city (5–15 min)" })).toBeVisible();
        await page.getByRole("heading", { level: 1 }).blur();
        await shoot(page, `done-${tag}`);
        await page.getByRole("button", { name: "Search the whole city (5–15 min)" }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `tests/e2e/__screens__/find-more-${tag}.png` });

        if (width < 1024) {
          await page.evaluate(() => window.scrollTo(0, 240));
          await page.screenshot({ path: `tests/e2e/__screens__/scrolled-${tag}.png` });
          await page.evaluate(() => window.scrollTo(0, 0));

          await page.getByRole("button", { name: "Lists" }).click();
          await expect(page.getByRole("dialog")).toBeVisible();
          await page.screenshot({ path: `tests/e2e/__screens__/sheet-${tag}.png` });
          await page.keyboard.press("Escape");
        }

        await page.goto("/?job=00000000-0000-4000-8000-000000000000");
        await expect(page.getByText("This list is no longer available.")).toBeVisible();
        await shoot(page, `unknown-${tag}`);
        expect(errors.filter((e) => !e.includes("404"))).toEqual([]);
      });

      test("running", async ({ page }) => {
        await rewriteJob(page, (job) => {
          job.status = "running";
          delete job.reconciliation;
          // Before the first batch is saved: the rows' skeleton.
          delete job.saved;
          job.progress = { stage: "checking_websites", places: 5, checked: 1, toCheck: 3, message: "" };
        });
        // The rail reads the job list; show the search running there too.
        await page.route(/\/api\/v1\/lists$/, async (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          const response = await route.fetch();
          const body = (await response.json()) as { lists: Record<string, unknown>[] };
          for (const job of body.lists) {
            job.status = "running";
            delete job.reconciliation;
          }
          await route.fulfill({ response, json: body });
        });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/");
        await search(page);
        await expect(page.getByRole("status")).toHaveText("Looking for emails on websites: 1 of 3");
        await page.getByRole("heading", { level: 1 }).blur();
        await shoot(page, `running-${tag}`);
      });

      test("new list with each choice and More options closed and open", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/");
        await expect(page.getByRole("radio", { name: /Everything one search finds/ })).toBeChecked();
        await shoot(page, `new-options-closed-${tag}`);

        await page.getByText("A quick look", { exact: true }).click();
        await expect(page.getByRole("radio", { name: /A quick look/ })).toBeChecked();
        await shoot(page, `new-choice-quick-${tag}`);

        await page.getByText("The whole city", { exact: true }).click();
        await expect(page.getByRole("radio", { name: /The whole city/ })).toBeChecked();
        await shoot(page, `new-choice-whole-${tag}`);

        await page.getByText("More options", { exact: true }).click();
        await expect(page.getByLabel("Look for emails on websites")).toBeVisible();
        await page.getByText("More options", { exact: true }).blur();
        await page.evaluate(() => window.scrollTo(0, 0));
        await shoot(page, `new-options-open-${tag}`);

        const slider = page.getByRole("slider", { name: "Exact number (optional)" });
        await slider.focus();
        for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
        await expect(page.getByRole("radio", { name: /The whole city/ })).not.toBeChecked();
        await slider.blur();
        await page.evaluate(() => window.scrollTo(0, 0));
        await shoot(page, `new-options-number-${tag}`);
      });

      test("running with partial rows", async ({ page }) => {
        // The batches server: 7 places a batch, 2.5 s apart; the first batch is saved, the search goes on.
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto(`http://127.0.0.1:${E2E_PORT + 3}/`);
        await page.getByLabel("What").fill("souvenir shop");
        await page.getByLabel("Where").fill("Melaka");
        await page.getByRole("button", { name: "Find", exact: true }).click();
        await expect(page.getByRole("main").getByRole("list").first().locator(":scope > li")).toHaveCount(7);
        await page.getByRole("heading", { level: 1 }).blur();
        await shoot(page, `running-rows-${tag}`);
        await page.getByRole("button", { name: "Cancel search" }).click();
        await page.getByRole("alertdialog").getByRole("button", { name: "Cancel search" }).click();
        await expect(page.getByRole("button", { name: "Edit search" })).toBeVisible();
      });

      test("cancelled", async ({ page }) => {
        await rewriteJob(page, (job) => {
          job.status = "cancelled";
          delete job.reconciliation;
        });
        await page.route(/\/api\/v1\/lists$/, async (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          const response = await route.fetch();
          const body = (await response.json()) as { lists: Record<string, unknown>[] };
          for (const job of body.lists) {
            job.status = "cancelled";
            delete job.reconciliation;
          }
          await route.fulfill({ response, json: body });
        });
        await page.goto("/");
        await search(page);
        await expect(page.getByRole("button", { name: "Edit search" })).toBeVisible();
        await page.getByRole("heading", { level: 1 }).blur();
        await shoot(page, `cancelled-${tag}`);
      });

      test("cancel dialog", async ({ page }) => {
        await rewriteJob(page, (job) => {
          job.status = "running";
          delete job.reconciliation;
          job.progress = { stage: "searching", places: 4, message: "" };
        });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/");
        await search(page);
        await page.getByRole("button", { name: "Cancel search" }).click();
        await expect(page.getByRole("alertdialog")).toBeVisible();
        await page.screenshot({ path: `tests/e2e/__screens__/cancel-dialog-${tag}.png` });
      });

      test("two runs that share a title", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        // The run in "Lisbon" is dated a day earlier, as if it ran yesterday.
        await page.route(/\/api\/v1\/lists$/, async (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          const response = await route.fetch();
          const body = (await response.json()) as { lists: { options: { keyword: string; city: string }; createdAt: string }[] };
          for (const job of body.lists) {
            if (job.options.city === "Lisbon") job.createdAt = new Date(Date.parse(job.createdAt) - 86_400_000).toISOString();
          }
          await route.fulfill({ response, json: body });
        });
        await page.goto("/");
        await page.getByLabel("What").fill("event management");
        await page.getByLabel("Where").fill("Lisbon");
        await page.getByRole("button", { name: "Find", exact: true }).click();
        await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible();
        await page.getByRole("link", { name: "New list" }).first().click();
        await page.getByLabel("What").fill("event management");
        await page.getByLabel("Where").fill("Lisbon, Portugal");
        await page.getByRole("button", { name: "Find", exact: true }).click();
        await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible();
        await page.getByRole("heading", { level: 1 }).blur();
        if (width < 1024) {
          await page.getByRole("button", { name: "Lists" }).click();
          const dialog = page.getByRole("dialog");
          await expect(dialog).toBeVisible();
          const eventLinks = dialog.getByRole("link", { name: /^Event management in Lisbon/ });
          await expect(eventLinks.first().getByText("Lisbon, Portugal", { exact: true })).toBeVisible();
          await expect(eventLinks.nth(1).getByText("Lisbon", { exact: true })).toBeVisible();
          await page.screenshot({ path: `tests/e2e/__screens__/same-search-${tag}.png` });
        } else {
          const eventLinks = page.getByRole("navigation", { name: "Lists" }).getByRole("link", { name: /^Event management in Lisbon/ });
          await expect(eventLinks.first().getByText("Lisbon, Portugal", { exact: true })).toBeVisible();
          await expect(eventLinks.nth(1).getByText("Lisbon", { exact: true })).toBeVisible();
          await page.screenshot({ path: `tests/e2e/__screens__/same-search-${tag}.png` });
        }
      });

      test("a list that mixes Maps and web-search places", async ({ page }) => {
        // Seeded by scripts/e2e-serve.ts: six Maps places plus two websites added with `business-finder add --into`.
        await page.goto("/");
        if (width < 1024) {
          await page.getByRole("button", { name: "Lists" }).click();
          await page.getByRole("dialog").getByRole("link", { name: /^Orthodontist in Lisbon/ }).click();
        } else {
          await page.getByRole("navigation", { name: "Lists" }).getByRole("link", { name: /^Orthodontist in Lisbon/ }).click();
        }
        await expect(page.getByText("2 from web search", { exact: true })).toBeVisible();
        await page.getByRole("heading", { level: 1 }).blur();
        await shoot(page, `mixed-${tag}`);
      });

      if (width < 1024) {
        test("tap a missing link", async ({ browser }) => {
          const context = await browser.newContext({
            baseURL: `http://127.0.0.1:${E2E_PORT + 1}`,
            viewport: { width, height: 812 },
            colorScheme: scheme,
            isMobile: true,
            hasTouch: true,
            reducedMotion: "reduce",
          });
          const page = await context.newPage();
          await page.goto("/");
          await search(page);
          const row = page.getByRole("main").getByRole("list").first().locator(":scope > li").filter({ hasText: "Zahnarztpraxis Müller" });
          await row.getByRole("button", { name: "No website" }).tap();
          await expect(page.getByRole("dialog").filter({ hasText: "No website" })).toBeVisible();
          await row.scrollIntoViewIfNeeded();
          await page.screenshot({ path: `tests/e2e/__screens__/missing-tap-${tag}.png` });
          await context.close();
        });
      }

      test("zero places", async ({ page }) => {
        await rewriteJob(page, (job) => {
          if (job.status !== "done") return;
          job.reconciliation = { found: 0, kept: 0, filtered: 0, duplicates: 0, toCheck: 0, fetched: 0, unreachable: 0, mismatched: 0, skipped: 0 };
          delete job.saved;
          // Every test searches for dentists, so the list combines many runs; show it as one run that found nothing.
          job.runs = 1;
        });
        await page.goto("/");
        await search(page);
        await expect(page.getByText("No places found for this search.")).toBeVisible();
        await page.getByRole("heading", { level: 1 }).blur();
        await shoot(page, `empty-${tag}`);
      });

      test("failed", async ({ page }) => {
        await rewriteJob(page, (job) => {
          if (job.status !== "done") return;
          job.status = "failed";
          job.error = "Could not reach OpenStreetMap to look up Lisbon, Portugal. Check the internet connection and try again.";
          delete job.reconciliation;
          delete job.saved;
        });
        await page.goto("/");
        await search(page);
        await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
        await page.getByRole("heading", { level: 1 }).blur();
        await shoot(page, `failed-${tag}`);
      });

      test("searching around, another country, a whole state", async ({ page }) => {
        // One route for all three states; `error` switches it from running to stopped.
        let error: string | null = null;
        let placeOverride: Record<string, string> | null = null;
        await rewriteJob(page, (job) => {
          delete job.reconciliation;
          delete job.saved;
          if (placeOverride) job.place = placeOverride;
          if (error === null) {
            job.status = "running";
            job.progress = { stage: "searching", places: 0, message: "" };
          } else if (job.status === "done") {
            job.status = "failed";
            job.error = error;
          }
        });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/");
        await search(page);
        await expect(page.getByText("Searching around Lisbon, Portugal", { exact: true })).toBeVisible();
        await page.getByRole("heading", { level: 1 }).blur();
        await shoot(page, `around-${tag}`);
        if (width === 1280 && scheme === "dark") {
          placeOverride = { name: "Pojuca", type: "town", label: "Pojuca, Bahia, Brazil" };
          await page.goto("/");
          await page.getByLabel("What").fill("coffee");
          await page.getByLabel("Where").fill("PJ");
          await page.getByRole("button", { name: "Find", exact: true }).click();
          await expect(page.getByText("Searching around Pojuca, Bahia, Brazil", { exact: true })).toBeVisible();
          await page.getByRole("heading", { level: 1 }).blur();
          await shoot(page, `around-pj-no-country-${tag}`);
          placeOverride = null;
        }

        const stops = [
          ["other-country", "PJ matched Pojuca in Brazil, not Malaysia. Write the full place name with its region and country."],
          ["state", "Penang is a whole state, too large for one search. Search towns inside it instead; you can give several at once."],
        ] as const;
        for (const [name, message] of stops) {
          error = message;
          await page.goto("/");
          await search(page);
          await expect(page.getByText(message)).toBeVisible();
          await page.getByRole("heading", { level: 1 }).blur();
          await shoot(page, `${name}-${tag}`);
        }
      });

      test("a search run twice: new and not-found markers", async ({ page }) => {
        // The repeat server (scripts/e2e-serve.ts) holds one run of this search; a second run finds other places.
        const repeat = `http://127.0.0.1:${E2E_PORT + 4}`;
        const { lists } = (await (await page.request.get(`${repeat}/api/v1/lists`)).json()) as { lists: { id: string; runs: number }[] };
        if (lists[0]!.runs === 1) {
          await page.goto(`${repeat}/`);
          await page.getByLabel("What").fill("gift shop");
          await page.getByLabel("Where").fill("Melaka");
          await page.getByRole("button", { name: "Find", exact: true }).click();
          await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible();
        } else {
          await page.goto(`${repeat}/?job=${lists[0]!.id}`);
        }
        await expect(page.getByText("4 new since the last search", { exact: true })).toBeVisible();
        await expect(page.getByTestId("row-marker").filter({ hasText: "Not in the last search" })).toHaveCount(5);
        await page.getByRole("heading", { level: 1 }).blur();
        await shoot(page, `combined-${tag}`);
      });

      test("stopped empty list, stopped with places, rail with stopped and cancelled, and running grid", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        const interrupted =
          "This search was interrupted because Business Finder was closed or restarted. Nothing is lost; try again to finish it.";
        const interruptedEmpty =
          "This search was interrupted because Business Finder was closed or restarted. Nothing was saved before it stopped. Try again to run this search.";
        await rewriteJob(page, (job) => {
          if (job.status !== "done") return;
          job.status = "failed";
          job.error = interrupted;
          job.runs = 1;
          delete job.reconciliation;
          delete job.saved;
        });
        await page.route(/\/api\/v1\/lists$/, async (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          const response = await route.fetch();
          const body = (await response.json()) as { lists: Record<string, unknown>[] };
          if (body.lists[0]) {
            body.lists[0].status = "failed";
            body.lists[0].error = interrupted;
            body.lists[0].title = "Event management in Kuala Lumpur";
            body.lists[0].count = 0;
            delete body.lists[0].reconciliation;
            delete body.lists[0].saved;
          }
          if (body.lists.length < 2 && body.lists[0]) {
            body.lists.push({ ...body.lists[0], id: "00000000-0000-4000-8000-000000000099" });
          }
          if (body.lists[1]) {
            body.lists[1].status = "cancelled";
            body.lists[1].title = "Florist in Lisbon";
            body.lists[1].count = 0;
            delete body.lists[1].reconciliation;
            delete body.lists[1].saved;
          }
          await route.fulfill({ response, json: body });
        });
        await page.goto("/");
        await page.getByLabel("What").fill("event management");
        await page.getByLabel("Where").fill("Kuala Lumpur");
        await page.getByRole("button", { name: "Find", exact: true }).click();
        await expect(page.getByText(interruptedEmpty)).toBeVisible();
        await expect(page.getByText("Nothing is lost")).toHaveCount(0);
        await page.getByRole("heading", { level: 1 }).blur();
        await shoot(page, `stopped-empty-${tag}`);

        if (width < 1024) {
          await page.getByRole("button", { name: "Lists" }).click();
          const dialog = page.getByRole("dialog");
          await expect(dialog).toBeVisible();
          await expect(dialog.getByText("Stopped", { exact: true })).toBeVisible();
          await expect(dialog.getByText("Cancelled", { exact: true })).toBeVisible();
          await page.screenshot({ path: `tests/e2e/__screens__/rail-stopped-cancelled-${tag}.png` });
          await page.keyboard.press("Escape");
        } else {
          const nav = page.getByRole("navigation", { name: "Lists" });
          await expect(nav.getByText("Stopped", { exact: true })).toBeVisible();
          await expect(nav.getByText("Cancelled", { exact: true })).toBeVisible();
          await page.screenshot({ path: `tests/e2e/__screens__/rail-stopped-cancelled-${tag}.png` });
        }

        await page.unrouteAll();
        await rewriteJob(page, (job) => {
          if (job.status !== "done") return;
          job.status = "failed";
          job.error = interrupted;
          job.runs = 1;
        });
        await page.goto("/");
        await search(page);
        await expect(page.getByText(interrupted)).toBeVisible();
        await expect(page.getByText(/it read before it stopped/)).toBeVisible();
        await page.getByRole("heading", { level: 1 }).blur();
        await shoot(page, `stopped-with-places-${tag}`);

        await page.unrouteAll();
        await rewriteJob(page, (job) => {
          job.status = "running";
          job.options = { ...(job.options as Record<string, unknown>), wholeCity: true };
          delete job.reconciliation;
          delete job.saved;
          job.progress = { stage: "searching", places: 42, cell: 3, cells: 12, message: "" };
        });
        await page.goto("/");
        await search(page);
        await expect(page.getByRole("status")).toHaveText("Searching Google Maps (area 3 of 12)… 42 places so far");
        await page.getByRole("heading", { level: 1 }).blur();
        await shoot(page, `running-grid-${tag}`);
      });

      test("legacy interrupted list", async ({ page }) => {
        const legacyInterrupted = "leadscout was stopped before this run finished. Start the search again.";
        const interruptedEmpty =
          "This search was interrupted because Business Finder was closed or restarted. Nothing was saved before it stopped. Try again to run this search.";
        await rewriteJob(page, (job) => {
          if (job.status !== "done") return;
          job.status = "failed";
          job.error = legacyInterrupted;
          job.runs = 1;
          delete job.reconciliation;
          delete job.saved;
        });
        await page.route(/\/api\/v1\/lists$/, async (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          const response = await route.fetch();
          const body = (await response.json()) as { lists: Record<string, unknown>[] };
          if (body.lists[0]) {
            body.lists[0].status = "failed";
            body.lists[0].error = legacyInterrupted;
            body.lists[0].title = "Event management in Kuala Lumpur";
            body.lists[0].count = 0;
            delete body.lists[0].reconciliation;
            delete body.lists[0].saved;
          }
          await route.fulfill({ response, json: body });
        });
        await page.goto("/");
        await page.getByLabel("What").fill("event management");
        await page.getByLabel("Where").fill("Kuala Lumpur");
        await page.getByRole("button", { name: "Find", exact: true }).click();
        await expect(page.getByText(interruptedEmpty)).toBeVisible();
        await expect(page.locator("main")).not.toContainText("this run");
        if (width > 600) {
          await expect(page.getByRole("navigation", { name: "Lists" }).getByText("Stopped")).toBeVisible();
        }
        await page.getByRole("heading", { level: 1 }).blur();
        await shoot(page, `stopped-legacy-${tag}`);
      });

      test("email row wording", async ({ page }) => {
        await page.route(/\/api\/v1\/jobs\/[^/]+\/rows$/, async (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          const response = await route.fetch();
          const body = (await response.json()) as { rows: Record<string, unknown>[]; list: unknown };
          if (body.rows[0]) {
            body.rows[0].emails = ["hello@clinica.test"];
            body.rows[0].email_types = ["generic"];
            body.rows[0].email_mx = ["ok"];
          }
          if (body.rows[1]) {
            body.rows[1].emails = ["dr.tanaka@dental.test"];
            body.rows[1].email_types = ["personal"];
            body.rows[1].email_mx = ["no mail server"];
          }
          if (body.rows[2]) {
            body.rows[2].emails = ["contact@alnoor.test"];
            body.rows[2].email_types = ["generic"];
            body.rows[2].email_mx = ["unknown"];
          }
          if (body.rows[3]) {
            body.rows[3].emails = ["clinic2026@parque.test"];
            body.rows[3].email_types = ["not_sure"];
            body.rows[3].email_mx = ["ok"];
          }
          await route.fulfill({ response, json: body });
        });
        await page.goto("/");
        await search(page, "dentist", "Lisbon, Portugal");
        await expect(page.getByText("shared inbox · address can receive mail")).toBeVisible();
        await expect(page.getByText("a person's address · cannot receive mail")).toBeVisible();
        await expect(page.getByText("shared inbox · could not check mail")).toBeVisible();
        await expect(page.getByText("not sure · address can receive mail")).toBeVisible();
        await page.getByRole("heading", { level: 1 }).blur();
        await shoot(page, `email-rows-${tag}`);
      });

      test("filters on and filtered empty state", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/");
        await search(page, "dentist", "Lisbon, Portugal");
        await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible();

        if (width < 1024) {
          await page.getByRole("button", { name: "Filters" }).click();
          const sheet = page.getByRole("dialog", { name: "Filters" });
          await sheet.getByRole("button", { name: "Has WhatsApp" }).click();
          await page.screenshot({ path: `tests/e2e/__screens__/filter-sheet-${tag}.png` });
          await sheet.getByRole("button", { name: "Done" }).click();
        } else {
          await page.getByRole("button", { name: "Has WhatsApp" }).click();
        }
        await expect(page.getByText("3 of 6 shown", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Download 3 for Excel" })).toBeVisible();
        await page.evaluate(() => window.scrollTo(0, 0));
        await shoot(page, `filtered-${tag}`);

        // Turn on an incompatible combination (WhatsApp + Email + 4.5+ is 1, hide Dentist category -> 0).
        if (width < 1024) {
          await page.getByRole("button", { name: /Filters/ }).click();
          const sheet = page.getByRole("dialog", { name: "Filters" });
          await sheet.getByRole("checkbox", { name: /Dentist/ }).uncheck();
          await sheet.getByRole("button", { name: "Done" }).click();
        } else {
          await page.getByRole("button", { name: "More filters" }).click();
          await expect(page.getByLabel("Email type")).toBeVisible();
          await page.screenshot({ path: `tests/e2e/__screens__/more-filters-open-${tag}.png` });
          await page.getByRole("checkbox", { name: /Dentist/ }).uncheck();
          await page.keyboard.press("Escape");
        }
        await expect(page.getByText("No places match these filters.")).toBeVisible();
        await page.evaluate(() => window.scrollTo(0, 0));
        await shoot(page, `filtered-empty-${tag}`);
      });

      test("delete dialog and after delete", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto("/");
        await page.getByLabel("What").fill("optician");
        await page.getByLabel("Where").fill("Lisbon, Portugal");
        await page.getByRole("button", { name: "Find", exact: true }).click();
        await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible();

        await page.getByRole("button", { name: "More actions" }).click();
        await page.getByRole("menuitem", { name: "Delete list" }).click();
        const dialog = page.getByRole("alertdialog");
        await expect(dialog).toBeVisible();
        await page.screenshot({ path: `tests/e2e/__screens__/delete-dialog-${tag}.png` });

        await dialog.getByRole("button", { name: "Delete" }).click();
        await expect(dialog).toBeHidden();
        await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("Optician in Lisbon");
        await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible();
        await page.getByRole("heading", { level: 1 }).blur();
        await shoot(page, `after-delete-${tag}`);
      });

      test("several keywords running and done", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await rewriteJob(page, (job) => {
          job.status = "running";
          job.options = {
            ...(job.options as Record<string, unknown>),
            keyword: "dentist",
            keywords: ["dentist", "牙医", "doktor gigi"],
            wholeCity: true,
          };
          delete job.reconciliation;
          delete job.saved;
          job.progress = { stage: "searching", places: 25, keywordIndex: 2, keywordsTotal: 3, cell: 3, cells: 12, message: "" };
        });
        await page.goto("/");
        await page.getByLabel("What").fill("dentist, 牙医, doktor gigi");
        await page.getByLabel("Where").fill("Lisbon, Portugal");
        await page.getByRole("button", { name: "Find", exact: true }).click();
        await expect(page.getByRole("status")).toHaveText("Searching Google Maps (keyword 2 of 3, area 3 of 12)… 25 places so far");
        await expect(page.locator("main")).not.toContainText(/\b(run|grid|cell|depth|JSON)\b/i);
        await page.getByRole("heading", { level: 1 }).blur();
        await page.evaluate(() => window.scrollTo(0, 0));
        await shoot(page, `multi-keyword-running-${tag}`);

        await page.unrouteAll();
        await page.goto("/");
        await page.getByLabel("What").fill("dentist, 牙医, doktor gigi");
        await page.getByLabel("Where").fill("Lisbon, Portugal");
        await page.getByRole("button", { name: "Find", exact: true }).click();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dentist +2 in Lisbon");
        await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible();
        await expect(page.getByText("dentist, 牙医, doktor gigi", { exact: true })).toBeVisible();
        await expect(page.locator("main")).not.toContainText(/\b(run|grid|cell|depth|JSON)\b/i);
        await page.getByRole("heading", { level: 1 }).blur();
        await page.evaluate(() => window.scrollTo(0, 0));
        await shoot(page, `multi-keyword-done-${tag}`);
      });
    });
  }
}

for (const width of WIDTHS) {
  test.describe(`styled controls and stepped slider ${width}px`, () => {
    test.use({ baseURL: `http://127.0.0.1:${E2E_PORT + 1}`, viewport: { width, height: width > 600 ? 800 : 812 }, colorScheme: "dark" });

    test("form More options, slider stops 20/120/500, and every select open", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await page.getByText("More options", { exact: true }).click();
      await expect(page.getByLabel("Look for emails on websites")).toBeVisible();
      await page.getByText("More options", { exact: true }).blur();
      await page.evaluate(() => window.scrollTo(0, 0));
      await shoot(page, `controls-form-more-options-${width}`);

      const slider = page.getByRole("slider", { name: "Exact number (optional)" });
      await slider.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(page.getByText("About 20 places · about 20 seconds")).toBeVisible();
      await slider.blur();
      await page.evaluate(() => window.scrollTo(0, 0));
      await shoot(page, `controls-slider-20-${width}`);

      await slider.focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect(page.getByText("About 120 places · about 2 minutes")).toBeVisible();
      await slider.blur();
      await page.evaluate(() => window.scrollTo(0, 0));
      await shoot(page, `controls-slider-120-${width}`);

      await slider.focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect(page.getByText("About 500 places · about 10 minutes · searches the whole city")).toBeVisible();
      await slider.blur();
      await page.evaluate(() => window.scrollTo(0, 0));
      await shoot(page, `controls-slider-500-${width}`);

      await page.getByLabel("Language").click();
      await expect(page.getByRole("listbox")).toBeVisible();
      await page.screenshot({ path: `tests/e2e/__screens__/controls-select-lang-${width}.png` });
      await page.keyboard.press("Escape");

      await page.getByLabel("Country for phone numbers").click();
      await expect(page.getByRole("listbox")).toBeVisible();
      await page.screenshot({ path: `tests/e2e/__screens__/controls-select-country-${width}.png` });
      await page.keyboard.press("Escape");

      await search(page);
      await expect(page.getByRole("button", { name: "Download for Excel" })).toBeVisible();

      await page.getByLabel("Sort by").click();
      await expect(page.getByRole("listbox")).toBeVisible();
      await page.screenshot({ path: `tests/e2e/__screens__/controls-select-sort-${width}.png` });
      await page.keyboard.press("Escape");

      if (width < 1024) {
        await page.getByRole("button", { name: "Filters" }).click();
        const sheet = page.getByRole("dialog", { name: "Filters" });
        await expect(sheet).toBeVisible();
        await page.screenshot({ path: `tests/e2e/__screens__/controls-more-filters-${width}.png` });

        for (const [key, label] of [
          ["rating", "Rating at least"],
          ["reviews", "Reviews at least"],
          ["email-type", "Email type"],
        ] as const) {
          await sheet.getByLabel(label).click();
          await expect(page.getByRole("listbox")).toBeVisible();
          await page.screenshot({ path: `tests/e2e/__screens__/controls-select-${key}-${width}.png` });
          await page.keyboard.press("Escape");
        }
      } else {
        await page.getByRole("button", { name: "More filters" }).click();
        await expect(page.getByLabel("Email type")).toBeVisible();
        await page.screenshot({ path: `tests/e2e/__screens__/controls-more-filters-${width}.png` });

        for (const [key, label] of [
          ["rating", "Rating at least"],
          ["reviews", "Reviews at least"],
          ["email-type", "Email type"],
        ] as const) {
          await page.getByLabel(label).click();
          await expect(page.getByRole("listbox")).toBeVisible();
          await page.screenshot({ path: `tests/e2e/__screens__/controls-select-${key}-${width}.png` });
          await page.keyboard.press("Escape");
        }
      }
    });
  });
}
