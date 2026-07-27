/**
 * A button label that changes without changing the button's width.
 *
 * "Save" becoming "Saved" made the button grow on click, which nudged whatever
 * sat next to it and made a deliberate action feel like a glitch. Reserving a
 * fixed width by eye would be guesswork - it depends on the font the brand is
 * currently set to - so instead both labels are stacked in one grid cell and
 * only the active one is visible. The cell sizes to the wider of the two, at
 * whatever font the brand is using, and nothing moves when the state flips.
 */
export function ToggleLabel({
  active,
  activeLabel,
  inactiveLabel,
  className,
}: {
  active: boolean;
  activeLabel: string;
  inactiveLabel: string;
  className?: string;
}) {
  return (
    <span className={`grid justify-items-center ${className || ""}`} data-testid="toggle-label">
      {/* Sizers: present for layout, never read. */}
      <span className="col-start-1 row-start-1 invisible" aria-hidden>{activeLabel}</span>
      <span className="col-start-1 row-start-1 invisible" aria-hidden>{inactiveLabel}</span>
      <span className="col-start-1 row-start-1">{active ? activeLabel : inactiveLabel}</span>
    </span>
  );
}
