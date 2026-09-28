-- Push instead of poll (scope: accept Sonarr/Radarr webhooks). Each service
-- gets its own random token embedded in its webhook URL, since Sonarr/
-- Radarr's webhook connection can't reliably be made to send a custom
-- Authorization header across every version. Webhooks never replace
-- polling — see app/poller.py — they just react sooner.
ALTER TABLE service_instances ADD COLUMN webhook_token TEXT NOT NULL DEFAULT '';
UPDATE service_instances SET webhook_token = lower(hex(randomblob(16))) WHERE webhook_token = '';
