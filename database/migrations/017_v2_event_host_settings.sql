BEGIN;

ALTER TABLE public.pb_events ADD COLUMN IF NOT EXISTS settings_revision integer NOT NULL DEFAULT 0 CHECK(settings_revision>=0);
ALTER TABLE public.pb_events ADD COLUMN IF NOT EXISTS look jsonb NOT NULL DEFAULT '{"version":1,"frameId":"film","filterId":"none","sceneId":null,"caption":"","showDate":false}';
CREATE INDEX IF NOT EXISTS pb_event_member_discovery ON public.pb_event_members(user_id,event_id) WHERE status IN ('active','invited');
CREATE TABLE IF NOT EXISTS public.pb_event_settings_requests (
  event_id uuid NOT NULL REFERENCES public.pb_events, request_id uuid NOT NULL, actor uuid NOT NULL REFERENCES auth.users,
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'), PRIMARY KEY(event_id,request_id)
);
ALTER TABLE public.pb_event_settings_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pb_event_settings_requests FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.pb_event_valid_look(p_look jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
SELECT coalesce(jsonb_typeof(p_look)='object' AND p_look ?& ARRAY['version','frameId','filterId','sceneId','caption','showDate']
  AND (p_look-ARRAY['version','frameId','filterId','sceneId','caption','showDate'])='{}'::jsonb
  AND p_look->'version'='1'::jsonb AND jsonb_typeof(p_look->'frameId')='string' AND p_look->>'frameId' IN ('film','noir','rose','butter','sage','sky','lavender')
  AND jsonb_typeof(p_look->'filterId')='string' AND p_look->>'filterId' IN ('none','bw','sepia','film','cool','glow')
  AND (p_look->'sceneId'='null'::jsonb OR jsonb_typeof(p_look->'sceneId')='string' AND p_look->>'sceneId' IN ('celebration-garden-v2','birthday-confetti-v2','midnight-disco-v2','graduation-atelier-v2','winter-celebration-v2','summer-festival-v2'))
  AND jsonb_typeof(p_look->'caption')='string' AND length(p_look->>'caption')<=160 AND p_look->>'caption' !~ U&'[\0001-\001F\007F-\009F]'
  AND jsonb_typeof(p_look->'showDate')='boolean',false)
$$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='pb_event_safe_look' AND conrelid='public.pb_events'::regclass) THEN
    ALTER TABLE public.pb_events ADD CONSTRAINT pb_event_safe_look CHECK(public.pb_event_valid_look(look));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_settings_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.look IS DISTINCT FROM OLD.look AND OLD.first_accepted_at IS NOT NULL THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
  IF ROW(NEW.title,NEW.timezone,NEW.starts_at,NEW.contribution_closes_at,NEW.expires_at,NEW.max_guests,NEW.max_contributions,NEW.max_bytes,NEW.look)
    IS DISTINCT FROM ROW(OLD.title,OLD.timezone,OLD.starts_at,OLD.contribution_closes_at,OLD.expires_at,OLD.max_guests,OLD.max_contributions,OLD.max_bytes,OLD.look) THEN
    IF OLD.settings_revision>=2147483646 THEN RAISE EXCEPTION 'PB_EVENT_CAPACITY'; END IF;
    NEW.settings_revision=OLD.settings_revision+1;
  ELSE NEW.settings_revision=OLD.settings_revision;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pb_event_settings_revision ON public.pb_events;
CREATE TRIGGER pb_event_settings_revision BEFORE UPDATE ON public.pb_events FOR EACH ROW EXECUTE FUNCTION public.pb_event_settings_revision();

CREATE OR REPLACE FUNCTION public.pb_event_host_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_event_require_service(); RETURN jsonb_build_object('version',1,'listLimit',25,'settingsReceipts',64,'captionCharacters',160); END $$;

CREATE OR REPLACE FUNCTION public.pb_event_host_list(p_actor uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 25) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE items jsonb; more boolean; cursor uuid;
BEGIN
  PERFORM public.pb_event_require_service();
  IF p_actor IS NULL OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_actor) THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  WITH page AS (
    SELECT e.id,e.title,e.timezone,e.starts_at,e.contribution_closes_at,e.expires_at,e.status,m.role,m.status AS membership
    FROM public.pb_events e JOIN public.pb_event_members m ON m.event_id=e.id
    WHERE m.user_id=p_actor AND ((m.role='owner' AND m.status='active') OR (m.role='moderator' AND m.status IN ('active','invited')))
      AND (p_after IS NULL OR e.id>p_after) ORDER BY e.id LIMIT p_limit+1
  ), numbered AS (SELECT *,row_number() OVER(ORDER BY id) AS n FROM page)
  SELECT coalesce(jsonb_agg(jsonb_build_object('eventId',id,'title',title,'timezone',timezone,'startsAt',starts_at,'closesAt',contribution_closes_at,'expiresAt',expires_at,'status',status,'role',role,'membership',membership) ORDER BY id) FILTER(WHERE n<=p_limit),'[]'::jsonb),count(*)>p_limit,(array_agg(id ORDER BY id) FILTER(WHERE n<=p_limit))[p_limit]
  INTO items,more,cursor FROM numbered;
  RETURN jsonb_build_object('version',1,'events',items,'nextCursor',CASE WHEN more THEN cursor ELSE NULL END);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_settings(p_actor uuid,p_event uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events;
BEGIN
  PERFORM public.pb_event_require_actor(p_event,p_actor,false);
  SELECT * INTO e FROM public.pb_events WHERE id=p_event;
  IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('version',1,'eventId',e.id,'revision',e.settings_revision,'locked',e.first_accepted_at IS NOT NULL OR e.status='deleted' OR e.expires_at<=clock_timestamp(),
    'event',jsonb_build_object('title',e.title,'timezone',e.timezone,'startsAt',e.starts_at,'closesAt',e.contribution_closes_at,'expiresAt',e.expires_at,'maxGuests',e.max_guests,'maxContributions',e.max_contributions,'maxBytes',e.max_bytes),'look',e.look);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_save_settings(p_actor uuid,p_event uuid,p_request uuid,p_revision integer,p_body jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events; prior public.pb_event_settings_requests; fingerprint text;
BEGIN
  PERFORM public.pb_event_require_actor(p_event,p_actor,true);
  IF p_request IS NULL OR p_revision IS NULL OR p_revision NOT BETWEEN 0 AND 2147483646 OR jsonb_typeof(p_body) IS DISTINCT FROM 'object'
    OR NOT p_body ?& ARRAY['event','look'] OR (p_body-ARRAY['event','look'])<>'{}'::jsonb OR octet_length(p_body::text)>8192 OR NOT public.pb_event_valid_look(p_body->'look') THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  -- Match the allocation lock order used by the existing settings update.
  PERFORM 1 FROM public.pb_event_configuration WHERE singleton FOR UPDATE;
  SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE;
  fingerprint=encode(sha256(convert_to(jsonb_build_object('revision',p_revision,'body',p_body)::text,'UTF8')),'hex');
  SELECT * INTO prior FROM public.pb_event_settings_requests WHERE event_id=p_event AND request_id=p_request;
  IF FOUND THEN
    IF prior.actor<>p_actor OR prior.fingerprint<>fingerprint THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
    RETURN public.pb_event_settings(p_actor,p_event);
  END IF;
  IF e.status='deleted' OR e.expires_at<=clock_timestamp() OR e.allocation_released THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
  IF e.settings_revision<>p_revision OR (e.first_accepted_at IS NOT NULL AND e.look IS DISTINCT FROM p_body->'look') THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
  IF (SELECT count(*) FROM public.pb_event_settings_requests WHERE event_id=p_event)>=64 THEN RAISE EXCEPTION 'PB_EVENT_CAPACITY'; END IF;
  PERFORM public.pb_event_manage(p_actor,p_event,'update',p_body->'event');
  UPDATE public.pb_events SET look=p_body->'look' WHERE id=p_event;
  INSERT INTO public.pb_event_settings_requests VALUES(p_event,p_request,p_actor,fingerprint);
  RETURN public.pb_event_settings(p_actor,p_event);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_guest_context(p_event uuid,p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events; available boolean;
BEGIN
  PERFORM public.pb_event_require_service(); SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR SHARE;
  PERFORM public.pb_event_token(p_event,p_token,'contribute');
  SELECT count(*) FILTER(WHERE state IN ('reserved','uploading','finalising','ready') OR staging_held_bytes+derivative_held_bytes>0)<e.max_contributions
    AND coalesce(sum(staging_held_bytes+derivative_held_bytes),0)+4100000<=e.max_bytes INTO available FROM public.pb_event_submissions WHERE event_id=p_event;
  RETURN jsonb_build_object('version',1,'eventId',e.id,'title',e.title,'timezone',e.timezone,'startsAt',e.starts_at,'closesAt',e.contribution_closes_at,'expiresAt',e.expires_at,'status',e.status,'look',e.look,'capacityAvailable',available,
    'canReserve',available AND e.status='open' AND clock_timestamp()>=e.starts_at AND clock_timestamp()<e.contribution_closes_at);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_revoke_capability(p_actor uuid,p_event uuid,p_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events;
BEGIN
  PERFORM public.pb_event_require_actor(p_event,p_actor,true);
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM public.pb_event_invites WHERE event_id=p_event AND hash=p_hash) AND NOT EXISTS(SELECT 1 FROM public.pb_event_tokens WHERE event_id=p_event AND hash=p_hash) THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  UPDATE public.pb_event_invites SET revoked=true WHERE event_id=p_event AND hash=p_hash;
  UPDATE public.pb_event_tokens SET revoked=true WHERE event_id=p_event AND hash=p_hash;
  RETURN to_jsonb(e);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_invite_moderator(p_actor uuid,p_event uuid,p_user uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events;
BEGIN
  PERFORM public.pb_event_require_actor(p_event,p_actor,true); SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE;
  IF p_user IS NULL OR p_user=e.owner_id OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_user) THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  IF e.status='deleted' OR e.expires_at<=clock_timestamp() OR e.allocation_released THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
  INSERT INTO public.pb_event_members VALUES(e.id,p_user,'moderator','invited') ON CONFLICT(event_id,user_id) DO UPDATE SET status=CASE WHEN pb_event_members.status='active' THEN 'active' ELSE 'invited' END;
  RETURN to_jsonb(e);
END $$;
REVOKE ALL ON FUNCTION public.pb_event_invite_moderator(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pb_event_invite_moderator(uuid,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.pb_event_revoke_capability(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pb_event_revoke_capability(uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.pb_event_guest_context(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pb_event_guest_context(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.pb_event_valid_look(jsonb),public.pb_event_settings_revision(),public.pb_event_host_capabilities(),public.pb_event_host_list(uuid,uuid,integer),public.pb_event_settings(uuid,uuid),public.pb_event_save_settings(uuid,uuid,uuid,integer,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pb_event_host_capabilities(),public.pb_event_host_list(uuid,uuid,integer),public.pb_event_settings(uuid,uuid),public.pb_event_save_settings(uuid,uuid,uuid,integer,jsonb) TO service_role;
COMMIT;
