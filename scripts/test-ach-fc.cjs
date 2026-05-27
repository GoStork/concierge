#!/usr/bin/env node
/**
 * One-shot test for ACH + Financial Connections in Stripe sandbox.
 *
 * Creates a $1 Checkout Session restricted to us_bank_account, prints the URL.
 * Open it in a browser - if Financial Connections is on, you'll see "Search for
 * your bank" (Plaid-style auth). If only manual entry shows, FC is off.
 *
 * Run: node scripts/test-ach-fc.cjs
 *
 * Requires STRIPE_SECRET_KEY (or restricted key with Checkout write) in .env.
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const Stripe = require(path.join(__dirname, "..", "node_modules", "stripe"));
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

(async () => {
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{
      price_data: {
        currency: "usd",
        product_data: { name: "ACH + Financial Connections smoke test" },
        unit_amount: 100,
      },
      quantity: 1,
    }],
    payment_method_types: ["us_bank_account"],
    payment_method_options: {
      us_bank_account: {
        financial_connections: { permissions: ["payment_method"] },
        verification_method: "instant",
      },
    },
    success_url: "https://example.com/success?session={CHECKOUT_SESSION_ID}",
    cancel_url: "https://example.com/cancel",
  });

  console.log("\nOpen this URL in your browser:\n");
  console.log("  " + session.url + "\n");
  console.log("What you should see if Financial Connections is on:");
  console.log("  - A 'Search for your bank' option (Plaid-style auth flow)");
  console.log("  - Sandbox test banks like 'Test Institution', 'Ozone Bank'");
  console.log("\nWhat you'd see if FC is off:");
  console.log("  - Only manual routing + account number fields\n");
})().catch((e) => {
  console.error("\nFailed:", e.message);
  if (e.message?.includes("permission") || e.code === "permission_error") {
    console.error("Your restricted key likely lacks 'Checkout Sessions: write'.");
    console.error("Either add the permission at dashboard.stripe.com/apikeys");
    console.error("or run with a full sk_test_ secret key.\n");
  }
  process.exit(1);
});
