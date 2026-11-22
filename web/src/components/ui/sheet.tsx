import * as DialogPrimitive from "@radix-ui/react-dialog";
import type * as React from "react";
import { cn } from "@/lib/utils";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetTitle = DialogPrimitive.Title;

/**
 * A panel that slides in from the left edge (lists drawer) or bottom edge
 * (mobile filters). Radix traps focus inside it, closes on Escape and returns
 * focus to the trigger; the slide is off under prefers-reduced-motion.
 */
function SheetContent({
  className,
  children,
  side = "left",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { side?: "left" | "bottom" }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-30 bg-scrim motion-safe:data-[state=open]:animate-scrim-in" />
      <DialogPrimitive.Content
        className={cn(
          "fixed z-40 flex flex-col outline-none",
          side === "left"
            ? "inset-y-0 left-0 w-[min(20rem,85vw)] bg-rail pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] motion-safe:data-[state=open]:animate-sheet-in"
            : "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-xl border-t border-line-strong bg-surface pb-[env(safe-area-inset-bottom)]",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger };
