import { Ellipsis } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";
import { INTERRUPTED_EMPTY_MESSAGE, INTERRUPTED_MESSAGE, isInterruptedMessage } from "../../../src/core/errors";
import { applyListQuery, categoryCounts, DEFAULT_LIST_QUERY, hasActiveFilters, type ListQuery } from "../../../src/jobs/filter";
import type { ExportFormat, LeadRow } from "@/api";
import { FilterBar } from "@/components/FilterBar";
import { LeadRows, RowsSkeleton } from "@/components/LeadRows";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { websitesLine } from "@/lib/summary";
import { cn } from "@/lib/utils";
import { aroundLine, cancelledLine, deleteConfirmMessage, endOfListLine, expectedTimeLine, listFacts, type MarkerContext, stageLine, type View } from "@/lib/view";

export type ListActions = {
  downloading: ExportFormat | null;
  downloadError: string | null;
  onDownload(format: ExportFormat): void;
  /** Opens the form with this list's search, to start a new list from it. */
  onEdit(): void;
  /** Runs the same search again as a new list. */
  onRetry(): void;
  /**
   * The list is a search that can run again. A list made only by
   * `business-finder add --title` has no city, so it offers no Search again,
   * Edit search or Try again.
   */
  canSearch: boolean;
  retrying: boolean;
  retryError: string | null;
  /** Stops the running search; the places it saved so far are kept. */
  onCancel(): void;
  cancelling: boolean;
  cancelError: string | null;
  /** Removes this list and every run of its search from disk. */
  onDelete(): void;
  deleting: boolean;
  deleteError: string | null;
  /** Starts a whole-city search with the same keyword, city and options. */
  onWholeCity(): void;
  expanding: boolean;
  expandError: string | null;
};

type Props = ListActions & {
  view: Exclude<View, { kind: "new" } | { kind: "unknown" }>;
  /** The list's title; null until it is known. */
  title: string | null;
  /** A problem reaching the server while the list was being read. */
  readError: string | null;
  /** Moves focus to the title when the list was opened on purpose, so a screen reader starts there. */
  focusTitle: boolean;
  /** On a list that combines runs, the marker context (same-day vs dated); null otherwise. */
  markerDay?: MarkerContext | string | null;
  /** Active filters and sort kept in the URL. */
  listQuery?: ListQuery;
  onListQueryChange?(next: ListQuery): void;
  onClearFilters?(): void;
};

/** Percent complete when it is known (capped below 100 while still running), null while the total is unknown. */
function percent(view: Props["view"]): number | null {
  if (view.kind !== "running") return null;
  const { stage, checked, toCheck } = view.job.progress;
  return stage === "checking_websites" && toCheck ? Math.min(99, Math.round(((checked ?? 0) / toCheck) * 100)) : null;
}

function Facts({
  job,
  leads,
  totalCount,
  live = false,
}: {
  job: Parameters<typeof listFacts>[0];
  leads: LeadRow[];
  totalCount?: number;
  live?: boolean;
}) {
  return (
    <p data-testid={live ? "live-facts" : undefined} className="flex flex-wrap items-center gap-x-[18px] gap-y-1 text-sm text-muted tabular-nums">
      {listFacts(job, leads, undefined, undefined, undefined, totalCount).map((f, i) => (
        <span key={`${i}-${f.label}`} dir="auto">
          {f.value !== undefined && <b className="font-medium text-foreground">{f.value}</b>} {f.label}
        </span>
      ))}
    </p>
  );
}

function MoreActions({
  buttonRef,
  errorId,
  deleting,
  onSelectDelete,
  openingConfirmRef,
  children,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  errorId?: string;
  deleting: boolean;
  onSelectDelete(): void;
  openingConfirmRef: RefObject<boolean>;
  children?: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={buttonRef}
          variant="ghost"
          aria-label="More actions"
          aria-describedby={errorId}
          className="size-11 px-0 text-muted sm:size-9"
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(e) => {
          if (openingConfirmRef.current) {
            openingConfirmRef.current = false;
            e.preventDefault();
          }
        }}
      >
        {children}
        <DropdownMenuItem disabled={deleting} onSelect={onSelectDelete}>
          {deleting ? "Deleting…" : "Delete list"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActionAlert({ id, error }: { id: string; error: string | null }) {
  return (
    <p id={id} role="alert" className={cn("max-w-80 text-sm text-danger text-pretty sm:text-right", !error && "sr-only")}>
      {error}
    </p>
  );
}

function Downloads({
  downloading,
  downloadError,
  deleteError,
  deleting,
  onDownload,
  onEdit,
  canSearch,
  filled,
  filteredCount = null,
  moreButtonRef,
  openingConfirmRef,
  onSelectDelete,
}: Pick<ListActions, "downloading" | "downloadError" | "deleteError" | "deleting" | "onDownload" | "onEdit" | "canSearch"> & {
  filled: boolean;
  filteredCount?: number | null;
  moreButtonRef: RefObject<HTMLButtonElement | null>;
  openingConfirmRef: RefObject<boolean>;
  onSelectDelete(): void;
}) {
  const errorId = useId();
  const empty = filteredCount === 0;
  const error = downloadError || deleteError;
  const label = downloading === "csv" ? "Preparing…" : filteredCount !== null ? `Download ${filteredCount} for Excel` : "Download for Excel";
  return (
    <div className="flex flex-col gap-1.5 sm:items-end">
      <div className="flex items-center gap-1">
        <Button
          variant={filled ? "default" : "outline"}
          disabled={downloading !== null || empty}
          aria-describedby={downloadError ? errorId : undefined}
          onClick={() => onDownload("csv")}
          className="h-11 flex-1 px-4 sm:h-9 sm:flex-none"
        >
          {label}
        </Button>
        <MoreActions
          buttonRef={moreButtonRef}
          errorId={error ? errorId : undefined}
          deleting={deleting}
          onSelectDelete={onSelectDelete}
          openingConfirmRef={openingConfirmRef}
        >
          <DropdownMenuItem disabled={downloading !== null || empty} onSelect={() => onDownload("json")}>
            Download for developers (JSON)
          </DropdownMenuItem>
          {canSearch && <DropdownMenuItem onSelect={onEdit}>Search again</DropdownMenuItem>}
        </MoreActions>
      </div>
      <ActionAlert id={errorId} error={error} />
    </div>
  );
}

/**
 * Cancel, with a confirm step: an alert dialog that starts on "Keep
 * searching". After a confirmed cancel, focus goes to the list's title (the
 * button is about to go), where the cancelled line is read next.
 */
function CancelSearch({
  onCancel,
  cancelling,
  cancelError,
  deleteError,
  deleting,
  titleRef,
  moreButtonRef,
  openingConfirmRef,
  onSelectDelete,
}: Pick<ListActions, "onCancel" | "cancelling" | "cancelError" | "deleteError" | "deleting"> & {
  titleRef: RefObject<HTMLHeadingElement | null>;
  moreButtonRef: RefObject<HTMLButtonElement | null>;
  openingConfirmRef: RefObject<boolean>;
  onSelectDelete(): void;
}) {
  const errorId = useId();
  const confirmed = useRef(false);
  const error = cancelError || deleteError;
  return (
    <div className="flex flex-col gap-1.5 sm:items-end">
      <div className="flex items-center gap-1">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              disabled={cancelling}
              aria-describedby={error ? errorId : undefined}
              onClick={() => (confirmed.current = false)}
              className="h-11 flex-1 px-4 sm:h-9 sm:flex-none"
            >
              {cancelling ? "Cancelling…" : "Cancel search"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent
            onCloseAutoFocus={(e) => {
              if (!confirmed.current) return;
              e.preventDefault();
              titleRef.current?.focus({ preventScroll: true });
            }}
          >
            <AlertDialogTitle className="text-base font-semibold text-balance">Cancel this search?</AlertDialogTitle>
            <AlertDialogDescription className="text-sm text-muted text-pretty">
              The places it has found so far stay in this list. Their emails may be missing if their websites were not checked yet.
            </AlertDialogDescription>
            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <AlertDialogCancel asChild>
                <Button variant="outline" className="h-11 px-4 sm:h-9">
                  Keep searching
                </Button>
              </AlertDialogCancel>
              <AlertDialogAction asChild>
                <Button
                  onClick={() => {
                    confirmed.current = true;
                    onCancel();
                  }}
                  className="h-11 px-4 sm:h-9"
                >
                  Cancel search
                </Button>
              </AlertDialogAction>
            </div>
          </AlertDialogContent>
        </AlertDialog>
        <MoreActions
          buttonRef={moreButtonRef}
          errorId={error ? errorId : undefined}
          deleting={deleting}
          onSelectDelete={onSelectDelete}
          openingConfirmRef={openingConfirmRef}
        />
      </div>
      <ActionAlert id={errorId} error={error} />
    </div>
  );
}

function FilteredEmpty({ onClearFilters }: { onClearFilters(): void }) {
  return (
    <div className="flex flex-col items-start gap-3 border-t border-line py-10">
      <p className="text-sm text-muted">No places match these filters.</p>
      <Button variant="outline" onClick={onClearFilters} className="h-11 px-4 sm:h-9">
        Clear filters
      </Button>
    </div>
  );
}

function FindMore({
  message,
  expanding,
  expandError,
  onWholeCity,
  onEdit,
}: {
  message: string;
  expanding: boolean;
  expandError: string | null;
  onWholeCity(): void;
  onEdit(): void;
}) {
  const errorId = useId();
  return (
    <section
      aria-label="Find more places"
      className="mt-6 flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-5"
    >
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted text-pretty">{message}</p>
        {expandError && (
          <p id={errorId} role="alert" className="text-sm text-danger text-pretty">
            {expandError}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-4 shrink-0">
        <Button
          type="button"
          variant="outline"
          disabled={expanding}
          aria-describedby={expandError ? errorId : undefined}
          onClick={onWholeCity}
          className="h-11 px-4 sm:h-9"
        >
          {expanding ? "Starting…" : "Search the whole city (5–15 min)"}
        </Button>
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onEdit();
          }}
          className="inline-flex min-h-11 items-center text-sm text-muted underline underline-offset-4 hover:text-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:min-h-9"
        >
          Change the search
        </a>
      </div>
    </section>
  );
}

/** One list: its title, a properties line, the header's action and the rows, in the state the list is in. */
export function ListPage({
  view,
  title,
  readError,
  focusTitle,
  markerDay = null,
  listQuery = DEFAULT_LIST_QUERY,
  onListQueryChange = () => {},
  onClearFilters = () => {},
  ...actions
}: Props) {
  const titleId = useId();
  const actionErrorId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const openingConfirmRef = useRef(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [runningDeleteError, setRunningDeleteError] = useState<string | null>(null);

  // Runs once per opened list: the page remounts this component on every navigation.
  useEffect(() => {
    if (focusTitle) titleRef.current?.focus({ preventScroll: true });
  }, [focusTitle]);

  const rawLeads = view.kind === "done" || view.kind === "cancelled" || view.kind === "failed" ? view.leads : null;
  const filtering = hasActiveFilters(listQuery);
  const shownLeads = useMemo(() => (rawLeads ? applyListQuery(rawLeads, listQuery) : null), [rawLeads, listQuery]);
  const categories = useMemo(() => (rawLeads ? categoryCounts(rawLeads) : []), [rawLeads]);
  const showNewFilter = useMemo(
    () => (markerDay !== null && Boolean(rawLeads?.some((l) => l.fresh))) || listQuery.onlyNew,
    [markerDay, rawLeads, listQuery.onlyNew],
  );
  const showHideNotFoundFilter = useMemo(
    () => (markerDay !== null && Boolean(rawLeads?.some((l) => l.gone))) || listQuery.hideNotFound,
    [markerDay, rawLeads, listQuery.hideNotFound],
  );
  const filteredCount = filtering && shownLeads ? shownLeads.length : null;
  const activeDeleteError = view.kind === "running" ? runningDeleteError : actions.deleteError;

  const handleSelectDelete = () => {
    if (view.kind === "running") {
      setRunningDeleteError("Cancel the search first.");
      return;
    }
    openingConfirmRef.current = true;
    setConfirmOpen(true);
  };

  const confirmCopy =
    view.kind !== "loading"
      ? deleteConfirmMessage({
          title: title ?? "this list",
          runs: view.job.runs ?? 1,
          places: rawLeads ? rawLeads.length : (view.job.saved ?? 0),
          shownPlaces: filteredCount,
        })
      : null;

  const filterBar =
    rawLeads && rawLeads.length > 0 && shownLeads ? (
      <FilterBar
        query={listQuery}
        categories={categories}
        showNewFilter={showNewFilter}
        showHideNotFoundFilter={showHideNotFoundFilter}
        shownCount={shownLeads.length}
        onChange={onListQueryChange}
        onClearFilters={onClearFilters}
      />
    ) : null;

  const rowsOrEmpty = (rows: LeadRow[]) =>
    rows.length > 0 ? <LeadRows leads={rows} labelledBy={titleId} markerDay={markerDay} /> : <FilteredEmpty onClearFilters={onClearFilters} />;

  const downloadProps = {
    ...actions,
    deleteError: activeDeleteError,
    moreButtonRef,
    openingConfirmRef,
    onSelectDelete: handleSelectDelete,
    filteredCount,
  };

  let line: ReactNode = null;
  let action: ReactNode = null;
  let body: ReactNode = null;

  switch (view.kind) {
    case "loading":
      line = <p className="text-sm text-muted">Opening this list…</p>;
      body = <RowsSkeleton />;
      break;
    case "running": {
      // Rows appear batch by batch while the search goes; the progress line stays above them.
      const found = view.leads && view.leads.length > 0 ? view.leads : null;
      const expectedTime = expectedTimeLine(view.job);
      const around = aroundLine(view.job);
      line = (
        <div className="flex max-w-md flex-col gap-2.5">
          {found && <Facts job={view.job} leads={found} live />}
          {around && <p className="text-sm text-pretty">{around}</p>}
          <p role="status" aria-live="polite" className="text-sm text-muted tabular-nums">
            {stageLine(view.job)}
          </p>
          <Progress value={percent(view)} aria-label="Search progress" className="h-1" />
          {expectedTime && <p className="text-xs text-faint">{expectedTime}</p>}
        </div>
      );
      // No primary action while it runs: Cancel is secondary, so it never competes with Download for Excel.
      action = (
        <CancelSearch
          {...actions}
          deleteError={activeDeleteError}
          titleRef={titleRef}
          moreButtonRef={moreButtonRef}
          openingConfirmRef={openingConfirmRef}
          onSelectDelete={handleSelectDelete}
        />
      );
      body = found ? <LeadRows leads={found} labelledBy={titleId} markerDay={markerDay} checking /> : <RowsSkeleton />;
      break;
    }
    case "cancelled": {
      const kept = view.leads ?? [];
      const shown = shownLeads ?? kept;
      // The same wrapper and live region as the running line, so the change is announced in place.
      line = (
        <div className="flex max-w-md flex-col gap-2.5">
          {kept.length > 0 && <Facts job={view.job} leads={shown} totalCount={filtering ? kept.length : undefined} />}
          <p role="status" aria-live="polite" className="text-sm text-muted text-pretty">
            {cancelledLine(view.leads ? kept.length : (view.job.saved ?? 0))}
          </p>
        </div>
      );
      action = (
        <div className="flex flex-col gap-1.5 sm:items-end">
          <div className="flex items-center gap-1">
            {actions.canSearch && (
              <Button onClick={actions.onEdit} className="h-11 flex-1 px-4 sm:h-9 sm:flex-none">
                Edit search
              </Button>
            )}
            {kept.length === 0 && (
              <MoreActions
                buttonRef={moreButtonRef}
                errorId={activeDeleteError ? actionErrorId : undefined}
                deleting={actions.deleting}
                onSelectDelete={handleSelectDelete}
                openingConfirmRef={openingConfirmRef}
              />
            )}
          </div>
          {kept.length === 0 && <ActionAlert id={actionErrorId} error={activeDeleteError} />}
        </div>
      );
      body = kept.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="flex justify-end">
            <Downloads {...downloadProps} filled={false} />
          </div>
          {filterBar}
          {rowsOrEmpty(shown)}
        </div>
      );
      break;
    }
    case "empty":
      line = <p className="text-sm text-muted">No places found for this search.</p>;
      action = (
        <div className="flex flex-col gap-1.5 sm:items-end">
          <div className="flex items-center gap-1">
            {actions.canSearch && (
              <Button onClick={actions.onEdit} className="h-11 flex-1 px-4 sm:h-9 sm:flex-none">
                Edit search
              </Button>
            )}
            <MoreActions
              buttonRef={moreButtonRef}
              errorId={activeDeleteError ? actionErrorId : undefined}
              deleting={actions.deleting}
              onSelectDelete={handleSelectDelete}
              openingConfirmRef={openingConfirmRef}
            />
          </div>
          <ActionAlert id={actionErrorId} error={activeDeleteError} />
        </div>
      );
      break;
    case "done": {
      line =
        view.leads && shownLeads ? (
          <Facts job={view.job} leads={shownLeads} totalCount={filtering ? view.leads.length : undefined} />
        ) : (
          <p className="text-sm text-muted">Loading the places…</p>
        );
      action = view.leads && <Downloads {...downloadProps} filled />;
      body =
        view.leads && shownLeads ? (
          <>
            {filterBar}
            {rowsOrEmpty(shownLeads)}
          </>
        ) : (
          <RowsSkeleton />
        );
      break;
    }
    case "failed": {
      const kept = view.leads && view.leads.length > 0 ? view.leads : null;
      const shown = shownLeads ?? kept;
      const interrupted = isInterruptedMessage(view.job.error);
      const emptyInterrupted = interrupted && !kept && view.leads !== null;
      const statusMessage = emptyInterrupted
        ? INTERRUPTED_EMPTY_MESSAGE
        : interrupted
          ? INTERRUPTED_MESSAGE
          : (view.job.error ?? "The search stopped before it finished.");
      const headerError = actions.retryError || (!kept ? activeDeleteError : null);
      line = (
        <div className="flex flex-col gap-1">
          <p className={cn("text-sm text-pretty", interrupted ? "text-muted" : "text-danger")}>
            {statusMessage}
          </p>
          {kept ? (
            <p className="text-sm text-muted text-pretty">
              These are the {kept.length === 1 ? "place" : `${kept.length} places`} it read before it stopped; the list may be missing some.
            </p>
          ) : (
            !interrupted && view.leads !== null && <p className="text-sm text-muted text-pretty">Nothing was saved before it stopped.</p>
          )}
        </div>
      );
      action = (actions.canSearch || !kept) && (
        <div className="flex flex-col gap-1.5 sm:items-end">
          <div className="flex flex-wrap items-center gap-2">
            {actions.canSearch && (
              <>
                <Button
                  onClick={actions.onRetry}
                  disabled={actions.retrying}
                  aria-describedby={actions.retryError ? actionErrorId : undefined}
                  className="h-11 flex-1 px-4 sm:h-9 sm:flex-none"
                >
                  {actions.retrying ? "Starting…" : "Try again"}
                </Button>
                <Button variant="outline" onClick={actions.onEdit} className="h-11 flex-1 px-4 sm:h-9 sm:flex-none">
                  Edit search
                </Button>
              </>
            )}
            {!kept && (
              <MoreActions
                buttonRef={moreButtonRef}
                errorId={headerError ? actionErrorId : undefined}
                deleting={actions.deleting}
                onSelectDelete={handleSelectDelete}
                openingConfirmRef={openingConfirmRef}
              />
            )}
          </div>
          <ActionAlert id={actionErrorId} error={headerError} />
        </div>
      );
      body = kept && shown && (
        <div className="flex flex-col gap-4">
          <div className="flex justify-end">
            <Downloads {...downloadProps} filled={false} />
          </div>
          {filterBar}
          {rowsOrEmpty(shown)}
        </div>
      );
      break;
    }
  }

  // The websites line counts one run; a list that combines runs leaves it out rather than undercount.
  const footnote =
    (view.kind === "done" || view.kind === "failed") &&
    Boolean(view.leads?.length) &&
    !((view.job.runs ?? 1) > 1) &&
    view.job.reconciliation;
  const endMessage = view.kind === "done" && Boolean(view.leads?.length) && actions.canSearch ? endOfListLine(view.job) : null;

  return (
    <article aria-labelledby={titleId} className="flex flex-col">
      <header className="flex flex-col gap-4 pb-8 sm:flex-row sm:items-end sm:justify-between sm:gap-8">
        <div className="flex min-w-0 flex-col gap-3">
          <h1
            id={titleId}
            ref={titleRef}
            tabIndex={-1}
            dir="auto"
            className="font-serif text-[30px] leading-tight font-semibold tracking-[-0.01em] text-balance break-words outline-none lg:text-[40px]"
          >
            {title ?? <span className="sr-only">Opening this list</span>}
            {title === null && <span aria-hidden="true" className="block h-10 w-72 max-w-full rounded bg-subtle" />}
          </h1>
          {line}
          {readError && (
            <p role="alert" className="text-sm text-danger text-pretty">
              {readError}
            </p>
          )}
        </div>
        {/* The header's action sits on the right: Download, Try again, Edit search, or Cancel while it runs. */}
        {action && <div className="shrink-0">{action}</div>}
      </header>
      {body}
      {footnote && <p className="mt-4 text-[13px] text-faint text-pretty tabular-nums">{websitesLine(footnote)}</p>}
      {endMessage && (
        <FindMore
          message={endMessage}
          expanding={actions.expanding}
          expandError={actions.expandError}
          onWholeCity={actions.onWholeCity}
          onEdit={actions.onEdit}
        />
      )}
      {confirmCopy && (
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              moreButtonRef.current?.focus({ preventScroll: true });
            }}
          >
            <AlertDialogTitle className="text-base font-semibold text-balance">{confirmCopy.heading}</AlertDialogTitle>
            <AlertDialogDescription className="text-sm text-muted text-pretty">{confirmCopy.description}</AlertDialogDescription>
            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <AlertDialogCancel asChild>
                <Button variant="outline" className="h-11 px-4 sm:h-9">
                  Cancel
                </Button>
              </AlertDialogCancel>
              <AlertDialogAction asChild>
                <Button onClick={actions.onDelete} className="h-11 px-4 sm:h-9">
                  Delete
                </Button>
              </AlertDialogAction>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </article>
  );
}

/** The list in the URL is gone (or never existed). */
export function Unavailable({ go }: { go(url: string): void }) {
  return (
    <section className="flex flex-col items-start gap-5">
      <h1 className="font-serif text-[30px] leading-tight font-semibold text-balance lg:text-[40px]">This list is no longer available.</h1>
      <p className="max-w-prose text-[15px] text-muted text-pretty">
        This list was deleted or doesn&apos;t exist. Start a new list, or open one of your lists.
      </p>
      <Button asChild className="h-11 px-4 sm:h-9">
        <a href="/" onClick={(e) => (e.preventDefault(), go("/"))}>
          ＋ New list
        </a>
      </Button>
    </section>
  );
}
