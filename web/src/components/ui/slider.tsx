import * as SliderPrimitive from "@radix-ui/react-slider";
import type * as React from "react";
import { cn } from "@/lib/utils";

type SliderProps = React.ComponentProps<typeof SliderPrimitive.Root> & {
  /** True when no stop is selected yet (for example when a preset card or off-stop legacy value is active). */
  unset?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-valuetext"?: string;
};

/**
 * Stepped range slider styled to match the Progress bar and Field inputs.
 * Forwards ARIA labelling props directly to the focusable `role="slider"` thumb.
 */
function Slider({
  className,
  unset = false,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  "aria-valuetext": ariaValueText,
  ...props
}: SliderProps) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn("relative flex min-h-11 w-full touch-none items-center select-none sm:min-h-8", className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-subtle">
        <SliderPrimitive.Range className={cn("absolute h-full bg-accent transition-opacity duration-150 motion-reduce:transition-none", unset && "opacity-0")} />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-unset={unset ? "true" : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-valuetext={ariaValueText}
        className={cn(
          "block size-6 cursor-grab rounded-full border-2 shadow-sm transition-colors outline-none active:cursor-grabbing sm:size-5",
          "motion-reduce:transition-none",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:pointer-events-none disabled:opacity-50",
          unset ? "border-field bg-surface" : "border-accent bg-background",
        )}
      />
    </SliderPrimitive.Root>
  );
}

export { Slider };
