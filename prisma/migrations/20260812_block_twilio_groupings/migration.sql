-- Twilio's geo-permission rows bundle some countries with a blocked
-- neighbour (Russia/Kazakhstan, Curacao/BQ, Morocco/Western Sahara,
-- Reunion/Mayotte). Blocking the bundle in Twilio blocks these too, so the
-- in-app gate and Cloudflare follow suit to keep the three layers aligned.
INSERT INTO "SecurityCountryPolicy" ("isoCode", "policy", "reason") VALUES
  ('KZ','BLOCKED','Twilio groups this with a blocked country (Aug 12 2026): KZ with RU, BQ with CW, EH with MA, YT with RE'),
  ('BQ','BLOCKED','Twilio groups this with a blocked country (Aug 12 2026): KZ with RU, BQ with CW, EH with MA, YT with RE'),
  ('EH','BLOCKED','Twilio groups this with a blocked country (Aug 12 2026): KZ with RU, BQ with CW, EH with MA, YT with RE'),
  ('YT','BLOCKED','Twilio groups this with a blocked country (Aug 12 2026): KZ with RU, BQ with CW, EH with MA, YT with RE')
ON CONFLICT ("isoCode") DO NOTHING;
