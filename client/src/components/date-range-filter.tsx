/**
 * Kept as the import path the invoices / cost-sheets / payouts / agreements
 * pages already use. The controls themselves now live in the shared filter
 * kit - this file had its own pill shape (filled when set, h-9 text-xs) that
 * differed from every other date pill in the product.
 */
export {
  FilterDateRange as DateRangeFilter,
  toDateParam,
  inDateRange,
} from "@/components/ui/filter-controls";
