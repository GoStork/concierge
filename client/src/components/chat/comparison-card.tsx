import { Fragment } from "react";
import { Check } from "lucide-react";
import { getPhotoSrc } from "@/lib/profile-utils";
import type { ComparisonCardData } from "@/pages/concierge-chat-page";

/**
 * Side-by-side comparison card for the AI concierge chat.
 *
 * Fully data-driven: one component renders a comparison of ANY entity type
 * (clinics, egg/sperm donors, surrogates, doctors, agencies). The server
 * (resolve_comparison MCP tool) builds the normalized {entities, groups} payload
 * from real DB data, flagging the best cell per numeric row - this component
 * never computes or invents values, it only lays them out.
 *
 * Brand-styled throughout via CSS variables (no hardcoded colors / fonts /
 * radii). The first column (attribute labels) sticks while the entity columns
 * scroll horizontally, so 2-4 entities stay readable on a narrow chat column.
 */
export function ComparisonCard({ card, brandColor }: { card: ComparisonCardData; brandColor: string }) {
  const entities = card.entities || [];
  if (entities.length < 2) return null;
  const groups = card.groups || [];

  // Highlight tint for the winning cell in a numeric row, derived from the
  // brand success color so it restyles with Brand Settings.
  const bestBg = "hsl(var(--brand-success) / 0.12)";
  const bestFg = "hsl(var(--brand-success))";

  const initials = (name: string) =>
    (name || "?")
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase();

  return (
    <div
      className="w-full overflow-hidden bg-card"
      style={{ borderRadius: "var(--container-radius, 0.5rem)", border: "1px solid hsl(var(--border))" }}
    >
      {card.title && (
        <div
          className="px-4 py-3 font-heading font-semibold text-sm"
          style={{ borderBottom: "1px solid hsl(var(--border))", color: "hsl(var(--foreground))" }}
        >
          {card.title}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse" style={{ fontSize: "0.8125rem" }}>
          {/* Entity header: photo + name + subtitle per column */}
          <thead>
            <tr>
              <th
                className="sticky left-0 z-10 bg-card text-left align-bottom px-3 py-2"
                style={{ minWidth: 132, borderBottom: "1px solid hsl(var(--border))" }}
              />
              {entities.map((e, i) => (
                <th
                  key={i}
                  className="px-3 py-3 text-center align-bottom"
                  style={{ minWidth: 118, borderBottom: "1px solid hsl(var(--border))", borderLeft: "1px solid hsl(var(--border))" }}
                >
                  <div className="flex flex-col items-center gap-1.5">
                    {e.photo ? (
                      <img
                        src={getPhotoSrc(e.photo) || e.photo}
                        alt={e.name}
                        className="w-11 h-11 rounded-full object-cover"
                        style={{ border: "1px solid hsl(var(--border))" }}
                      />
                    ) : (
                      <div
                        className="w-11 h-11 rounded-full flex items-center justify-center font-ui font-semibold text-xs"
                        style={{ backgroundColor: `${brandColor}1A`, color: brandColor }}
                      >
                        {initials(e.name)}
                      </div>
                    )}
                    <span className="font-ui font-semibold leading-tight" style={{ color: "hsl(var(--foreground))" }}>
                      {e.name}
                    </span>
                    {e.subtitle && (
                      <span className="text-[0.6875rem] leading-tight" style={{ color: "hsl(var(--muted-foreground))" }}>
                        {e.subtitle}
                      </span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {groups.map((g) => (
              <Fragment key={g.key}>
                {/* Group divider row */}
                <tr>
                  <td
                    colSpan={entities.length + 1}
                    className="px-3 py-1.5 font-ui font-semibold uppercase tracking-wide text-[0.6875rem]"
                    style={{ backgroundColor: "hsl(var(--secondary))", color: "hsl(var(--muted-foreground))" }}
                  >
                    {g.label}
                  </td>
                </tr>
                {g.rows.map((r, ri) => (
                  <tr key={ri}>
                    <td
                      className="sticky left-0 z-10 bg-card px-3 py-2 align-top"
                      style={{ borderTop: "1px solid hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}
                    >
                      {r.label}
                    </td>
                    {r.values.map((v, vi) => (
                      <td
                        key={vi}
                        className="px-3 py-2 text-center align-top font-ui"
                        style={{
                          borderTop: "1px solid hsl(var(--border))",
                          borderLeft: "1px solid hsl(var(--border))",
                          backgroundColor: v.best ? bestBg : undefined,
                          color: v.best ? bestFg : "hsl(var(--foreground))",
                          fontWeight: v.best ? 600 : 400,
                        }}
                      >
                        <span className="inline-flex items-center gap-1 justify-center">
                          {v.display}
                          {v.best && <Check className="w-3.5 h-3.5 shrink-0" />}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
