-- Rename AiChatSession.status PROVIDER_JOINED to PROVIDER_CONNECTED.
-- status is a free-form String, so no enum/type change is needed.
UPDATE "AiChatSession" SET status = 'PROVIDER_CONNECTED' WHERE status = 'PROVIDER_JOINED';
