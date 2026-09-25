BEGIN;

ALTER TABLE public.pb_photo_dates ADD COLUMN IF NOT EXISTS ritual_delivery_status text NOT NULL DEFAULT 'idle';
ALTER TABLE public.pb_photo_dates ADD COLUMN IF NOT EXISTS ritual_delivery_attempts integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS public.pb_ritual_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), date_id uuid NOT NULL REFERENCES public.pb_photo_dates ON DELETE CASCADE,
  revision integer NOT NULL CHECK(revision>=0), cycle integer NOT NULL CHECK(cycle>=0), scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','completed','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5), lease_token uuid, lease_until timestamptz,
  retry_at timestamptz NOT NULL DEFAULT clock_timestamp(), uncertain boolean NOT NULL DEFAULT false,
  terminal_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(date_id,revision,scheduled_at)
);
CREATE INDEX IF NOT EXISTS pb_ritual_occurrence_history ON public.pb_ritual_occurrences(date_id,terminal_at DESC,id);
CREATE TABLE IF NOT EXISTS public.pb_ritual_targets (
  occurrence_id uuid NOT NULL REFERENCES public.pb_ritual_occurrences ON DELETE CASCADE,
  recipient_id uuid NOT NULL, channel text NOT NULL CHECK(channel='email' OR channel ~ '^push:[0-9a-f-]{36}$'),
  target jsonb NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatching','delivered','gone')),
  payload_hash text CHECK(payload_hash ~ '^[0-9a-f]{64}$'), first_started_at timestamptz,
  PRIMARY KEY(occurrence_id,recipient_id,channel), CHECK(pg_column_size(target)<=8192)
);
CREATE TABLE IF NOT EXISTS public.pb_ritual_months (
  date_id uuid NOT NULL REFERENCES public.pb_photo_dates ON DELETE CASCADE,
  month_key integer NOT NULL CHECK(month_key=0 OR month_key/100 BETWEEN 1970 AND 2199 AND month_key%100 BETWEEN 1 AND 12),
  completed bigint NOT NULL DEFAULT 0, skipped bigint NOT NULL DEFAULT 0, failed bigint NOT NULL DEFAULT 0,
  uncertain bigint NOT NULL DEFAULT 0, cancelled bigint NOT NULL DEFAULT 0, PRIMARY KEY(date_id,month_key)
);
ALTER TABLE public.pb_ritual_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pb_ritual_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pb_ritual_months ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pb_ritual_occurrences,public.pb_ritual_targets,public.pb_ritual_months FROM PUBLIC,anon,authenticated,service_role;

ALTER TABLE public.pb_reminder_deliveries ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.pb_reminder_deliveries ADD COLUMN IF NOT EXISTS ritual_revision integer;
ALTER TABLE public.pb_reminder_deliveries ADD COLUMN IF NOT EXISTS recipient_id uuid;
ALTER TABLE public.pb_reminder_deliveries ADD COLUMN IF NOT EXISTS occurrence_id uuid;
ALTER TABLE public.pb_reminder_deliveries DROP CONSTRAINT IF EXISTS pb_reminder_deliveries_pkey;
ALTER TABLE public.pb_reminder_deliveries ADD PRIMARY KEY(id);
CREATE UNIQUE INDEX IF NOT EXISTS pb_reminder_legacy_checkpoint ON public.pb_reminder_deliveries(date_id,scheduled_at,channel) WHERE ritual_revision IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pb_reminder_ritual_checkpoint ON public.pb_reminder_deliveries(date_id,ritual_revision,scheduled_at,recipient_id,channel) WHERE ritual_revision IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='pb_reminder_checkpoint_identity' AND conrelid='public.pb_reminder_deliveries'::regclass) THEN
    ALTER TABLE public.pb_reminder_deliveries ADD CONSTRAINT pb_reminder_checkpoint_identity CHECK(
      ritual_revision IS NULL AND recipient_id IS NULL AND occurrence_id IS NULL OR ritual_revision>=0 AND recipient_id IS NOT NULL AND occurrence_id IS NOT NULL);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pb_ritual_compact(p_date uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.pb_ritual_occurrences; m integer; delivered boolean; sums record;
BEGIN
  FOR o IN SELECT * FROM public.pb_ritual_occurrences WHERE date_id=p_date AND terminal_at IS NOT NULL ORDER BY terminal_at DESC,id OFFSET 100 LOOP
    m:=to_char(o.scheduled_at AT TIME ZONE 'UTC','YYYYMM')::integer;
    SELECT EXISTS(SELECT 1 FROM public.pb_ritual_targets WHERE occurrence_id=o.id AND state='delivered') INTO delivered;
    INSERT INTO public.pb_ritual_months(date_id,month_key,completed,skipped,failed,uncertain,cancelled)
    VALUES(p_date,m,(o.status='completed' AND delivered)::integer,(o.status='completed' AND NOT delivered)::integer,(o.status='failed')::integer,o.uncertain::integer,(o.status='cancelled')::integer)
    ON CONFLICT(date_id,month_key) DO UPDATE SET completed=pb_ritual_months.completed+excluded.completed,skipped=pb_ritual_months.skipped+excluded.skipped,failed=pb_ritual_months.failed+excluded.failed,uncertain=pb_ritual_months.uncertain+excluded.uncertain,cancelled=pb_ritual_months.cancelled+excluded.cancelled;
    DELETE FROM public.pb_reminder_deliveries WHERE occurrence_id=o.id AND ritual_revision IS NOT NULL;
    DELETE FROM public.pb_ritual_occurrences WHERE id=o.id;
  END LOOP;
  SELECT coalesce(sum(completed),0) completed,coalesce(sum(skipped),0) skipped,coalesce(sum(failed),0) failed,coalesce(sum(uncertain),0) uncertain,coalesce(sum(cancelled),0) cancelled INTO sums
    FROM public.pb_ritual_months WHERE date_id=p_date AND month_key IN (SELECT month_key FROM public.pb_ritual_months WHERE date_id=p_date AND month_key<>0 ORDER BY month_key DESC OFFSET 120);
  DELETE FROM public.pb_ritual_months WHERE date_id=p_date AND month_key IN (SELECT month_key FROM public.pb_ritual_months WHERE date_id=p_date AND month_key<>0 ORDER BY month_key DESC OFFSET 120);
  IF sums.completed+sums.skipped+sums.failed+sums.uncertain+sums.cancelled>0 THEN
    INSERT INTO public.pb_ritual_months(date_id,month_key,completed,skipped,failed,uncertain,cancelled) VALUES(p_date,0,sums.completed,sums.skipped,sums.failed,sums.uncertain,sums.cancelled)
    ON CONFLICT(date_id,month_key) DO UPDATE SET completed=pb_ritual_months.completed+excluded.completed,skipped=pb_ritual_months.skipped+excluded.skipped,failed=pb_ritual_months.failed+excluded.failed,uncertain=pb_ritual_months.uncertain+excluded.uncertain,cancelled=pb_ritual_months.cancelled+excluded.cancelled;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.pb_ritual_delivery_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE internal boolean:=coalesce(current_setting('pb.ritual_write',true),'')='on' AND coalesce(auth.role(),'')='service_role' AND (current_setting('role',true)='service_role' OR session_user='service_role');
BEGIN
  IF NOT internal AND (TG_OP='INSERT' AND (NEW.ritual_delivery_status<>'idle' OR NEW.ritual_delivery_attempts<>0) OR TG_OP='UPDATE' AND (NEW.ritual_delivery_status,NEW.ritual_delivery_attempts) IS DISTINCT FROM (OLD.ritual_delivery_status,OLD.ritual_delivery_attempts)) THEN RAISE EXCEPTION 'PB_RITUAL_DENIED'; END IF;
  IF NEW.ritual_delivery_status NOT IN ('idle','pending','retrying','failed','uncertain') OR NEW.ritual_delivery_attempts NOT BETWEEN 0 AND 5 THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  IF TG_OP='UPDATE' AND NEW.ritual_revision<>OLD.ritual_revision THEN
    NEW.ritual_delivery_status:='idle'; NEW.ritual_delivery_attempts:=0;
    IF NEW.ritual_enabled AND NEW.scheduled_at=OLD.scheduled_at AND NEW.scheduled_at<=clock_timestamp() AND EXISTS(SELECT 1 FROM public.pb_ritual_occurrences WHERE date_id=OLD.id AND revision=OLD.ritual_revision) THEN
      NEW.ritual_enabled:=false; NEW.ritual_delivery_status:='uncertain';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.pb_ritual_invalidate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.ritual_revision<>OLD.ritual_revision OR NEW.ritual_deleted THEN
    UPDATE public.pb_ritual_occurrences o SET status='cancelled',terminal_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,
      uncertain=EXISTS(SELECT 1 FROM public.pb_ritual_targets t WHERE t.occurrence_id=o.id AND t.state='dispatching')
      WHERE date_id=NEW.id AND status IN ('queued','leased') AND (revision<>NEW.ritual_revision OR NEW.ritual_deleted);
    PERFORM public.pb_ritual_compact(NEW.id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pb_ritual_delivery_guard ON public.pb_photo_dates;
CREATE TRIGGER pb_ritual_delivery_guard BEFORE INSERT OR UPDATE ON public.pb_photo_dates FOR EACH ROW EXECUTE FUNCTION public.pb_ritual_delivery_guard();
DROP TRIGGER IF EXISTS pb_ritual_invalidate ON public.pb_photo_dates;
CREATE TRIGGER pb_ritual_invalidate AFTER UPDATE ON public.pb_photo_dates FOR EACH ROW EXECUTE FUNCTION public.pb_ritual_invalidate();

CREATE OR REPLACE FUNCTION public.pb_ritual_fence(p_occurrence uuid,p_token uuid) RETURNS public.pb_ritual_occurrences LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.pb_ritual_occurrences; d public.pb_photo_dates; c public.pb_couples;
BEGIN
  PERFORM public.pb_ritual_service(); SELECT * INTO o FROM public.pb_ritual_occurrences WHERE id=p_occurrence;
  SELECT * INTO d FROM public.pb_photo_dates WHERE id=o.date_id;
  SELECT * INTO c FROM public.pb_couples WHERE id=d.couple_id FOR UPDATE;
  SELECT * INTO d FROM public.pb_photo_dates WHERE id=o.date_id FOR UPDATE;
  SELECT * INTO o FROM public.pb_ritual_occurrences WHERE id=p_occurrence FOR UPDATE;
  IF o.id IS NULL OR c.id IS NULL OR d.id IS NULL OR o.status<>'leased' OR o.lease_token IS DISTINCT FROM p_token OR o.lease_until<=clock_timestamp() OR d.ritual_revision<>o.revision OR d.scheduled_at<>o.scheduled_at OR NOT d.ritual_enabled OR d.ritual_paused OR d.ritual_deleted OR d.active OR NOT d.ritual_recipients<@array_remove(ARRAY[c.member_a,c.member_b],NULL) THEN RAISE EXCEPTION 'PB_RITUAL_FENCE'; END IF;
  RETURN o;
END $$;
CREATE OR REPLACE FUNCTION public.pb_ritual_claim_result(o public.pb_ritual_occurrences,d public.pb_photo_dates,p_token uuid,p_terminal boolean) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object('id',o.id,'dateId',d.id,'revision',o.revision,'cycle',o.cycle,'scheduledAt',o.scheduled_at,'title',d.title,'token',p_token,'terminal',p_terminal,
    'targets',CASE WHEN p_terminal THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(jsonb_build_object('recipientId',recipient_id,'channel',channel,'target',target) ORDER BY recipient_id,channel) FROM public.pb_ritual_targets WHERE occurrence_id=o.id),'[]'::jsonb) END)
$$;
CREATE OR REPLACE FUNCTION public.pb_ritual_claim(p_run_token uuid,p_token uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE candidate record; d public.pb_photo_dates; c public.pb_couples; o public.pb_ritual_occurrences; item record; overflow boolean;
BEGIN
  PERFORM public.pb_ritual_service();
  IF p_token IS NULL OR NOT EXISTS(SELECT 1 FROM public.pb_job_leases WHERE job='reminders' AND token=p_run_token AND lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'PB_RITUAL_FENCE'; END IF;
  FOR candidate IN SELECT d0.id,d0.couple_id FROM public.pb_photo_dates d0 LEFT JOIN public.pb_ritual_occurrences o0 ON o0.date_id=d0.id AND o0.revision=d0.ritual_revision AND o0.scheduled_at=d0.scheduled_at
    WHERE d0.ritual_version=1 AND d0.ritual_enabled AND NOT d0.ritual_paused AND NOT d0.ritual_deleted AND NOT d0.active AND d0.scheduled_at<=clock_timestamp()
    AND (o0.id IS NULL OR o0.status='queued' AND o0.retry_at<=clock_timestamp() OR o0.status='leased' AND o0.lease_until<=clock_timestamp()) ORDER BY d0.scheduled_at,d0.id LIMIT 1 LOOP
    SELECT * INTO c FROM public.pb_couples WHERE id=candidate.couple_id FOR UPDATE SKIP LOCKED; IF c.id IS NULL THEN CONTINUE; END IF;
    SELECT * INTO d FROM public.pb_photo_dates WHERE id=candidate.id FOR UPDATE SKIP LOCKED;
    IF d.id IS NULL OR NOT d.ritual_enabled OR d.ritual_paused OR d.ritual_deleted OR d.scheduled_at>clock_timestamp() THEN CONTINUE; END IF;
    SELECT * INTO o FROM public.pb_ritual_occurrences WHERE date_id=d.id AND revision=d.ritual_revision AND scheduled_at=d.scheduled_at FOR UPDATE;
    IF o.id IS NULL THEN
      INSERT INTO public.pb_ritual_occurrences(date_id,revision,cycle,scheduled_at) VALUES(d.id,d.ritual_revision,(d.ritual_next->>'cycle')::integer,d.scheduled_at) RETURNING * INTO o;
      SELECT count(*)>20 INTO overflow FROM public.pb_push_subscriptions s JOIN public.pb_ritual_channels p ON p.date_id=d.id AND p.recipient_id=s.owner AND p.push WHERE s.owner=ANY(d.ritual_recipients);
      IF overflow THEN
        UPDATE public.pb_ritual_occurrences SET status='failed',terminal_at=clock_timestamp() WHERE id=o.id RETURNING * INTO o;
        PERFORM set_config('pb.ritual_write','on',true); UPDATE public.pb_photo_dates SET ritual_enabled=false,ritual_delivery_status='failed' WHERE id=d.id; PERFORM set_config('pb.ritual_write','off',true); PERFORM public.pb_ritual_compact(d.id); RETURN public.pb_ritual_claim_result(o,d,p_token,true);
      END IF;
      FOR item IN SELECT p.recipient_id,profiles.email,p.email opted_email,p.push opted_push FROM public.pb_ritual_channels p LEFT JOIN public.profiles ON profiles.id=p.recipient_id WHERE p.date_id=d.id AND p.recipient_id=ANY(d.ritual_recipients) LOOP
        IF item.opted_email THEN INSERT INTO public.pb_ritual_targets(occurrence_id,recipient_id,channel,target) VALUES(o.id,item.recipient_id,'email',jsonb_build_object('email',CASE WHEN length(item.email)<=320 THEN item.email ELSE NULL END)); END IF;
        IF item.opted_push THEN INSERT INTO public.pb_ritual_targets(occurrence_id,recipient_id,channel,target)
          SELECT o.id,item.recipient_id,'push:'||s.id::text,CASE WHEN length(s.endpoint)<=4096 AND length(s.p256dh)<=256 AND length(s.auth)<=256 THEN jsonb_build_object('id',s.id,'endpoint',s.endpoint,'p256dh',s.p256dh,'auth',s.auth) ELSE jsonb_build_object('id',s.id,'endpoint',NULL,'p256dh',NULL,'auth',NULL) END FROM public.pb_push_subscriptions s WHERE s.owner=item.recipient_id; END IF;
      END LOOP;
    END IF;
    IF o.status NOT IN ('queued','leased') OR o.status='leased' AND o.lease_until>clock_timestamp() OR o.retry_at>clock_timestamp() THEN CONTINUE; END IF;
    IF o.attempts>=5 OR NOT d.ritual_recipients<@array_remove(ARRAY[c.member_a,c.member_b],NULL) THEN
      UPDATE public.pb_ritual_occurrences SET status='failed',terminal_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,uncertain=EXISTS(SELECT 1 FROM public.pb_ritual_targets WHERE occurrence_id=o.id AND state='dispatching') WHERE id=o.id RETURNING * INTO o;
      PERFORM set_config('pb.ritual_write','on',true); UPDATE public.pb_photo_dates SET ritual_enabled=false,ritual_delivery_status=CASE WHEN EXISTS(SELECT 1 FROM public.pb_ritual_targets WHERE occurrence_id=o.id AND state='dispatching') THEN 'uncertain' ELSE 'failed' END,ritual_delivery_attempts=o.attempts WHERE id=d.id; PERFORM set_config('pb.ritual_write','off',true); PERFORM public.pb_ritual_compact(d.id); RETURN public.pb_ritual_claim_result(o,d,p_token,true);
    END IF;
    UPDATE public.pb_ritual_occurrences SET status='leased',attempts=attempts+1,lease_token=p_token,lease_until=clock_timestamp()+interval '300 seconds' WHERE id=o.id RETURNING * INTO o;
    PERFORM set_config('pb.ritual_write','on',true); UPDATE public.pb_photo_dates SET ritual_delivery_status=CASE WHEN o.attempts=1 THEN 'pending' ELSE 'retrying' END,ritual_delivery_attempts=o.attempts WHERE id=d.id; PERFORM set_config('pb.ritual_write','off',true);
    RETURN public.pb_ritual_claim_result(o,d,p_token,false);
  END LOOP;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.pb_ritual_dispatch(p_occurrence uuid,p_token uuid,p_recipient uuid,p_channel text,p_hash text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.pb_ritual_occurrences; t public.pb_ritual_targets; opted boolean; unchanged boolean;
BEGIN
  o:=public.pb_ritual_fence(p_occurrence,p_token);
  UPDATE public.pb_ritual_occurrences SET lease_until=clock_timestamp()+interval '300 seconds' WHERE id=o.id;
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  SELECT * INTO t FROM public.pb_ritual_targets WHERE occurrence_id=o.id AND recipient_id=p_recipient AND channel=p_channel FOR UPDATE;
  IF t.occurrence_id IS NULL THEN RAISE EXCEPTION 'PB_RITUAL_FENCE'; END IF;
  SELECT CASE WHEN p_channel='email' THEN email ELSE push END INTO opted FROM public.pb_ritual_channels WHERE date_id=o.date_id AND recipient_id=p_recipient;
  IF NOT coalesce(opted,false) THEN RAISE EXCEPTION 'PB_RITUAL_FENCE'; END IF;
  IF t.state IN ('delivered','gone') THEN RETURN t.state; END IF;
  IF p_channel='email' THEN
    SELECT email IS NOT NULL AND email=t.target->>'email' INTO unchanged FROM public.profiles WHERE id=p_recipient;
    IF NOT coalesce(unchanged,false) THEN RETURN 'unavailable'; END IF;
  ELSE
    SELECT jsonb_build_object('id',s.id,'endpoint',s.endpoint,'p256dh',s.p256dh,'auth',s.auth)=t.target INTO unchanged FROM public.pb_push_subscriptions s WHERE s.id=(substring(p_channel FROM 6))::uuid AND s.owner=p_recipient;
    IF NOT coalesce(unchanged,false) THEN
      IF t.state='dispatching' THEN RETURN 'uncertain'; END IF;
      UPDATE public.pb_ritual_targets SET state='gone' WHERE occurrence_id=o.id AND recipient_id=p_recipient AND channel=p_channel; RETURN 'gone';
    END IF;
  END IF;
  IF t.state='dispatching' AND (p_channel<>'email' OR t.first_started_at<clock_timestamp()-interval '23 hours' OR t.payload_hash IS DISTINCT FROM p_hash) THEN RETURN 'uncertain'; END IF;
  UPDATE public.pb_ritual_targets SET state='dispatching',payload_hash=coalesce(payload_hash,p_hash),first_started_at=coalesce(first_started_at,clock_timestamp()) WHERE occurrence_id=o.id AND recipient_id=p_recipient AND channel=p_channel;
  RETURN 'send';
END $$;
CREATE OR REPLACE FUNCTION public.pb_ritual_record(p_occurrence uuid,p_token uuid,p_recipient uuid,p_channel text,p_outcome text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.pb_ritual_occurrences; t public.pb_ritual_targets; opted boolean;
BEGIN
  o:=public.pb_ritual_fence(p_occurrence,p_token);
  SELECT * INTO t FROM public.pb_ritual_targets WHERE occurrence_id=o.id AND recipient_id=p_recipient AND channel=p_channel FOR UPDATE;
  SELECT CASE WHEN p_channel='email' THEN email ELSE push END INTO opted FROM public.pb_ritual_channels WHERE date_id=o.date_id AND recipient_id=p_recipient;
  IF t.occurrence_id IS NULL OR NOT coalesce(opted,false) OR p_outcome NOT IN ('sent','gone') OR p_outcome IS NULL OR p_outcome='gone' AND p_channel='email' OR t.state NOT IN ('dispatching','delivered','gone') THEN RAISE EXCEPTION 'PB_RITUAL_FENCE'; END IF;
  IF t.state IN ('delivered','gone') THEN RETURN true; END IF;
  UPDATE public.pb_ritual_targets SET state=CASE WHEN p_outcome='sent' THEN 'delivered' ELSE 'gone' END WHERE occurrence_id=o.id AND recipient_id=p_recipient AND channel=p_channel;
  IF p_outcome='sent' THEN
    INSERT INTO public.pb_reminder_deliveries(date_id,scheduled_at,channel,ritual_revision,recipient_id,occurrence_id) VALUES(o.date_id,o.scheduled_at,p_channel,o.revision,p_recipient,o.id) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM public.pb_push_subscriptions s WHERE s.id=(substring(p_channel FROM 6))::uuid AND s.owner=p_recipient AND jsonb_build_object('id',s.id,'endpoint',s.endpoint,'p256dh',s.p256dh,'auth',s.auth)=t.target;
  END IF;
  RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.pb_ritual_finish_context(p_occurrence uuid,p_token uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.pb_ritual_occurrences; d public.pb_photo_dates;
BEGIN o:=public.pb_ritual_fence(p_occurrence,p_token); SELECT * INTO d FROM public.pb_photo_dates WHERE id=o.date_id; RETURN jsonb_build_object('now',clock_timestamp(),'schedule',d.ritual_schedule); END $$;
CREATE OR REPLACE FUNCTION public.pb_ritual_finish(p_occurrence uuid,p_token uuid,p_proof jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.pb_ritual_occurrences; d public.pb_photo_dates; occurrence jsonb;
BEGIN
  o:=public.pb_ritual_fence(p_occurrence,p_token); SELECT * INTO d FROM public.pb_photo_dates WHERE id=o.date_id;
  IF EXISTS(SELECT 1 FROM public.pb_ritual_targets WHERE occurrence_id=o.id AND state NOT IN ('delivered','gone')) THEN RAISE EXCEPTION 'PB_RITUAL_UNCERTAIN'; END IF;
  IF EXISTS(SELECT 1 FROM public.pb_ritual_targets t LEFT JOIN public.pb_ritual_channels p ON p.date_id=o.date_id AND p.recipient_id=t.recipient_id WHERE t.occurrence_id=o.id AND NOT coalesce(CASE WHEN t.channel='email' THEN p.email ELSE p.push END,false)) THEN RAISE EXCEPTION 'PB_RITUAL_FENCE'; END IF;
  PERFORM public.pb_ritual_validate(d.ritual_schedule,p_proof); occurrence:=nullif(p_proof->'occurrence','null'::jsonb);
  IF occurrence IS NOT NULL AND ((occurrence->>'cycle')::integer<=o.cycle OR (occurrence->>'instant')::timestamptz<=o.scheduled_at) THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  UPDATE public.pb_ritual_occurrences SET status='completed',terminal_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=o.id;
  PERFORM set_config('pb.ritual_write','on',true);
  UPDATE public.pb_photo_dates SET ritual_next=occurrence,scheduled_at=coalesce((occurrence->>'instant')::timestamptz,scheduled_at),ritual_enabled=occurrence IS NOT NULL,ritual_delivery_status='idle',ritual_delivery_attempts=0,last_sent_at=CASE WHEN EXISTS(SELECT 1 FROM public.pb_ritual_targets WHERE occurrence_id=o.id AND state='delivered') THEN clock_timestamp() ELSE last_sent_at END WHERE id=d.id;
  PERFORM set_config('pb.ritual_write','off',true); PERFORM public.pb_ritual_compact(d.id); RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.pb_ritual_fail(p_occurrence uuid,p_token uuid,p_uncertain boolean DEFAULT false) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.pb_ritual_occurrences; d public.pb_photo_dates; is_uncertain boolean; terminal boolean;
BEGIN
  PERFORM public.pb_ritual_service(); SELECT * INTO o FROM public.pb_ritual_occurrences WHERE id=p_occurrence; SELECT * INTO d FROM public.pb_photo_dates WHERE id=o.date_id;
  PERFORM 1 FROM public.pb_couples WHERE id=d.couple_id FOR UPDATE; SELECT * INTO d FROM public.pb_photo_dates WHERE id=o.date_id FOR UPDATE; SELECT * INTO o FROM public.pb_ritual_occurrences WHERE id=p_occurrence FOR UPDATE;
  IF o.id IS NULL OR o.status<>'leased' OR o.lease_token IS DISTINCT FROM p_token THEN RETURN 'stale'; END IF;
  is_uncertain:=coalesce(p_uncertain,false) OR EXISTS(SELECT 1 FROM public.pb_ritual_targets WHERE occurrence_id=o.id AND state='dispatching' AND (o.attempts>=5 OR channel<>'email' OR first_started_at<clock_timestamp()-interval '23 hours'));
  terminal:=is_uncertain OR o.attempts>=5;
  UPDATE public.pb_ritual_occurrences SET status=CASE WHEN terminal THEN 'failed' ELSE 'queued' END,uncertain=is_uncertain,terminal_at=CASE WHEN terminal THEN clock_timestamp() ELSE NULL END,lease_token=NULL,lease_until=NULL,retry_at=clock_timestamp()+interval '1 minute' WHERE id=o.id;
  IF d.ritual_revision=o.revision AND d.scheduled_at=o.scheduled_at THEN
    PERFORM set_config('pb.ritual_write','on',true); UPDATE public.pb_photo_dates SET ritual_enabled=CASE WHEN terminal THEN false ELSE ritual_enabled END,ritual_delivery_status=CASE WHEN is_uncertain THEN 'uncertain' WHEN terminal THEN 'failed' ELSE 'retrying' END,ritual_delivery_attempts=o.attempts WHERE id=d.id; PERFORM set_config('pb.ritual_write','off',true);
  END IF;
  IF terminal THEN PERFORM public.pb_ritual_compact(o.date_id); END IF; RETURN CASE WHEN is_uncertain THEN 'uncertain' WHEN terminal THEN 'failed' ELSE 'retrying' END;
END $$;

CREATE OR REPLACE FUNCTION public.pb_ritual_projection(d public.pb_photo_dates,p_actor uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object('id',d.id,'coupleId',d.couple_id,'creatorId',d.created_by,'title',d.title,'revision',d.ritual_revision,'legacy',d.ritual_version IS NULL,'scheduledAt',d.scheduled_at,'cadence',d.cadence,'active',d.active,'schedule',d.ritual_schedule,'next',d.ritual_next,'paused',d.ritual_paused,'enabled',d.ritual_enabled,
    'channels',coalesce((SELECT jsonb_build_object('email',email,'push',push) FROM public.pb_ritual_channels WHERE date_id=d.id AND recipient_id=p_actor),'{"email":false,"push":false}'::jsonb),
    'delivery',jsonb_build_object('status',d.ritual_delivery_status,'attempts',d.ritual_delivery_attempts))
$$;

REVOKE ALL ON FUNCTION public.pb_ritual_compact(uuid),public.pb_ritual_delivery_guard(),public.pb_ritual_invalidate(),public.pb_ritual_fence(uuid,uuid),public.pb_ritual_claim_result(public.pb_ritual_occurrences,public.pb_photo_dates,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.pb_ritual_claim(uuid,uuid),public.pb_ritual_dispatch(uuid,uuid,uuid,text,text),public.pb_ritual_record(uuid,uuid,uuid,text,text),public.pb_ritual_finish_context(uuid,uuid),public.pb_ritual_finish(uuid,uuid,jsonb),public.pb_ritual_fail(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pb_ritual_claim(uuid,uuid),public.pb_ritual_dispatch(uuid,uuid,uuid,text,text),public.pb_ritual_record(uuid,uuid,uuid,text,text),public.pb_ritual_finish_context(uuid,uuid),public.pb_ritual_finish(uuid,uuid,jsonb),public.pb_ritual_fail(uuid,uuid,boolean) TO service_role;

-- The worker capability is enabled only in this complete forward migration.
CREATE OR REPLACE FUNCTION public.pb_ritual_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_ritual_service(); RETURN jsonb_build_object('ready',true,'version',1,'maximumPerCouple',20,'pageMaximum',20,'proofSeconds',30,'deliveryVersion',1); END $$;
COMMIT;
