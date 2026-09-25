BEGIN;

CREATE TABLE IF NOT EXISTS public.pb_event_worker_health (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  verified_at timestamptz
);
INSERT INTO public.pb_event_worker_health(singleton) VALUES(true) ON CONFLICT DO NOTHING;
ALTER TABLE public.pb_event_worker_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pb_event_worker_health FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.pb_event_worker_status() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE verified timestamptz; pending integer;
BEGIN
  PERFORM public.pb_event_require_service();
  SELECT verified_at INTO verified FROM public.pb_event_worker_health WHERE singleton;
  SELECT count(*) INTO pending FROM public.pb_event_submissions WHERE state IN ('reserved','uploading','finalising');
  RETURN jsonb_build_object('version',1,'ready',coalesce(verified<=clock_timestamp() AND verified>clock_timestamp()-interval '150 seconds',false),'verifiedAt',verified,'pending',pending,'maxPending',2,'heartbeatMaxAgeSeconds',150);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_worker_verified() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.pb_event_require_service();
  IF public.pb_event_capabilities()->'ready' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
  UPDATE public.pb_event_worker_health SET verified_at=clock_timestamp() WHERE singleton;
  IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
  RETURN public.pb_event_worker_status();
END $$;

DO $$ BEGIN
  IF to_regprocedure('public.pb_event_reserve_before_worker_gate(uuid,text,uuid,uuid,text,uuid[],jsonb)') IS NULL THEN
    ALTER FUNCTION public.pb_event_reserve(uuid,text,uuid,uuid,text,uuid[],jsonb) RENAME TO pb_event_reserve_before_worker_gate;
  END IF;
  IF to_regprocedure('public.pb_event_authorise_upload_before_worker_gate(uuid,text,uuid)') IS NULL THEN
    ALTER FUNCTION public.pb_event_authorise_upload(uuid,text,uuid) RENAME TO pb_event_authorise_upload_before_worker_gate;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_reserve(p_event uuid,p_token text,p_submission uuid,p_request uuid,p_receipt_hash text,p_contributors uuid[],p_consent jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.pb_event_tokens; health jsonb;
BEGIN
  PERFORM public.pb_event_require_service();
  PERFORM pg_advisory_xact_lock(hashtextextended('pb-event-admission-v1',0));
  t=public.pb_event_token(p_event,p_token,'contribute');
  IF NOT EXISTS(SELECT 1 FROM public.pb_event_submissions WHERE event_id=p_event AND guest_id=t.guest_id AND request_id=p_request) THEN
    health=public.pb_event_worker_status();
    IF health->'ready' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
    IF (health->>'pending')::integer>=2 THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
  END IF;
  RETURN public.pb_event_reserve_before_worker_gate(p_event,p_token,p_submission,p_request,p_receipt_hash,p_contributors,p_consent);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_authorise_upload(p_event uuid,p_token text,p_submission uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.pb_event_require_service();
  PERFORM public.pb_event_token(p_event,p_token,'contribute');
  IF public.pb_event_worker_status()->'ready' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
  RETURN public.pb_event_authorise_upload_before_worker_gate(p_event,p_token,p_submission);
END $$;

CREATE INDEX IF NOT EXISTS pb_event_pending_admission ON public.pb_event_submissions(state) WHERE state IN ('reserved','uploading','finalising');

REVOKE ALL ON FUNCTION public.pb_event_reserve_before_worker_gate(uuid,text,uuid,uuid,text,uuid[],jsonb),public.pb_event_authorise_upload_before_worker_gate(uuid,text,uuid),public.pb_event_worker_status(),public.pb_event_worker_verified(),public.pb_event_reserve(uuid,text,uuid,uuid,text,uuid[],jsonb),public.pb_event_authorise_upload(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pb_event_worker_status(),public.pb_event_worker_verified(),public.pb_event_reserve(uuid,text,uuid,uuid,text,uuid[],jsonb),public.pb_event_authorise_upload(uuid,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.pb_event_claim_jobs(p_limit integer DEFAULT 10) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.pb_event_jobs; output jsonb='[]';
BEGIN
  PERFORM public.pb_event_require_service(); IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  FOR j IN SELECT candidate.* FROM public.pb_event_jobs candidate WHERE candidate.status IN ('queued','retry','running') AND candidate.attempts<8 AND candidate.available_at<=clock_timestamp() AND (candidate.lease_until IS NULL OR candidate.lease_until<=clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM public.pb_event_jobs active WHERE active.submission_id=candidate.submission_id AND active.id<>candidate.id AND active.status='running' AND active.lease_until>clock_timestamp())
    AND (candidate.kind='finalise' OR NOT EXISTS(SELECT 1 FROM public.pb_event_jobs pending WHERE pending.submission_id=candidate.submission_id AND pending.kind='finalise' AND pending.status IN ('queued','running','retry')))
    ORDER BY CASE WHEN candidate.kind='finalise' THEN 0 ELSE 1 END,candidate.available_at,candidate.id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('pb-event-job:'||j.submission_id,0));
    IF EXISTS(SELECT 1 FROM public.pb_event_jobs WHERE submission_id=j.submission_id AND id<>j.id AND status='running' AND lease_until>clock_timestamp()) OR (j.kind<>'finalise' AND EXISTS(SELECT 1 FROM public.pb_event_jobs WHERE submission_id=j.submission_id AND kind='finalise' AND status IN ('queued','running','retry'))) THEN CONTINUE; END IF;
    UPDATE public.pb_event_jobs SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '120 seconds' WHERE id=j.id RETURNING * INTO j;
    output=output||jsonb_build_array(to_jsonb(j)); EXIT WHEN jsonb_array_length(output)>=p_limit;
  END LOOP;
  RETURN output;
END $$;

COMMIT;
