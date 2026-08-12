-- Seed the country policy with what the production incident taught us, plus
-- ranges the industry knows as SMS-pump origins. BLOCKED is reserved for the
-- observed fraud sources and for sanctioned/conflict states with effectively
-- no fertility market; countries that are risky but real get WHATSAPP_ONLY,
-- which a genuine parent can still complete (WhatsApp has no carrier revenue
-- share to farm). ON CONFLICT DO NOTHING - an admin's later decision wins.
INSERT INTO "SecurityCountryPolicy" ("isoCode", "policy", "reason") VALUES
  -- Observed in the Aug 2026 bot signup wave on production
  ('ET', 'BLOCKED', 'Bot signup wave, Aug 2026 - premium-rate OTP pumping'),
  ('AZ', 'BLOCKED', 'Bot signup wave, Aug 2026 - premium-rate OTP pumping'),
  ('RS', 'BLOCKED', 'Bot signup wave, Aug 2026 - premium-rate OTP pumping'),
  ('PK', 'BLOCKED', 'Bot signup wave, Aug 2026 - premium-rate OTP pumping'),
  ('KG', 'BLOCKED', 'Bot signup wave, Aug 2026 - premium-rate OTP pumping'),
  ('TJ', 'BLOCKED', 'Bot signup wave, Aug 2026 - premium-rate OTP pumping'),
  -- Sanctioned or conflict states with no serviceable market
  ('KP', 'BLOCKED', 'Sanctioned - no serviceable market'),
  ('SY', 'BLOCKED', 'Sanctioned - no serviceable market'),
  ('AF', 'BLOCKED', 'No serviceable market; high fraud risk'),
  ('YE', 'BLOCKED', 'No serviceable market; high fraud risk'),
  ('SD', 'BLOCKED', 'No serviceable market; high fraud risk'),
  ('SO', 'BLOCKED', 'No serviceable market; high fraud risk'),
  -- Known SMS-pump origins where real families DO exist - WhatsApp still works
  ('UZ', 'WHATSAPP_ONLY', 'Known SMS-pump range - WhatsApp verification only'),
  ('BD', 'WHATSAPP_ONLY', 'Known SMS-pump range - WhatsApp verification only'),
  ('MM', 'WHATSAPP_ONLY', 'Known SMS-pump range - WhatsApp verification only'),
  ('LK', 'WHATSAPP_ONLY', 'Known SMS-pump range - WhatsApp verification only'),
  ('NG', 'WHATSAPP_ONLY', 'Known SMS-pump range - WhatsApp verification only'),
  ('ID', 'WHATSAPP_ONLY', 'Known SMS-pump range - WhatsApp verification only'),
  ('IQ', 'WHATSAPP_ONLY', 'Known SMS-pump range - WhatsApp verification only'),
  ('LY', 'WHATSAPP_ONLY', 'Known SMS-pump range - WhatsApp verification only'),
  ('DZ', 'WHATSAPP_ONLY', 'Known SMS-pump range - WhatsApp verification only'),
  ('TN', 'WHATSAPP_ONLY', 'Known SMS-pump range - WhatsApp verification only')
ON CONFLICT ("isoCode") DO NOTHING;
