import sanitizeHtml from "sanitize-html";

/**
 * CRM note bodies are rich HTML written by staff - bold, lists, links,
 * inline images, file attachments. HTML from a browser is untrusted input no
 * matter who typed it, and these notes render with dangerouslySetInnerHTML on
 * pages BOTH audiences read, so this sanitizer is the whole XSS story:
 *
 *  - sanitize on WRITE (POST and PATCH), so nothing hostile is ever stored;
 *  - sanitize on READ too, because notes written before this feature are
 *    plain text a user could have typed literal markup into, and the client
 *    decides text-vs-HTML rendering by sniffing for tags.
 *
 * The allowlist is deliberately small: structure, emphasis, links, images.
 * No style attributes - visual styling comes from the page's own tokens, and
 * a style allowlist is where sanitizer bypasses live. No iframes, no forms,
 * no event handlers (sanitize-html drops on* attributes by default).
 */
/**
 * GCS URLs in notes must go through our authenticated proxy. The uploads
 * bucket is PRIVATE - a raw storage.googleapis.com URL 403s in an <img>, so
 * an inserted photo rendered as a broken image. Chat surfaces solve this
 * client-side with getPhotoSrc(); note HTML is stored markup, so the rewrite
 * lives here instead - applied on write AND read, which also repairs notes
 * saved before the fix.
 */
function proxyGcsUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const m = url.match(/^https?:\/\/storage\.googleapis\.com\/[^/]*gostork[^/]*\/(.+)$/i);
  return m ? `/api/uploads/gcs?path=${encodeURIComponent(decodeURIComponent(m[1]))}` : url;
}

const NOTE_SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "div", "span",
    "b", "strong", "i", "em", "u",
    "ul", "ol", "li", "blockquote",
    "a", "img",
  ],
  allowedAttributes: {
    a: ["href", "target", "rel"],
    img: ["src", "alt"],
    // #7 @mentions: a mention is a span carrying the tagged user's id. The id
    // is validated on write (only real, in-audience users survive); class is
    // for styling only.
    span: ["data-mention-user-id", "class"],
  },
  // http(s) plus same-origin relative paths (/uploads, /api/uploads/proxy).
  allowedSchemes: ["http", "https"],
  allowProtocolRelative: false,
  transformTags: {
    // Every link opens in a new tab and never leaks an opener handle; links
    // into the private GCS bucket are rewritten to the authenticated proxy.
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, href: proxyGcsUrl(attribs.href) ?? "", target: "_blank", rel: "noopener noreferrer" },
    }),
    img: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, src: proxyGcsUrl(attribs.src) ?? "" },
    }),
  },
};

export function sanitizeNoteHtml(raw: string): string {
  return sanitizeHtml(String(raw ?? ""), NOTE_SANITIZE).trim();
}

/**
 * The text a human actually wrote, tags stripped - what the contact-info
 * guard scans. Scanning the HTML would let markup split a phone number
 * ("555<b>-</b>0143") straight past the regex.
 */
export function noteHtmlToText(raw: string): string {
  return sanitizeHtml(String(raw ?? ""), { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}
