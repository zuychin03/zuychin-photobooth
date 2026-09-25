BEGIN;
ALTER TABLE public.pb_event_submissions ADD COLUMN IF NOT EXISTS publication_revision bigint NOT NULL DEFAULT 0 CHECK(publication_revision BETWEEN 0 AND 9007199254740991);
ALTER TABLE public.pb_event_tokens ADD COLUMN IF NOT EXISTS audience_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE TABLE IF NOT EXISTS public.pb_event_publication_requests (
 event_id uuid NOT NULL REFERENCES public.pb_events, request_id uuid NOT NULL, actor uuid NOT NULL REFERENCES auth.users,
 fingerprint jsonb NOT NULL, PRIMARY KEY(event_id,request_id)
);
CREATE TABLE IF NOT EXISTS public.pb_event_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES public.pb_events,
 submission_id uuid NOT NULL REFERENCES public.pb_event_submissions, destination text NOT NULL CHECK(destination IN ('gallery','wall')),
 reporter_hash text NOT NULL CHECK(reporter_hash ~ '^[a-f0-9]{64}$'), request_id uuid NOT NULL,
 reason text NOT NULL CHECK(reason IN ('privacy','inappropriate','other')), detail text NOT NULL CHECK(length(detail)<=500),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(event_id,reporter_hash,request_id), UNIQUE(event_id,reporter_hash,submission_id,destination)
);
ALTER TABLE public.pb_event_publication_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pb_event_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pb_event_publication_requests,public.pb_event_reports FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.pb_event_publication_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='pb_event_submissions' THEN
  IF (NEW.state,NEW.gallery_state,NEW.wall_state) IS DISTINCT FROM (OLD.state,OLD.gallery_state,OLD.wall_state) THEN NEW.publication_revision=OLD.publication_revision+1; END IF;
  RETURN NEW;
 END IF;
 IF (NEW.submission_consent,NEW.gallery_consent,NEW.wall_consent) IS DISTINCT FROM (OLD.submission_consent,OLD.gallery_consent,OLD.wall_consent) THEN
  UPDATE public.pb_event_submissions SET publication_revision=publication_revision+1 WHERE id=NEW.submission_id;
 END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pb_event_publication_revision ON public.pb_event_submissions;
CREATE TRIGGER pb_event_publication_revision BEFORE UPDATE ON public.pb_event_submissions FOR EACH ROW EXECUTE FUNCTION public.pb_event_publication_revision();
DROP TRIGGER IF EXISTS pb_event_publication_grant_revision ON public.pb_event_publication_grants;
CREATE TRIGGER pb_event_publication_grant_revision AFTER UPDATE ON public.pb_event_publication_grants FOR EACH ROW EXECUTE FUNCTION public.pb_event_publication_revision();

DO $$ BEGIN
 IF to_regprocedure('public.pb_event_manage_before_publication(uuid,uuid,text,jsonb)') IS NULL THEN ALTER FUNCTION public.pb_event_manage(uuid,uuid,text,jsonb) RENAME TO pb_event_manage_before_publication; END IF;
 IF to_regprocedure('public.pb_event_consent_before_publication(uuid,text,uuid,jsonb)') IS NULL THEN ALTER FUNCTION public.pb_event_consent(uuid,text,uuid,jsonb) RENAME TO pb_event_consent_before_publication; END IF;
 IF to_regprocedure('public.pb_event_sweep_before_publication(integer)') IS NULL THEN ALTER FUNCTION public.pb_event_sweep(integer) RENAME TO pb_event_sweep_before_publication; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_manage(p_actor uuid,p_event uuid,p_action text,p_body jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.pb_event_require_service();
 IF p_action='publication' THEN RAISE EXCEPTION 'PB_EVENT_UPDATE_REQUIRED'; END IF;
 RETURN public.pb_event_manage_before_publication(p_actor,p_event,p_action,p_body);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_consent(p_event uuid,p_token text,p_submission uuid,p_consent jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.pb_event_consent_before_publication(p_event,p_token,p_submission,p_consent);
 UPDATE public.pb_event_submissions s SET
 gallery_state=CASE WHEN gallery_state='private' AND NOT EXISTS(SELECT 1 FROM public.pb_event_publication_grants g JOIN public.pb_event_guests v ON v.id=g.guest_id WHERE g.submission_id=s.id AND (v.revoked OR NOT g.submission_consent OR NOT g.gallery_consent)) THEN 'awaiting_approval' ELSE gallery_state END,
 wall_state=CASE WHEN wall_state='private' AND NOT EXISTS(SELECT 1 FROM public.pb_event_publication_grants g JOIN public.pb_event_guests v ON v.id=g.guest_id WHERE g.submission_id=s.id AND (v.revoked OR NOT g.submission_consent OR NOT g.wall_consent)) THEN 'awaiting_approval' ELSE wall_state END
 WHERE s.event_id=p_event AND s.id=p_submission AND s.state='ready';
 RETURN public.pb_event_receipt_json(p_submission);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_sweep(p_limit integer DEFAULT 25) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb; target uuid;
BEGIN
 PERFORM public.pb_event_require_service(); IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 result=public.pb_event_sweep_before_publication(p_limit);
 FOR target IN SELECT e.id FROM public.pb_events e WHERE (e.status='deleted' OR e.expires_at<=clock_timestamp()) AND EXISTS(SELECT 1 FROM public.pb_event_reports r WHERE r.event_id=e.id) ORDER BY e.id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
  DELETE FROM public.pb_event_reports WHERE event_id=target;
 END LOOP;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_publication_capabilities() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('publicationVersion',1,'pageItems',12,'wallItems',3,'pollMs',5000,'freshnessMs',10000,'thumbnailBytes',100000,'imageBytes',2000000,'readSeconds',300,'reportCharacters',500,'reports',100)
$$;
CREATE OR REPLACE FUNCTION public.pb_event_publication_instant(p_time timestamptz) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT to_char(p_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;
CREATE OR REPLACE FUNCTION public.pb_event_audience_subject(p_event uuid,p_hash text,p_destination text,p_session uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events; t public.pb_event_tokens; instant timestamptz=clock_timestamp();
BEGIN
 PERFORM public.pb_event_require_service(); IF p_destination IS NULL OR p_destination NOT IN ('gallery','wall') THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR SHARE;
 t=public.pb_event_token(p_event,p_hash,CASE WHEN p_destination='wall' THEN 'display' ELSE 'gallery' END);
 IF p_session IS NOT NULL AND p_session<>t.audience_id THEN RAISE EXCEPTION 'PB_EVENT_IDENTITY_CHANGED'; END IF;
 RETURN jsonb_build_object('version',1,'eventId',e.id,'destination',p_destination,'sessionId',t.audience_id,'eventTitle',e.title,'checkedAt',public.pb_event_publication_instant(instant),'expiresAt',public.pb_event_publication_instant(least(t.expires_at,e.expires_at)));
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_audience_session(p_event uuid,p_hash text,p_destination text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.pb_event_audience_subject(p_event,p_hash,p_destination)
$$;
CREATE OR REPLACE FUNCTION public.pb_event_publication_visible(p_event uuid,p_submission uuid,p_destination text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.pb_event_submissions s WHERE s.id=p_submission AND s.event_id=p_event AND s.state='ready' AND s.promised_expires_at>clock_timestamp()
 AND CASE WHEN p_destination='gallery' THEN s.gallery_state='approved' ELSE s.wall_state='approved' END
 AND EXISTS(SELECT 1 FROM public.pb_event_publication_grants g WHERE g.submission_id=s.id)
 AND NOT EXISTS(SELECT 1 FROM public.pb_event_publication_grants g JOIN public.pb_event_guests v ON v.id=g.guest_id WHERE g.submission_id=s.id AND (v.revoked OR NOT g.submission_consent OR NOT CASE WHEN p_destination='gallery' THEN g.gallery_consent ELSE g.wall_consent END)))
$$;
CREATE OR REPLACE FUNCTION public.pb_event_audience_list(p_event uuid,p_hash text,p_destination text,p_session uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 12) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE context jsonb; entries jsonb; more boolean; cursor_id uuid;
BEGIN
 IF p_session IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 12 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 context=public.pb_event_audience_subject(p_event,p_hash,p_destination,p_session);
 WITH selected AS(SELECT s.*,row_number() OVER(ORDER BY id) n FROM public.pb_event_submissions s WHERE event_id=p_event AND (p_after IS NULL OR id>p_after) AND public.pb_event_publication_visible(p_event,id,p_destination) AND public.pb_event_review_thumbnail(p_event,id) IS NOT NULL ORDER BY id LIMIT p_limit+1)
 SELECT coalesce(jsonb_agg(jsonb_build_object('submissionId',id,'revision',publication_revision,'createdAt',public.pb_event_publication_instant(created_at)) ORDER BY id) FILTER(WHERE n<=p_limit),'[]'),count(*)>p_limit,(array_agg(id ORDER BY id) FILTER(WHERE n<=p_limit))[p_limit] INTO entries,more,cursor_id FROM selected;
 RETURN (context-'sessionId')||jsonb_build_object('entries',entries,'nextCursor',CASE WHEN more THEN cursor_id ELSE NULL END);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_audience_validate(p_event uuid,p_hash text,p_destination text,p_session uuid,p_submissions uuid[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE context jsonb; entries jsonb;
BEGIN
 IF p_session IS NULL OR p_submissions IS NULL OR cardinality(p_submissions)>12 OR cardinality(p_submissions)<>(SELECT count(DISTINCT id) FROM unnest(p_submissions) id) THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 context=public.pb_event_audience_subject(p_event,p_hash,p_destination,p_session);
 SELECT coalesce(jsonb_agg(jsonb_build_object('submissionId',s.id,'revision',s.publication_revision) ORDER BY s.id),'[]') INTO entries FROM public.pb_event_submissions s WHERE s.id=ANY(p_submissions) AND public.pb_event_publication_visible(p_event,s.id,p_destination) AND public.pb_event_review_thumbnail(p_event,s.id) IS NOT NULL;
 RETURN (context-ARRAY['sessionId','eventTitle'])||jsonb_build_object('entries',entries);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_audience_access(p_event uuid,p_hash text,p_destination text,p_session uuid,p_submission uuid,p_variant text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE context jsonb; descriptor jsonb; s public.pb_event_submissions; proof jsonb; size bigint; expiry timestamptz;
BEGIN
 IF p_session IS NULL OR p_variant IS NULL OR p_variant NOT IN ('thumbnail','image') OR p_destination='wall' AND p_variant<>'thumbnail' THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 context=public.pb_event_audience_subject(p_event,p_hash,p_destination,p_session);
 IF NOT public.pb_event_publication_visible(p_event,p_submission,p_destination) THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 descriptor=public.pb_event_review_thumbnail(p_event,p_submission); IF descriptor IS NULL THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 SELECT * INTO s FROM public.pb_event_submissions WHERE id=p_submission AND event_id=p_event;
 expiry=least((context->>'expiresAt')::timestamptz,s.promised_expires_at);
 descriptor=(descriptor-ARRAY['expiresAt','maxAgeSeconds'])||jsonb_build_object('revision',s.publication_revision,'variant',p_variant,'width',NULL,'height',NULL,'expiresAt',public.pb_event_publication_instant(expiry),'maxAgeSeconds',least(300,floor(extract(epoch FROM expiry-clock_timestamp()))));
 IF p_variant='image' THEN
  SELECT checkpoint INTO proof FROM public.pb_event_jobs WHERE submission_id=s.id AND kind='finalise' AND status='complete';
  SELECT CASE WHEN metadata->>'size' ~ '^[0-9]{1,7}$' THEN (metadata->>'size')::bigint ELSE NULL END INTO size FROM storage.objects WHERE bucket_id='photobooth-events-v2' AND name=s.delivery_path;
  IF size IS NULL OR size NOT BETWEEN 1 AND 2000000 OR NOT coalesce(proof->>'sha256' ~ '^[a-f0-9]{64}$',false) OR NOT coalesce(proof->>'width' ~ '^[0-9]{1,4}$',false) OR NOT coalesce(proof->>'height' ~ '^[0-9]{1,4}$',false) OR (proof->>'width')::integer NOT BETWEEN 1 AND 4096 OR (proof->>'height')::integer NOT BETWEEN 1 AND 4096 OR (proof->>'width')::bigint*(proof->>'height')::bigint>12000000 THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
  descriptor=descriptor||jsonb_build_object('path',s.delivery_path,'bytes',size,'sha256',proof->>'sha256','width',(proof->>'width')::integer,'height',(proof->>'height')::integer);
 END IF;
 IF (descriptor->>'maxAgeSeconds')::integer<1 THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF; RETURN descriptor;
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_publication_entry(p_submission uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('submissionId',s.id,'revision',s.publication_revision,'createdAt',public.pb_event_publication_instant(s.created_at),'state',public.pb_event_receipt_json(s.id)->>'state','gallery',s.gallery_state,'wall',s.wall_state,
 'galleryConsent',EXISTS(SELECT 1 FROM public.pb_event_publication_grants WHERE submission_id=s.id) AND NOT EXISTS(SELECT 1 FROM public.pb_event_publication_grants g JOIN public.pb_event_guests v ON v.id=g.guest_id WHERE g.submission_id=s.id AND (v.revoked OR NOT g.submission_consent OR NOT g.gallery_consent)),
 'wallConsent',EXISTS(SELECT 1 FROM public.pb_event_publication_grants WHERE submission_id=s.id) AND NOT EXISTS(SELECT 1 FROM public.pb_event_publication_grants g JOIN public.pb_event_guests v ON v.id=g.guest_id WHERE g.submission_id=s.id AND (v.revoked OR NOT g.submission_consent OR NOT g.wall_consent)),
 'thumbnailAvailable',public.pb_event_review_thumbnail(s.event_id,s.id) IS NOT NULL) FROM public.pb_event_submissions s WHERE s.id=p_submission
$$;
CREATE OR REPLACE FUNCTION public.pb_event_publication_list(p_actor uuid,p_event uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 12) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE entries jsonb; more boolean; cursor_id uuid;
BEGIN
 PERFORM public.pb_event_review_subject(p_actor,p_event); IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 12 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 WITH selected AS(SELECT id,row_number() OVER(ORDER BY id) n FROM public.pb_event_submissions WHERE event_id=p_event AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT p_limit+1)
 SELECT coalesce(jsonb_agg(public.pb_event_publication_entry(id) ORDER BY id) FILTER(WHERE n<=p_limit),'[]'),count(*)>p_limit,(array_agg(id ORDER BY id) FILTER(WHERE n<=p_limit))[p_limit] INTO entries,more,cursor_id FROM selected;
 RETURN jsonb_build_object('version',1,'eventId',p_event,'entries',entries,'nextCursor',CASE WHEN more THEN cursor_id ELSE NULL END);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_publication_decide(p_actor uuid,p_event uuid,p_submission uuid,p_destination text,p_revision bigint,p_state text,p_request uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.pb_event_submissions; prior public.pb_event_publication_requests; fingerprint jsonb;
BEGIN
 PERFORM public.pb_event_require_service(); PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE; PERFORM public.pb_event_review_subject(p_actor,p_event);
 IF p_destination IS NULL OR p_destination NOT IN ('gallery','wall') OR p_state IS NULL OR p_state NOT IN ('approved','hidden','rejected') OR p_revision IS NULL OR p_revision<0 OR (p_state='approved')<>(p_request IS NOT NULL) THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 SELECT * INTO s FROM public.pb_event_submissions WHERE id=p_submission AND event_id=p_event FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 fingerprint=jsonb_build_object('submissionId',p_submission,'destination',p_destination,'revision',p_revision,'state',p_state);
 IF p_request IS NOT NULL THEN
  SELECT * INTO prior FROM public.pb_event_publication_requests WHERE event_id=p_event AND request_id=p_request;
  IF FOUND THEN IF prior.actor<>p_actor OR prior.fingerprint<>fingerprint THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF; RETURN public.pb_event_publication_entry(p_submission); END IF;
 END IF;
 IF s.publication_revision<>p_revision THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 IF p_state='approved' THEN
  IF s.state<>'ready' OR public.pb_event_review_thumbnail(p_event,s.id) IS NULL OR NOT (public.pb_event_publication_entry(s.id)->>CASE WHEN p_destination='gallery' THEN 'galleryConsent' ELSE 'wallConsent' END)::boolean THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
  IF (SELECT count(*) FROM public.pb_event_publication_requests WHERE event_id=p_event)>=512 THEN RAISE EXCEPTION 'PB_EVENT_CAPACITY'; END IF;
  INSERT INTO public.pb_event_publication_requests VALUES(p_event,p_request,p_actor,fingerprint);
 END IF;
 UPDATE public.pb_event_submissions SET gallery_state=CASE WHEN p_destination='gallery' THEN p_state ELSE gallery_state END,wall_state=CASE WHEN p_destination='wall' THEN p_state ELSE wall_state END WHERE id=s.id;
 RETURN public.pb_event_publication_entry(p_submission);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_report_receipt(p_report uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('version',1,'reportId',id,'status',status) FROM public.pb_event_reports WHERE id=p_report
$$;
CREATE OR REPLACE FUNCTION public.pb_event_publication_remove(p_actor uuid,p_event uuid,p_submission uuid,p_revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.pb_event_submissions;
BEGIN
 PERFORM public.pb_event_require_service(); PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE; PERFORM public.pb_event_review_subject(p_actor,p_event);
 SELECT * INTO s FROM public.pb_event_submissions WHERE id=p_submission AND event_id=p_event FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 IF p_revision IS NULL OR p_revision<0 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 IF s.state='deleted' THEN RETURN public.pb_event_publication_entry(s.id); END IF;
 IF s.publication_revision<>p_revision THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 PERFORM public.pb_event_manage_before_publication(p_actor,p_event,'remove_submission',jsonb_build_object('submissionId',s.id));
 RETURN public.pb_event_publication_entry(s.id);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_audience_report(p_event uuid,p_hash text,p_destination text,p_session uuid,p_submission uuid,p_request uuid,p_reason text,p_detail text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE prior public.pb_event_reports; reporter text; report_id uuid;
BEGIN
 PERFORM public.pb_event_require_service(); PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE; PERFORM public.pb_event_audience_subject(p_event,p_hash,p_destination,p_session);
 IF p_session IS NULL OR p_request IS NULL OR p_reason IS NULL OR p_reason NOT IN ('privacy','inappropriate','other') OR p_detail IS NULL OR length(p_detail)>500 OR p_detail ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 reporter=encode(sha256(convert_to('event-report:'||p_hash,'UTF8')),'hex');
 SELECT * INTO prior FROM public.pb_event_reports WHERE event_id=p_event AND reporter_hash=reporter AND request_id=p_request;
 IF FOUND THEN IF (prior.submission_id,prior.destination,prior.reason,prior.detail) IS DISTINCT FROM (p_submission,p_destination,p_reason,p_detail) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF; RETURN public.pb_event_report_receipt(prior.id); END IF;
 IF NOT public.pb_event_publication_visible(p_event,p_submission,p_destination) THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 IF EXISTS(SELECT 1 FROM public.pb_event_reports WHERE event_id=p_event AND reporter_hash=reporter AND submission_id=p_submission AND destination=p_destination) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 IF (SELECT count(*) FROM public.pb_event_reports WHERE event_id=p_event)>=100 THEN RAISE EXCEPTION 'PB_EVENT_CAPACITY'; END IF;
 INSERT INTO public.pb_event_reports(event_id,submission_id,destination,reporter_hash,request_id,reason,detail) VALUES(p_event,p_submission,p_destination,reporter,p_request,p_reason,p_detail) RETURNING id INTO report_id;
 RETURN public.pb_event_report_receipt(report_id);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_report_list(p_actor uuid,p_event uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 12) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE entries jsonb; more boolean; cursor_id uuid;
BEGIN
 PERFORM public.pb_event_review_subject(p_actor,p_event); IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 12 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 WITH selected AS(SELECT *,row_number() OVER(ORDER BY id) n FROM public.pb_event_reports WHERE event_id=p_event AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT p_limit+1)
 SELECT coalesce(jsonb_agg(public.pb_event_report_receipt(id)||jsonb_build_object('submissionId',submission_id,'destination',destination,'reason',reason,'detail',detail,'createdAt',public.pb_event_publication_instant(created_at)) ORDER BY id) FILTER(WHERE n<=p_limit),'[]'),count(*)>p_limit,(array_agg(id ORDER BY id) FILTER(WHERE n<=p_limit))[p_limit] INTO entries,more,cursor_id FROM selected;
 RETURN jsonb_build_object('version',1,'eventId',p_event,'entries',entries,'nextCursor',CASE WHEN more THEN cursor_id ELSE NULL END);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_publication_report(p_actor uuid,p_event uuid,p_destination text,p_submission uuid,p_request uuid,p_reason text,p_detail text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE prior public.pb_event_reports; reporter text; report_id uuid;
BEGIN
 PERFORM public.pb_event_require_service(); PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE; PERFORM public.pb_event_review_subject(p_actor,p_event);
 IF p_destination IS NULL OR p_destination NOT IN ('gallery','wall') OR p_request IS NULL OR p_reason IS NULL OR p_reason NOT IN ('privacy','inappropriate','other') OR p_detail IS NULL OR length(p_detail)>500 OR p_detail ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 reporter=encode(sha256(convert_to('actor-report:'||p_actor::text,'UTF8')),'hex');
 SELECT * INTO prior FROM public.pb_event_reports WHERE event_id=p_event AND reporter_hash=reporter AND request_id=p_request;
 IF FOUND THEN IF (prior.submission_id,prior.destination,prior.reason,prior.detail) IS DISTINCT FROM (p_submission,p_destination,p_reason,p_detail) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF; RETURN public.pb_event_report_receipt(prior.id); END IF;
 IF public.pb_event_review_thumbnail(p_event,p_submission) IS NULL THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 IF EXISTS(SELECT 1 FROM public.pb_event_reports WHERE event_id=p_event AND reporter_hash=reporter AND submission_id=p_submission AND destination=p_destination) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 IF (SELECT count(*) FROM public.pb_event_reports WHERE event_id=p_event)>=100 THEN RAISE EXCEPTION 'PB_EVENT_CAPACITY'; END IF;
 INSERT INTO public.pb_event_reports(event_id,submission_id,destination,reporter_hash,request_id,reason,detail) VALUES(p_event,p_submission,p_destination,reporter,p_request,p_reason,p_detail) RETURNING id INTO report_id;
 RETURN public.pb_event_report_receipt(report_id);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_report_resolve(p_actor uuid,p_event uuid,p_report uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.pb_event_require_service(); PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE; PERFORM public.pb_event_review_subject(p_actor,p_event);
 UPDATE public.pb_event_reports SET status='resolved' WHERE id=p_report AND event_id=p_event; IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 RETURN public.pb_event_report_receipt(p_report);
END $$;

REVOKE ALL ON FUNCTION public.pb_event_manage_before_publication(uuid,uuid,text,jsonb),public.pb_event_consent_before_publication(uuid,text,uuid,jsonb),public.pb_event_sweep_before_publication(integer) FROM PUBLIC,anon,authenticated,service_role;
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND (proname LIKE 'pb_event_publication_%' OR proname LIKE 'pb_event_audience_%' OR proname LIKE 'pb_event_report_%') LOOP EXECUTE 'REVOKE ALL ON FUNCTION '||f||' FROM PUBLIC,anon,authenticated,service_role'; END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.pb_event_manage(uuid,uuid,text,jsonb),public.pb_event_consent(uuid,text,uuid,jsonb),public.pb_event_sweep(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pb_event_manage(uuid,uuid,text,jsonb),public.pb_event_consent(uuid,text,uuid,jsonb),public.pb_event_sweep(integer),public.pb_event_publication_capabilities(),public.pb_event_audience_session(uuid,text,text),public.pb_event_audience_list(uuid,text,text,uuid,uuid,integer),public.pb_event_audience_validate(uuid,text,text,uuid,uuid[]),public.pb_event_audience_access(uuid,text,text,uuid,uuid,text),public.pb_event_audience_report(uuid,text,text,uuid,uuid,uuid,text,text),public.pb_event_publication_list(uuid,uuid,uuid,integer),public.pb_event_publication_decide(uuid,uuid,uuid,text,bigint,text,uuid),public.pb_event_report_list(uuid,uuid,uuid,integer),public.pb_event_report_resolve(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pb_event_publication_remove(uuid,uuid,uuid,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.pb_event_publication_report(uuid,uuid,text,uuid,uuid,text,text) TO service_role;
COMMIT;
