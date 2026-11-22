import { ChevronDown, SlidersHorizontal, X } from "lucide-react";
import { useId, useState } from "react";
import {
  activeFilterCount,
  type CategoryCount,
  clearFilters,
  hasActiveFilters,
  moreFilterCount,
  type ListQuery,
  type SortBy,
} from "../../../src/jobs/filter";
import type { EmailType } from "../../../src/core/enrich/emailType";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type Props = {
  query: ListQuery;
  categories: CategoryCount[];
  showNewFilter: boolean;
  showHideNotFoundFilter: boolean;
  shownCount: number;
  onChange(next: ListQuery): void;
  onClearFilters(): void;
};

const RATING_PRESETS = [3.5, 4, 4.5] as const;
const REVIEW_PRESETS = [5, 10, 25, 50, 100] as const;
const ANY_VALUE = "any";

const SORT_LABELS: Record<SortBy, string> = {
  default: "Default",
  rating: "Rating",
  reviews: "Reviews",
  name: "Name",
};

const EMAIL_TYPE_LABELS: Record<EmailType, string> = {
  personal: "A person's address",
  generic: "Shared inbox",
  not_sure: "Not sure",
};

const toggleStyle = (active: boolean) =>
  cn(
    "inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors duration-150 ease-out select-none sm:min-h-9",
    "motion-reduce:transition-none",
    "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    active
      ? "border-accent bg-subtle font-medium text-foreground"
      : "border-line-strong bg-surface text-secondary hover:bg-subtle hover:text-foreground",
  );

const thresholdTriggerStyle = (active: boolean) =>
  cn(
    "h-11 min-h-11 px-2.5 sm:h-9 sm:min-h-9",
    active && "border-accent bg-subtle font-medium",
  );

function formatRating(n: number): string {
  return Number.isInteger(n) ? `${n}.0+` : `${n}+`;
}

function ToggleButton({ active, label, onClick }: { active: boolean; label: string; onClick(): void }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={toggleStyle(active)}>
      {label}
    </button>
  );
}

function ThresholdSelects({
  query,
  onChange,
  withLabels = false,
}: {
  query: ListQuery;
  onChange(next: ListQuery): void;
  withLabels?: boolean;
}) {
  const ratingId = useId();
  const reviewsId = useId();
  const emailTypeId = useId();
  const ratingOptions =
    query.minRating !== null && !RATING_PRESETS.includes(query.minRating as (typeof RATING_PRESETS)[number])
      ? [...RATING_PRESETS, query.minRating].sort((a, b) => a - b)
      : [...RATING_PRESETS];
  const reviewOptions =
    query.minReviews !== null && !REVIEW_PRESETS.includes(query.minReviews as (typeof REVIEW_PRESETS)[number])
      ? [...REVIEW_PRESETS, query.minReviews].sort((a, b) => a - b)
      : [...REVIEW_PRESETS];

  const ratingLabel = query.minRating === null ? "Any rating" : `${formatRating(query.minRating)} rating`;
  const reviewsLabel = query.minReviews === null ? "Any reviews" : `${query.minReviews}+ reviews`;
  const emailTypeLabel = query.emailType === null ? "Any email type" : EMAIL_TYPE_LABELS[query.emailType];

  return (
    <>
      <div className={cn("flex flex-col gap-1", !withLabels && "contents")}>
        {withLabels && (
          <label htmlFor={ratingId} className="text-xs font-medium text-muted">
            Rating at least
          </label>
        )}
        <Select
          value={query.minRating === null ? ANY_VALUE : String(query.minRating)}
          onValueChange={(value) => onChange({ ...query, minRating: value === ANY_VALUE ? null : Number(value) })}
        >
          <SelectTrigger
            id={ratingId}
            aria-label={withLabels ? undefined : "Rating at least"}
            className={thresholdTriggerStyle(query.minRating !== null)}
          >
            <SelectValue>{ratingLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_VALUE}>Any rating</SelectItem>
            {ratingOptions.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {formatRating(n)} rating
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className={cn("flex flex-col gap-1", !withLabels && "contents")}>
        {withLabels && (
          <label htmlFor={reviewsId} className="text-xs font-medium text-muted">
            Reviews at least
          </label>
        )}
        <Select
          value={query.minReviews === null ? ANY_VALUE : String(query.minReviews)}
          onValueChange={(value) => onChange({ ...query, minReviews: value === ANY_VALUE ? null : Number(value) })}
        >
          <SelectTrigger
            id={reviewsId}
            aria-label={withLabels ? undefined : "Reviews at least"}
            className={thresholdTriggerStyle(query.minReviews !== null)}
          >
            <SelectValue>{reviewsLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_VALUE}>Any reviews</SelectItem>
            {reviewOptions.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}+ reviews
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className={cn("flex flex-col gap-1", withLabels ? "col-span-2" : "contents")}>
        {withLabels && (
          <label htmlFor={emailTypeId} className="text-xs font-medium text-muted">
            Email type
          </label>
        )}
        <Select
          value={query.emailType ?? ANY_VALUE}
          onValueChange={(value) => onChange({ ...query, emailType: value === ANY_VALUE ? null : (value as EmailType) })}
        >
          <SelectTrigger
            id={emailTypeId}
            aria-label={withLabels ? undefined : "Email type"}
            className={thresholdTriggerStyle(query.emailType !== null)}
          >
            <SelectValue>{emailTypeLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_VALUE}>Any email type</SelectItem>
            <SelectItem value="personal">{EMAIL_TYPE_LABELS.personal}</SelectItem>
            <SelectItem value="generic">{EMAIL_TYPE_LABELS.generic}</SelectItem>
            <SelectItem value="not_sure">{EMAIL_TYPE_LABELS.not_sure}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </>
  );
}

function CategoryChecklist({
  categories,
  hiddenCategories,
  onToggle,
  onShowAll,
}: {
  categories: CategoryCount[];
  hiddenCategories: string[];
  onToggle(name: string): void;
  onShowAll(): void;
}) {
  const hidden = new Set(hiddenCategories);
  return (
    <div className="flex flex-col gap-1">
      {hiddenCategories.length > 0 && (
        <div className="flex items-center justify-between px-2 py-1 text-xs text-muted">
          <span>{hiddenCategories.length} hidden</span>
          <button
            type="button"
            onClick={onShowAll}
            className="cursor-pointer font-medium text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Show all
          </button>
        </div>
      )}
      {categories.map((cat) => {
        const shown = !hidden.has(cat.name);
        return (
          <label
            key={cat.name}
            className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-md px-2 text-sm text-foreground select-none hover:bg-subtle sm:min-h-9"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <input
                type="checkbox"
                checked={shown}
                onChange={() => onToggle(cat.name)}
                className="size-5 shrink-0 cursor-pointer accent-accent sm:size-4"
              />
              <span className="truncate">{cat.name}</span>
            </span>
            <span className="shrink-0 text-xs text-muted tabular-nums">{cat.count}</span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * Filter toggles, numeric thresholds, category visibility, sort order and
 * clear action. Inline on desktop; a compact row with a bottom sheet on 375 px.
 */
export function FilterBar({ query, categories, showNewFilter, showHideNotFoundFilter, shownCount, onChange, onClearFilters }: Props) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const active = hasActiveFilters(query);
  const activeCount = activeFilterCount(query);
  const moreCount = moreFilterCount(query);
  const showClearInBar = active && shownCount > 0;

  function toggleCategory(name: string) {
    const exists = query.hiddenCategories.includes(name);
    const next = exists ? query.hiddenCategories.filter((c) => c !== name) : [...query.hiddenCategories, name];
    onChange({ ...query, hiddenCategories: next });
  }

  function clearCategories() {
    onChange({ ...query, hiddenCategories: [] });
  }

  const contactItems = [
    { key: "whatsapp", label: "Has WhatsApp", on: query.whatsapp, toggle: () => onChange({ ...query, whatsapp: !query.whatsapp }) },
    { key: "email", label: "Has email", on: query.email, toggle: () => onChange({ ...query, email: !query.email }) },
    { key: "website", label: "Has website", on: query.website, toggle: () => onChange({ ...query, website: !query.website }) },
    { key: "phone", label: "Has phone", on: query.phone, toggle: () => onChange({ ...query, phone: !query.phone }) },
  ];

  const extraToggleItems = [
    ...(showNewFilter
      ? [
          {
            key: "onlyNew",
            label: "Only new since the last search",
            on: query.onlyNew,
            toggle: () => onChange({ ...query, onlyNew: !query.onlyNew }),
          },
        ]
      : []),
    ...(showHideNotFoundFilter
      ? [
          {
            key: "hideNotFound",
            label: "Hide not found last time",
            on: query.hideNotFound,
            toggle: () => onChange({ ...query, hideNotFound: !query.hideNotFound }),
          },
        ]
      : []),
  ];

  const toggleItems = [...contactItems, ...extraToggleItems];

  return (
    <section aria-label="Filter and sort" className="mb-4 flex flex-wrap items-center gap-2">
      {/* Mobile: one-row trigger that opens all filter controls in a bottom sheet. */}
      <div className="sm:hidden">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <button type="button" className={toggleStyle(active)}>
              <SlidersHorizontal aria-hidden="true" className="size-4" />
              <span>{activeCount > 0 ? `Filters (${activeCount})` : "Filters"}</span>
            </button>
          </SheetTrigger>
          <SheetContent side="bottom" aria-describedby={undefined}>
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <SheetTitle className="text-base font-semibold">Filters</SheetTitle>
              <SheetClose asChild>
                <Button variant="ghost" aria-label="Close filters" className="size-11 px-0 text-muted">
                  <X aria-hidden="true" className="size-5" />
                </Button>
              </SheetClose>
            </div>
            <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
              <div className="flex flex-wrap gap-2">
                {toggleItems.map((item) => (
                  <ToggleButton key={item.key} active={item.on} label={item.label} onClick={item.toggle} />
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <ThresholdSelects query={query} onChange={onChange} withLabels />
              </div>
              {categories.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs font-medium text-muted">Categories</p>
                  <CategoryChecklist
                    categories={categories}
                    hiddenCategories={query.hiddenCategories}
                    onToggle={toggleCategory}
                    onShowAll={clearCategories}
                  />
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
              {active && (
                <Button variant="outline" onClick={() => onChange(clearFilters(query))} className="h-11 px-4">
                  Clear filters
                </Button>
              )}
              <SheetClose asChild>
                <Button className="ml-auto h-11 px-5">Done</Button>
              </SheetClose>
            </div>
          </SheetContent>
        </Sheet>
      </div>

      {/* Desktop: four contact chips, More filters popover, and Sort on one row. */}
      <div className="hidden sm:flex sm:flex-wrap sm:items-center sm:gap-2">
        {contactItems.map((item) => (
          <ToggleButton key={item.key} active={item.on} label={item.label} onClick={item.toggle} />
        ))}
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className={toggleStyle(moreCount > 0)}>
              <span>{moreCount > 0 ? `More filters (${moreCount})` : "More filters"}</span>
              <ChevronDown aria-hidden="true" className="size-3.5 text-muted" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="flex max-h-[70vh] w-80 flex-col gap-4 overflow-y-auto p-4">
            <div className="grid grid-cols-2 gap-3">
              <ThresholdSelects query={query} onChange={onChange} withLabels />
            </div>
            {extraToggleItems.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {extraToggleItems.map((item) => (
                  <ToggleButton key={item.key} active={item.on} label={item.label} onClick={item.toggle} />
                ))}
              </div>
            )}
            {categories.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs font-medium text-muted">Categories</p>
                <CategoryChecklist
                  categories={categories}
                  hiddenCategories={query.hiddenCategories}
                  onToggle={toggleCategory}
                  onShowAll={clearCategories}
                />
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {/* Shared Sort + Clear filters (always a single DOM instance across widths). */}
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:ml-auto sm:flex-none">
        <Select value={query.sort} onValueChange={(value) => onChange({ ...query, sort: value as SortBy })}>
          <SelectTrigger
            aria-label="Sort by"
            className={cn(toggleStyle(query.sort !== "default"), "w-auto min-w-[122px] flex-1 justify-between sm:flex-none")}
          >
            <span className="truncate">
              Sort: <SelectValue>{SORT_LABELS[query.sort]}</SelectValue>
            </span>
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="default">Default</SelectItem>
            <SelectItem value="rating">Rating</SelectItem>
            <SelectItem value="reviews">Reviews</SelectItem>
            <SelectItem value="name">Name</SelectItem>
          </SelectContent>
        </Select>
        {showClearInBar && (
          <Button variant="ghost" onClick={onClearFilters} className="h-11 shrink-0 px-1.5 text-muted hover:text-foreground sm:h-9 sm:px-3">
            Clear filters
          </Button>
        )}
      </div>
    </section>
  );
}
