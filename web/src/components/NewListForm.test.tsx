import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyQuery, queryOf, SIZE_CHOICES, toRequest } from "@/lib/search";
import { NewListForm } from "./NewListForm";

const baseProps = {
  examples: false,
  busy: false,
  error: null,
  onSearch: () => {},
  onInvalid: () => {},
};

describe("NewListForm", () => {
  it("uses 'e.g. Lisbon' for Where, defaults to Everything one search finds, and keeps Exact number inside More options", () => {
    const html = renderToStaticMarkup(<NewListForm {...baseProps} />);
    expect(html).toContain('placeholder="e.g. Lisbon"');
    expect(html).not.toContain("e.g. Lisbon, Portugal");

    for (const choice of SIZE_CHOICES) {
      expect(html).toContain(choice.label);
    }
    expect(html).not.toContain("About 60");
    expect(html).toMatch(/id="size-oneSearch"[^>]*checked=""/);

    // More options is closed by default, and holds Exact number slider with plain hint text.
    expect(html).not.toMatch(/<details[^>]*open=/);
    expect(html).toContain("Exact number (optional)");
    expect(html).toContain('role="slider"');
    expect(html).toContain("Optional. Above 120 searches the whole city.");
    expect(html).toContain('role="combobox"');
    const fieldsetPart = html.split("</fieldset>")[0]!;
    expect(fieldsetPart).not.toContain("Exact number");
  });

  it("opens More options, shows the slider at stop 60, and deselects all three presets when an exact stop is pre-filled", () => {
    const html = renderToStaticMarkup(
      <NewListForm {...baseProps} initial={{ ...emptyQuery(), keyword: "dentist", city: "Lisbon", size: null, exact: "60" }} />,
    );
    expect(html).toMatch(/<details[^>]*open=""/);
    expect(html).not.toMatch(/id="size-about20"[^>]*checked/);
    expect(html).not.toMatch(/id="size-oneSearch"[^>]*checked/);
    expect(html).not.toMatch(/id="size-wholeCity"[^>]*checked/);
    expect(html).toContain('aria-valuetext="About 60 places · about 50 seconds"');
    expect(html).toContain("right:80%");
    expect(html).toContain("About 60 places · about 50 seconds");
    expect(html).toContain(">Clear<");
  });

  it("keeps The whole city selected, leaves the slider unset, and shows stored 50 as text when editing a whole-city list with limit 50", () => {
    const initial = queryOf({
      keyword: "dentist",
      city: "Lisbon",
      depth: 10,
      lang: "en",
      emails: true,
      socials: true,
      deep: true,
      maxSeconds: 1800,
      wholeCity: true,
      limit: 50,
    });
    expect(initial).toMatchObject({ size: "wholeCity", exact: "50" });

    const html = renderToStaticMarkup(<NewListForm {...baseProps} initial={initial} />);
    expect(html).toMatch(/<details[^>]*open=""/);
    expect(html).toMatch(/id="size-wholeCity"[^>]*checked=""/);
    expect(html).toContain("Saved limit: 50 places");
    expect(html).toContain('data-unset="true"');
    expect(toRequest(initial)).toMatchObject({ wholeCity: true, limit: 50 });
  });

  it("renders stop 250 with whole-city duration and preserves 50, 250, and 1000 round trips", () => {
    const q250 = queryOf({
      keyword: "dentist",
      city: "Lisbon",
      depth: 10,
      lang: "en",
      emails: true,
      socials: true,
      deep: true,
      maxSeconds: 1800,
      wholeCity: true,
      limit: 250,
    });
    const html250 = renderToStaticMarkup(<NewListForm {...baseProps} initial={q250} />);
    expect(html250).toContain('aria-valuetext="About 250 places · about 8 minutes · searches the whole city"');
    expect(html250).toContain("right:40%");
    expect(html250).toContain("About 250 places · about 8 minutes · searches the whole city");
    expect(toRequest(q250)).toMatchObject({ wholeCity: true, limit: 250 });

    const q1000 = queryOf({
      keyword: "dentist",
      city: "Lisbon",
      depth: 10,
      lang: "en",
      emails: true,
      socials: true,
      deep: true,
      maxSeconds: 1800,
      wholeCity: true,
      limit: 1000,
    });
    const html1000 = renderToStaticMarkup(<NewListForm {...baseProps} initial={q1000} />);
    expect(html1000).toContain('aria-valuetext="About 1000 places · about 15 minutes · searches the whole city"');
    expect(html1000).toContain("right:0%");
    expect(html1000).toContain("About 1000 places · about 15 minutes · searches the whole city");
    expect(toRequest(q1000)).toMatchObject({ wholeCity: true, limit: 1000 });
  });

  it("shows comma guidance for several keywords in any language and preserves multi-keyword drafts", () => {
    const html = renderToStaticMarkup(
      <NewListForm {...baseProps} initial={{ ...emptyQuery(), keyword: "souvenir shop, 纪念品店, kedai cenderamata", city: "Melaka" }} />,
    );
    expect(html).toContain("commas");
    expect(html).toContain('value="souvenir shop, 纪念品店, kedai cenderamata"');
  });
});
