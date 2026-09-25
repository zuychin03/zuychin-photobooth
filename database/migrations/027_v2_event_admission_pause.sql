BEGIN;

ALTER TABLE public.pb_event_worker_health ADD COLUMN IF NOT EXISTS admission_paused boolean NOT NULL DEFAULT false;
ALTER TABLE public.pb_event_worker_health ADD COLUMN IF NOT EXISTS admission_revision integer NOT NULL DEFAULT 0 CHECK(admission_revision>=0);

CREATE OR REPLACE FUNCTION public.pb_event_admission_control(p_paused boolean DEFAULT NULL,p_expected_revision integer DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h public.pb_event_worker_health;
BEGIN
  PERFORM public.pb_event_require_service();
  PERFORM pg_advisory_xact_lock(hashtextextended('pb-event-admission-v1',0));
  SELECT * INTO h FROM public.pb_event_worker_health WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
  IF p_paused IS NULL THEN
    IF p_expected_revision IS NOT NULL THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  ELSE
    IF p_expected_revision IS NULL OR p_expected_revision<0 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
    IF p_expected_revision<>h.admission_revision THEN
      IF p_expected_revision<>h.admission_revision-1 OR p_paused<>h.admission_paused THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
    ELSIF p_paused<>h.admission_paused THEN
      IF h.admission_revision=2147483647 THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
      UPDATE public.pb_event_worker_health SET admission_paused=p_paused,admission_revision=admission_revision+1 WHERE singleton RETURNING * INTO h;
    END IF;
  END IF;
  RETURN jsonb_build_object('version',1,'paused',h.admission_paused,'revision',h.admission_revision);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_worker_status() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE h public.pb_event_worker_health; pending integer;
BEGIN
  PERFORM public.pb_event_require_service();
  SELECT * INTO h FROM public.pb_event_worker_health WHERE singleton;
  SELECT count(*) INTO pending FROM public.pb_event_submissions WHERE state IN ('reserved','uploading','finalising');
  RETURN jsonb_build_object('version',1,'ready',coalesce(NOT h.admission_paused AND h.verified_at<=clock_timestamp() AND h.verified_at>clock_timestamp()-interval '150 seconds',false),'verifiedAt',h.verified_at,'pending',pending,'maxPending',2,'heartbeatMaxAgeSeconds',150,'admissionPaused',coalesce(h.admission_paused,true));
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_authorise_upload(p_event uuid,p_token text,p_submission uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.pb_event_require_service();
  PERFORM pg_advisory_xact_lock(hashtextextended('pb-event-admission-v1',0));
  PERFORM public.pb_event_token(p_event,p_token,'contribute');
  IF public.pb_event_worker_status()->'ready' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
  RETURN public.pb_event_authorise_upload_before_worker_gate(p_event,p_token,p_submission);
END $$;

REVOKE ALL ON FUNCTION public.pb_event_admission_control(boolean,integer),public.pb_event_worker_status(),public.pb_event_authorise_upload(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pb_event_admission_control(boolean,integer),public.pb_event_worker_status(),public.pb_event_authorise_upload(uuid,text,uuid) TO service_role;

COMMIT;
