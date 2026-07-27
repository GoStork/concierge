import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Content typography primitives.
 *
 * Every label/value pair, prompt block, dense-card key and attribute chip in
 * the product renders through these. They read ONLY brand CSS variables
 * (--field-*, --prompt-*, --micro-label-*, --chip-*), which are emitted by
 * applyBrandToDocument() from the Brand Settings page's "Content Typography"
 * section. Nothing here hardcodes a size, weight, color or spacing value.
 *
 * If you need a new content text role, add a brand setting for it - do not
 * reach for a Tailwind size or muted-foreground utility in a page.
 *
 * Roles
 *  - Field / FieldLabel / FieldValue - an attribute pair ("Health status" /
 *    "Excellent"). The label recedes, the value is the anchor.
 *  - PromptBlock - a question the reader does NOT scan for, answered in prose
 *    ("My worst fear" / "Becoming unhealthy"). Emphasis is inverted: the
 *    question is a small accent eyebrow, the answer is the largest text.
 *  - MicroField - a compact uppercase key for dense cards and tables.
 *  - AttributeChip - a pill for a value whose key is obvious or iconified.
 */

/* ------------------------------------------------------------------ */
/* Attribute pair                                                      */
/* ------------------------------------------------------------------ */

export function FieldLabel({ children, className, ...rest }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("m-0", className)}
      style={{
        fontSize: "var(--field-label-size)",
        fontWeight: "var(--field-label-weight)" as any,
        color: "var(--field-label-color)",
        textTransform: "var(--field-label-case)" as any,
        letterSpacing: "var(--field-label-tracking)",
        lineHeight: 1.35,
        marginBottom: "var(--field-label-gap)",
      }}
      {...rest}
    >
      {children}
    </p>
  );
}

export function FieldValue({
  children,
  prose = false,
  className,
  ...rest
}: React.HTMLAttributes<HTMLParagraphElement> & {
  /** Long-form answer: relaxes the weight and opens the line height. */
  prose?: boolean;
}) {
  return (
    <p
      className={cn("m-0", prose && "whitespace-pre-line", className)}
      style={{
        fontSize: "var(--field-value-size)",
        fontWeight: prose ? ("var(--font-weight-body)" as any) : ("var(--field-value-weight)" as any),
        color: "var(--field-value-color)",
        lineHeight: prose ? "var(--line-height-body)" : 1.45,
      }}
      {...rest}
    >
      {children}
    </p>
  );
}

export function Field({
  label,
  value,
  prose,
  wide,
  className,
  children,
  "data-testid": testId,
}: {
  label: React.ReactNode;
  /** Rendered through FieldValue. Omit and pass children for custom content. */
  value?: React.ReactNode;
  prose?: boolean;
  /**
   * Claim the whole row inside a FieldGrid. Use for a long question or a long
   * answer: at a third of the width a 170-character question wraps three times,
   * which reads as a cramped column rather than a sentence.
   */
  wide?: boolean;
  className?: string;
  children?: React.ReactNode;
  "data-testid"?: string;
}) {
  return (
    <div
      className={cn("min-w-0", wide && "md:col-span-2 lg:col-span-3", className)}
      data-testid={testId}
    >
      <FieldLabel>{label}</FieldLabel>
      {children ?? <FieldValue prose={prose}>{value}</FieldValue>}
    </div>
  );
}

/**
 * True when a pair should span the full row rather than sit in one grid column.
 * Thresholds are in characters and tuned to a third-width column at the brand's
 * value size - roughly 75 characters per line.
 */
export function isWideField(label: string, value: string): boolean {
  return (label || "").length > 70 || (value || "").length > 140;
}

/**
 * Column container for Fields. The row gap is the brand's pair gap, which is
 * what stops an answer from sitting closer to the NEXT question than its own.
 */
export function FieldGrid({
  columns = 1,
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  /** Desktop column count. Always 1 on mobile. */
  columns?: 1 | 2 | 3;
}) {
  const cols =
    columns === 3 ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-3" : columns === 2 ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1";
  return (
    <div
      className={cn("grid", cols, className)}
      style={{ rowGap: "var(--field-pair-gap)", columnGap: "calc(var(--field-pair-gap) * 2)" }}
      {...rest}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Prompt block                                                        */
/* ------------------------------------------------------------------ */

export function PromptEyebrow({ children, className, ...rest }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("m-0", className)}
      style={{
        fontSize: "var(--prompt-eyebrow-size)",
        fontWeight: "var(--prompt-eyebrow-weight)" as any,
        color: "var(--prompt-eyebrow-color)",
        letterSpacing: "var(--prompt-eyebrow-tracking)",
        textTransform: "var(--prompt-eyebrow-case)" as any,
        lineHeight: 1.3,
        marginBottom: "calc(var(--field-label-gap) * 2)",
      }}
      {...rest}
    >
      {children}
    </p>
  );
}

export function PromptAnswer({ children, className, ...rest }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("m-0 whitespace-pre-line", className)}
      style={{
        fontSize: "var(--prompt-answer-size)",
        fontWeight: "var(--prompt-answer-weight)" as any,
        color: "var(--prompt-answer-color)",
        lineHeight: "var(--prompt-answer-line-height)",
      }}
      {...rest}
    >
      {children}
    </p>
  );
}

/**
 * A question + its answer, with the emphasis inverted. Use for personality and
 * free-text content: letters to intended parents, "things about me", agency
 * comments, anything a person wrote in their own voice.
 */
export function PromptBlock({
  question,
  answer,
  className,
  "data-testid": testId,
}: {
  question: React.ReactNode;
  answer: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div className={cn("min-w-0", className)} data-testid={testId}>
      <PromptEyebrow>{question}</PromptEyebrow>
      <PromptAnswer>{answer}</PromptAnswer>
    </div>
  );
}

/** Stack of PromptBlocks separated by the brand's block gap + a hairline. */
export function PromptStack({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("prompt-stack", className)} {...rest}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dense card key                                                      */
/* ------------------------------------------------------------------ */

export function MicroLabel({ children, className, ...rest }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("m-0 uppercase", className)}
      style={{
        fontSize: "var(--micro-label-size)",
        fontWeight: "var(--micro-label-weight)" as any,
        color: "var(--micro-label-color)",
        letterSpacing: "var(--micro-label-tracking)",
        lineHeight: 1.3,
      }}
      {...rest}
    >
      {children}
    </p>
  );
}

/** Compact key/value for dense cards (family health, education, cost rows). */
export function MicroField({
  label,
  value,
  className,
  "data-testid": testId,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div className={cn("min-w-0", className)} data-testid={testId}>
      <MicroLabel>{label}</MicroLabel>
      <p
        className="m-0"
        style={{
          fontSize: "var(--micro-value-size)",
          fontWeight: "var(--field-value-weight)" as any,
          color: "var(--field-value-color)",
          lineHeight: 1.4,
          marginTop: "calc(var(--field-label-gap) / 2)",
        }}
      >
        {value}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Attribute chip                                                      */
/* ------------------------------------------------------------------ */

export function AttributeChip({
  children,
  icon: Icon,
  className,
  "data-testid": testId,
}: {
  children: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 max-w-full", className)}
      style={{
        fontSize: "var(--chip-font-size)",
        fontWeight: "var(--chip-font-weight)" as any,
        borderRadius: "var(--chip-radius)",
        padding: "var(--chip-py) var(--chip-px)",
        background: "var(--chip-bg)",
        color: "var(--chip-fg)",
        lineHeight: 1.3,
      }}
      data-testid={testId}
    >
      {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

export function ChipRow({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)} {...rest}>
      {children}
    </div>
  );
}

/**
 * Splits a scraped free-text list ("Anxiety Disorder / Panic Attacks",
 * "English, Spanish") into chip-sized parts. Returns null when the text is
 * really a sentence, so the caller can fall back to FieldValue prose.
 */
export function toChipParts(text: string, maxPartLength = 42): string[] | null {
  const raw = (text || "").trim();
  if (!raw) return null;
  const parts = raw
    .split(/\s*[/,;]\s*|\s{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  if (parts.some((p) => p.length > maxPartLength || /\s\w+\s\w+\s\w+\s\w+/.test(p))) return null;
  return parts;
}
