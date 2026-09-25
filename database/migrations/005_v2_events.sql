BEGIN;

CREATE TABLE IF NOT EXISTS public.pb_event_configuration (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), deployment_bytes bigint NOT NULL DEFAULT 0 CHECK(deployment_bytes>=0)
);
INSERT INTO public.pb_event_configuration(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.pb_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES auth.users,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 100), timezone text NOT NULL, creation_fingerprint jsonb NOT NULL,
  starts_at timestamptz NOT NULL, contribution_closes_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','paused','closed','deleted')),
  closed_at timestamptz, first_accepted_at timestamptz, max_guests integer NOT NULL CHECK(max_guests BETWEEN 1 AND 25),
  max_contributions integer NOT NULL CHECK(max_contributions BETWEEN 1 AND 100), max_bytes bigint NOT NULL CHECK(max_bytes BETWEEN 4100000 AND 250000000),
  allocation_released boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), maintained_at timestamptz NOT NULL DEFAULT '-infinity',
  CHECK(starts_at<contribution_closes_at AND contribution_closes_at<=expires_at)
);
CREATE INDEX IF NOT EXISTS pb_event_expiry ON public.pb_events(status,expires_at);
CREATE TABLE IF NOT EXISTS public.pb_event_members (
  event_id uuid NOT NULL REFERENCES public.pb_events, user_id uuid NOT NULL REFERENCES auth.users,
  role text NOT NULL CHECK(role IN ('owner','moderator')), status text NOT NULL CHECK(status IN ('invited','active','revoked')),
  PRIMARY KEY(event_id,user_id)
);
CREATE TABLE IF NOT EXISTS public.pb_event_guests (
  id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES public.pb_events, revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(event_id,id)
);
CREATE TABLE IF NOT EXISTS public.pb_event_invites (
  hash text PRIMARY KEY CHECK(hash ~ '^[a-f0-9]{64}$'), event_id uuid NOT NULL REFERENCES public.pb_events,
  expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS public.pb_event_submissions (
  id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES public.pb_events, guest_id uuid NOT NULL,
  request_id uuid NOT NULL, request_fingerprint jsonb NOT NULL, state text NOT NULL CHECK(state IN ('reserved','uploading','finalising','ready','failed','expired','deleted')),
  logical_expires_at timestamptz NOT NULL, promised_expires_at timestamptz NOT NULL,
  staging_path text NOT NULL UNIQUE, delivery_path text NOT NULL UNIQUE, thumbnail_path text NOT NULL UNIQUE,
  staging_held_bytes bigint NOT NULL DEFAULT 2000000 CHECK(staging_held_bytes BETWEEN 0 AND 2000000),
  derivative_held_bytes bigint NOT NULL DEFAULT 2100000 CHECK(derivative_held_bytes BETWEEN 0 AND 2100000),
  gallery_state text NOT NULL DEFAULT 'private' CHECK(gallery_state IN ('private','awaiting_approval','approved','hidden','rejected')),
  wall_state text NOT NULL DEFAULT 'private' CHECK(wall_state IN ('private','awaiting_approval','approved','hidden','rejected')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(event_id,id), UNIQUE(event_id,guest_id,request_id),
  FOREIGN KEY(event_id,guest_id) REFERENCES public.pb_event_guests(event_id,id)
);
CREATE INDEX IF NOT EXISTS pb_event_submission_state ON public.pb_event_submissions(event_id,state,created_at,id);
CREATE TABLE IF NOT EXISTS public.pb_event_publication_grants (
  event_id uuid NOT NULL, submission_id uuid NOT NULL, guest_id uuid NOT NULL,
  submission_consent boolean NOT NULL DEFAULT false, gallery_consent boolean NOT NULL DEFAULT false, wall_consent boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(submission_id,guest_id),
  FOREIGN KEY(event_id,submission_id) REFERENCES public.pb_event_submissions(event_id,id), FOREIGN KEY(event_id,guest_id) REFERENCES public.pb_event_guests(event_id,id)
);
CREATE TABLE IF NOT EXISTS public.pb_event_upload_intents (
  submission_id uuid PRIMARY KEY REFERENCES public.pb_event_submissions, generation integer NOT NULL DEFAULT 0 CHECK(generation BETWEEN 0 AND 8),
  mint_before timestamptz, authorisation_until timestamptz, cleanup_after timestamptz NOT NULL,
  staging_deleted boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS public.pb_event_tokens (
  hash text PRIMARY KEY CHECK(hash ~ '^[a-f0-9]{64}$'), event_id uuid NOT NULL REFERENCES public.pb_events,
  guest_id uuid, submission_id uuid, kind text NOT NULL CHECK(kind IN ('contribute','receipt','gallery','display')),
  expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false,
  FOREIGN KEY(event_id,guest_id) REFERENCES public.pb_event_guests(event_id,id), FOREIGN KEY(event_id,submission_id) REFERENCES public.pb_event_submissions(event_id,id),
  CHECK((kind='contribute' AND guest_id IS NOT NULL AND submission_id IS NULL) OR (kind='receipt' AND guest_id IS NOT NULL AND submission_id IS NOT NULL) OR (kind IN ('gallery','display') AND submission_id IS NULL))
);
CREATE INDEX IF NOT EXISTS pb_event_tokens_subject ON public.pb_event_tokens(event_id,guest_id,submission_id);
CREATE TABLE IF NOT EXISTS public.pb_event_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES public.pb_events, submission_id uuid NOT NULL REFERENCES public.pb_event_submissions,
  kind text NOT NULL CHECK(kind IN ('finalise','delete_delivery','delete_staging')),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','retry','complete','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8), lease_token uuid, lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(), checkpoint jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(checkpoint)='object' AND octet_length(checkpoint::text)<=8192),
  error_code text CHECK(error_code ~ '^[a-z_]{1,40}$'), UNIQUE(submission_id,kind)
);
CREATE INDEX IF NOT EXISTS pb_event_jobs_ready ON public.pb_event_jobs(status,available_at,lease_until);

CREATE OR REPLACE FUNCTION public.pb_event_require_service() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN IF coalesce(auth.role(),'')<>'service_role' THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.pb_event_require_actor(p_event uuid,p_actor uuid,p_owner_only boolean DEFAULT true) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.pb_event_require_service();
  IF p_actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.pb_event_members WHERE event_id=p_event AND user_id=p_actor AND status='active' AND (NOT p_owner_only OR role='owner')) THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE budget bigint; allocated bigint; buckets_ready boolean=false;
BEGIN
  PERFORM public.pb_event_require_service(); SELECT deployment_bytes INTO budget FROM public.pb_event_configuration WHERE singleton;
  SELECT coalesce(sum(max_bytes),0) INTO allocated FROM public.pb_events WHERE NOT allocation_released;
  IF to_regclass('storage.buckets') IS NOT NULL THEN SELECT count(*)=2 INTO buckets_ready FROM storage.buckets WHERE id IN ('photobooth-events-v2','photobooth-event-images-staging-v2') AND NOT public AND file_size_limit=2000000 AND allowed_mime_types=ARRAY['image/jpeg','image/png','image/webp']; END IF;
  RETURN jsonb_build_object('version',1,'ready',budget>0 AND buckets_ready,'deploymentBytes',budget,'allocatedBytes',allocated,'limits',jsonb_build_object('guests',25,'contributions',100,'eventBytes',250000000,'imageBytes',2000000,'thumbnailBytes',100000,'derivativeBytes',2100000,'logicalSeconds',600,'uploadSeconds',7200,'cleanupMarginSeconds',300,'issueSeconds',60,'readSeconds',300,'jobBatch',10,'leaseSeconds',120));
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_configure(p_bytes bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.pb_event_require_service(); PERFORM 1 FROM public.pb_event_configuration WHERE singleton FOR UPDATE;
  IF p_bytes IS NULL OR p_bytes<0 OR p_bytes>9007199254740991 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  IF p_bytes<(SELECT coalesce(sum(max_bytes),0) FROM public.pb_events WHERE NOT allocation_released) THEN RAISE EXCEPTION 'PB_EVENT_CAPACITY'; END IF;
  UPDATE public.pb_event_configuration SET deployment_bytes=p_bytes WHERE singleton; RETURN public.pb_event_capabilities();
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_create(p_actor uuid,p_event uuid,p_body jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events; budget bigint; fingerprint jsonb;
BEGIN
  PERFORM public.pb_event_require_service();
  IF p_actor IS NULL OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_actor) OR p_event IS NULL OR jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR (p_body-ARRAY['title','timezone','startsAt','closesAt','expiresAt','maxGuests','maxContributions','maxBytes'])<>'{}'::jsonb THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  SELECT deployment_bytes INTO budget FROM public.pb_event_configuration WHERE singleton FOR UPDATE;
  IF budget<=0 OR public.pb_event_capabilities()->'ready' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=p_body->>'timezone') OR length(btrim(p_body->>'title')) NOT BETWEEN 1 AND 100 OR (p_body->>'expiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  fingerprint=jsonb_build_object('title',btrim(p_body->>'title'),'timezone',p_body->>'timezone','startsAt',extract(epoch FROM (p_body->>'startsAt')::timestamptz),'closesAt',extract(epoch FROM (p_body->>'closesAt')::timestamptz),'expiresAt',extract(epoch FROM (p_body->>'expiresAt')::timestamptz),'maxGuests',(p_body->>'maxGuests')::integer,'maxContributions',(p_body->>'maxContributions')::integer,'maxBytes',(p_body->>'maxBytes')::bigint);
  SELECT * INTO e FROM public.pb_events WHERE id=p_event;
  IF FOUND THEN
    IF e.owner_id<>p_actor THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
    IF e.status='deleted' OR e.expires_at<=clock_timestamp() OR e.creation_fingerprint IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
    RETURN to_jsonb(e);
  END IF;
  IF (SELECT coalesce(sum(max_bytes),0) FROM public.pb_events WHERE NOT allocation_released)+(p_body->>'maxBytes')::bigint>budget THEN RAISE EXCEPTION 'PB_EVENT_CAPACITY'; END IF;
  INSERT INTO public.pb_events(id,owner_id,title,timezone,creation_fingerprint,starts_at,contribution_closes_at,expires_at,max_guests,max_contributions,max_bytes)
  VALUES(p_event,p_actor,btrim(p_body->>'title'),p_body->>'timezone',fingerprint,(p_body->>'startsAt')::timestamptz,(p_body->>'closesAt')::timestamptz,(p_body->>'expiresAt')::timestamptz,(p_body->>'maxGuests')::integer,(p_body->>'maxContributions')::integer,(p_body->>'maxBytes')::bigint) RETURNING * INTO e;
  INSERT INTO public.pb_event_members VALUES(p_event,p_actor,'owner','active'); RETURN to_jsonb(e);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_token(p_event uuid,p_hash text,p_kind text,p_submission uuid DEFAULT NULL) RETURNS public.pb_event_tokens LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.pb_event_tokens;
BEGIN
  PERFORM public.pb_event_require_service(); SELECT * INTO t FROM public.pb_event_tokens WHERE hash=p_hash AND event_id=p_event AND kind=p_kind AND NOT revoked AND expires_at>clock_timestamp();
  IF NOT FOUND OR (p_kind='receipt' AND t.submission_id IS DISTINCT FROM p_submission) OR EXISTS(SELECT 1 FROM public.pb_event_guests WHERE id=t.guest_id AND revoked) OR NOT EXISTS(SELECT 1 FROM public.pb_events WHERE id=p_event AND status<>'deleted' AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  RETURN t;
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_receipt_json(p_submission uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
SELECT jsonb_build_object('submissionId',s.id,'state',CASE WHEN s.state NOT IN ('deleted','failed','expired') AND (s.promised_expires_at<=clock_timestamp() OR (s.state IN ('reserved','uploading','finalising') AND least(s.logical_expires_at,coalesce(e.closed_at+interval '10 minutes',s.logical_expires_at))<=clock_timestamp())) THEN 'expired' ELSE s.state END,'logicalExpiresAt',s.logical_expires_at,'eventExpiresAt',s.promised_expires_at,'gallery',s.gallery_state,'wall',s.wall_state) FROM public.pb_event_submissions s JOIN public.pb_events e ON e.id=s.event_id WHERE s.id=p_submission
$$;
CREATE OR REPLACE FUNCTION public.pb_event_queue_cleanup(p_submission uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.pb_event_submissions; u public.pb_event_upload_intents;
BEGIN
  SELECT * INTO s FROM public.pb_event_submissions WHERE id=p_submission; SELECT * INTO u FROM public.pb_event_upload_intents WHERE submission_id=p_submission;
  IF s.derivative_held_bytes>0 THEN INSERT INTO public.pb_event_jobs(event_id,submission_id,kind) VALUES(s.event_id,s.id,'delete_delivery') ON CONFLICT DO NOTHING; END IF;
  IF s.staging_held_bytes>0 THEN INSERT INTO public.pb_event_jobs(event_id,submission_id,kind,available_at) VALUES(s.event_id,s.id,'delete_staging',u.cleanup_after) ON CONFLICT(submission_id,kind) DO UPDATE SET available_at=greatest(pb_event_jobs.available_at,excluded.available_at); END IF;
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_manage(p_actor uuid,p_event uuid,p_action text,p_body jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events; s public.pb_event_submissions; sub uuid; destination text;
BEGIN
  PERFORM public.pb_event_require_service();
  IF p_action NOT IN ('update','open','pause','close','delete','invite','rotate_invite','revoke_guest','invite_moderator','accept_moderator','revoke_moderator','publication','remove_submission','issue_read_token','revoke_token') OR p_action IS NULL OR jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR octet_length(p_body::text)>8192 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  IF p_action='update' THEN PERFORM 1 FROM public.pb_event_configuration WHERE singleton FOR UPDATE; END IF;
  SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  IF p_action='accept_moderator' THEN
    UPDATE public.pb_event_members SET status='active' WHERE event_id=p_event AND user_id=p_actor AND role='moderator' AND status='invited';
    IF NOT FOUND OR e.status='deleted' OR e.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF; RETURN jsonb_build_object('accepted',true);
  END IF;
  PERFORM public.pb_event_require_actor(p_event,p_actor,p_action NOT IN ('publication','remove_submission'));
  IF (e.status='deleted' OR e.expires_at<=clock_timestamp() OR e.allocation_released) AND p_action<>'delete' THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
  IF p_action='update' THEN
    IF (p_body-ARRAY['title','timezone','startsAt','closesAt','expiresAt','maxGuests','maxContributions','maxBytes'])<>'{}'::jsonb OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=p_body->>'timezone') THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
    IF e.first_accepted_at IS NOT NULL AND ((p_body->>'expiresAt')::timestamptz<e.expires_at OR (p_body->>'startsAt')::timestamptz<>e.starts_at OR p_body->>'timezone'<>e.timezone) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
    IF (SELECT coalesce(sum(max_bytes),0) FROM public.pb_events WHERE NOT allocation_released AND id<>e.id)+(p_body->>'maxBytes')::bigint>(SELECT deployment_bytes FROM public.pb_event_configuration WHERE singleton)
      OR (p_body->>'maxBytes')::bigint<(SELECT coalesce(sum(staging_held_bytes+derivative_held_bytes),0) FROM public.pb_event_submissions WHERE event_id=e.id)
      OR (p_body->>'maxGuests')::integer<(SELECT count(*) FROM public.pb_event_guests WHERE event_id=e.id)
      OR (p_body->>'maxContributions')::integer<(SELECT count(*) FROM public.pb_event_submissions WHERE event_id=e.id AND (state IN ('reserved','uploading','finalising','ready') OR staging_held_bytes+derivative_held_bytes>0)) THEN RAISE EXCEPTION 'PB_EVENT_CAPACITY'; END IF;
    UPDATE public.pb_events SET title=p_body->>'title',timezone=p_body->>'timezone',starts_at=(p_body->>'startsAt')::timestamptz,contribution_closes_at=(p_body->>'closesAt')::timestamptz,expires_at=(p_body->>'expiresAt')::timestamptz,max_guests=(p_body->>'maxGuests')::integer,max_contributions=(p_body->>'maxContributions')::integer,max_bytes=(p_body->>'maxBytes')::bigint WHERE id=e.id;
    IF (p_body->>'expiresAt')::timestamptz>e.expires_at THEN
      UPDATE public.pb_event_submissions SET promised_expires_at=(p_body->>'expiresAt')::timestamptz WHERE event_id=e.id;
      UPDATE public.pb_event_tokens SET expires_at=(p_body->>'expiresAt')::timestamptz WHERE event_id=e.id AND expires_at=e.expires_at;
    END IF;
  ELSIF p_action IN ('open','pause','close','delete') THEN
    IF p_action='open' AND (e.status NOT IN ('draft','paused') OR e.expires_at<=clock_timestamp() OR e.contribution_closes_at<=clock_timestamp()) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
    IF p_action='pause' AND e.status<>'open' THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
    UPDATE public.pb_events SET status=CASE p_action WHEN 'pause' THEN 'paused' WHEN 'close' THEN 'closed' WHEN 'delete' THEN 'deleted' ELSE 'open' END,closed_at=CASE WHEN p_action IN ('pause','close','delete') THEN coalesce(closed_at,clock_timestamp()) ELSE NULL END WHERE id=e.id;
    IF p_action='delete' THEN UPDATE public.pb_event_tokens SET revoked=true WHERE event_id=e.id; FOR sub IN UPDATE public.pb_event_submissions SET state='deleted' WHERE event_id=e.id RETURNING id LOOP PERFORM public.pb_event_queue_cleanup(sub); END LOOP; END IF;
  ELSIF p_action IN ('invite','rotate_invite') THEN
    IF p_action='rotate_invite' THEN UPDATE public.pb_event_invites SET revoked=true WHERE event_id=e.id; END IF;
    INSERT INTO public.pb_event_invites(hash,event_id,expires_at) VALUES(p_body->>'hash',e.id,least((p_body->>'expiresAt')::timestamptz,e.contribution_closes_at));
  ELSIF p_action='revoke_guest' THEN
    UPDATE public.pb_event_guests SET revoked=true WHERE event_id=e.id AND id=(p_body->>'guestId')::uuid; IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
    UPDATE public.pb_event_tokens SET revoked=true WHERE event_id=e.id AND guest_id=(p_body->>'guestId')::uuid;
    FOR sub IN UPDATE public.pb_event_submissions SET state='deleted' WHERE event_id=e.id AND id IN(SELECT submission_id FROM public.pb_event_publication_grants WHERE guest_id=(p_body->>'guestId')::uuid) RETURNING id LOOP PERFORM public.pb_event_queue_cleanup(sub); END LOOP;
  ELSIF p_action IN ('invite_moderator','revoke_moderator') THEN
    IF (p_body->>'userId')::uuid=e.owner_id THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
    INSERT INTO public.pb_event_members VALUES(e.id,(p_body->>'userId')::uuid,'moderator',CASE WHEN p_action='invite_moderator' THEN 'invited' ELSE 'revoked' END) ON CONFLICT(event_id,user_id) DO UPDATE SET status=excluded.status;
  ELSIF p_action='issue_read_token' THEN
    IF p_body->>'kind' NOT IN ('gallery','display') OR p_body->>'kind' IS NULL OR (p_body->>'expiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
    INSERT INTO public.pb_event_tokens(hash,event_id,kind,expires_at) VALUES(p_body->>'hash',e.id,p_body->>'kind',least((p_body->>'expiresAt')::timestamptz,e.expires_at));
  ELSIF p_action='revoke_token' THEN UPDATE public.pb_event_tokens SET revoked=true WHERE event_id=e.id AND hash=p_body->>'hash';
  ELSE
    SELECT * INTO s FROM public.pb_event_submissions WHERE id=(p_body->>'submissionId')::uuid AND event_id=e.id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
    IF p_action='remove_submission' THEN UPDATE public.pb_event_submissions SET state='deleted' WHERE id=s.id; PERFORM public.pb_event_queue_cleanup(s.id);
    ELSE
      destination=p_body->>'destination'; IF destination NOT IN ('gallery','wall') OR p_body->>'state' NOT IN ('approved','hidden','rejected') THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
      IF p_body->>'state'='approved' AND (s.state<>'ready' OR EXISTS(SELECT 1 FROM public.pb_event_publication_grants g JOIN public.pb_event_guests v ON v.id=g.guest_id WHERE g.submission_id=s.id AND (v.revoked OR NOT g.submission_consent OR NOT CASE WHEN destination='gallery' THEN g.gallery_consent ELSE g.wall_consent END))) THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
      UPDATE public.pb_event_submissions SET gallery_state=CASE WHEN destination='gallery' THEN p_body->>'state' ELSE gallery_state END,wall_state=CASE WHEN destination='wall' THEN p_body->>'state' ELSE wall_state END WHERE id=s.id;
    END IF;
  END IF;
  SELECT * INTO e FROM public.pb_events WHERE id=p_event; RETURN to_jsonb(e);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_redeem(p_event uuid,p_invite_hash text,p_guest uuid,p_contribute_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events;
BEGIN
  PERFORM public.pb_event_require_service(); SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE;
  IF NOT FOUND OR e.status<>'open' OR clock_timestamp()<e.starts_at OR clock_timestamp()>=e.contribution_closes_at OR NOT EXISTS(SELECT 1 FROM public.pb_event_invites WHERE hash=p_invite_hash AND event_id=e.id AND NOT revoked AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.pb_event_tokens WHERE hash=p_contribute_hash AND event_id=e.id AND guest_id=p_guest AND kind='contribute' AND NOT revoked) THEN RETURN jsonb_build_object('guestId',p_guest); END IF;
  IF (SELECT count(*) FROM public.pb_event_guests WHERE event_id=e.id)>=e.max_guests THEN RAISE EXCEPTION 'PB_EVENT_CAPACITY'; END IF;
  INSERT INTO public.pb_event_guests(id,event_id) VALUES(p_guest,e.id); INSERT INTO public.pb_event_tokens(hash,event_id,guest_id,kind,expires_at) VALUES(p_contribute_hash,e.id,p_guest,'contribute',e.expires_at);
  RETURN jsonb_build_object('guestId',p_guest);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_reserve(p_event uuid,p_token text,p_submission uuid,p_request uuid,p_receipt_hash text,p_contributors uuid[],p_consent jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events; t public.pb_event_tokens; s public.pb_event_submissions; guest uuid;
BEGIN
  PERFORM public.pb_event_require_service(); SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE; t=public.pb_event_token(p_event,p_token,'contribute');
  IF p_request IS NULL OR p_submission IS NULL OR p_contributors IS NULL OR cardinality(p_contributors) NOT BETWEEN 1 AND 4 OR NOT t.guest_id=ANY(p_contributors) OR cardinality(p_contributors)<>(SELECT count(DISTINCT x) FROM unnest(p_contributors) x) OR p_consent IS NULL OR (p_consent-ARRAY['submission','gallery','wall'])<>'{}'::jsonb OR p_consent->'submission' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(p_consent->'gallery') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_consent->'wall') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  SELECT * INTO s FROM public.pb_event_submissions WHERE event_id=e.id AND guest_id=t.guest_id AND request_id=p_request;
  IF FOUND THEN
    IF s.id<>p_submission OR s.request_fingerprint<>jsonb_build_object('consent',p_consent,'contributors',(SELECT array_agg(x ORDER BY x) FROM unnest(p_contributors) x)) OR NOT EXISTS(SELECT 1 FROM public.pb_event_tokens WHERE hash=p_receipt_hash AND submission_id=s.id AND kind='receipt') THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
  ELSE
    IF e.status<>'open' OR clock_timestamp()<e.starts_at OR clock_timestamp()>=e.contribution_closes_at THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
    IF (SELECT count(*) FROM public.pb_event_submissions WHERE event_id=e.id AND (state IN ('reserved','uploading','finalising','ready') OR staging_held_bytes+derivative_held_bytes>0))>=e.max_contributions OR (SELECT coalesce(sum(staging_held_bytes+derivative_held_bytes),0) FROM public.pb_event_submissions WHERE event_id=e.id)+4100000>e.max_bytes THEN RAISE EXCEPTION 'PB_EVENT_CAPACITY'; END IF;
    IF (SELECT count(*) FROM public.pb_event_guests WHERE event_id=e.id AND id=ANY(p_contributors) AND NOT revoked)<>cardinality(p_contributors) THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
    INSERT INTO public.pb_event_submissions(id,event_id,guest_id,request_id,request_fingerprint,state,logical_expires_at,promised_expires_at,staging_path,delivery_path,thumbnail_path)
    VALUES(p_submission,e.id,t.guest_id,p_request,jsonb_build_object('consent',p_consent,'contributors',(SELECT array_agg(x ORDER BY x) FROM unnest(p_contributors) x)),'reserved',least(clock_timestamp()+interval '10 minutes',e.expires_at),e.expires_at,e.id||'/'||p_submission||'/source',e.id||'/'||p_submission||'/image',e.id||'/'||p_submission||'/thumbnail') RETURNING * INTO s;
    INSERT INTO public.pb_event_upload_intents(submission_id,cleanup_after) VALUES(s.id,clock_timestamp());
    FOREACH guest IN ARRAY p_contributors LOOP INSERT INTO public.pb_event_publication_grants(event_id,submission_id,guest_id,submission_consent,gallery_consent,wall_consent) VALUES(e.id,s.id,guest,guest=t.guest_id,guest=t.guest_id AND (p_consent->>'gallery')::boolean,guest=t.guest_id AND (p_consent->>'wall')::boolean); END LOOP;
    INSERT INTO public.pb_event_tokens(hash,event_id,guest_id,submission_id,kind,expires_at) VALUES(p_receipt_hash,e.id,t.guest_id,s.id,'receipt',e.expires_at);
    UPDATE public.pb_events SET first_accepted_at=coalesce(first_accepted_at,clock_timestamp()) WHERE id=e.id;
  END IF;
  RETURN public.pb_event_receipt_json(s.id)||jsonb_build_object('stagingPath',s.staging_path,'stagingHeldBytes',s.staging_held_bytes,'derivativeHeldBytes',s.derivative_held_bytes);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_authorise_upload(p_event uuid,p_token text,p_submission uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events; t public.pb_event_tokens; s public.pb_event_submissions; u public.pb_event_upload_intents; deadline timestamptz; mint_deadline timestamptz;
BEGIN
  PERFORM public.pb_event_require_service(); SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE; t=public.pb_event_token(p_event,p_token,'contribute');
  SELECT * INTO s FROM public.pb_event_submissions WHERE id=p_submission AND event_id=e.id AND guest_id=t.guest_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  deadline=least(s.logical_expires_at,coalesce(e.closed_at+interval '10 minutes',s.logical_expires_at),e.expires_at);
  IF s.state NOT IN ('reserved','uploading') OR clock_timestamp()>=deadline THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
  IF EXISTS(SELECT 1 FROM public.pb_event_publication_grants g JOIN public.pb_event_guests v ON v.id=g.guest_id WHERE g.submission_id=s.id AND (v.revoked OR NOT g.submission_consent)) THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  SELECT * INTO u FROM public.pb_event_upload_intents WHERE submission_id=s.id FOR UPDATE;
  IF u.generation>=8 OR u.staging_deleted THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
  mint_deadline=least(clock_timestamp()+interval '1 minute',deadline);
  UPDATE public.pb_event_upload_intents SET generation=generation+1,mint_before=mint_deadline,authorisation_until=mint_deadline+interval '2 hours',cleanup_after=mint_deadline+interval '125 minutes' WHERE submission_id=s.id RETURNING * INTO u;
  UPDATE public.pb_event_submissions SET state='uploading' WHERE id=s.id;
  RETURN jsonb_build_object('bucket','photobooth-event-images-staging-v2','path',s.staging_path,'generation',u.generation,'mintBefore',u.mint_before,'authorisationUntil',u.authorisation_until,'cleanupAfter',u.cleanup_after,'maxBytes',2000000,'overwrite',false);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_consent(p_event uuid,p_token text,p_submission uuid,p_consent jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.pb_event_tokens; s public.pb_event_submissions;
BEGIN
  PERFORM public.pb_event_require_service(); PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE; t=public.pb_event_token(p_event,p_token,'contribute');
  IF p_consent IS NULL OR (p_consent-ARRAY['submission','gallery','wall'])<>'{}'::jsonb OR jsonb_typeof(p_consent->'submission') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_consent->'gallery') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_consent->'wall') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  SELECT * INTO s FROM public.pb_event_submissions WHERE event_id=p_event AND id=p_submission FOR UPDATE;
  IF NOT FOUND OR s.state IN ('deleted','expired','failed') THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  UPDATE public.pb_event_publication_grants SET submission_consent=(p_consent->>'submission')::boolean,gallery_consent=(p_consent->>'gallery')::boolean,wall_consent=(p_consent->>'wall')::boolean,revision=revision+1,updated_at=clock_timestamp() WHERE submission_id=s.id AND guest_id=t.guest_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  IF p_consent->'submission'='false'::jsonb THEN UPDATE public.pb_event_submissions SET state='deleted',gallery_state='private',wall_state='private' WHERE id=s.id; PERFORM public.pb_event_queue_cleanup(s.id);
  ELSE UPDATE public.pb_event_submissions SET gallery_state=CASE WHEN p_consent->'gallery'='false'::jsonb THEN 'private' ELSE gallery_state END,wall_state=CASE WHEN p_consent->'wall'='false'::jsonb THEN 'private' ELSE wall_state END WHERE id=s.id; END IF;
  RETURN public.pb_event_receipt_json(s.id);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_receipt(p_event uuid,p_token text,p_submission uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_event_token(p_event,p_token,'receipt',p_submission); RETURN public.pb_event_receipt_json(p_submission); END $$;
CREATE OR REPLACE FUNCTION public.pb_event_read_access(p_event uuid,p_token text,p_submission uuid,p_destination text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.pb_event_submissions;
BEGIN
  PERFORM public.pb_event_require_service(); PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE;
  IF p_destination NOT IN ('receipt','gallery','wall') OR p_destination IS NULL THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  PERFORM public.pb_event_token(p_event,p_token,CASE p_destination WHEN 'wall' THEN 'display' ELSE p_destination END,p_submission);
  SELECT * INTO s FROM public.pb_event_submissions WHERE id=p_submission AND event_id=p_event;
  IF NOT FOUND OR s.state<>'ready' OR s.promised_expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM public.pb_event_publication_grants g JOIN public.pb_event_guests v ON v.id=g.guest_id WHERE g.submission_id=s.id AND (v.revoked OR NOT g.submission_consent OR (p_destination='gallery' AND NOT g.gallery_consent) OR (p_destination='wall' AND NOT g.wall_consent))) OR (p_destination='gallery' AND s.gallery_state<>'approved') OR (p_destination='wall' AND s.wall_state<>'approved') THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('bucket','photobooth-events-v2','path',s.delivery_path,'maxAgeSeconds',least(300,greatest(0,floor(extract(epoch FROM s.promised_expires_at-clock_timestamp())))));
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_enqueue_finalise(p_event uuid,p_token text,p_submission uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events; t public.pb_event_tokens; s public.pb_event_submissions;
BEGIN
  PERFORM public.pb_event_require_service(); SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE; t=public.pb_event_token(p_event,p_token,'contribute');
  SELECT * INTO s FROM public.pb_event_submissions WHERE event_id=e.id AND id=p_submission AND guest_id=t.guest_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  IF s.state='ready' THEN RETURN public.pb_event_receipt_json(s.id); END IF;
  IF s.state NOT IN ('uploading','finalising') OR clock_timestamp()>=least(s.logical_expires_at,coalesce(e.closed_at+interval '10 minutes',s.logical_expires_at),e.expires_at) THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
  IF EXISTS(SELECT 1 FROM public.pb_event_publication_grants g JOIN public.pb_event_guests v ON v.id=g.guest_id WHERE g.submission_id=s.id AND (v.revoked OR NOT g.submission_consent)) THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  INSERT INTO public.pb_event_jobs(event_id,submission_id,kind) VALUES(e.id,s.id,'finalise') ON CONFLICT DO NOTHING;
  UPDATE public.pb_event_submissions SET state='finalising' WHERE id=s.id; RETURN public.pb_event_receipt_json(s.id);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_claim_jobs(p_limit integer DEFAULT 10) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.pb_event_jobs; output jsonb='[]';
BEGIN
  PERFORM public.pb_event_require_service(); IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  FOR j IN SELECT candidate.* FROM public.pb_event_jobs candidate WHERE candidate.status IN ('queued','retry','running') AND candidate.attempts<8 AND candidate.available_at<=clock_timestamp() AND (candidate.lease_until IS NULL OR candidate.lease_until<=clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM public.pb_event_jobs active WHERE active.submission_id=candidate.submission_id AND active.id<>candidate.id AND active.status='running' AND active.lease_until>clock_timestamp())
    AND (candidate.kind='finalise' OR NOT EXISTS(SELECT 1 FROM public.pb_event_jobs pending WHERE pending.submission_id=candidate.submission_id AND pending.kind='finalise' AND pending.status IN ('queued','running','retry')))
    ORDER BY candidate.available_at,candidate.id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('pb-event-job:'||j.submission_id,0));
    IF EXISTS(SELECT 1 FROM public.pb_event_jobs WHERE submission_id=j.submission_id AND id<>j.id AND status='running' AND lease_until>clock_timestamp()) OR (j.kind<>'finalise' AND EXISTS(SELECT 1 FROM public.pb_event_jobs WHERE submission_id=j.submission_id AND kind='finalise' AND status IN ('queued','running','retry'))) THEN CONTINUE; END IF;
    UPDATE public.pb_event_jobs SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '120 seconds' WHERE id=j.id RETURNING * INTO j;
    output=output||jsonb_build_array(to_jsonb(j)); EXIT WHEN jsonb_array_length(output)>=p_limit;
  END LOOP;
  RETURN output;
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_checkpoint_job(p_job uuid,p_lease uuid,p_checkpoint jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.pb_event_jobs; e public.pb_events; s public.pb_event_submissions;
BEGIN
  PERFORM public.pb_event_require_service();
  IF p_checkpoint IS NULL OR jsonb_typeof(p_checkpoint)<>'object' OR octet_length(p_checkpoint::text)>8192 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  SELECT * INTO j FROM public.pb_event_jobs WHERE id=p_job; SELECT * INTO e FROM public.pb_events WHERE id=j.event_id FOR UPDATE;
  SELECT * INTO s FROM public.pb_event_submissions WHERE id=j.submission_id;
  IF j.kind='finalise' AND (e.status='deleted' OR s.state<>'finalising' OR clock_timestamp()>=least(e.expires_at,s.logical_expires_at,coalesce(e.closed_at+interval '10 minutes',s.logical_expires_at)) OR EXISTS(SELECT 1 FROM public.pb_event_publication_grants g JOIN public.pb_event_guests v ON v.id=g.guest_id WHERE g.submission_id=s.id AND (v.revoked OR NOT g.submission_consent))) THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
  UPDATE public.pb_event_jobs SET checkpoint=checkpoint||p_checkpoint,lease_until=clock_timestamp()+interval '120 seconds' WHERE id=p_job AND lease_token=p_lease AND status='running' AND lease_until>clock_timestamp() RETURNING * INTO j;
  IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_LEASE'; END IF; RETURN to_jsonb(j);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_dashboard(p_actor uuid,p_event uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 25) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events; items jsonb;
BEGIN
  PERFORM public.pb_event_require_actor(p_event,p_actor,false); IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  SELECT * INTO e FROM public.pb_events WHERE id=p_event;
  SELECT coalesce(jsonb_agg(public.pb_event_receipt_json(id)),'[]') INTO items FROM (SELECT id FROM public.pb_event_submissions WHERE event_id=p_event AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT p_limit) page;
  RETURN jsonb_build_object('event',to_jsonb(e),'submissions',items,'usage',(SELECT jsonb_build_object('guests',(SELECT count(*) FROM public.pb_event_guests WHERE event_id=p_event),'count',count(*) FILTER(WHERE state IN ('reserved','uploading','finalising','ready') OR staging_held_bytes+derivative_held_bytes>0),'bytes',coalesce(sum(staging_held_bytes+derivative_held_bytes),0),'stagingBytes',coalesce(sum(staging_held_bytes),0),'derivativeBytes',coalesce(sum(derivative_held_bytes),0)) FROM public.pb_event_submissions WHERE event_id=p_event));
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_finish_job(p_job uuid,p_lease uuid,p_outcome text,p_error text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.pb_event_jobs; e public.pb_events; s public.pb_event_submissions; u public.pb_event_upload_intents; image_size bigint; thumbnail_size bigint;
BEGIN
  PERFORM public.pb_event_require_service(); SELECT * INTO j FROM public.pb_event_jobs WHERE id=p_job;
  SELECT * INTO e FROM public.pb_events WHERE id=j.event_id FOR UPDATE; SELECT * INTO j FROM public.pb_event_jobs WHERE id=p_job FOR UPDATE;
  IF j.id IS NULL OR j.lease_token IS DISTINCT FROM p_lease OR j.status<>'running' OR j.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'PB_EVENT_LEASE'; END IF;
  IF p_outcome NOT IN ('complete','retry','failed') OR p_outcome IS NULL OR (p_error IS NOT NULL AND p_error !~ '^[a-z_]{1,40}$') THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  SELECT * INTO s FROM public.pb_event_submissions WHERE id=j.submission_id FOR UPDATE; SELECT * INTO u FROM public.pb_event_upload_intents WHERE submission_id=s.id;
  IF p_outcome='complete' THEN
    IF j.kind='finalise' THEN
      IF e.status='deleted' OR e.expires_at<=clock_timestamp() OR s.state<>'finalising' OR clock_timestamp()>=least(s.logical_expires_at,coalesce(e.closed_at+interval '10 minutes',s.logical_expires_at)) OR EXISTS(SELECT 1 FROM public.pb_event_publication_grants g JOIN public.pb_event_guests v ON v.id=g.guest_id WHERE g.submission_id=s.id AND (v.revoked OR NOT g.submission_consent)) THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
      IF j.checkpoint->'decoded' IS DISTINCT FROM 'true'::jsonb OR j.checkpoint->'objectsVerified' IS DISTINCT FROM 'true'::jsonb OR coalesce(j.checkpoint->>'sha256','') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
      IF coalesce(j.checkpoint->>'mime','') NOT IN ('image/png','image/jpeg','image/webp') OR coalesce((j.checkpoint->>'width')::integer,0) NOT BETWEEN 1 AND 4096 OR coalesce((j.checkpoint->>'height')::integer,0) NOT BETWEEN 1 AND 4096 OR (j.checkpoint->>'width')::bigint*(j.checkpoint->>'height')::bigint>12582912 THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
      SELECT (metadata->>'size')::bigint INTO image_size FROM storage.objects WHERE bucket_id='photobooth-events-v2' AND name=s.delivery_path;
      SELECT (metadata->>'size')::bigint INTO thumbnail_size FROM storage.objects WHERE bucket_id='photobooth-events-v2' AND name=s.thumbnail_path;
      IF image_size IS NULL OR image_size NOT BETWEEN 1 AND 2000000 OR thumbnail_size IS NULL OR thumbnail_size NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
      UPDATE public.pb_event_submissions SET state='ready',derivative_held_bytes=image_size+thumbnail_size,gallery_state=CASE WHEN NOT EXISTS(SELECT 1 FROM public.pb_event_publication_grants WHERE submission_id=s.id AND NOT gallery_consent) THEN 'awaiting_approval' ELSE 'private' END,wall_state=CASE WHEN NOT EXISTS(SELECT 1 FROM public.pb_event_publication_grants WHERE submission_id=s.id AND NOT wall_consent) THEN 'awaiting_approval' ELSE 'private' END WHERE id=s.id;
      INSERT INTO public.pb_event_jobs(event_id,submission_id,kind,available_at) VALUES(e.id,s.id,'delete_staging',u.cleanup_after) ON CONFLICT DO NOTHING;
    ELSE
      IF j.checkpoint->'deleted' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
      IF j.kind='delete_staging' THEN
        IF u.cleanup_after>clock_timestamp() OR EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='photobooth-event-images-staging-v2' AND name=s.staging_path) THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
        UPDATE public.pb_event_submissions SET staging_held_bytes=0 WHERE id=s.id; UPDATE public.pb_event_upload_intents SET staging_deleted=true WHERE submission_id=s.id;
      ELSE
        IF s.state NOT IN ('deleted','expired','failed') OR EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='photobooth-events-v2' AND name IN(s.delivery_path,s.thumbnail_path)) THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
        UPDATE public.pb_event_submissions SET derivative_held_bytes=0 WHERE id=s.id;
      END IF;
    END IF;
  END IF;
  UPDATE public.pb_event_jobs SET status=CASE WHEN p_outcome='retry' AND attempts>=8 THEN 'failed' ELSE p_outcome END,lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()+interval '60 seconds',error_code=p_error WHERE id=j.id RETURNING * INTO j;
  IF j.kind='finalise' AND j.status='failed' THEN UPDATE public.pb_event_submissions SET state=CASE WHEN state IN ('deleted','expired') THEN state ELSE 'failed' END WHERE id=s.id; PERFORM public.pb_event_queue_cleanup(s.id); END IF;
  RETURN to_jsonb(j);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_sweep(p_limit integer DEFAULT 25) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.pb_event_submissions; e public.pb_events; n integer=0;
BEGIN
  PERFORM public.pb_event_require_service(); IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  FOR e IN SELECT * FROM public.pb_events WHERE NOT allocation_released ORDER BY maintained_at,expires_at,id LIMIT 25 FOR UPDATE SKIP LOCKED LOOP
    UPDATE public.pb_events SET maintained_at=clock_timestamp() WHERE id=e.id;
    UPDATE public.pb_event_jobs j SET status='failed',lease_token=NULL,lease_until=NULL,error_code='expired' WHERE j.event_id=e.id AND j.kind='finalise' AND j.status IN ('queued','running','retry') AND (j.lease_until IS NULL OR j.lease_until<=clock_timestamp()) AND (j.attempts>=8 OR EXISTS(SELECT 1 FROM public.pb_event_submissions candidate WHERE candidate.id=j.submission_id AND candidate.state IN ('expired','deleted','failed')));
    FOR s IN SELECT candidate.* FROM public.pb_event_submissions candidate JOIN public.pb_event_jobs j ON j.submission_id=candidate.id AND j.kind='finalise' AND j.status='failed' WHERE candidate.event_id=e.id AND candidate.state='finalising' LIMIT p_limit-n FOR UPDATE OF candidate LOOP
      UPDATE public.pb_event_submissions SET state='failed' WHERE id=s.id; PERFORM public.pb_event_queue_cleanup(s.id); n=n+1;
    END LOOP;
    FOR s IN SELECT * FROM public.pb_event_submissions WHERE event_id=e.id AND state NOT IN ('expired','deleted','failed') AND (e.status='deleted' OR e.expires_at<=clock_timestamp() OR (state IN ('reserved','uploading','finalising') AND least(logical_expires_at,coalesce(e.closed_at+interval '10 minutes',logical_expires_at))<=clock_timestamp())) ORDER BY created_at,id LIMIT p_limit-n FOR UPDATE LOOP
      UPDATE public.pb_event_submissions SET state='expired' WHERE id=s.id;
      UPDATE public.pb_event_jobs SET status='failed',lease_token=NULL,lease_until=NULL,error_code='expired' WHERE submission_id=s.id AND kind='finalise' AND (lease_until IS NULL OR lease_until<=clock_timestamp());
      PERFORM public.pb_event_queue_cleanup(s.id); n=n+1;
    END LOOP;
    IF (e.status='deleted' OR e.expires_at<=clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM public.pb_event_submissions WHERE event_id=e.id AND staging_held_bytes+derivative_held_bytes>0) THEN UPDATE public.pb_events SET allocation_released=true WHERE id=e.id; END IF;
    EXIT WHEN n>=p_limit;
  END LOOP;
  RETURN jsonb_build_object('expired',n);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_object_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.pb_event_submissions; e public.pb_events; j public.pb_event_jobs; context jsonb;
BEGIN
  IF TG_OP='UPDATE' AND OLD.bucket_id IN ('photobooth-events-v2','photobooth-event-images-staging-v2') AND (NEW.bucket_id<>OLD.bucket_id OR NEW.name<>OLD.name) THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
  IF NEW.bucket_id<>'photobooth-events-v2' THEN RETURN NEW; END IF;
  SELECT * INTO s FROM public.pb_event_submissions WHERE NEW.name IN (delivery_path,thumbnail_path);
  SELECT * INTO e FROM public.pb_events WHERE id=s.event_id FOR UPDATE;
  SELECT * INTO j FROM public.pb_event_jobs WHERE submission_id=s.id AND kind='finalise' FOR UPDATE;
  SELECT * INTO s FROM public.pb_event_submissions WHERE id=s.id FOR UPDATE;
  context=to_jsonb(NEW)->'user_metadata';
  IF s.id IS NULL OR s.state<>'finalising' OR s.derivative_held_bytes<>2100000 OR e.status='deleted' OR j.status IS DISTINCT FROM 'running' OR j.lease_until<=clock_timestamp() OR j.lease_token IS NULL
    OR context->>'eventJobId' IS DISTINCT FROM j.id::text OR context->>'eventLease' IS DISTINCT FROM j.lease_token::text
    OR clock_timestamp()>=least(e.expires_at,s.logical_expires_at,coalesce(e.closed_at+interval '10 minutes',s.logical_expires_at))
    OR EXISTS(SELECT 1 FROM public.pb_event_publication_grants g JOIN public.pb_event_guests v ON v.id=g.guest_id WHERE g.submission_id=s.id AND (v.revoked OR NOT g.submission_consent)) THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pb_event_object_fence ON storage.objects;
CREATE TRIGGER pb_event_object_fence BEFORE INSERT OR UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION public.pb_event_object_fence();
DROP POLICY IF EXISTS pb_event_storage_boundary ON storage.objects;
CREATE POLICY pb_event_storage_boundary ON storage.objects AS RESTRICTIVE FOR ALL TO anon,authenticated USING(bucket_id NOT IN ('photobooth-events-v2','photobooth-event-images-staging-v2')) WITH CHECK(bucket_id NOT IN ('photobooth-events-v2','photobooth-event-images-staging-v2'));

DO $$ DECLARE t text; f record;
BEGIN
  FOREACH t IN ARRAY ARRAY['pb_event_configuration','pb_events','pb_event_members','pb_event_guests','pb_event_invites','pb_event_submissions','pb_event_publication_grants','pb_event_upload_intents','pb_event_tokens','pb_event_jobs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'pb_event_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature); END LOOP;
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES('photobooth-events-v2','photobooth-events-v2',false,2000000,ARRAY['image/jpeg','image/png','image/webp']),('photobooth-event-images-staging-v2','photobooth-event-images-staging-v2',false,2000000,ARRAY['image/jpeg','image/png','image/webp'])
    ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.pb_event_capabilities(),public.pb_event_configure(bigint),public.pb_event_create(uuid,uuid,jsonb),public.pb_event_manage(uuid,uuid,text,jsonb),public.pb_event_redeem(uuid,text,uuid,text),public.pb_event_reserve(uuid,text,uuid,uuid,text,uuid[],jsonb),public.pb_event_authorise_upload(uuid,text,uuid),public.pb_event_consent(uuid,text,uuid,jsonb),public.pb_event_receipt(uuid,text,uuid),public.pb_event_read_access(uuid,text,uuid,text),public.pb_event_enqueue_finalise(uuid,text,uuid),public.pb_event_claim_jobs(integer),public.pb_event_checkpoint_job(uuid,uuid,jsonb),public.pb_event_finish_job(uuid,uuid,text,text),public.pb_event_sweep(integer),public.pb_event_dashboard(uuid,uuid,uuid,integer) TO service_role;
COMMIT;
