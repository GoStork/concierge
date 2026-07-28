import { Fragment, type ReactNode } from "react";

/**
 * The single renderer for chat message text.
 *
 * Previously the parent's chat linkified URLs while the shared provider/admin
 * list did not, so the same message was clickable for one side and dead text
 * for the other. Both now use this.
 *
 * Supports:
 *   **bold**
 *   [label](url)   - preferred; keeps a long profile URL out of the prose
 *   bare http(s) URLs and /room/<id> links
 */

const MD_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g;
const BARE_LINK = /(https?:\/\/[^\s)]+|\/room\/[A-Za-z0-9-]+)/g;

function anchor(href: string, label: string, key: string): ReactNode {
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline"
      style={{ color: "inherit", textUnderlineOffset: "2px" }}
      onClick={(e) => e.stopPropagation()}
    >
      {label}
    </a>
  );
}

/** Bare URLs only - markdown links are peeled off before this runs. */
function linkifyPlain(text: string, keyPrefix: string): ReactNode[] {
  const cleaned = text.replace(/`/g, "");
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  BARE_LINK.lastIndex = 0;
  while ((m = BARE_LINK.exec(cleaned)) !== null) {
    if (m.index > last) nodes.push(<Fragment key={`${keyPrefix}-t${idx}`}>{cleaned.slice(last, m.index)}</Fragment>);
    nodes.push(anchor(m[0], m[0], `${keyPrefix}-a${idx}`));
    last = m.index + m[0].length;
    idx++;
  }
  if (last < cleaned.length) nodes.push(<Fragment key={`${keyPrefix}-t${idx}`}>{cleaned.slice(last)}</Fragment>);
  return nodes;
}

/** Markdown links first (so their URL never gets bare-linkified), then bold, then bare URLs. */
function renderSegment(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  MD_LINK.lastIndex = 0;
  while ((m = MD_LINK.exec(text)) !== null) {
    if (m.index > last) out.push(...linkifyPlain(text.slice(last, m.index), `${keyPrefix}-p${idx}`));
    out.push(anchor(m[2], m[1], `${keyPrefix}-md${idx}`));
    last = m.index + m[0].length;
    idx++;
  }
  if (last < text.length) out.push(...linkifyPlain(text.slice(last), `${keyPrefix}-p${idx}`));
  return out;
}

export function renderRichLine(line: string, keyPrefix = "l"): ReactNode[] {
  const out: ReactNode[] = [];
  line.split(/(\*\*[^*]+\*\*)/g).forEach((part, pi) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      out.push(<strong key={`${keyPrefix}b${pi}`}>{part.slice(2, -2)}</strong>);
    } else if (part) {
      out.push(...renderSegment(part, `${keyPrefix}${pi}`));
    }
  });
  return out;
}

/** Full message body: newlines become <br>, each line rendered rich. */
export function renderRichText(text: string): ReactNode {
  return text.split("\n").map((line, li) => (
    <Fragment key={li}>
      {li > 0 && <br />}
      {renderRichLine(line, `l${li}`)}
    </Fragment>
  ));
}

/** Strip markdown link syntax for plain-text contexts (previews, notifications). */
export function stripRichText(text: string): string {
  return (text || "").replace(MD_LINK, "$1");
}
