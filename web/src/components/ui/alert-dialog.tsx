import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import type * as React from "react";
import { cn } from "@/lib/utils";

const AlertDialog = AlertDialogPrimitive.Root;
const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
const AlertDialogTitle = AlertDialogPrimitive.Title;
const AlertDialogDescription = AlertDialogPrimitive.Description;
const AlertDialogAction = AlertDialogPrimitive.Action;
const AlertDialogCancel = AlertDialogPrimitive.Cancel;

/**
 * A confirm step before something that cannot be undone. Radix traps focus
 * inside it, starts on the safe choice, closes on Escape (never on a click
 * outside) and returns focus to the trigger; the fade is off under
 * prefers-reduced-motion.
 */
function AlertDialogContent({ className, children, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className="fixed inset-0 z-30 bg-scrim motion-safe:data-[state=open]:animate-scrim-in" />
      <AlertDialogPrimitive.Content
        className={cn(
          "fixed top-1/2 left-1/2 z-40 flex w-[min(26rem,calc(100vw-2.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-2",
          "rounded-xl border border-line-strong bg-surface p-6 text-foreground shadow-lg outline-none",
          "motion-safe:data-[state=open]:animate-scrim-in",
          className,
        )}
        {...props}
      >
        {children}
      </AlertDialogPrimitive.Content>
    </AlertDialogPrimitive.Portal>
  );
}

export { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger };
