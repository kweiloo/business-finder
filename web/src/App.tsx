import { Menu, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearFilters, type ListQuery } from "../../src/jobs/filter";
import { ApiError, cancelJob, createJob, deleteList, downloadExport, type ExportFormat, getLeads, getList, type LeadRow, type ListInfo, listLists, type RowsMeta } from "@/api";
import { ListPage, Unavailable } from "@/components/ListPage";
import { followLink, ListsNav } from "@/components/ListsNav";
import { NewListForm, type Query, type SearchError } from "@/components/NewListForm";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { afterDelete, finished, type Listed, listTitle, searchKey } from "@/lib/lists";
import { queryOf, readQuery, toRequest } from "@/lib/search";
import { refreshOnFocus } from "@/lib/focus";
import { jobIdFromSearch, listQueryFromSearch, startList, urlForJob } from "@/lib/route";
import { searchable } from "@/lib/source";
import { markerContext, viewOf } from "@/lib/view";

const POLL_MS = 400;
/** How often the lists are re-read while a search other than the open one is still running. */
const LISTS_MS = 2_000;
const RETRY_MS = 2_000;
/** How often the rows are re-read while the open search runs; they arrive batch by batch. */
const ROWS_MS = 1_500;

function messageOf(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong in this page. Reload it and try again.";
}

function fieldOf(e: unknown): SearchError["field"] {
  return e instanceof ApiError && (e.field === "keyword" || e.field === "city" || e.field === "exact")
    ? e.field
    : e instanceof ApiError && e.field === "limit"
      ? "exact"
      : undefined;
}

/** What the history entry carries besides the URL: the search an edited list starts from. */
type HistoryState = { draft?: Query } | null;

type Route = {
  jobId: string | null;
  listQuery: ListQuery;
  draft: Query | null;
  /** Changes on every navigation, so each opened page starts fresh; never on data loading or filter tweaks. */
  seq: number;
  /** The person navigated here (not a first load), so focus moves into the page. */
  moved: boolean;
};

function readRoute(seq: number, moved: boolean): Route {
  const state = window.history.state as HistoryState;
  return {
    jobId: jobIdFromSearch(window.location.search),
    listQuery: listQueryFromSearch(window.location.search),
    draft: readQuery(state?.draft),
    seq,
    moved,
  };
}

/**
 * The answers for the job in the URL; kept under its id so another list's
 * answer is never shown. `job` is the run the list follows, which is the
 * newest run of the search, not always the one in the URL.
 */
type Opened = { id: string; job: ListInfo | null; missing: boolean; leads: LeadRow[] | null; meta: RowsMeta | null; error: string | null };

export function App() {
  const [route, setRoute] = useState<Route>(() => readRoute(0, false));
  const [opened, setOpened] = useState<Opened | null>(null);
  // Every saved list, one per search; null until the first answer.
  const [lists, setLists] = useState<Listed[] | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<SearchError | null>(null);
  const [downloading, setDownloading] = useState<ExportFormat | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  // The job a cancel was sent for; its button stays "Cancelling…" until the poll sees it stop.
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [expanding, setExpanding] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  // A sheet closed by opening a list hands focus to the page, not back to the Lists button.
  const closedByNavigation = useRef(false);

  const go = useCallback((url: string, draft?: Query, replace = false) => {
    const state: HistoryState = draft ? { draft } : null;
    if (replace || (url === window.location.pathname + window.location.search && !draft)) {
      window.history.replaceState(state, "", url);
    } else {
      window.history.pushState(state, "", url);
    }
    closedByNavigation.current = true;
    setSheetOpen(false);
    setFormError(null);
    setDownloadError(null);
    setRetryError(null);
    setCancelError(null);
    setDeleteError(null);
    setExpandError(null);
    setRoute((r) => readRoute(r.seq + 1, true));
  }, []);

  useEffect(() => {
    const onPop = () => setRoute((r) => readRoute(r.seq + 1, false));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const refreshJobs = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await listLists(signal);
      if (!signal?.aborted) setLists(next);
    } catch {
      // The lists are a convenience; without them the page still searches and opens links.
      if (!signal?.aborted) setLists((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshJobs(controller.signal);
    return () => controller.abort();
  }, [refreshJobs]);

  // A list an agent made in a terminal while the page was in the background shows up on return, without a reload.
  useEffect(() => refreshOnFocus(window, () => void refreshJobs()), [refreshJobs]);

  const jobId = route.jobId;

  // The one poller: follows the job in the URL until it ends, then loads its rows.
  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = (patch: Partial<Opened>) =>
      setOpened((prev) => ({ ...(prev?.id === jobId ? prev : { id: jobId, job: null, missing: false, leads: null, meta: null, error: null }), ...patch }));

    // Rows are read while the search runs whenever more have been saved, and
    // at least every ROWS_MS while websites are being checked (rows fill in).
    let rowsAt = 0;
    let rowsSaved = -1;
    const readRows = async (): Promise<boolean> => {
      try {
        const { rows, meta } = await getLeads(jobId, signal);
        if (!signal.aborted) update({ leads: rows, meta });
        return true;
      } catch (e) {
        if (signal.aborted) return false;
        update({ error: messageOf(e) });
        return false;
      }
    };

    const poll = async () => {
      let next: ListInfo;
      try {
        next = await getList(jobId, signal);
      } catch (e) {
        if (signal.aborted) return;
        if (e instanceof ApiError && e.status === 404) return update({ missing: true, error: null });
        update({ error: messageOf(e) });
        timer = setTimeout(poll, RETRY_MS);
        return;
      }
      if (signal.aborted) return;
      update({ job: next, error: null });
      if (!finished(next)) {
        const saved = next.saved ?? 0;
        const filling = next.progress.stage === "checking_websites" && Date.now() - rowsAt >= ROWS_MS;
        if (saved > 0 && (saved !== rowsSaved || filling)) {
          rowsAt = Date.now();
          if (await readRows()) rowsSaved = saved;
          if (signal.aborted) return;
        }
        timer = setTimeout(poll, POLL_MS);
        return;
      }
      void refreshJobs();
      // Any search that stopped (done, failed, Google limiting the computer,
      // or cancelled) keeps the places it saved; read them once more as they ended.
      if (next.runs <= 1 && !(next.saved ?? next.reconciliation?.kept ?? 0)) return update({ leads: [] });
      if (!(await readRows()) && !signal.aborted) timer = setTimeout(poll, RETRY_MS);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [jobId, refreshJobs, reloadSeq]);

  // Another list still searching: re-read the lists until it ends, so its count appears.
  const followed = opened?.id === jobId ? opened.job?.id : undefined;
  const othersRunning = lists?.some((j) => j.id !== jobId && j.id !== followed && !finished(j)) ?? false;
  useEffect(() => {
    if (!othersRunning) return;
    const controller = new AbortController();
    const timer = setTimeout(() => void refreshJobs(controller.signal), LISTS_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [othersRunning, lists, refreshJobs]);

  const current = opened?.id === jobId ? opened : null;
  // Any run's id opens its search's list, which follows the search's newest run.
  const view = viewOf({ jobId: current?.job?.id ?? jobId, job: current?.job ?? null, missing: current?.missing ?? false, leads: current?.leads ?? null });
  const known = current?.job ?? lists?.find((j) => j.id === jobId) ?? null;
  // The rail's title for this search, so the heading reads the same as the rail, for an older run too.
  const title = known ? ((current?.job?.title || lists?.find((l) => searchKey(l) === searchKey(known))?.title) ?? listTitle(known.options)) : null;
  const meta = current?.meta;
  const day = useMemo(() => (meta ? markerContext(meta.latest, meta.runDates, meta.runs) : null), [meta]);

  useEffect(() => {
    const name = view.kind === "new" ? "New list" : view.kind === "unknown" ? "List not found" : title;
    document.title = name ? `${name} · Business Finder` : "Business Finder";
  }, [view.kind, title]);

  const create = (query: Query) => createJob(toRequest(query));

  async function search(query: Query) {
    setFormError(null);
    setSubmitting(true);
    try {
      await startList(query, { create, go });
      void refreshJobs();
    } catch (e) {
      setFormError({ message: messageOf(e), field: fieldOf(e) });
    } finally {
      setSubmitting(false);
    }
  }

  async function retry() {
    if (!known) return;
    setRetryError(null);
    setSubmitting(true);
    try {
      // The same search with the same size and options.
      await startList(queryOf(known.options), { create, go });
      void refreshJobs();
    } catch (e) {
      setRetryError(messageOf(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function expandToWholeCity() {
    if (!known) return;
    setExpandError(null);
    setExpanding(true);
    try {
      await startList({ ...queryOf(known.options), size: "wholeCity", exact: "" }, { create, go });
      void refreshJobs();
    } catch (e) {
      setExpandError(messageOf(e));
    } finally {
      setExpanding(false);
    }
  }

  const updateListQuery = useCallback(
    (next: ListQuery) => {
      if (!route.jobId) return;
      window.history.replaceState(window.history.state, "", urlForJob(route.jobId, next));
      setDownloadError(null);
      setRoute((r) => ({ ...r, listQuery: next }));
    },
    [route.jobId],
  );

  const handleClearFilters = useCallback(() => {
    updateListQuery(clearFilters(route.listQuery));
  }, [route.listQuery, updateListQuery]);

  async function download(format: ExportFormat) {
    if (!jobId) return;
    setDownloadError(null);
    setDownloading(format);
    try {
      await downloadExport(jobId, format, route.listQuery);
    } catch (e) {
      setDownloadError(messageOf(e));
    } finally {
      setDownloading(null);
    }
  }

  async function cancel() {
    // The list's running run, which may be newer than the run in the URL.
    const id = current?.job?.id ?? jobId;
    if (!id) return;
    setCancelError(null);
    setCancellingId(id);
    try {
      await cancelJob(id);
      void refreshJobs();
    } catch (e) {
      setCancellingId(null);
      setCancelError(messageOf(e));
    }
  }

  async function remove() {
    const id = current?.job?.id ?? jobId;
    if (!id) return;
    setDeleteError(null);
    setDeleting(true);
    try {
      await deleteList(id);
      const target = known ?? { id, options: { keyword: "", city: "" } };
      const next = afterDelete(lists ?? [], target);
      setLists(next.lists);
      setOpened(null);
      go(next.url, undefined, true);
      void refreshJobs();
    } catch (e) {
      setDeleteError(messageOf(e));
      // When a multi-run delete stops midway, refresh the rail and re-read what remains.
      if (e instanceof ApiError && e.status && e.status >= 500) {
        void refreshJobs();
        setReloadSeq((n) => n + 1);
      }
    } finally {
      setDeleting(false);
    }
  }

  const edit = () => known && go("/", queryOf(known.options));

  return (
    <div className="min-h-dvh bg-background lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh flex-col gap-1 overflow-y-auto border-r border-subtle bg-rail px-3.5 py-[22px] lg:flex">
        <p className="flex items-center gap-2 px-2.5 pb-[18px] text-sm font-semibold">
          <span aria-hidden="true" className="size-2.5 rounded-[3px] bg-accent" />
          Business Finder
        </p>
        <ListsNav lists={lists} openId={jobId} go={go} />
      </aside>

      <header className="sticky top-0 z-20 flex items-center gap-1 border-b border-line bg-background px-2 pt-[env(safe-area-inset-top)] lg:hidden">
        <Sheet
          open={sheetOpen}
          onOpenChange={(open) => {
            if (open) closedByNavigation.current = false;
            setSheetOpen(open);
          }}
        >
          <SheetTrigger asChild>
            <Button variant="ghost" className="h-11 gap-2 px-3 font-medium">
              <Menu aria-hidden="true" />
              Lists
            </Button>
          </SheetTrigger>
          <SheetContent
            aria-describedby={undefined}
            onCloseAutoFocus={(e) => {
              if (closedByNavigation.current) e.preventDefault();
            }}
            className="gap-1 overflow-y-auto px-3.5 py-3"
          >
            <div className="flex items-center justify-between pb-3 pl-2.5">
              <SheetTitle className="flex items-center gap-2 text-sm font-semibold">
                <span aria-hidden="true" className="size-2.5 rounded-[3px] bg-accent" />
                Business Finder
              </SheetTitle>
              <SheetClose asChild>
                <Button variant="ghost" aria-label="Close lists" className="size-11 px-0 text-muted">
                  <X aria-hidden="true" className="size-5" />
                </Button>
              </SheetClose>
            </div>
            <ListsNav lists={lists} openId={jobId} go={go} touch />
          </SheetContent>
        </Sheet>
        <p className="flex-1 text-center text-sm font-semibold">Business Finder</p>
        <Button asChild variant="ghost" className="size-11 px-0">
          <a href="/" aria-label="New list" onClick={(e) => followLink(e, go)}>
            <Plus aria-hidden="true" className="size-5" />
          </a>
        </Button>
      </header>

      <main className="mx-auto w-full max-w-[1104px] px-5 pt-8 pb-[calc(env(safe-area-inset-bottom)+3rem)] sm:px-10 lg:px-[72px] lg:pt-14">
        {view.kind === "new" ? (
          <NewListForm
            key={route.seq}
            initial={route.draft}
            examples={lists !== null && lists.length === 0 && !route.draft}
            autoFocus={route.moved}
            busy={submitting}
            error={formError}
            onSearch={search}
            onInvalid={setFormError}
          />
        ) : view.kind === "unknown" ? (
          <Unavailable go={go} />
        ) : (
          <ListPage
            key={route.seq}
            view={view}
            title={title}
            readError={current?.error ?? null}
            focusTitle={route.moved}
            downloading={downloading}
            downloadError={downloadError}
            onDownload={download}
            onEdit={edit}
            onRetry={retry}
            canSearch={known ? searchable(known) : true}
            retrying={submitting}
            retryError={retryError}
            onCancel={cancel}
            cancelling={cancellingId !== null && cancellingId === (current?.job?.id ?? jobId)}
            markerDay={day}
            listQuery={route.listQuery}
            onListQueryChange={updateListQuery}
            onClearFilters={handleClearFilters}
            cancelError={cancelError}
            onDelete={remove}
            deleting={deleting}
            deleteError={deleteError}
            onWholeCity={expandToWholeCity}
            expanding={expanding}
            expandError={expandError}
          />
        )}
      </main>
    </div>
  );
}
