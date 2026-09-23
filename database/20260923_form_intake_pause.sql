-- Emergency pause: keep existing data, stop new VIP/catering records.
BEGIN;
UPDATE core.businesses SET intake_enabled = false
WHERE id = 'a358eba4-b197-4309-805b-46f43a718454';
COMMIT;
