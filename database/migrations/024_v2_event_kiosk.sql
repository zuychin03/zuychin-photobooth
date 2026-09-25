BEGIN;
CREATE TABLE IF NOT EXISTS public.pb_event_kiosks (
 id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES public.pb_events, owner_id uuid NOT NULL REFERENCES auth.users,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'), pin_hash text NOT NULL CHECK(pin_hash ~ '^[a-f0-9]{64}$'),
 generation integer NOT NULL DEFAULT 0 CHECK(generation BETWEEN 0 AND 10000), guest_id uuid REFERENCES public.pb_event_guests,
 revoked boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL, reset_request uuid,
 pin_window timestamptz NOT NULL DEFAULT clock_timestamp(), pin_attempts integer NOT NULL DEFAULT 0 CHECK(pin_attempts BETWEEN 0 AND 5),
 unlock_hash text CHECK(unlock_hash ~ '^[a-f0-9]{64}$'), unlock_until timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(event_id,id)
);
CREATE TABLE IF NOT EXISTS public.pb_event_kiosk_jobs (
 submission_id uuid PRIMARY KEY REFERENCES public.pb_event_submissions, event_id uuid NOT NULL, device_id uuid NOT NULL,
 generation integer NOT NULL CHECK(generation BETWEEN 0 AND 10000), guest_id uuid NOT NULL REFERENCES public.pb_event_guests,
 request_id uuid NOT NULL, contribution_hash text NOT NULL CHECK(contribution_hash ~ '^[a-f0-9]{64}$'),
 approval jsonb NOT NULL CHECK(jsonb_typeof(approval)='object' AND octet_length(approval::text)<=2048),
 FOREIGN KEY(event_id,device_id) REFERENCES public.pb_event_kiosks(event_id,id), UNIQUE(device_id,request_id)
);
ALTER TABLE public.pb_event_kiosks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pb_event_kiosk_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pb_event_kiosks,public.pb_event_kiosk_jobs FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.pb_event_kiosk_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_event_require_service(); RETURN '{"version":1,"activeDevices":2,"retainedDevices":8,"queueItems":8,"queueBytes":16000000,"imageBytes":2000000,"idleSeconds":120,"unlockSeconds":60,"pinAttempts":5,"pinWindowSeconds":900,"localSeconds":86400}'::jsonb; END $$;
CREATE OR REPLACE FUNCTION public.pb_event_kiosk_device(p_event uuid,p_token text,p_live boolean DEFAULT true) RETURNS public.pb_event_kiosks LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.pb_event_kiosks;
BEGIN
 PERFORM public.pb_event_require_service();
 SELECT * INTO d FROM public.pb_event_kiosks WHERE event_id=p_event AND token_hash=p_token FOR UPDATE;
 IF d.id IS NULL OR p_live AND (d.revoked OR d.expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM public.pb_events WHERE id=p_event AND status<>'deleted' AND expires_at>clock_timestamp())) THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
 RETURN d;
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_kiosk_json(p_device uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('version',1,'eventId',d.event_id,'deviceId',d.id,'generation',d.generation,'guestId',d.guest_id,'expiresAt',least(d.expires_at,e.expires_at),'enabled',NOT d.revoked AND d.expires_at>clock_timestamp() AND e.expires_at>clock_timestamp() AND e.status<>'deleted') FROM public.pb_event_kiosks d JOIN public.pb_events e ON e.id=d.event_id WHERE d.id=p_device
$$;
CREATE OR REPLACE FUNCTION public.pb_event_kiosk_create(p_actor uuid,p_event uuid,p_device uuid,p_token text,p_pin text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events; d public.pb_event_kiosks;
BEGIN
 PERFORM public.pb_event_require_actor(p_event,p_actor,true); SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE;
 IF e.status='deleted' OR e.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
 IF p_device IS NULL OR p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' OR p_pin IS NULL OR p_pin !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 SELECT * INTO d FROM public.pb_event_kiosks WHERE id=p_device;
 IF d.id IS NOT NULL THEN
  IF (d.event_id,d.owner_id,d.token_hash,d.pin_hash) IS DISTINCT FROM (p_event,p_actor,p_token,p_pin) OR d.revoked THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 ELSE
  IF (SELECT count(*) FROM public.pb_event_kiosks WHERE event_id=p_event)>=8 OR (SELECT count(*) FROM public.pb_event_kiosks WHERE event_id=p_event AND NOT revoked AND expires_at>clock_timestamp())>=2 THEN RAISE EXCEPTION 'PB_EVENT_CAPACITY'; END IF;
  INSERT INTO public.pb_event_kiosks(id,event_id,owner_id,token_hash,pin_hash,expires_at) VALUES(p_device,p_event,p_actor,p_token,p_pin,e.expires_at);
 END IF;
 RETURN public.pb_event_kiosk_json(p_device);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_kiosk_session(p_event uuid,p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.pb_event_kiosks; BEGIN d=public.pb_event_kiosk_device(p_event,p_token,false); RETURN public.pb_event_kiosk_json(d.id); END $$;
CREATE OR REPLACE FUNCTION public.pb_event_kiosk_unlock(p_event uuid,p_token text,p_pin text,p_unlock text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.pb_event_kiosks; until_at timestamptz;
BEGIN
 d=public.pb_event_kiosk_device(p_event,p_token,false);
 IF p_pin IS NULL OR p_pin !~ '^[a-f0-9]{64}$' OR p_unlock IS NULL OR p_unlock !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 IF d.pin_window+interval '15 minutes'<=clock_timestamp() THEN d.pin_window=clock_timestamp(); d.pin_attempts=0; END IF;
 IF d.pin_attempts>=5 THEN RETURN jsonb_build_object('allowed',false,'retryAfterSeconds',greatest(1,ceil(extract(epoch FROM d.pin_window+interval '15 minutes'-clock_timestamp()))),'unlockedUntil',NULL); END IF;
 UPDATE public.pb_event_kiosks SET pin_window=d.pin_window,pin_attempts=d.pin_attempts+1 WHERE id=d.id;
 IF d.pin_hash<>p_pin THEN RETURN jsonb_build_object('allowed',false,'retryAfterSeconds',CASE WHEN d.pin_attempts=4 THEN 900 ELSE 0 END,'unlockedUntil',NULL); END IF;
 until_at=clock_timestamp()+interval '60 seconds';
 UPDATE public.pb_event_kiosks SET unlock_hash=p_unlock,unlock_until=until_at WHERE id=d.id;
 RETURN jsonb_build_object('allowed',true,'retryAfterSeconds',0,'unlockedUntil',until_at);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_kiosk_operator(p_event uuid,p_token text,p_unlock text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.pb_event_kiosks; BEGIN d=public.pb_event_kiosk_device(p_event,p_token,false); IF d.unlock_hash IS DISTINCT FROM p_unlock OR d.unlock_until IS NULL OR d.unlock_until<=clock_timestamp() THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF; RETURN jsonb_build_object('deviceId',d.id,'unlockedUntil',d.unlock_until); END $$;
CREATE OR REPLACE FUNCTION public.pb_event_kiosk_reset(p_event uuid,p_token text,p_generation integer,p_request uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.pb_event_kiosks;
BEGIN
 d=public.pb_event_kiosk_device(p_event,p_token,false);
 IF p_request IS NULL OR p_generation IS NULL THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 IF d.reset_request=p_request AND d.generation=p_generation+1 THEN RETURN public.pb_event_kiosk_json(d.id); END IF;
 IF d.generation<>p_generation OR d.generation>=10000 THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 UPDATE public.pb_event_kiosks SET generation=generation+1,guest_id=NULL,reset_request=p_request,unlock_hash=NULL,unlock_until=NULL WHERE id=d.id;
 RETURN public.pb_event_kiosk_json(d.id);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_kiosk_begin(p_event uuid,p_token text,p_generation integer,p_guest uuid,p_contribution text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.pb_event_kiosks; e public.pb_events;
BEGIN
 PERFORM public.pb_event_require_service(); SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE;
 d=public.pb_event_kiosk_device(p_event,p_token);
 IF p_generation IS NULL OR p_guest IS NULL OR p_contribution IS NULL OR p_contribution !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 IF d.generation<>p_generation THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 IF d.guest_id IS NOT NULL THEN
  IF d.guest_id<>p_guest OR NOT EXISTS(SELECT 1 FROM public.pb_event_tokens WHERE hash=p_contribution AND guest_id=p_guest AND kind='contribute' AND NOT revoked) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 ELSE
  IF e.status<>'open' OR clock_timestamp()<e.starts_at OR clock_timestamp()>=e.contribution_closes_at THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
  IF (SELECT count(*) FROM public.pb_event_guests WHERE event_id=e.id)>=e.max_guests THEN RAISE EXCEPTION 'PB_EVENT_CAPACITY'; END IF;
  INSERT INTO public.pb_event_guests(id,event_id) VALUES(p_guest,e.id);
  INSERT INTO public.pb_event_tokens(hash,event_id,guest_id,kind,expires_at) VALUES(p_contribution,e.id,p_guest,'contribute',e.expires_at);
  UPDATE public.pb_event_kiosks SET guest_id=p_guest,unlock_hash=NULL,unlock_until=NULL WHERE id=d.id;
 END IF;
 RETURN public.pb_event_kiosk_json(d.id);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_kiosk_reserve(p_event uuid,p_token text,p_generation integer,p_guest uuid,p_contribution text,p_submission uuid,p_request uuid,p_receipt text,p_approval jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.pb_event_kiosks; prior public.pb_event_kiosk_jobs; result jsonb;
BEGIN
 PERFORM public.pb_event_require_service(); PERFORM pg_advisory_xact_lock(hashtextextended('pb-event-admission-v1',0)); PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE;
 d=public.pb_event_kiosk_device(p_event,p_token);
 IF d.generation IS DISTINCT FROM p_generation OR d.guest_id IS DISTINCT FROM p_guest OR p_guest IS NULL OR NOT EXISTS(SELECT 1 FROM public.pb_event_tokens WHERE hash=p_contribution AND event_id=p_event AND guest_id=p_guest AND kind='contribute' AND NOT revoked) THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 IF p_approval IS NULL OR jsonb_typeof(p_approval)<>'object' OR (p_approval-ARRAY['sha256','bytes','width','height','mime','consent','missionId'])<>'{}'::jsonb OR coalesce(p_approval->>'sha256','') !~ '^[a-f0-9]{64}$' OR p_approval->>'mime' IS DISTINCT FROM 'image/jpeg' OR coalesce((p_approval->>'bytes')::integer,0) NOT BETWEEN 1 AND 2000000 OR coalesce((p_approval->>'width')::integer,0) NOT BETWEEN 1 AND 4096 OR coalesce((p_approval->>'height')::integer,0) NOT BETWEEN 1 AND 4096 OR (p_approval->>'width')::bigint*(p_approval->>'height')::bigint>12000000 OR NOT p_approval ? 'missionId' THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 SELECT * INTO prior FROM public.pb_event_kiosk_jobs WHERE device_id=d.id AND request_id=p_request;
 IF prior.submission_id IS NOT NULL AND (prior.submission_id,prior.generation,prior.guest_id,prior.approval,prior.contribution_hash) IS DISTINCT FROM (p_submission,p_generation,p_guest,p_approval,p_contribution) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 result=public.pb_event_reserve_mission(p_event,p_contribution,p_guest,p_submission,p_request,p_receipt,p_approval->'consent',p_approval->>'missionId');
 INSERT INTO public.pb_event_kiosk_jobs(submission_id,event_id,device_id,generation,guest_id,request_id,contribution_hash,approval) VALUES(p_submission,p_event,d.id,p_generation,p_guest,p_request,p_contribution,p_approval) ON CONFLICT(submission_id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.pb_event_kiosk_jobs WHERE submission_id=p_submission AND device_id=d.id AND generation=p_generation AND guest_id=p_guest AND approval=p_approval) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 RETURN result||jsonb_build_object('deviceId',d.id,'guestId',p_guest,'generation',p_generation);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_kiosk_job(p_event uuid,p_token text,p_generation integer,p_submission uuid,p_operation text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.pb_event_kiosks; k public.pb_event_kiosk_jobs; result jsonb;
BEGIN
 PERFORM public.pb_event_require_service(); PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE; d=public.pb_event_kiosk_device(p_event,p_token);
 SELECT * INTO k FROM public.pb_event_kiosk_jobs WHERE event_id=p_event AND device_id=d.id AND submission_id=p_submission AND generation=p_generation;
 IF k.submission_id IS NULL THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
 IF p_operation='upload' THEN RETURN public.pb_event_authorise_upload(p_event,k.contribution_hash,k.submission_id);
 ELSIF p_operation='finalise' THEN
  result=public.pb_event_enqueue_finalise(p_event,k.contribution_hash,k.submission_id);
  UPDATE public.pb_event_jobs SET checkpoint=checkpoint||jsonb_build_object('sourceApproval',k.approval-ARRAY['consent','missionId']) WHERE submission_id=k.submission_id AND kind='finalise';
  RETURN result;
 ELSIF p_operation='status' THEN PERFORM public.pb_event_token(p_event,k.contribution_hash,'contribute'); RETURN public.pb_event_receipt_json(k.submission_id);
 ELSE RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_kiosk_revoke(p_actor uuid,p_event uuid,p_device uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_event_require_actor(p_event,p_actor,true); UPDATE public.pb_event_kiosks SET revoked=true,guest_id=NULL,unlock_hash=NULL,unlock_until=NULL WHERE id=p_device AND event_id=p_event; IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF; RETURN jsonb_build_object('revoked',true); END $$;

CREATE OR REPLACE FUNCTION public.pb_event_kiosk_ready_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE k public.pb_event_kiosk_jobs; proof jsonb;
BEGIN
 IF NEW.state='ready' AND OLD.state IS DISTINCT FROM NEW.state THEN
  SELECT * INTO k FROM public.pb_event_kiosk_jobs WHERE submission_id=NEW.id;
  IF k.submission_id IS NOT NULL THEN
   SELECT checkpoint INTO proof FROM public.pb_event_jobs WHERE submission_id=NEW.id AND kind='finalise';
   IF proof->>'sourceSha256' IS DISTINCT FROM k.approval->>'sha256' OR proof->'sourceBytes' IS DISTINCT FROM k.approval->'bytes' OR proof->'sourceWidth' IS DISTINCT FROM k.approval->'width' OR proof->'sourceHeight' IS DISTINCT FROM k.approval->'height' THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pb_event_kiosk_ready ON public.pb_event_submissions;
CREATE TRIGGER pb_event_kiosk_ready BEFORE UPDATE OF state ON public.pb_event_submissions FOR EACH ROW EXECUTE FUNCTION public.pb_event_kiosk_ready_guard();

DO $$ DECLARE f record; BEGIN FOR f IN SELECT p.oid::regprocedure signature,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'pb_event_kiosk_%' LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
 IF f.proname NOT IN ('pb_event_kiosk_device','pb_event_kiosk_json','pb_event_kiosk_ready_guard') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature); END IF;
END LOOP; END $$;
COMMIT;
