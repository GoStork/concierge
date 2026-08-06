/**
 * react-big-calendar ships a TimeGrid internal that the DefinitelyTyped
 * package does not declare. The calendar page imports it to build the custom
 * multi-day view; without this the import is an implicit any and the file
 * fails the typecheck.
 */
declare module "react-big-calendar/lib/TimeGrid" {
  import type { ComponentType } from "react";
  const TimeGrid: ComponentType<any>;
  export default TimeGrid;
}
