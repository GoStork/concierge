import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // JS/CSS assets have content-hash filenames - cache them aggressively
  // HTML must NOT be cached so browsers always get the latest asset references
  app.use(express.static(distPath, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    },
  }));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    if (isNoIndexPath(req.path)) res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}

/**
 * Auth and intake screens that must never appear in search results.
 *
 * These pages have no search value (they are forms, not content) and every one
 * of them sits behind the Cloudflare bot challenge, so a crawler's visit ends
 * in a challenge rather than a page. That combination is what produced Search
 * Console's "Blocked due to access forbidden (403)" report on 12 URLs and
 * failed the fix validation on 2026-09-06: Google kept retrying URLs that we
 * never wanted indexed in the first place. Telling Google not to index them
 * retires the error at the source instead of loosening the bot protection that
 * exists to guard exactly these endpoints.
 *
 * We serve a header rather than a <meta> tag because this is a single-page
 * app: one index.html backs every route, so a meta tag could not vary per
 * path. Googlebot honours X-Robots-Tag identically.
 *
 * Prefix match, so nested steps (/onboarding/ai-intro, /reset-password/:token)
 * are covered. The app root "/" is deliberately NOT here - it is the entry
 * point for app.gostork.com and noindexing it would delist the app itself.
 */
const NOINDEX_PREFIXES = [
  "/login",
  "/auth",
  "/register",
  "/questionnaire",
  "/onboarding",
  "/forgot-password",
  "/check-email",
  "/reset-password",
  "/complete-profile",
];

export function isNoIndexPath(pathname: string): boolean {
  const p = pathname.toLowerCase().replace(/\/+$/, "") || "/";
  return NOINDEX_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + "/"));
}
