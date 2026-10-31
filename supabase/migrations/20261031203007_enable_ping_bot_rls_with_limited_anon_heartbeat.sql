-- Restrict the public Data API on the keep-alive table to its single heartbeat row.
-- The server-side database owner and service_role retain their intended access.
ALTER TABLE public.ping_bot ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.ping_bot FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.ping_bot FROM authenticated;

-- The GitHub keep-alive workflow uses PostgREST upsert with id=1 and message.
-- Grant only the columns and operations needed by that request.
GRANT SELECT (id, message), INSERT (id, message), UPDATE (id, message)
ON TABLE public.ping_bot TO anon;

-- Explicit grant for the server-side role, required for new Data API exposure rules.
GRANT ALL PRIVILEGES ON TABLE public.ping_bot TO service_role;

DROP POLICY IF EXISTS ping_bot_anon_read_heartbeat ON public.ping_bot;
DROP POLICY IF EXISTS ping_bot_anon_insert_heartbeat ON public.ping_bot;
DROP POLICY IF EXISTS ping_bot_anon_update_heartbeat ON public.ping_bot;

CREATE POLICY ping_bot_anon_read_heartbeat
ON public.ping_bot
FOR SELECT
TO anon
USING (id = 1);

CREATE POLICY ping_bot_anon_insert_heartbeat
ON public.ping_bot
FOR INSERT
TO anon
WITH CHECK (
  id = 1
  AND message ~ '^Engine active\. Last pinged on: [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
);

CREATE POLICY ping_bot_anon_update_heartbeat
ON public.ping_bot
FOR UPDATE
TO anon
USING (id = 1)
WITH CHECK (
  id = 1
  AND message ~ '^Engine active\. Last pinged on: [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
);
