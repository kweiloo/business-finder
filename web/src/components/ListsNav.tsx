import { Plus } from "lucide-react";
import { type MouseEvent, useId } from "react";
import type { Job } from "@/api";
import { type Listed, listCount, railDetail, railWhen, searchText } from "@/lib/lists";
import { urlForJob } from "@/lib/route";
import { cn } from "@/lib/utils";

/**
 * Follows a same-page link without reloading. A click with a modifier key or
 * another mouse button is left to the browser, so a list still opens in a
 * new tab.
 */
export function followLink(e: MouseEvent<HTMLAnchorElement>, go: (url: string) => void) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go(e.currentTarget.getAttribute("href") ?? "/");
}

/** The right-hand figure of a list: its place count, or a word for why there is none. */
function Count({ job }: { job: Job }) {
  const n = listCount(job);
  if (n !== null) return <>{n}</>;
  if (job.status === "cancelled") return <>Cancelled</>;
  if (job.status === "queued" || job.status === "running") {
    return (
      <>
        <span aria-hidden="true" className="block size-1.5 rounded-full bg-accent" />
        <span className="sr-only">searching</span>
      </>
    );
  }
  return <>Stopped</>;
}

type Props = {
  /** Lists newest first, already collapsed; null until the server answers. */
  lists: Listed[] | null;
  openId: string | null;
  go(url: string): void;
  /** Taller rows for touch, in the phone sheet. */
  touch?: boolean;
};

/** ＋ New list, then every past search as a list; the open one is marked as the current page. */
export function ListsNav({ lists, openId, go, touch = false }: Props) {
  const headingId = useId();
  const row = cn(
    "flex items-center gap-3 rounded-md px-2.5 text-[13.5px] outline-none",
    "hover:bg-subtle focus-visible:ring-2 focus-visible:ring-ring",
    touch ? "min-h-11" : "min-h-8",
  );
  // Read once per render, so every entry is dated against the same moment.
  const now = new Date();
  return (
    <nav aria-label="Lists" className="flex flex-col gap-1">
      <a href="/" onClick={(e) => followLink(e, go)} className={cn(row, "mb-3 font-medium text-foreground")}>
        <Plus aria-hidden="true" className="size-4 text-muted" />
        New list
      </a>
      <h2 id={headingId} className="px-2.5 py-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        Your lists
      </h2>
      {lists && lists.length === 0 && <p className="px-2.5 text-[13px] text-muted">Your searches will be kept here.</p>}
      {lists && lists.length > 0 && (
        <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
          {lists.map((job) => {
            const open = job.id === openId;
            const title = job.title;
            const detail = railDetail(job, lists);
            const ran = railWhen(job, now);
            return (
              <li key={job.id}>
                <a
                  href={urlForJob(job.id)}
                  onClick={(e) => followLink(e, go)}
                  aria-current={open ? "page" : undefined}
                  title={`${searchText(job.options)} · ${ran}`}
                  className={cn(row, "justify-between py-1.5 text-secondary", open && "bg-subtle text-foreground")}
                >
                  {/* Two runs can share a title; the typed city (when it differs) and when each ran tell them apart. */}
                  <span className="flex min-w-0 flex-col">
                    <span dir="auto" className={cn("line-clamp-2 leading-snug break-words", open && "font-medium")}>
                      {title}
                    </span>
                    {detail && (
                      <span dir="auto" className="truncate text-xs text-muted">
                        {detail}
                      </span>
                    )}
                    <span className="truncate text-xs text-muted tabular-nums">{ran}</span>
                  </span>
                  <span className="flex shrink-0 items-center text-xs text-muted tabular-nums">
                    <Count job={job} />
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
