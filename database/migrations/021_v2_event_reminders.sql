BEGIN;
CREATE TABLE IF NOT EXISTS public.pb_event_reminders (
 event_id uuid PRIMARY KEY REFERENCES public.pb_events ON DELETE CASCADE,
 revision integer NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 1000000),
 expiry_revision integer NOT NULL DEFAULT 0 CHECK(expiry_revision BETWEEN 0 AND 1000000),
 expires_at timestamptz NOT NULL, email boolean NOT NULL DEFAULT false, push boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','queued','leased','completed','failed','uncertain','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 lease_token uuid, lease_until timestamptz, retry_at timestamptz NOT NULL DEFAULT '-infinity'
);
CREATE TABLE IF NOT EXISTS public.pb_event_reminder_targets (
 event_id uuid NOT NULL REFERENCES public.pb_event_reminders ON DELETE CASCADE,
 channel text NOT NULL CHECK(channel='email' OR channel ~ '^push:[0-9a-f-]{36}$'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatching','delivered','gone','uncertain')),
 payload_hash text, target_hash text, started_at timestamptz, PRIMARY KEY(event_id,channel)
);
ALTER TABLE public.pb_event_reminder_targets ADD COLUMN IF NOT EXISTS target_hash text;
ALTER TABLE public.pb_event_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pb_event_reminder_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pb_event_reminders,public.pb_event_reminder_targets FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.pb_event_reminder_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.status='deleted' AND OLD.status<>'deleted' THEN
  DELETE FROM public.pb_event_reminder_targets WHERE event_id=NEW.id;
  UPDATE public.pb_event_reminders SET expires_at=NEW.expires_at,expiry_revision=least(expiry_revision+1,1000000),revision=least(revision+1,1000000),
   status=CASE WHEN NEW.status='deleted' THEN 'cancelled' ELSE 'idle' END,attempts=0,lease_token=NULL,lease_until=NULL,retry_at='-infinity',
   email=CASE WHEN NEW.status='deleted' THEN false ELSE email END,push=CASE WHEN NEW.status='deleted' THEN false ELSE push END WHERE event_id=NEW.id;
 END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pb_event_reminder_changed ON public.pb_events;
CREATE TRIGGER pb_event_reminder_changed AFTER UPDATE OF expires_at,status ON public.pb_events FOR EACH ROW EXECUTE FUNCTION public.pb_event_reminder_changed();

CREATE OR REPLACE FUNCTION public.pb_event_reminder_settings(p_actor uuid,p_event uuid,p_revision integer DEFAULT NULL,p_email boolean DEFAULT NULL,p_push boolean DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events; r public.pb_event_reminders;
BEGIN
 PERFORM public.pb_event_require_service(); PERFORM public.pb_event_require_actor(p_event,p_actor,true);
 SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE;
 INSERT INTO public.pb_event_reminders(event_id,expires_at) VALUES(e.id,e.expires_at) ON CONFLICT DO NOTHING;
 SELECT * INTO r FROM public.pb_event_reminders WHERE event_id=e.id FOR UPDATE;
 IF p_revision IS NOT NULL THEN
  IF p_email IS NULL OR p_push IS NULL OR p_revision<0 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  IF e.status='deleted' OR e.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
  IF r.revision<>p_revision AND NOT (r.revision=p_revision+1 AND r.email=p_email AND r.push=p_push) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
  IF r.email IS DISTINCT FROM p_email OR r.push IS DISTINCT FROM p_push THEN
   UPDATE public.pb_event_reminder_targets SET state='uncertain' WHERE event_id=e.id AND state='dispatching' AND (channel='email' AND NOT p_email OR channel LIKE 'push:%' AND NOT p_push);
   UPDATE public.pb_event_reminders SET email=p_email,push=p_push,revision=revision+1,lease_token=NULL,lease_until=NULL,
    status=CASE WHEN EXISTS(SELECT 1 FROM public.pb_event_reminder_targets WHERE event_id=e.id AND state='uncertain') THEN 'uncertain' WHEN status='leased' THEN 'queued' ELSE status END WHERE event_id=e.id RETURNING * INTO r;
  END IF;
 ELSIF p_email IS NOT NULL OR p_push IS NOT NULL THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 RETURN jsonb_build_object('version',1,'eventId',e.id,'revision',r.revision,'email',r.email,'push',r.push,'expiresAt',e.expires_at,
  'scheduledAt',e.expires_at-interval '24 hours','status',CASE WHEN e.status='deleted' OR e.expires_at<=clock_timestamp() THEN 'cancelled' ELSE r.status END,
  'emailAvailable',EXISTS(SELECT 1 FROM auth.users WHERE id=e.owner_id AND email_confirmed_at IS NOT NULL AND email IS NOT NULL),
  'pushAvailable',EXISTS(SELECT 1 FROM public.pb_push_subscriptions WHERE owner=e.owner_id));
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_reminder_claim(p_run uuid,p_token uuid,p_email boolean,p_push boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events; r public.pb_event_reminders; targets jsonb;
BEGIN
 PERFORM public.pb_event_require_service();
 IF p_token IS NULL OR NOT EXISTS(SELECT 1 FROM public.pb_job_leases WHERE job='reminders' AND token=p_run AND lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 FOR e IN SELECT ev.* FROM public.pb_events ev JOIN public.pb_event_reminders x ON x.event_id=ev.id
  WHERE ev.status<>'deleted' AND ev.expires_at>clock_timestamp() AND ev.expires_at-interval '24 hours'<=clock_timestamp()
   AND ((x.email AND p_email) OR (x.push AND p_push)) AND x.status IN ('idle','queued','leased')
   AND coalesce(x.lease_until,'-infinity')<=clock_timestamp() AND x.retry_at<=clock_timestamp()
  ORDER BY ev.expires_at,ev.id LIMIT 1 FOR UPDATE OF ev SKIP LOCKED LOOP
  SELECT * INTO r FROM public.pb_event_reminders WHERE event_id=e.id FOR UPDATE;
  IF r.attempts>=5 THEN UPDATE public.pb_event_reminders SET status=CASE WHEN EXISTS(SELECT 1 FROM public.pb_event_reminder_targets WHERE event_id=e.id AND state='dispatching') THEN 'uncertain' ELSE 'failed' END,lease_token=NULL,lease_until=NULL WHERE event_id=e.id; RETURN NULL; END IF;
  IF r.attempts=0 THEN
   IF r.email AND p_email THEN INSERT INTO public.pb_event_reminder_targets(event_id,channel) SELECT e.id,'email' FROM auth.users WHERE id=e.owner_id AND email_confirmed_at IS NOT NULL AND email IS NOT NULL ON CONFLICT DO NOTHING; END IF;
   IF r.push AND p_push THEN INSERT INTO public.pb_event_reminder_targets(event_id,channel) SELECT e.id,'push:'||id FROM public.pb_push_subscriptions WHERE owner=e.owner_id ORDER BY id LIMIT 10 ON CONFLICT DO NOTHING; END IF;
  END IF;
  UPDATE public.pb_event_reminders SET status='leased',attempts=attempts+1,lease_token=p_token,lease_until=clock_timestamp()+interval '300 seconds' WHERE event_id=e.id;
  SELECT coalesce(jsonb_agg(channel ORDER BY channel),'[]') INTO targets FROM public.pb_event_reminder_targets WHERE event_id=e.id AND state NOT IN ('delivered','gone','uncertain');
  RETURN jsonb_build_object('eventId',e.id,'expiryRevision',r.expiry_revision,'expiresAt',e.expires_at,'timezone',e.timezone,'title',e.title,'token',p_token,'channels',targets);
 END LOOP; RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_reminder_dispatch(p_event uuid,p_token uuid,p_channel text,p_hash text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events; r public.pb_event_reminders; t public.pb_event_reminder_targets; target jsonb;
BEGIN
 PERFORM public.pb_event_require_service(); SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE;
 SELECT * INTO r FROM public.pb_event_reminders WHERE event_id=p_event FOR UPDATE;
 IF r.lease_token IS DISTINCT FROM p_token OR r.status<>'leased' OR r.lease_until<=clock_timestamp() OR e.status='deleted' OR e.expires_at<=clock_timestamp() OR e.expires_at<>r.expires_at THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 SELECT * INTO t FROM public.pb_event_reminder_targets WHERE event_id=p_event AND channel=p_channel FOR UPDATE;
 IF t.event_id IS NULL THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 IF t.state IN ('delivered','gone','uncertain') THEN RETURN jsonb_build_object('state',t.state,'target',NULL); END IF;
 IF p_channel='email' AND r.email THEN SELECT jsonb_build_object('email',email) INTO target FROM auth.users WHERE id=e.owner_id AND email_confirmed_at IS NOT NULL;
 ELSIF p_channel LIKE 'push:%' AND r.push THEN SELECT jsonb_build_object('id',id,'endpoint',endpoint,'p256dh',p256dh,'auth',auth) INTO target FROM public.pb_push_subscriptions WHERE owner=e.owner_id AND id=substring(p_channel FROM 6)::uuid; END IF;
 IF target IS NULL THEN
  UPDATE public.pb_event_reminder_targets SET state=CASE WHEN t.state='dispatching' THEN 'uncertain' ELSE 'gone' END WHERE event_id=p_event AND channel=p_channel;
  RETURN jsonb_build_object('state',CASE WHEN t.state='dispatching' THEN 'uncertain' ELSE 'gone' END,'target',NULL);
 END IF;
 IF t.state='dispatching' AND (p_channel<>'email' OR t.started_at<clock_timestamp()-interval '23 hours' OR p_hash IS NOT NULL AND t.payload_hash IS DISTINCT FROM p_hash) THEN
  UPDATE public.pb_event_reminder_targets SET state='uncertain' WHERE event_id=p_event AND channel=p_channel; RETURN jsonb_build_object('state','uncertain','target',NULL);
 END IF;
 IF p_hash IS NOT NULL THEN
  IF p_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  UPDATE public.pb_event_reminder_targets SET state='dispatching',payload_hash=p_hash,target_hash=encode(sha256(convert_to(target::text,'UTF8')),'hex'),started_at=coalesce(started_at,clock_timestamp()) WHERE event_id=p_event AND channel=p_channel;
 END IF;
 RETURN jsonb_build_object('state','send','target',target);
END $$;

DROP FUNCTION IF EXISTS public.pb_event_reminder_record(uuid,uuid,text,text);
CREATE OR REPLACE FUNCTION public.pb_event_reminder_record(p_event uuid,p_token uuid,p_channel text,p_outcome text,p_target jsonb DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.pb_event_reminders; t public.pb_event_reminder_targets; e public.pb_events;
BEGIN
 PERFORM public.pb_event_require_service(); SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE;
 SELECT * INTO r FROM public.pb_event_reminders WHERE event_id=p_event FOR UPDATE;
 IF r.lease_token IS DISTINCT FROM p_token OR r.status<>'leased' OR r.lease_until<=clock_timestamp() OR p_outcome NOT IN ('delivered','gone') THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 SELECT * INTO t FROM public.pb_event_reminder_targets WHERE event_id=p_event AND channel=p_channel FOR UPDATE;
 IF p_outcome='gone' THEN
  IF p_channel NOT LIKE 'push:%' OR p_target IS NULL OR pg_column_size(p_target)>8192 OR t.target_hash IS DISTINCT FROM encode(sha256(convert_to(p_target::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
  IF t.state='dispatching' THEN DELETE FROM public.pb_push_subscriptions s WHERE s.owner=e.owner_id AND s.id=substring(p_channel FROM 6)::uuid AND jsonb_build_object('id',s.id,'endpoint',s.endpoint,'p256dh',s.p256dh,'auth',s.auth)=p_target; END IF;
 END IF;
 UPDATE public.pb_event_reminder_targets SET state=p_outcome WHERE event_id=p_event AND channel=p_channel AND state='dispatching'; RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_reminder_finish(p_event uuid,p_token uuid,p_failed boolean) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.pb_event_reminders;
BEGIN
 PERFORM public.pb_event_require_service(); PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE;
 SELECT * INTO r FROM public.pb_event_reminders WHERE event_id=p_event FOR UPDATE;
 IF r.lease_token IS DISTINCT FROM p_token OR r.status<>'leased' THEN RETURN false; END IF;
 UPDATE public.pb_event_reminders SET status=CASE WHEN EXISTS(SELECT 1 FROM public.pb_event_reminder_targets WHERE event_id=p_event AND (state='uncertain' OR r.attempts>=5 AND state='dispatching')) THEN 'uncertain' WHEN p_failed THEN CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END ELSE 'completed' END,
  lease_token=NULL,lease_until=NULL,retry_at=clock_timestamp()+interval '1 minute' WHERE event_id=p_event; RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.pb_event_reminder_changed(),public.pb_event_reminder_settings(uuid,uuid,integer,boolean,boolean),public.pb_event_reminder_claim(uuid,uuid,boolean,boolean),public.pb_event_reminder_dispatch(uuid,uuid,text,text),public.pb_event_reminder_record(uuid,uuid,text,text,jsonb),public.pb_event_reminder_finish(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pb_event_reminder_settings(uuid,uuid,integer,boolean,boolean),public.pb_event_reminder_claim(uuid,uuid,boolean,boolean),public.pb_event_reminder_dispatch(uuid,uuid,text,text),public.pb_event_reminder_record(uuid,uuid,text,text,jsonb),public.pb_event_reminder_finish(uuid,uuid,boolean) TO service_role;
COMMIT;
