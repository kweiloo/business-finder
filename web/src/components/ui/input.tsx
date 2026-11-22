import type * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-md border border-field bg-surface px-3 text-base text-foreground outline-none",
        "placeholder:text-placeholder focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "aria-invalid:border-danger aria-invalid:ring-danger/20 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
