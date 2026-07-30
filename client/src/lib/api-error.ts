/**
 * apiRequest throws `new Error("409: {json body}")` (queryClient.ts), so every
 * caller that wants the server's structured `code` or a human-readable
 * `message` has to unwrap that string itself. Doing it here once keeps raw
 * JSON out of the UI - a parent should never see
 * `409: {"code":"CONSULTATION_ALREADY_OPEN",...}` in a form error.
 */
export interface ParsedApiError {
  status: number | null;
  /** Server-supplied machine code, e.g. "CONSULTATION_ALREADY_OPEN". */
  code: string | null;
  /** Human-readable text, safe to render. Falls back to the raw string. */
  message: string;
  /** The rest of the body, for callers that need extra fields. */
  body: Record<string, any> | null;
}

export function parseApiError(err: unknown): ParsedApiError {
  const raw = String((err as any)?.message ?? err ?? "").trim();
  const match = raw.match(/^(\d{3}):\s*([\s\S]*)$/);
  const status = match ? Number(match[1]) : null;
  const rest = match ? match[2].trim() : raw;

  if (rest.startsWith("{")) {
    try {
      const body = JSON.parse(rest);
      const message = Array.isArray(body?.message) ? body.message.join(" ") : body?.message;
      return {
        status,
        code: body?.code ?? null,
        message: typeof message === "string" && message ? message : rest,
        body,
      };
    } catch {
      /* not JSON after all - fall through */
    }
  }
  return { status, code: null, message: rest || "Something went wrong. Please try again.", body: null };
}
