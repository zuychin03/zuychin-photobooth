BEGIN;

CREATE TABLE IF NOT EXISTS public.pb_event_rates (
  key text PRIMARY KEY CHECK(key ~ '^[a-f0-9]{64}$'), window_start timestamptz NOT NULL,
  reads integer NOT NULL DEFAULT 0 CHECK(reads BETWEEN 0 AND 120),
  writes integer NOT NULL DEFAULT 0 CHECK(writes BETWEEN 0 AND 60),
  redemptions integer NOT NULL DEFAULT 0 CHECK(redemptions BETWEEN 0 AND 30)
);
CREATE TABLE IF NOT EXISTS public.pb_event_capability_requests (
  event_id uuid NOT NULL REFERENCES public.pb_events, request_id uuid NOT NULL, actor uuid NOT NULL REFERENCES auth.users,
  kind text NOT NULL CHECK(kind IN ('invite','gallery','display')), hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'),
  requested_expiry timestamptz NOT NULL, expires_at timestamptz NOT NULL, rotate boolean NOT NULL,
  PRIMARY KEY(event_id,request_id)
);
ALTER TABLE public.pb_event_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pb_event_capability_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pb_event_rates,public.pb_event_capability_requests FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.pb_event_transport_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_event_require_service(); RETURN jsonb_build_object('version',1,'rateKeys',10000,'readPerMinute',120,'writePerMinute',60,'redeemPerMinute',30,'issuancePerEvent',64); END $$;

CREATE OR REPLACE FUNCTION public.pb_event_check_rate(p_key text,p_bucket text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.pb_event_rates; at_time timestamptz=clock_timestamp(); used integer; ceiling integer;
BEGIN
  PERFORM public.pb_event_require_service();
  IF p_key IS NULL OR p_key !~ '^[a-f0-9]{64}$' OR p_bucket IS NULL OR p_bucket NOT IN ('read','write','redeem') THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  SELECT * INTO r FROM public.pb_event_rates WHERE key=p_key FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM pg_advisory_xact_lock(hashtext('pb-event-rate-keys'));
    SELECT * INTO r FROM public.pb_event_rates WHERE key=p_key FOR UPDATE;
    IF NOT FOUND THEN
      DELETE FROM public.pb_event_rates WHERE key IN(SELECT key FROM public.pb_event_rates WHERE window_start<at_time-interval '2 minutes' ORDER BY window_start LIMIT 100 FOR UPDATE SKIP LOCKED);
      IF (SELECT count(*) FROM public.pb_event_rates)>=10000 THEN RETURN jsonb_build_object('allowed',false,'retryAfterSeconds',60); END IF;
      INSERT INTO public.pb_event_rates(key,window_start) VALUES(p_key,at_time) RETURNING * INTO r;
    END IF;
  END IF;
  IF r.window_start<=at_time-interval '1 minute' THEN
    UPDATE public.pb_event_rates SET window_start=at_time,reads=0,writes=0,redemptions=0 WHERE key=p_key RETURNING * INTO r;
  END IF;
  used=CASE p_bucket WHEN 'read' THEN r.reads WHEN 'write' THEN r.writes ELSE r.redemptions END;
  ceiling=CASE p_bucket WHEN 'read' THEN 120 WHEN 'write' THEN 60 ELSE 30 END;
  IF used>=ceiling THEN RETURN jsonb_build_object('allowed',false,'retryAfterSeconds',greatest(1,least(60,ceil(extract(epoch FROM r.window_start+interval '1 minute'-at_time))))); END IF;
  UPDATE public.pb_event_rates SET reads=reads+CASE WHEN p_bucket='read' THEN 1 ELSE 0 END,writes=writes+CASE WHEN p_bucket='write' THEN 1 ELSE 0 END,redemptions=redemptions+CASE WHEN p_bucket='redeem' THEN 1 ELSE 0 END WHERE key=p_key;
  RETURN jsonb_build_object('allowed',true,'retryAfterSeconds',0);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_session(p_event uuid,p_hash text,p_kind text,p_submission uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.pb_event_tokens;
BEGIN
  PERFORM public.pb_event_require_service();
  IF p_kind IS NULL OR p_kind NOT IN ('contribute','receipt','gallery','display') OR (p_kind='receipt')<>(p_submission IS NOT NULL) THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  PERFORM 1 FROM public.pb_events WHERE id=p_event FOR SHARE;
  t=public.pb_event_token(p_event,p_hash,p_kind,p_submission);
  RETURN jsonb_build_object('eventId',t.event_id,'kind',t.kind,'guestId',t.guest_id,'submissionId',t.submission_id,'expiresAt',t.expires_at);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_issue_capability(p_actor uuid,p_event uuid,p_request uuid,p_kind text,p_hash text,p_expires timestamptz,p_rotate boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events; prior public.pb_event_capability_requests; expiry timestamptz;
BEGIN
  PERFORM public.pb_event_require_service();
  SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
  PERFORM public.pb_event_require_actor(p_event,p_actor,true);
  IF p_request IS NULL OR p_kind IS NULL OR p_kind NOT IN ('invite','gallery','display') OR p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' OR p_expires IS NULL OR NOT isfinite(p_expires) OR p_rotate IS NULL OR (p_rotate AND p_kind<>'invite') THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  IF e.status='deleted' OR e.expires_at<=clock_timestamp() OR e.allocation_released THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
  SELECT * INTO prior FROM public.pb_event_capability_requests WHERE event_id=p_event AND request_id=p_request;
  IF FOUND THEN
    IF prior.actor<>p_actor OR prior.kind<>p_kind OR prior.hash<>p_hash OR prior.requested_expiry<>p_expires OR prior.rotate<>p_rotate THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
    IF prior.expires_at<=clock_timestamp() OR (p_kind='invite' AND NOT EXISTS(SELECT 1 FROM public.pb_event_invites WHERE hash=p_hash AND event_id=p_event AND NOT revoked)) OR (p_kind<>'invite' AND NOT EXISTS(SELECT 1 FROM public.pb_event_tokens WHERE hash=p_hash AND event_id=p_event AND kind=p_kind AND NOT revoked)) THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
    RETURN jsonb_build_object('kind',prior.kind,'expiresAt',prior.expires_at);
  END IF;
  expiry=least(p_expires,CASE WHEN p_kind='invite' THEN e.contribution_closes_at ELSE e.expires_at END);
  IF expiry<=clock_timestamp() THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
  IF (SELECT count(*) FROM public.pb_event_capability_requests WHERE event_id=p_event)>=64 OR
    (SELECT count(*) FROM public.pb_event_invites WHERE event_id=p_event)+(SELECT count(*) FROM public.pb_event_tokens WHERE event_id=p_event AND kind IN ('gallery','display'))>=64 THEN RAISE EXCEPTION 'PB_EVENT_CAPACITY'; END IF;
  PERFORM public.pb_event_manage(p_actor,p_event,CASE WHEN p_kind='invite' THEN CASE WHEN p_rotate THEN 'rotate_invite' ELSE 'invite' END ELSE 'issue_read_token' END,jsonb_build_object('hash',p_hash,'kind',p_kind,'expiresAt',expiry));
  INSERT INTO public.pb_event_capability_requests VALUES(p_event,p_request,p_actor,p_kind,p_hash,p_expires,expiry,p_rotate);
  RETURN jsonb_build_object('kind',p_kind,'expiresAt',expiry);
END $$;

REVOKE ALL ON FUNCTION public.pb_event_transport_capabilities(),public.pb_event_check_rate(text,text),public.pb_event_session(uuid,text,text,uuid),public.pb_event_issue_capability(uuid,uuid,uuid,text,text,timestamptz,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pb_event_transport_capabilities(),public.pb_event_check_rate(text,text),public.pb_event_session(uuid,text,text,uuid),public.pb_event_issue_capability(uuid,uuid,uuid,text,text,timestamptz,boolean) TO service_role;
COMMIT;
