/**
 * Comma-formatted number input. Displays large numbers with thousands
 * separators (1,200 / 25,000) while exposing the raw numeric string to
 * the form via onChange. Use this wherever the user types money or
 * any other quantity - never raw <Input type="number"> for that.
 *
 * API matches the project's existing pattern: `value` is a numeric string
 * (no commas) and `onChange` receives the same. Decimals supported.
 */
import * as React from "react";
import { Input } from "./input";

export interface NumberInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange" | "inputMode"> {
  value: string;
  onChange: (rawValue: string) => void;
  /** Allow decimals. Defaults to true. Set false for integer-only fields. */
  allowDecimal?: boolean;
}

function formatWithCommas(raw: string, allowDecimal: boolean): string {
  if (raw === "" || raw === "-") return raw;
  const negative = raw.startsWith("-");
  const stripped = negative ? raw.slice(1) : raw;
  const [intPart, decPart] = allowDecimal ? stripped.split(".") : [stripped, undefined];
  const intDigits = intPart.replace(/\D/g, "");
  const formattedInt = intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = decPart !== undefined ? `${formattedInt}.${decPart}` : formattedInt;
  return negative ? `-${body}` : body;
}

function sanitizeRaw(input: string, allowDecimal: boolean): string {
  let cleaned = input.replace(/,/g, "");
  if (!allowDecimal) cleaned = cleaned.replace(/\./g, "");
  cleaned = cleaned.replace(allowDecimal ? /[^0-9.\-]/g : /[^0-9\-]/g, "");
  // Only one leading minus.
  if (cleaned.includes("-")) {
    cleaned = (cleaned.startsWith("-") ? "-" : "") + cleaned.replace(/-/g, "");
  }
  // Only one decimal point.
  if (allowDecimal) {
    const firstDot = cleaned.indexOf(".");
    if (firstDot !== -1) {
      cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
    }
  }
  return cleaned;
}

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ value, onChange, allowDecimal = true, ...rest }, ref) => {
    const display = formatWithCommas(value ?? "", allowDecimal);
    return (
      <Input
        {...rest}
        ref={ref}
        type="text"
        inputMode={allowDecimal ? "decimal" : "numeric"}
        value={display}
        onChange={e => onChange(sanitizeRaw(e.target.value, allowDecimal))}
      />
    );
  },
);
NumberInput.displayName = "NumberInput";
