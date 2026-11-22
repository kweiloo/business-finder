import { ChevronRight } from "lucide-react";
import { type FormEvent, useId, useMemo, useRef, useState } from "react";
import { parseKeywords } from "../../../src/core/keywords";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  COUNTRY_CODES,
  countryName,
  DEFAULT_SEARCH_SIZE,
  emptyQuery,
  EXACT_STOPS,
  exactStopIndex,
  exactSummaryText,
  LANGUAGES,
  MAX_WHOLE_CITY_LIMIT,
  type Query,
  SIZE_CHOICES,
} from "@/lib/search";
import { cn } from "@/lib/utils";

export type { Query };

/** Generic starting points for a first search; they fill the What field. */
const EXAMPLES = ["dentist", "hotel", "event venue", "accounting firm"] as const;

export type SearchError = { message: string; field?: "keyword" | "city" | "exact" | undefined };

type Props = {
  /** A list's search to start from (Edit search); the fields start empty without it. */
  initial?: Query | null | undefined;
  /** Shows the example searches; off once the person has any list. */
  examples: boolean;
  busy: boolean;
  error: SearchError | null;
  /** Puts the cursor in What when the form was opened on purpose (＋ or Edit search). */
  autoFocus?: boolean;
  onSearch(query: Query): void;
  onInvalid(error: SearchError): void;
};

const AUTO_COUNTRY = "auto";

const selectTrigger = "h-11 border-field bg-surface px-3 text-base sm:h-10 sm:text-sm";

/**
 * The new-list form. It owns what is typed: nothing the page loads later
 * (the job list answering, for example) remounts it or replaces the fields.
 *
 * One visible choice besides the search itself, how many places; the rest
 * sits under "More options", closed, with defaults that suit a first search.
 */
export function NewListForm({ initial, examples, busy, error, autoFocus = false, onSearch, onInvalid }: Props) {
  const start = initial ?? emptyQuery();
  const [keyword, setKeyword] = useState(start.keyword);
  const [city, setCity] = useState(start.city);
  const [size, setSize] = useState(start.size);
  const [exact, setExact] = useState(start.exact);
  const [emails, setEmails] = useState(start.emails);
  const [lang, setLang] = useState(start.lang);
  const [country, setCountry] = useState(start.country);
  const errorId = useId();
  const headingId = useId();
  const whatHintId = useId();
  const sizeId = useId();
  const exactLabelId = useId();
  const exactHintId = useId();
  const emailsHintId = useId();
  const countryHintId = useId();
  const whereRef = useRef<HTMLInputElement>(null);
  const sliderChangedRef = useRef(false);
  // An edited search with options changed opens with them showing.
  const changed = start.exact.trim() !== "" || start.emails !== true || start.lang !== "en" || start.country !== "";
  const stopIndex = exactStopIndex(exact);
  const exactUnset = stopIndex === null;
  const exactSummary = exactSummaryText(exact, size);
  const countries = useMemo(
    () => COUNTRY_CODES.map((code) => ({ code, name: countryName(code) })).sort((a, b) => a.name.localeCompare(b.name)),
    [],
  );
  // A language not in the list (set from the API or a terminal) stays selectable.
  const languages = LANGUAGES.some((l) => l.code === lang) ? LANGUAGES : [...LANGUAGES, { code: lang, name: lang }];
  const countryList = !country || countries.some((c) => c.code === country) ? countries : [...countries, { code: country, name: country }];
  const selectedLang = languages.find((l) => l.code === lang)?.name ?? lang;
  const selectedCountry = !country ? "Automatic (from the place)" : (countryList.find((c) => c.code === country)?.name ?? country);

  function selectStop(index: number) {
    const stop = EXACT_STOPS[index];
    if (stop === undefined) return;
    setExact(String(stop));
    setSize(null);
  }

  function clearExact() {
    setExact("");
    setSize(DEFAULT_SEARCH_SIZE);
  }

  // Fills What, then moves on to Where when it is still empty.
  function pickExample(example: string) {
    setKeyword(example);
    if (!city.trim()) whereRef.current?.focus();
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const k = keyword.trim();
    const c = city.trim();
    // The same wording the API uses, so the message does not change with where it was caught.
    if (!k || parseKeywords(k).length === 0) return onInvalid({ field: "keyword", message: "Enter what to search for." });
    if (!c) return onInvalid({ field: "city", message: "Enter a city." });
    const ex = exact.trim();
    if (ex !== "" && (!/^\d+$/.test(ex) || Number(ex) < 1 || Number(ex) > MAX_WHOLE_CITY_LIMIT)) {
      return onInvalid({ field: "exact", message: `Enter a whole number from 1 to ${MAX_WHOLE_CITY_LIMIT}.` });
    }
    onSearch({ keyword: k, city: c, size, exact: ex, emails, lang, country });
  }

  const field = "h-12 rounded-md px-3.5 text-base placeholder:text-placeholder";

  return (
    <section aria-labelledby={headingId} className="flex max-w-2xl flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 id={headingId} className="font-serif text-[30px] leading-tight font-semibold text-balance lg:text-[40px]">
          Find businesses to contact
        </h1>
        <p className="max-w-prose text-[15px] text-muted text-pretty">
          Name a kind of business and a city. Business Finder searches Google Maps from this computer, then reads each business's own
          website for emails, and keeps the result here as a list.
        </p>
      </div>

      <form onSubmit={submit} noValidate aria-labelledby={headingId} className="flex flex-col gap-6">
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="what">What</Label>
            <Input
              id="what"
              name="keyword"
              autoComplete="off"
              autoFocus={autoFocus}
              placeholder="e.g. dentist, 牙医"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              aria-describedby={whatHintId}
              aria-invalid={error?.field === "keyword" || undefined}
              aria-errormessage={error?.field === "keyword" ? errorId : undefined}
              className={field}
            />
            <p id={whatHintId} className="text-[13px] text-muted text-pretty">
              Separate several keywords with commas, in any language.
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="where">Where</Label>
            <Input
              id="where"
              ref={whereRef}
              name="city"
              autoComplete="address-level2"
              placeholder="e.g. Lisbon"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              aria-invalid={error?.field === "city" || undefined}
              aria-errormessage={error?.field === "city" ? errorId : undefined}
              className={field}
            />
          </div>
        </div>

        {/* Native radios: arrow keys move between the choices, Tab leaves the group. */}
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend id={sizeId} className="pb-1.5 text-sm font-medium text-muted">
            How many places
          </legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {SIZE_CHOICES.map((choice) => {
              const hintId = `${sizeId}-${choice.size}`;
              return (
                <label
                  key={choice.size}
                  className={cn(
                    "relative flex cursor-pointer flex-col gap-0.5 rounded-md border border-line-strong bg-surface px-3.5 py-3",
                    "transition-colors duration-150 ease-out motion-reduce:transition-none",
                    "has-checked:border-accent has-checked:ring-1 has-checked:ring-accent",
                    "has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-2 has-focus-visible:ring-offset-background",
                  )}
                >
                  <input
                    type="radio"
                    id={`size-${choice.size}`}
                    name="size"
                    value={choice.size}
                    checked={size === choice.size}
                    onChange={() => {
                      setSize(choice.size);
                      setExact("");
                    }}
                    aria-describedby={hintId}
                    className="peer sr-only"
                  />
                  <span className="text-[15px] font-medium text-foreground">{choice.label}</span>
                  <span id={hintId} className="text-[13px] text-muted text-pretty">
                    {choice.hint}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <details open={changed || error?.field === "exact" || undefined} className="group">
          <summary
            className={cn(
              "inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md pr-2 text-sm font-medium text-muted select-none sm:min-h-8",
              "hover:text-foreground [&::-webkit-details-marker]:hidden",
              "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            )}
          >
            <ChevronRight
              aria-hidden="true"
              className="size-4 transition-transform duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none"
            />
            More options
          </summary>
          <div className="mt-3 flex flex-col gap-5 border-l border-line pl-4">
            <div className="flex flex-col gap-2 sm:max-w-sm">
              <div className="flex min-h-8 items-center justify-between gap-3">
                <span id={exactLabelId} className="text-sm font-medium text-foreground">
                  Exact number (optional)
                </span>
                {exact.trim() !== "" && (
                  <button
                    type="button"
                    onClick={clearExact}
                    className="inline-flex min-h-11 cursor-pointer items-center rounded-md px-2 text-xs font-medium text-muted underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:min-h-7"
                  >
                    Clear
                  </button>
                )}
              </div>
              <Slider
                min={0}
                max={EXACT_STOPS.length - 1}
                step={1}
                unset={exactUnset}
                value={[stopIndex ?? 0]}
                aria-labelledby={exactLabelId}
                aria-describedby={exactHintId}
                aria-valuetext={exact.trim() !== "" ? exactSummary : "Not set"}
                onPointerDown={() => {
                  sliderChangedRef.current = false;
                }}
                onPointerUp={() => {
                  if (exactUnset && !sliderChangedRef.current) selectStop(0);
                }}
                onKeyDown={(e) => {
                  if (exactUnset && (e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "Home")) {
                    e.preventDefault();
                    selectStop(0);
                  }
                }}
                onValueChange={([idx]) => {
                  sliderChangedRef.current = true;
                  if (idx !== undefined) selectStop(idx);
                }}
              />
              <div aria-hidden="true" className="flex justify-between text-xs tabular-nums">
                {EXACT_STOPS.map((stop, idx) => (
                  <span
                    key={stop}
                    onClick={() => selectStop(idx)}
                    className={cn(
                      "cursor-pointer select-none",
                      idx === stopIndex ? "font-medium text-foreground" : "text-muted hover:text-foreground",
                    )}
                  >
                    {stop}
                  </span>
                ))}
              </div>
              <p id={exactHintId} className="text-[13px] text-muted text-pretty">
                {exactSummary}
              </p>
            </div>
            <div className="flex items-start gap-3">
              <input
                id="emails"
                type="checkbox"
                checked={emails}
                onChange={(e) => setEmails(e.target.checked)}
                aria-describedby={emailsHintId}
                className="mt-0.5 size-5 shrink-0 cursor-pointer accent-accent sm:size-4"
              />
              <div className="flex flex-col gap-0.5">
                <label htmlFor="emails" className="cursor-pointer text-sm font-medium text-foreground">
                  Look for emails on websites
                </label>
                <p id={emailsHintId} className="text-[13px] text-muted text-pretty">
                  Turning it off is faster: no business's website is opened, so the list has no emails or social links.
                </p>
              </div>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="lang">Language</Label>
                <Select value={lang} onValueChange={setLang}>
                  <SelectTrigger id="lang" className={selectTrigger}>
                    <SelectValue>{selectedLang}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {languages.map((l) => (
                      <SelectItem key={l.code} value={l.code} lang={l.code}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="country">Country for phone numbers</Label>
                <Select value={country || AUTO_COUNTRY} onValueChange={(v) => setCountry(v === AUTO_COUNTRY ? "" : v)}>
                  <SelectTrigger id="country" aria-describedby={countryHintId} className={selectTrigger}>
                    <SelectValue>{selectedCountry}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO_COUNTRY}>Automatic (from the place)</SelectItem>
                    {countryList.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p id={countryHintId} className="text-[13px] text-muted text-pretty">
                  Used to read local numbers and make WhatsApp links. The place is looked up in this country.
                </p>
              </div>
            </div>
          </div>
        </details>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <Button type="submit" disabled={busy} aria-describedby={error ? errorId : undefined} className="h-12 px-7 text-base sm:h-11">
            {/* While the list is being created the button says so, so it does not look broken. */}
            {busy ? "Starting…" : "Find"}
          </Button>
          <p id={errorId} role="alert" className={cn("text-sm text-danger text-pretty", !error && "sr-only")}>
            {error?.message}
          </p>
        </div>
        {examples && (
          <div role="group" aria-label="Example searches" className="flex flex-wrap items-center gap-2">
            <span aria-hidden="true" className="text-sm text-muted">
              Try
            </span>
            {EXAMPLES.map((example) => (
              <Button
                key={example}
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                data-selected={keyword.trim() === example || undefined}
                onClick={() => pickExample(example)}
                className="h-11 rounded-full px-4 font-normal data-selected:border-accent data-selected:text-accent sm:h-8 sm:px-3"
              >
                {example}
              </Button>
            ))}
          </div>
        )}
      </form>
    </section>
  );
}
