import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { DayPicker } from "react-day-picker"

import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"

export type CalendarProps = React.ComponentProps<typeof DayPicker>

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  // Dropdown caption mode (DOB pickers: captionLayout="dropdown-buttons"):
  // react-day-picker renders month/year <select>s plus an aria-hidden label
  // span and visually-hidden a11y labels. Without explicit classNames all of
  // them stack up unstyled - style the selects, hide the duplicates.
  const isDropdownCaption = String((props as any).captionLayout || "").startsWith("dropdown")
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col sm:flex-row space-y-4 sm:space-x-4 sm:space-y-0",
        month: "space-y-4",
        caption: "flex justify-center pt-1 relative items-center",
        caption_label: isDropdownCaption ? "hidden" : "text-sm font-medium",
        caption_dropdowns: "flex justify-center items-center gap-1.5",
        dropdown:
          "appearance-none rounded-[var(--radius)] border border-input bg-card px-2 py-1 text-sm font-medium cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring",
        dropdown_month: "relative",
        dropdown_year: "relative",
        dropdown_icon: "hidden",
        vhidden: "hidden",
        nav: "space-x-1 flex items-center",
        nav_button: cn(
          buttonVariants({ variant: "outline" }),
          "h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100"
        ),
        nav_button_previous: "absolute left-1",
        nav_button_next: "absolute right-1",
        table: "w-full border-collapse space-y-1",
        head_row: "flex",
        head_cell:
          "text-muted-foreground rounded-[var(--radius)] w-9 font-normal text-[0.8rem]",
        row: "flex w-full mt-2",
        // Single-date selection: the highlight lives on the circular day
        // button only - no accent square on the containing cell (that rule
        // set is for range mode, which we don't use, and it rendered as a
        // "circle inside a square" glitch).
        cell: "h-9 w-9 text-center text-sm p-0 relative focus-within:relative focus-within:z-20",
        day: cn(
          buttonVariants({ variant: "ghost" }),
          "h-9 w-9 p-0 font-normal rounded-full aria-selected:opacity-100"
        ),
        day_range_end: "day-range-end",
        day_selected:
          "rounded-full bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground",
        day_today: "rounded-full bg-accent text-accent-foreground",
        day_outside:
          "day-outside text-muted-foreground aria-selected:bg-accent/50 aria-selected:text-muted-foreground",
        day_disabled: "text-muted-foreground opacity-50",
        day_range_middle:
          "aria-selected:bg-accent aria-selected:text-accent-foreground",
        day_hidden: "invisible",
        ...classNames,
      }}
      components={{
        IconLeft: ({ className, ...props }) => (
          <ChevronLeft className={cn("h-4 w-4", className)} {...props} />
        ),
        IconRight: ({ className, ...props }) => (
          <ChevronRight className={cn("h-4 w-4", className)} {...props} />
        ),
      }}
      {...props}
    />
  )
}
Calendar.displayName = "Calendar"

export { Calendar }
