BEGIN;

ALTER TABLE public.pb_photo_dates ADD COLUMN IF NOT EXISTS ritual_version integer;
ALTER TABLE public.pb_photo_dates ADD COLUMN IF NOT EXISTS ritual_schedule jsonb;
ALTER TABLE public.pb_photo_dates ADD COLUMN IF NOT EXISTS ritual_revision integer NOT NULL DEFAULT 0;
ALTER TABLE public.pb_photo_dates ADD COLUMN IF NOT EXISTS ritual_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.pb_photo_dates ADD COLUMN IF NOT EXISTS ritual_paused boolean NOT NULL DEFAULT false;
ALTER TABLE public.pb_photo_dates ADD COLUMN IF NOT EXISTS ritual_next jsonb;
ALTER TABLE public.pb_photo_dates ADD COLUMN IF NOT EXISTS ritual_recipients uuid[];
ALTER TABLE public.pb_photo_dates ADD COLUMN IF NOT EXISTS ritual_request jsonb;
ALTER TABLE public.pb_photo_dates ADD COLUMN IF NOT EXISTS ritual_deleted boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS pb_ritual_due ON public.pb_photo_dates(scheduled_at,id) WHERE ritual_version=1 AND ritual_enabled AND NOT ritual_paused AND NOT ritual_deleted;
CREATE INDEX IF NOT EXISTS pb_ritual_listing ON public.pb_photo_dates(couple_id,id) WHERE NOT ritual_deleted;
CREATE TABLE IF NOT EXISTS public.pb_ritual_channels (
  date_id uuid NOT NULL REFERENCES public.pb_photo_dates ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  email boolean NOT NULL DEFAULT false, push boolean NOT NULL DEFAULT false,
  PRIMARY KEY(date_id,recipient_id)
);
ALTER TABLE public.pb_ritual_channels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pb_ritual_channels FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.pb_ritual_service() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF coalesce(auth.role(),'')<>'service_role' OR NOT (current_setting('role',true)='service_role' OR session_user='service_role') THEN RAISE EXCEPTION 'PB_RITUAL_DENIED'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.pb_ritual_couple(p_actor uuid,p_couple uuid) RETURNS public.pb_couples LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_couples;
BEGIN
  PERFORM public.pb_ritual_service(); SELECT * INTO c FROM public.pb_couples WHERE id=p_couple FOR UPDATE;
  IF p_actor IS NULL OR c.id IS NULL OR p_actor IS DISTINCT FROM c.member_a AND p_actor IS DISTINCT FROM c.member_b THEN RAISE EXCEPTION 'PB_RITUAL_DENIED'; END IF;
  RETURN c;
END $$;
CREATE OR REPLACE FUNCTION public.pb_ritual_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_couples; internal boolean := coalesce(current_setting('pb.ritual_write',true),'')='on' AND coalesce(auth.role(),'')='service_role' AND (current_setting('role',true)='service_role' OR session_user='service_role');
BEGIN
  IF TG_OP='DELETE' THEN
    IF (OLD.ritual_version IS NOT NULL OR OLD.ritual_deleted) AND NOT internal AND EXISTS(SELECT 1 FROM public.pb_couples WHERE id=OLD.couple_id) THEN RAISE EXCEPTION 'PB_RITUAL_DENIED'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' THEN SELECT * INTO c FROM public.pb_couples WHERE id=NEW.couple_id FOR UPDATE;
  ELSE SELECT * INTO c FROM public.pb_couples WHERE id=NEW.couple_id; END IF;
  IF c.id IS NULL OR NEW.created_by IS DISTINCT FROM c.member_a AND NEW.created_by IS DISTINCT FROM c.member_b THEN RAISE EXCEPTION 'PB_RITUAL_DENIED'; END IF;
  IF TG_OP='UPDATE' AND (NEW.id,NEW.couple_id,NEW.created_by,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.couple_id,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'PB_RITUAL_DENIED'; END IF;
  IF TG_OP='INSERT' THEN
    IF (SELECT count(*) FROM public.pb_photo_dates WHERE couple_id=NEW.couple_id AND NOT ritual_deleted)>=20 THEN RAISE EXCEPTION 'PB_RITUAL_CAPACITY'; END IF;
    IF NOT internal AND (auth.uid() IS NULL OR NEW.created_by<>auth.uid()) THEN RAISE EXCEPTION 'PB_RITUAL_DENIED'; END IF;
  END IF;
  IF TG_OP='INSERT' OR NEW.title IS DISTINCT FROM OLD.title THEN
    IF length(NEW.title) NOT BETWEEN 1 AND 100 OR btrim(NEW.title)='' OR NEW.title ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  END IF;
  IF NEW.cadence NOT IN ('once','weekly','monthly','yearly') THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  IF NOT internal THEN
    IF NEW.ritual_version IS NOT NULL OR NEW.ritual_schedule IS NOT NULL OR NEW.ritual_revision<>0 OR NEW.ritual_enabled OR NEW.ritual_paused OR NEW.ritual_next IS NOT NULL OR NEW.ritual_recipients IS NOT NULL OR NEW.ritual_request IS NOT NULL OR NEW.ritual_deleted OR TG_OP='UPDATE' AND OLD.ritual_version IS NOT NULL THEN RAISE EXCEPTION 'PB_RITUAL_DENIED'; END IF;
  ELSIF NEW.ritual_version IS NULL THEN
    IF TG_OP<>'UPDATE' OR OLD.ritual_version IS NOT NULL OR NOT NEW.ritual_deleted OR NEW.active OR NEW.ritual_revision<>OLD.ritual_revision+1 OR NEW.ritual_schedule IS NOT NULL OR NEW.ritual_request IS NOT NULL OR NEW.ritual_recipients IS NOT NULL OR NEW.ritual_next IS NOT NULL OR NEW.ritual_enabled OR NEW.ritual_paused THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  ELSIF NEW.ritual_version IS DISTINCT FROM 1 OR NEW.active OR NEW.ritual_revision<0 OR NEW.ritual_schedule IS NULL OR NEW.ritual_request IS NULL OR cardinality(NEW.ritual_recipients) NOT BETWEEN 1 AND 2 OR NEW.ritual_enabled AND (NEW.ritual_paused OR NEW.ritual_deleted OR NEW.ritual_next IS NULL) THEN
    RAISE EXCEPTION 'PB_RITUAL_INVALID';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pb_ritual_guard ON public.pb_photo_dates;
CREATE TRIGGER pb_ritual_guard BEFORE INSERT OR UPDATE OR DELETE ON public.pb_photo_dates FOR EACH ROW EXECUTE FUNCTION public.pb_ritual_guard();
DROP POLICY IF EXISTS pb_ritual_legacy_only ON public.pb_photo_dates;
CREATE POLICY pb_ritual_legacy_only ON public.pb_photo_dates AS RESTRICTIVE FOR ALL TO authenticated USING (
  ritual_version IS NULL AND NOT ritual_deleted AND EXISTS(SELECT 1 FROM public.pb_couples c WHERE c.id=couple_id AND auth.uid() IN (c.member_a,c.member_b))
) WITH CHECK (ritual_version IS NULL AND NOT ritual_deleted AND EXISTS(SELECT 1 FROM public.pb_couples c WHERE c.id=couple_id AND auth.uid() IN (c.member_a,c.member_b)));

CREATE OR REPLACE FUNCTION public.pb_ritual_projection(d public.pb_photo_dates,p_actor uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object('id',d.id,'coupleId',d.couple_id,'creatorId',d.created_by,'title',d.title,'revision',d.ritual_revision,
    'legacy',d.ritual_version IS NULL,'scheduledAt',d.scheduled_at,'cadence',d.cadence,'active',d.active,'schedule',d.ritual_schedule,
    'next',d.ritual_next,'paused',d.ritual_paused,'enabled',d.ritual_enabled,
    'channels',coalesce((SELECT jsonb_build_object('email',email,'push',push) FROM public.pb_ritual_channels WHERE date_id=d.id AND recipient_id=p_actor),'{"email":false,"push":false}'::jsonb))
$$;
CREATE OR REPLACE FUNCTION public.pb_ritual_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_ritual_service(); RETURN jsonb_build_object('ready',true,'version',1,'maximumPerCouple',20,'pageMaximum',20,'proofSeconds',30,'deliveryVersion',0); END $$;
CREATE OR REPLACE FUNCTION public.pb_ritual_context(p_actor uuid,p_couple uuid,p_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.pb_photo_dates;
BEGIN
  PERFORM public.pb_ritual_couple(p_actor,p_couple);
  IF p_id IS NOT NULL THEN
    SELECT * INTO d FROM public.pb_photo_dates WHERE id=p_id AND couple_id=p_couple AND NOT ritual_deleted;
    IF d.id IS NULL OR d.ritual_version IS NOT NULL AND NOT p_actor=ANY(d.ritual_recipients) THEN RAISE EXCEPTION 'PB_RITUAL_DENIED'; END IF;
  END IF;
  RETURN jsonb_build_object('now',clock_timestamp(),'row',CASE WHEN d.id IS NULL THEN NULL ELSE public.pb_ritual_projection(d,p_actor) END);
END $$;
CREATE OR REPLACE FUNCTION public.pb_ritual_list(p_actor uuid,p_couple uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 20) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE items jsonb; cursor uuid;
BEGIN
  PERFORM public.pb_ritual_couple(p_actor,p_couple);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  SELECT coalesce(jsonb_agg(public.pb_ritual_projection(d,p_actor) ORDER BY id),'[]') INTO items FROM (
    SELECT * FROM public.pb_photo_dates WHERE couple_id=p_couple AND NOT ritual_deleted AND (ritual_version IS NULL OR p_actor=ANY(ritual_recipients)) AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT p_limit
  ) d;
  IF jsonb_array_length(items)=p_limit THEN
    cursor:=(items->(p_limit-1)->>'id')::uuid;
    IF NOT EXISTS(SELECT 1 FROM public.pb_photo_dates WHERE couple_id=p_couple AND NOT ritual_deleted AND (ritual_version IS NULL OR p_actor=ANY(ritual_recipients)) AND id>cursor) THEN cursor:=NULL; END IF;
  END IF;
  RETURN jsonb_build_object('version',1,'items',items,'nextCursor',cursor);
END $$;

CREATE OR REPLACE FUNCTION public.pb_ritual_validate(p_schedule jsonb,p_proof jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o jsonb; checked_date date; instant timestamptz; computed timestamptz;
BEGIN
  PERFORM public.pb_ritual_service();
  IF jsonb_typeof(p_schedule) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(p_schedule) e WHERE e.key NOT IN ('version','interval','onceAt') AND jsonb_typeof(e.value)<>'string') THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  IF jsonb_typeof(p_schedule) IS DISTINCT FROM 'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_schedule) key) IS DISTINCT FROM ARRAY['anchorDate','fold','frequency','gap','interval','invalidDate','localTime','onceAt','timeZone','version'] OR p_schedule->'version'<>'1'::jsonb OR p_schedule->>'frequency' NOT IN ('once','weekly','monthly','yearly') OR p_schedule->>'invalidDate' NOT IN ('clamp','skip') OR p_schedule->>'gap' NOT IN ('shift-forward','skip') OR p_schedule->>'fold' NOT IN ('earlier','later') OR p_schedule->>'interval' !~ '^([1-9]|1[0-2])$' OR jsonb_typeof(p_schedule->'interval')<>'number' OR p_schedule->>'anchorDate' !~ '^\d{4}-\d{2}-\d{2}$' OR p_schedule->>'localTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR length(p_schedule->>'timeZone')>100 OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=p_schedule->>'timeZone') THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  checked_date:=(p_schedule->>'anchorDate')::date;
  IF checked_date<date '1970-01-01' OR checked_date>date '2199-12-31' THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  IF p_schedule->>'frequency'='once' THEN
    instant:=(p_schedule->>'onceAt')::timestamptz;
    IF instant IS NULL OR p_schedule->>'interval'<>'1' OR to_char(instant AT TIME ZONE (p_schedule->>'timeZone'),'YYYY-MM-DD')<>p_schedule->>'anchorDate' OR to_char(instant AT TIME ZONE (p_schedule->>'timeZone'),'HH24:MI')<>p_schedule->>'localTime' THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  ELSIF p_schedule->'onceAt' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  IF jsonb_typeof(p_proof) IS DISTINCT FROM 'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_proof) key) IS DISTINCT FROM ARRAY['computedAt','occurrence'] THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  IF jsonb_typeof(p_proof->'computedAt') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  computed:=(p_proof->>'computedAt')::timestamptz;
  IF computed IS NULL OR computed<clock_timestamp()-interval '30 seconds' OR computed>clock_timestamp()+interval '1 second' THEN RAISE EXCEPTION 'PB_RITUAL_STALE_PROOF'; END IF;
  o:=p_proof->'occurrence';
  IF o='null'::jsonb THEN RETURN; END IF;
  IF jsonb_typeof(o) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(o) e WHERE e.key NOT IN ('cycle','adjustments') AND jsonb_typeof(e.value)<>'string') THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  IF jsonb_typeof(o) IS DISTINCT FROM 'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(o) key) IS DISTINCT FROM ARRAY['adjustments','cycle','instant','localDate','localTime','scheduledDate'] OR o->>'cycle' !~ '^\d{1,7}$' OR jsonb_typeof(o->'cycle')<>'number' OR (o->>'cycle')::integer>1000000 OR jsonb_typeof(o->'adjustments') IS DISTINCT FROM 'array' OR jsonb_array_length(o->'adjustments')>2 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(o->'adjustments') a WHERE a NOT IN ('date-clamp','gap-shift','fold-earlier','fold-later')) OR o->>'localDate' !~ '^\d{4}-\d{2}-\d{2}$' OR o->>'scheduledDate' !~ '^\d{4}-\d{2}-\d{2}$' OR o->>'localTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  instant:=(o->>'instant')::timestamptz;
  IF instant IS NULL OR instant<=clock_timestamp() OR instant>=timestamptz '2200-01-02 UTC' OR p_schedule->>'frequency'='once' AND (instant<>(p_schedule->>'onceAt')::timestamptz OR o->>'cycle'<>'0') THEN RAISE EXCEPTION 'PB_RITUAL_STALE_PROOF'; END IF;
  IF to_char(instant AT TIME ZONE (p_schedule->>'timeZone'),'YYYY-MM-DD') IS DISTINCT FROM o->>'localDate' OR to_char(instant AT TIME ZONE (p_schedule->>'timeZone'),'HH24:MI') IS DISTINCT FROM o->>'localTime' THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pb_ritual_save(p_actor uuid,p_couple uuid,p_id uuid,p_action text,p_revision integer,p_title text,p_schedule jsonb,p_proof jsonb,p_expected_legacy timestamptz DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_couples; d public.pb_photo_dates; request jsonb; occurrence jsonb;
BEGIN
  c:=public.pb_ritual_couple(p_actor,p_couple);
  IF p_id IS NULL OR p_action NOT IN ('create','upgrade','edit') OR p_action IS NULL OR length(p_title) NOT BETWEEN 1 AND 100 OR p_title IS NULL OR btrim(p_title)='' OR p_title ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  request:=jsonb_build_object('title',p_title,'schedule',p_schedule);
  SELECT * INTO d FROM public.pb_photo_dates WHERE id=p_id FOR UPDATE;
  IF d.id IS NOT NULL AND (d.couple_id<>p_couple OR d.created_by<>p_actor) THEN RAISE EXCEPTION 'PB_RITUAL_DENIED'; END IF;
  IF p_action='create' AND d.id IS NOT NULL THEN
    IF d.ritual_deleted OR d.ritual_version IS DISTINCT FROM 1 OR d.ritual_request IS DISTINCT FROM request THEN RAISE EXCEPTION 'PB_RITUAL_CONFLICT'; END IF;
    RETURN public.pb_ritual_projection(d,p_actor);
  END IF;
  IF p_action<>'create' AND (d.id IS NULL OR d.ritual_deleted) THEN RAISE EXCEPTION 'PB_RITUAL_DENIED'; END IF;
  IF p_revision IS NULL OR p_revision<0 OR p_revision>=2147483646 OR (p_action='create' AND p_revision<>0) OR (d.id IS NOT NULL AND d.ritual_revision<>p_revision) THEN RAISE EXCEPTION 'PB_RITUAL_CONFLICT'; END IF;
  IF p_action='upgrade' AND (d.ritual_version IS NOT NULL OR p_expected_legacy IS NULL OR d.scheduled_at<>p_expected_legacy) OR p_action='edit' AND d.ritual_version IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'PB_RITUAL_CONFLICT'; END IF;
  PERFORM public.pb_ritual_validate(p_schedule,p_proof); occurrence:=nullif(p_proof->'occurrence','null'::jsonb);
  IF p_action IN ('create','upgrade') AND occurrence IS NULL THEN RAISE EXCEPTION 'PB_RITUAL_NO_FUTURE'; END IF;
  PERFORM set_config('pb.ritual_write','on',true);
  IF p_action='create' THEN
    INSERT INTO public.pb_photo_dates(id,couple_id,created_by,title,scheduled_at,cadence,active,ritual_version,ritual_schedule,ritual_revision,ritual_enabled,ritual_next,ritual_recipients,ritual_request)
    VALUES(p_id,p_couple,p_actor,p_title,(occurrence->>'instant')::timestamptz,p_schedule->>'frequency',false,1,p_schedule,0,true,occurrence,array_remove(ARRAY[c.member_a,c.member_b],NULL),request) RETURNING * INTO d;
  ELSE
    UPDATE public.pb_photo_dates SET title=p_title,cadence=p_schedule->>'frequency',active=false,ritual_version=1,ritual_schedule=p_schedule,ritual_revision=ritual_revision+1,
      ritual_enabled=occurrence IS NOT NULL AND NOT ritual_paused,ritual_next=occurrence,scheduled_at=coalesce((occurrence->>'instant')::timestamptz,scheduled_at),
      ritual_recipients=coalesce(ritual_recipients,array_remove(ARRAY[c.member_a,c.member_b],NULL)),ritual_request=coalesce(ritual_request,request) WHERE id=p_id RETURNING * INTO d;
  END IF;
  PERFORM set_config('pb.ritual_write','off',true);
  RETURN public.pb_ritual_projection(d,p_actor);
END $$;
CREATE OR REPLACE FUNCTION public.pb_ritual_action(p_actor uuid,p_couple uuid,p_id uuid,p_revision integer,p_action text,p_proof jsonb DEFAULT NULL,p_channels jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.pb_photo_dates; occurrence jsonb;
BEGIN
  PERFORM public.pb_ritual_couple(p_actor,p_couple);
  SELECT * INTO d FROM public.pb_photo_dates WHERE id=p_id AND couple_id=p_couple FOR UPDATE;
  IF d.id IS NOT NULL AND NOT d.ritual_deleted AND d.ritual_version IS NULL AND d.created_by=p_actor AND p_action='delete' THEN
    IF p_revision IS NULL OR p_revision<>d.ritual_revision THEN RAISE EXCEPTION 'PB_RITUAL_CONFLICT'; END IF;
    PERFORM set_config('pb.ritual_write','on',true);
    UPDATE public.pb_photo_dates SET active=false,ritual_deleted=true,ritual_revision=ritual_revision+1 WHERE id=p_id RETURNING * INTO d;
    PERFORM set_config('pb.ritual_write','off',true);
    RETURN jsonb_build_object('id',p_id,'deleted',true,'revision',d.ritual_revision);
  END IF;
  IF d.id IS NULL OR d.ritual_deleted OR d.ritual_version IS DISTINCT FROM 1 OR NOT p_actor=ANY(d.ritual_recipients) OR p_action<>'channels' AND d.created_by<>p_actor THEN RAISE EXCEPTION 'PB_RITUAL_DENIED'; END IF;
  IF p_revision IS NULL OR p_revision<>d.ritual_revision OR p_revision>=2147483646 THEN RAISE EXCEPTION 'PB_RITUAL_CONFLICT'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('pause','resume','delete','channels') THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
  IF p_action='resume' THEN PERFORM public.pb_ritual_validate(d.ritual_schedule,p_proof); occurrence:=nullif(p_proof->'occurrence','null'::jsonb); END IF;
  IF p_action='channels' THEN
    IF jsonb_typeof(p_channels) IS DISTINCT FROM 'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_channels) key) IS DISTINCT FROM ARRAY['email','push'] OR jsonb_typeof(p_channels->'email') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_channels->'push') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'PB_RITUAL_INVALID'; END IF;
    INSERT INTO public.pb_ritual_channels(date_id,recipient_id,email,push) VALUES(p_id,p_actor,(p_channels->>'email')::boolean,(p_channels->>'push')::boolean)
    ON CONFLICT(date_id,recipient_id) DO UPDATE SET email=excluded.email,push=excluded.push;
  END IF;
  PERFORM set_config('pb.ritual_write','on',true);
  UPDATE public.pb_photo_dates SET ritual_revision=ritual_revision+1,ritual_paused=CASE p_action WHEN 'pause' THEN true WHEN 'resume' THEN false ELSE ritual_paused END,
    ritual_deleted=p_action='delete',ritual_enabled=CASE WHEN p_action IN ('pause','delete') THEN false WHEN p_action='resume' THEN occurrence IS NOT NULL ELSE ritual_enabled END,
    ritual_next=CASE WHEN p_action='resume' THEN occurrence ELSE ritual_next END,scheduled_at=CASE WHEN p_action='resume' THEN coalesce((occurrence->>'instant')::timestamptz,scheduled_at) ELSE scheduled_at END WHERE id=p_id RETURNING * INTO d;
  PERFORM set_config('pb.ritual_write','off',true);
  IF p_action='delete' THEN RETURN jsonb_build_object('id',p_id,'deleted',true,'revision',d.ritual_revision); END IF;
  RETURN public.pb_ritual_projection(d,p_actor);
END $$;

REVOKE ALL ON FUNCTION public.pb_ritual_service(),public.pb_ritual_couple(uuid,uuid),public.pb_ritual_guard(),public.pb_ritual_projection(public.pb_photo_dates,uuid),public.pb_ritual_validate(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.pb_ritual_capabilities(),public.pb_ritual_context(uuid,uuid,uuid),public.pb_ritual_list(uuid,uuid,uuid,integer),public.pb_ritual_save(uuid,uuid,uuid,text,integer,text,jsonb,jsonb,timestamptz),public.pb_ritual_action(uuid,uuid,uuid,integer,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pb_ritual_capabilities(),public.pb_ritual_context(uuid,uuid,uuid),public.pb_ritual_list(uuid,uuid,uuid,integer),public.pb_ritual_save(uuid,uuid,uuid,text,integer,text,jsonb,jsonb,timestamptz),public.pb_ritual_action(uuid,uuid,uuid,integer,text,jsonb,jsonb) TO service_role;
COMMIT;
