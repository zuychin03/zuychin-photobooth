BEGIN;
CREATE OR REPLACE FUNCTION public.pb_event_own_consent_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN PERFORM public.pb_event_require_service(); RETURN '{"version":1}'::jsonb; END $$;
DO $$ BEGIN IF to_regprocedure('public.pb_event_consent_before_own_consent(uuid,text,uuid,jsonb)') IS NULL THEN ALTER FUNCTION public.pb_event_consent(uuid,text,uuid,jsonb) RENAME TO pb_event_consent_before_own_consent; END IF; END $$;
REVOKE ALL ON FUNCTION public.pb_event_consent_before_own_consent(uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.pb_event_own_consent(p_event uuid,p_hash text,p_guest uuid,p_submission uuid,p_revision integer DEFAULT NULL,p_gallery boolean DEFAULT NULL,p_wall boolean DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.pb_event_tokens; s public.pb_event_submissions; g public.pb_event_publication_grants;
BEGIN
 PERFORM public.pb_event_require_service(); PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE;
 t=public.pb_event_token(p_event,p_hash,'contribute');
 IF p_guest IS NULL OR t.guest_id IS DISTINCT FROM p_guest THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM public.pb_event_submissions WHERE event_id=p_event AND id=p_submission AND guest_id=p_guest FOR UPDATE;
 IF NOT FOUND OR s.state IN ('deleted','expired','failed') OR s.promised_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
 SELECT * INTO g FROM public.pb_event_publication_grants WHERE event_id=p_event AND submission_id=s.id AND guest_id=p_guest FOR UPDATE;
 IF NOT FOUND OR NOT g.submission_consent THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
 IF p_revision IS NULL THEN
  IF p_gallery IS NOT NULL OR p_wall IS NOT NULL THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 ELSE
  IF p_revision<0 OR p_gallery IS NULL OR p_wall IS NULL THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  IF g.revision<>p_revision AND NOT (g.revision::bigint=p_revision::bigint+1 AND (g.gallery_consent,g.wall_consent) IS NOT DISTINCT FROM (p_gallery,p_wall)) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
  IF (g.gallery_consent,g.wall_consent) IS DISTINCT FROM (p_gallery,p_wall) THEN
   IF g.revision>=2147483646 AND ((p_gallery AND NOT g.gallery_consent) OR (p_wall AND NOT g.wall_consent)) THEN RAISE EXCEPTION 'PB_EVENT_CAPACITY'; END IF;
   IF g.revision=2147483647 THEN UPDATE public.pb_event_publication_grants SET revision=2147483646 WHERE submission_id=s.id AND guest_id=p_guest; END IF;
   PERFORM public.pb_event_consent_before_own_consent(p_event,p_hash,s.id,jsonb_build_object('submission',true,'gallery',p_gallery,'wall',p_wall));
   SELECT * INTO g FROM public.pb_event_publication_grants WHERE submission_id=s.id AND guest_id=p_guest;
  END IF;
 END IF;
 RETURN jsonb_build_object('version',1,'eventId',p_event,'submissionId',s.id,'revision',g.revision,'consent',jsonb_build_object('submission',g.submission_consent,'gallery',g.gallery_consent,'wall',g.wall_consent),'receipt',public.pb_event_receipt_json(s.id));
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_consent(p_event uuid,p_token text,p_submission uuid,p_consent jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.pb_event_tokens; g public.pb_event_publication_grants;
BEGIN
 PERFORM public.pb_event_require_service(); PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE; t=public.pb_event_token(p_event,p_token,'contribute');
 IF p_consent IS NULL OR (p_consent-ARRAY['submission','gallery','wall'])<>'{}'::jsonb OR jsonb_typeof(p_consent->'submission') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_consent->'gallery') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_consent->'wall') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 SELECT * INTO g FROM public.pb_event_publication_grants WHERE event_id=p_event AND submission_id=p_submission AND guest_id=t.guest_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
 IF ((p_consent->>'submission')::boolean AND NOT g.submission_consent) OR ((p_consent->>'gallery')::boolean AND NOT g.gallery_consent) OR ((p_consent->>'wall')::boolean AND NOT g.wall_consent) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 IF g.revision=2147483647 THEN UPDATE public.pb_event_publication_grants SET revision=2147483646 WHERE submission_id=p_submission AND guest_id=t.guest_id; END IF;
 RETURN public.pb_event_consent_before_own_consent(p_event,p_token,p_submission,p_consent);
END $$;
REVOKE ALL ON FUNCTION public.pb_event_own_consent_capabilities(),public.pb_event_own_consent(uuid,text,uuid,uuid,integer,boolean,boolean),public.pb_event_consent(uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pb_event_own_consent_capabilities(),public.pb_event_own_consent(uuid,text,uuid,uuid,integer,boolean,boolean),public.pb_event_consent(uuid,text,uuid,jsonb) TO service_role;
COMMIT;
