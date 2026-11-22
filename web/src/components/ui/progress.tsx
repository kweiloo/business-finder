import * as ProgressPrimitive from "@radix-ui/react-progress";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Determinate when `value` is a number; indeterminate (a sliding bar) when
 * it is null. Both the fill transition and the slide are turned off under
 * prefers-reduced-motion.
 */
function Progress({ className, value, ...props }: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const indeterminate = value === null || value === undefined;
  const pct = indeterminate ? 0 : Math.max(0, Math.min(100, value));
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-subtle", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "h-full rounded-full bg-accent transition-transform duration-300 ease-out motion-reduce:transition-none",
          indeterminate ? "w-1/3 animate-progress-slide motion-reduce:w-1/3 motion-reduce:translate-x-full motion-reduce:animate-none motion-reduce:opacity-60" : "w-full",
        )}
        style={indeterminate ? undefined : { transform: `translateX(-${100 - pct}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
