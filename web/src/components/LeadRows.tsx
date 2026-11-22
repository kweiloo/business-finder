import { Globe } from "lucide-react";
import { siWhatsapp } from "simple-icons";
import type { ReactNode } from "react";
import type { LeadRow } from "@/api";
import { classifyEmail, emailMxLabel, emailTypeLabel } from "../../../src/core/enrich/emailType";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type ContactLink, websiteLink, whatsappLink } from "@/lib/contact";
import { fromWeb } from "@/lib/source";
import { cn } from "@/lib/utils";
import { type MarkerContext, rowMarker } from "@/lib/view";

// Name · phone · email · Website · WhatsApp on wide screens; stacked on a phone.
const GRID = "md:grid md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.3fr)_3.5rem_4.5rem] md:items-center md:gap-5";

/** WhatsApp's own logo (Simple Icons, CC0). */
function WhatsAppLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className} fill="currentColor">
      <path d={siWhatsapp.path} />
    </svg>
  );
}

const ICON = "size-5";
const SLOT = "grid size-11 place-items-center rounded-lg md:size-9";

/** A link the row has: an icon on a tile, opening in a new tab. */
function IconLink({ link, children, className }: { link: ContactLink; children: ReactNode; className?: string }) {
  return (
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={link.name}
      title={link.hint}
      className={cn(
        SLOT,
        "bg-tile transition-[opacity,transform] duration-150 ease-out hover:opacity-80 active:scale-[0.96]",
        "motion-reduce:transition-none motion-reduce:active:scale-100",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
    >
      {children}
    </a>
  );
}

/** The slash across a missing link's icon. */
function Slash() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="absolute size-5" fill="none" strokeLinecap="round">
      {/* A page-coloured edge first, so the slash cuts the icon instead of blurring into it. */}
      <path d="M4 4l16 16" stroke="var(--background)" strokeWidth="4.5" />
      <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

// Devices that can hover read the hover hint; touch-only devices tap for the words instead.
const HOVER_ONLY = "[@media(hover:none)]:hidden";
const TOUCH_ONLY = "hidden [@media(hover:none)]:grid";

/**
 * A link the row lacks: the same icon in grey with a slash, named in words.
 * With a mouse it is a picture with a hover hint, not a link and not a Tab
 * stop. On a touch screen, where nothing hovers, a tap shows the words.
 */
function Missing({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span role="img" aria-label={label} title={label} className={cn(SLOT, "relative text-missing", HOVER_ONLY)}>
        {children}
        <Slash />
      </span>
      <Popover>
        <PopoverTrigger
          aria-label={label}
          className={cn(
            SLOT,
            "relative text-missing outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            TOUCH_ONLY,
          )}
        >
          {children}
          <Slash />
        </PopoverTrigger>
        <PopoverContent side="top">{label}</PopoverContent>
      </Popover>
    </>
  );
}

/**
 * A link that may still come: the row was saved before its website was
 * checked. The same tile as a missing link, without the slash, so nothing
 * moves when the check fills it in.
 */
function Unknown({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span role="img" aria-label={label} title={label} className={cn(SLOT, "text-missing opacity-60")}>
      {children}
    </span>
  );
}

/** Words for a row whose website has not been checked: still going, or never will be. */
const notChecked = (checking: boolean) => (checking ? "Checking website…" : "Website not checked");

/** Website, then WhatsApp: the same two places on every row, so the columns line up. */
function Links({ lead, checking }: { lead: LeadRow; checking: boolean }) {
  const site = websiteLink(lead);
  const chat = whatsappLink(lead);
  return (
    <>
      <div className="md:justify-self-center">
        {site ? (
          <IconLink link={site} className="text-foreground">
            <Globe aria-hidden="true" strokeWidth={1.8} className={ICON} />
          </IconLink>
        ) : (
          <Missing label="No website">
            <Globe aria-hidden="true" strokeWidth={1.8} className={ICON} />
          </Missing>
        )}
      </div>
      <div className="md:justify-self-center">
        {chat ? (
          <IconLink link={chat} className="text-whatsapp">
            <WhatsAppLogo className={ICON} />
          </IconLink>
        ) : lead.unchecked && site ? (
          // A website can still give a WhatsApp link.
          <Unknown label={`WhatsApp: ${notChecked(checking).toLowerCase()}`}>
            <WhatsAppLogo className={ICON} />
          </Unknown>
        ) : (
          <Missing label="No WhatsApp">
            <WhatsAppLogo className={ICON} />
          </Missing>
        )}
      </div>
    </>
  );
}

/** "Rua de Teste, Lisboa · ★ 4.5": where the place is and how it is rated. */
function Detail({ lead }: { lead: LeadRow }) {
  const rated = lead.review_rating !== null;
  if (!lead.address && !rated) return null;
  return (
    <p className="mt-0.5 flex min-w-0 gap-1 text-[12.5px] text-faint">
      {lead.address && (
        <span dir="auto" title={lead.address} className="min-w-0 truncate">
          {lead.address}
        </span>
      )}
      {lead.address && rated && <span aria-hidden="true">·</span>}
      {rated && (
        <span className="shrink-0 tabular-nums">
          <span aria-hidden="true">★ {lead.review_rating}</span>
          <span className="sr-only">
            rated {lead.review_rating}
            {lead.review_count !== null && ` from ${lead.review_count} reviews`}
          </span>
        </span>
      )}
    </p>
  );
}

function Email({
  emails,
  emailTypes,
  emailMx,
  unchecked,
  checking,
}: {
  emails: string[] | null;
  emailTypes: LeadRow["email_types"];
  emailMx: LeadRow["email_mx"];
  unchecked: boolean;
  checking: boolean;
}) {
  const [first, ...more] = emails ?? [];
  if (!first && unchecked) return <span className="text-faint">{notChecked(checking)}</span>;
  if (!first) return <span className="text-faint">No email found</span>;
  const type = emailTypeLabel(emailTypes?.[0] ?? classifyEmail(first));
  const mx = emailMxLabel(emailMx?.[0]);
  return (
    <span className="flex min-w-0 flex-col">
      <span className="break-all md:truncate md:break-normal" title={emails?.join(", ")}>
        {first}
      </span>
      <span className="text-xs text-muted">{mx ? `${type} · ${mx}` : type}</span>
      {more.length > 0 && <span className="text-xs text-faint">and {more.length} more in the download</span>}
    </span>
  );
}

/**
 * The list's places as borderless rows with a hairline between them.
 * `checking`: the search is still running, so a row saved before its website
 * check says the check is coming rather than that it never happened.
 * `markerDay`: on a list that combines runs, the marker context (same-day
 * vs dated); null otherwise.
 */
export function LeadRows({
  leads,
  labelledBy,
  checking = false,
  markerDay = null,
}: {
  leads: LeadRow[];
  labelledBy: string;
  checking?: boolean;
  markerDay?: MarkerContext | string | null;
}) {
  return (
    <>
    {/* Column names for sighted readers; every icon already carries its own name. */}
    <div aria-hidden="true" className={cn("hidden px-1 pb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase", GRID)}>
      <span>Place</span>
      <span>Phone</span>
      <span>Email</span>
      <span className="text-center">Website</span>
      <span className="text-center">WhatsApp</span>
    </div>
    <ul aria-labelledby={labelledBy} className="border-t border-line">
      {leads.map((lead, i) => {
        const marker = rowMarker(lead, markerDay);
        return (
        <li key={`${i}:${lead.title}`} className={cn("flex flex-col gap-2 border-b border-line px-1 py-4 text-sm", GRID)}>
          <div className="min-w-0">
            <p dir="auto" title={lead.title} className={cn("line-clamp-2 text-left font-medium break-words", marker && lead.gone && "text-muted")}>
              {lead.title}
            </p>
            {/* Muted words, not a badge: one accent per view. */}
            {marker && (
              <p data-testid="row-marker" className="mt-0.5 text-[12.5px] text-muted">
                {marker}
              </p>
            )}
            {/* Maps is the default and carries no label; a place an agent found on the web says so. */}
            {fromWeb(lead) && <p className="mt-0.5 text-[12.5px] text-muted">From web search</p>}
            <Detail lead={lead} />
          </div>
          <div className="text-secondary tabular-nums">{lead.phone ?? <span className="text-faint">No phone listed</span>}</div>
          <div className="min-w-0 text-secondary">
            <Email
              emails={lead.emails}
              emailTypes={lead.email_types}
              emailMx={lead.email_mx}
              unchecked={lead.unchecked}
              checking={checking}
            />
          </div>
          <div className="mt-1 flex gap-3 md:contents">
            <Links lead={lead} checking={checking} />
          </div>
        </li>
        );
      })}
    </ul>
    </>
  );
}

/** The rows' shape while a search runs, so the page does not jump when they land. Static: only the progress bar moves. */
export function RowsSkeleton() {
  return (
    <div aria-hidden="true" className="border-t border-line">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className={cn("flex flex-col gap-3 border-b border-line px-1 py-5", GRID)}>
          <div className="flex flex-col gap-2">
            <div className="h-3.5 w-44 max-w-full rounded bg-subtle" />
            <div className="h-3 w-24 rounded bg-subtle/70" />
          </div>
          <div className="h-3.5 w-28 rounded bg-subtle" />
          <div className="h-3.5 w-40 max-w-full rounded bg-subtle" />
          <div className="flex gap-3 md:contents">
            <div className="size-11 rounded-lg bg-subtle md:size-9 md:justify-self-center" />
            <div className="size-11 rounded-lg bg-subtle md:size-9 md:justify-self-center" />
          </div>
        </div>
      ))}
    </div>
  );
}
