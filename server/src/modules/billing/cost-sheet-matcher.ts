// Phase 2 cost-sheet selection engine. Pure functions, no Prisma calls, no
// Nest decorators. Given a parent's profile + chat-extracted facts + the
// provider's library of ProviderCostSheets, picks the highest-specificity
// matching sheet.
//
// Selection algorithm:
//   1. Filter to sheets with status = "APPROVED"
//   2. For each sheet: every rule in matchingRules must pass (AND)
//   3. Rank surviving candidates by matchedRuleCount DESC
//   4. Tie-break: updatedAt DESC (newer wins)
//   5. Sheets with empty/null matchingRules act as a catch-all (score 0)
//      and only win if no rule-bearing sheet matches
//
// Field paths are restricted to two roots to prevent arbitrary object
// traversal from admin-authored rules:
//   profile.*  - IntendedParentProfile fields
//   chat.*     - values extracted from the chat context

export type MatchOperator = "=" | "contains" | "in" | "exists";

export interface MatchRule {
  field: string;
  operator: MatchOperator;
  value: unknown;
}

export interface ChatExtractions {
  surrogateCompCents: number | null;
  donorCompCents: number | null;
  mentionedSurrogateId: string | null;
  mentionedEggDonorId: string | null;
  mentionedSpermDonorId: string | null;
}

export interface MatchContext {
  profile: Record<string, unknown> | null;
  chat: ChatExtractions;
}

export interface ProviderCostSheetLite {
  id: string;
  status: string;
  matchingRules: MatchRule[] | null;
  updatedAt: Date;
  // Anything else passed through, opaque to the matcher.
  [k: string]: unknown;
}

export interface ScoredCandidate {
  costSheet: ProviderCostSheetLite;
  matchedRuleCount: number;
  totalRuleCount: number;
}

const ALLOWED_FIELD_ROOTS = new Set(["profile", "chat"]);

function resolveField(field: string, ctx: MatchContext): unknown {
  const dot = field.indexOf(".");
  if (dot < 1) return undefined;
  const root = field.slice(0, dot);
  const rest = field.slice(dot + 1);
  if (!ALLOWED_FIELD_ROOTS.has(root)) return undefined;
  const obj = root === "profile" ? ctx.profile : (ctx.chat as unknown as Record<string, unknown>);
  if (!obj) return undefined;
  // Single-level only (no nested dots). Keeps the rule surface predictable
  // and matches the admin UI which only offers flat IP profile fields.
  return (obj as Record<string, unknown>)[rest];
}

function toComparable(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v).trim().toLowerCase();
}

export function evaluateRule(rule: MatchRule, ctx: MatchContext): boolean {
  const actual = resolveField(rule.field, ctx);
  switch (rule.operator) {
    case "=": {
      return toComparable(actual) === toComparable(rule.value);
    }
    case "contains": {
      if (Array.isArray(actual)) {
        const needle = toComparable(rule.value);
        return actual.some(item => toComparable(item) === needle);
      }
      if (typeof actual === "string") {
        return actual.toLowerCase().includes(toComparable(rule.value));
      }
      return false;
    }
    case "in": {
      const haystack = Array.isArray(rule.value)
        ? rule.value
        : typeof rule.value === "string"
          ? rule.value.split(",").map(s => s.trim())
          : [];
      const needle = toComparable(actual);
      return haystack.some(v => toComparable(v) === needle);
    }
    case "exists": {
      if (actual === null || actual === undefined) return false;
      if (typeof actual === "string" && actual.trim() === "") return false;
      if (Array.isArray(actual) && actual.length === 0) return false;
      return true;
    }
    default:
      return false;
  }
}

export interface PickResult {
  picked: ProviderCostSheetLite | null;
  ranked: ScoredCandidate[];
}

export function pickCostSheet(
  sheets: ProviderCostSheetLite[],
  ctx: MatchContext,
): PickResult {
  const approved = sheets.filter(s => s.status === "APPROVED");

  const candidates: ScoredCandidate[] = [];
  for (const sheet of approved) {
    const rules = Array.isArray(sheet.matchingRules) ? sheet.matchingRules : [];
    if (rules.length === 0) {
      // Catch-all sheet; only wins if nothing more specific matches.
      candidates.push({ costSheet: sheet, matchedRuleCount: 0, totalRuleCount: 0 });
      continue;
    }
    let allPass = true;
    for (const rule of rules) {
      if (!evaluateRule(rule, ctx)) {
        allPass = false;
        break;
      }
    }
    if (allPass) {
      candidates.push({ costSheet: sheet, matchedRuleCount: rules.length, totalRuleCount: rules.length });
    }
  }

  candidates.sort((a, b) => {
    if (a.matchedRuleCount !== b.matchedRuleCount) return b.matchedRuleCount - a.matchedRuleCount;
    return b.costSheet.updatedAt.getTime() - a.costSheet.updatedAt.getTime();
  });

  return {
    picked: candidates[0]?.costSheet || null,
    ranked: candidates,
  };
}
