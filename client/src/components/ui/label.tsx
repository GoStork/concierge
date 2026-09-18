import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Size, weight, color, case and tracking come from the Brand Settings page
// (Interface Typography -> Form Label). Never restyle a Label per page.
const labelVariants = cva(
  "t-form-label leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
)

// Form controls a Label can name. Plain buttons are deliberately absent.
const CONTROL_SELECTOR =
  'input:not([type="hidden"]), select, textarea, [role="switch"], [role="checkbox"], [role="combobox"], [role="slider"], [role="spinbutton"], [role="radiogroup"]'

/**
 * The app writes `<Label>Provider Name</Label><Input />` as siblings, with no
 * htmlFor, almost everywhere: an audit of the provider Settings tabs found
 * about 250 inputs, switches and sliders whose visible label was not
 * programmatically tied to them, so a screen reader announced "edit text" and
 * clicking the label focused nothing.
 *
 * A Label that was given no htmlFor and does not wrap a control associates
 * itself with the control(s) it sits beside: the unnamed controls inside its
 * own parent element (or, when that holds none - a label sharing a header row
 * with a value readout above its slider - one level up), provided it is the
 * only such label there. It sets
 * aria-labelledby on the control (works for Radix switches and sliders, which
 * are not labelable elements) and htmlFor when the control is labelable, so
 * the click target works too. An explicit htmlFor, aria-label or
 * aria-labelledby always wins, and a parent holding several loose labels is
 * left alone rather than guessed at.
 */
function useAutoAssociate(ref: React.RefObject<HTMLLabelElement>, htmlFor?: string) {
  const uid = React.useId()
  React.useEffect(() => {
    const label = ref.current
    if (!label || htmlFor) return
    if (label.querySelector(CONTROL_SELECTOR)) return // a wrapping label already names its control
    let scope = label.parentElement
    if (!scope) return
    // `<div><Label/><span>21px</span></div><Slider/>`: the control is a
    // sibling of the label's row, not of the label.
    if (!scope.querySelector(CONTROL_SELECTOR) && scope.parentElement) scope = scope.parentElement
    const looseLabels = Array.from(scope.querySelectorAll("label")).filter(
      (l) => !l.getAttribute("for") && !l.querySelector(CONTROL_SELECTOR),
    )
    if (looseLabels.length !== 1 || looseLabels[0] !== label) return
    const controls = Array.from(scope.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).filter(
      (c) =>
        !c.closest("label") &&
        !c.getAttribute("aria-label") &&
        (!c.getAttribute("aria-labelledby") || c.getAttribute("data-auto-labelled") === uid) &&
        !((c as HTMLInputElement).labels && (c as HTMLInputElement).labels!.length > 0 && c.getAttribute("data-auto-labelled") !== uid),
    )
    // One control is the normal case; a color swatch + its hex field share a
    // label. More than three is a group this heuristic should not guess at.
    if (controls.length === 0 || controls.length > 3) return
    if (!label.id) label.id = `lbl-${uid.replace(/:/g, "")}`
    controls.forEach((c, i) => {
      c.setAttribute("aria-labelledby", label.id)
      c.setAttribute("data-auto-labelled", uid)
      if (i === 0 && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(c.tagName)) {
        if (!c.id) c.id = `ctl-${uid.replace(/:/g, "")}`
        label.setAttribute("for", c.id)
      }
    })
  })
}

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> &
    VariantProps<typeof labelVariants>
>(({ className, ...props }, ref) => {
  const innerRef = React.useRef<HTMLLabelElement>(null)
  React.useImperativeHandle(ref, () => innerRef.current as HTMLLabelElement)
  useAutoAssociate(innerRef, props.htmlFor)
  return (
    <LabelPrimitive.Root
      ref={innerRef}
      className={cn(labelVariants(), className)}
      {...props}
    />
  )
})
Label.displayName = LabelPrimitive.Root.displayName

export { Label }
