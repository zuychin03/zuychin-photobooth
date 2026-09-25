BEGIN;

CREATE TABLE IF NOT EXISTS public.pb_memory_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subject_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  source_kind text NOT NULL CHECK(source_kind IN ('strip','project_asset')), source_id uuid NOT NULL,
  scope_kind text NOT NULL CHECK(scope_kind IN ('personal','couple','project')), scope_id uuid,
  occurred_at timestamptz NOT NULL, provenance text NOT NULL CHECK(provenance IN ('saved_at','verified_at','legacy_created_at')),
  state text NOT NULL CHECK(state IN ('available','archive_pending','archived','expired','deleted','unknown')),
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), chapter_id uuid, occasion text CHECK(length(occasion) BETWEEN 1 AND 80),
  UNIQUE(source_kind,source_id,subject_id), CHECK((scope_kind='personal')=(scope_id IS NULL))
);
CREATE INDEX IF NOT EXISTS pb_memory_activity_subject ON public.pb_memory_activity(subject_id,id);
CREATE INDEX IF NOT EXISTS pb_memory_activity_source ON public.pb_memory_activity(source_kind,source_id);
CREATE INDEX IF NOT EXISTS pb_memory_activity_scope ON public.pb_memory_activity(scope_kind,scope_id,id);
CREATE TABLE IF NOT EXISTS public.pb_memory_months (
  subject_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  month_key integer NOT NULL CHECK(month_key=0 OR (month_key/100 BETWEEN 1970 AND 2199 AND month_key%100 BETWEEN 1 AND 12)),
  total bigint NOT NULL CHECK(total>=0), PRIMARY KEY(subject_id,month_key)
);
CREATE TABLE IF NOT EXISTS public.pb_memory_chapters (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 80), revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.pb_strips ADD COLUMN IF NOT EXISTS activity_recorded_at timestamptz;
ALTER TABLE public.pb_project_assets ADD COLUMN IF NOT EXISTS activity_recorded_at timestamptz;
CREATE INDEX IF NOT EXISTS pb_memory_strip_unrecorded ON public.pb_strips(id) WHERE activity_recorded_at IS NULL;
CREATE INDEX IF NOT EXISTS pb_memory_asset_unrecorded ON public.pb_project_assets(id) WHERE activity_recorded_at IS NULL AND kind='photo' AND status='ready';
REVOKE UPDATE(activity_recorded_at) ON public.pb_strips FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.pb_memory_actor(p_actor uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.pb_project_require_service();
  IF p_actor IS NULL OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_actor) THEN RAISE EXCEPTION 'PB_MEMORY_DENIED'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.pb_memory_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_project_require_service(); RETURN jsonb_build_object('version',1,'ready',true,'detailLimit',2000,'annotatedLimit',500,'chapterLimit',100,'pageLimit',50,'summaryTimezone','UTC'); END $$;

CREATE OR REPLACE FUNCTION public.pb_memory_record(p_subject uuid,p_kind text,p_source uuid,p_scope_kind text,p_scope uuid,p_at timestamptz,p_provenance text,p_state text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE inserted uuid; month integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pb-memory:'||p_subject,0));
  INSERT INTO public.pb_memory_activity(subject_id,source_kind,source_id,scope_kind,scope_id,occurred_at,provenance,state)
    VALUES(p_subject,p_kind,p_source,p_scope_kind,p_scope,p_at,p_provenance,p_state) ON CONFLICT(source_kind,source_id,subject_id) DO NOTHING RETURNING id INTO inserted;
  IF inserted IS NULL THEN RETURN; END IF;
  month=CASE WHEN extract(year FROM p_at AT TIME ZONE 'UTC') BETWEEN 1970 AND 2199 THEN extract(year FROM p_at AT TIME ZONE 'UTC')::integer*100+extract(month FROM p_at AT TIME ZONE 'UTC')::integer ELSE 0 END;
  INSERT INTO public.pb_memory_months(subject_id,month_key,total) VALUES(p_subject,month,1) ON CONFLICT(subject_id,month_key) DO UPDATE SET total=pb_memory_months.total+1;
  DELETE FROM public.pb_memory_activity WHERE id IN (
    SELECT id FROM public.pb_memory_activity WHERE subject_id=p_subject AND chapter_id IS NULL AND occasion IS NULL ORDER BY occurred_at DESC,id DESC OFFSET 2000
  );
END $$;

CREATE OR REPLACE FUNCTION public.pb_memory_source_hook() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.pb_strips; a public.pb_project_assets; moment timestamptz; availability text;
BEGIN
  IF TG_TABLE_NAME='pb_strips' THEN
    IF TG_OP='DELETE' THEN s=OLD; ELSE s=NEW; END IF;
    IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=s.owner) THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
    IF TG_OP='INSERT' THEN s.activity_recorded_at=NULL; ELSIF TG_OP='UPDATE' THEN s.activity_recorded_at=OLD.activity_recorded_at; END IF;
    availability=CASE WHEN TG_OP='DELETE' THEN 'deleted' WHEN s.purged AND s.cloudinary_public_id IS NOT NULL THEN CASE WHEN s.archive_verified_at IS NOT NULL THEN 'archived' ELSE 'unknown' END WHEN s.purged THEN 'expired' WHEN s.kept AND s.archive_verified_at IS NULL THEN 'archive_pending' ELSE 'available' END;
    IF s.activity_recorded_at IS NULL THEN
      PERFORM public.pb_memory_record(s.owner,'strip',s.id,CASE WHEN s.couple_id IS NULL THEN 'personal' ELSE 'couple' END,s.couple_id,s.created_at,'saved_at',availability);
      s.activity_recorded_at=s.created_at;
    END IF;
    UPDATE public.pb_memory_activity SET state=availability WHERE source_kind='strip' AND source_id=s.id;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    NEW.activity_recorded_at=s.activity_recorded_at; RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN a=OLD; ELSE a=NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=a.owner_id) THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  IF TG_OP='INSERT' THEN a.activity_recorded_at=NULL; ELSIF TG_OP='UPDATE' THEN a.activity_recorded_at=OLD.activity_recorded_at; END IF;
  availability=CASE WHEN TG_OP='DELETE' OR a.status='deleted' THEN 'deleted' WHEN a.status='expired' THEN 'expired' WHEN a.status='ready' THEN 'available' ELSE 'unknown' END;
  IF a.kind='photo' AND a.activity_recorded_at IS NULL AND a.status='ready' THEN
    moment=CASE WHEN TG_OP='UPDATE' AND OLD.status<>'ready' THEN statement_timestamp() ELSE a.created_at END;
    PERFORM public.pb_memory_record(a.owner_id,'project_asset',a.id,'project',a.project_id,moment,CASE WHEN TG_OP='UPDATE' AND OLD.status<>'ready' THEN 'verified_at' ELSE 'legacy_created_at' END,availability);
    a.activity_recorded_at=moment;
  END IF;
  UPDATE public.pb_memory_activity SET state=availability WHERE source_kind='project_asset' AND source_id=a.id;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  NEW.activity_recorded_at=a.activity_recorded_at; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS zz_pb_memory_strip ON public.pb_strips;
CREATE TRIGGER zz_pb_memory_strip BEFORE INSERT OR UPDATE OR DELETE ON public.pb_strips FOR EACH ROW EXECUTE FUNCTION public.pb_memory_source_hook();
DROP TRIGGER IF EXISTS zz_pb_memory_asset ON public.pb_project_assets;
CREATE TRIGGER zz_pb_memory_asset BEFORE INSERT OR UPDATE OR DELETE ON public.pb_project_assets FOR EACH ROW EXECUTE FUNCTION public.pb_memory_source_hook();

CREATE OR REPLACE FUNCTION public.pb_memory_scope_visible(a public.pb_memory_activity,p_actor uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT CASE WHEN a.scope_kind='personal' THEN a.subject_id=p_actor
    WHEN a.scope_kind='couple' THEN EXISTS(SELECT 1 FROM public.pb_couples c WHERE c.id=a.scope_id AND p_actor IN (c.member_a,c.member_b) AND a.subject_id IN (c.member_a,c.member_b))
    WHEN a.scope_kind='project' THEN EXISTS(SELECT 1 FROM public.pb_projects p JOIN public.pb_project_members m ON m.project_id=p.id JOIN public.pb_project_members author ON author.project_id=p.id WHERE p.id=a.scope_id AND p.status='active' AND m.user_id=p_actor AND m.status='accepted' AND author.user_id=a.subject_id AND author.status='accepted')
      AND public.pb_project_protection_read(a.source_id,p_actor)
    ELSE false END
$$;
CREATE OR REPLACE FUNCTION public.pb_memory_projection(a public.pb_memory_activity,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE visible boolean=public.pb_memory_scope_visible(a,p_actor); result jsonb;
BEGIN
  IF a.subject_id<>p_actor AND NOT visible THEN RETURN NULL; END IF;
  result=jsonb_build_object('id',a.id,'mine',a.subject_id=p_actor,'occurredAt',a.occurred_at,'provenance',a.provenance,'availability',CASE WHEN visible THEN a.state ELSE 'access_lost' END);
  IF visible THEN result=result||jsonb_build_object('sourceKind',a.source_kind,'sourceId',a.source_id,'scopeKind',a.scope_kind,'scopeId',a.scope_id); END IF;
  IF a.subject_id=p_actor THEN result=result||jsonb_build_object('revision',a.revision,'chapterId',a.chapter_id,'occasion',a.occasion); END IF;
  RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.pb_memory_list(p_actor uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 20) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE rows jsonb; cursor uuid;
BEGIN
  PERFORM public.pb_memory_actor(p_actor); IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'PB_MEMORY_INVALID'; END IF;
  SELECT coalesce(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
    SELECT a.id,public.pb_memory_projection(a,p_actor) item FROM public.pb_memory_activity a WHERE (p_after IS NULL OR a.id>p_after) AND (a.subject_id=p_actor OR public.pb_memory_scope_visible(a,p_actor)) ORDER BY a.id LIMIT p_limit+1
  ) bounded;
  IF jsonb_array_length(rows)>p_limit THEN rows=rows-(jsonb_array_length(rows)-1); cursor=(rows->(p_limit-1)->>'id')::uuid; END IF;
  RETURN jsonb_build_object('items',rows,'nextCursor',cursor);
END $$;
CREATE OR REPLACE FUNCTION public.pb_memory_summary(p_actor uuid,p_year integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.pb_memory_actor(p_actor); IF p_year IS NULL OR p_year NOT BETWEEN 1970 AND 2199 THEN RAISE EXCEPTION 'PB_MEMORY_INVALID'; END IF;
  RETURN jsonb_build_object('year',p_year,'timezone','UTC','basis','own_source_records','months',(SELECT jsonb_agg(jsonb_build_object('month',month,'total',coalesce(m.total,0)) ORDER BY month) FROM generate_series(1,12) month LEFT JOIN public.pb_memory_months m ON m.subject_id=p_actor AND m.month_key=p_year*100+month),'outsideCalendar',(SELECT coalesce(max(total),0) FROM public.pb_memory_months WHERE subject_id=p_actor AND month_key=0));
END $$;

CREATE OR REPLACE FUNCTION public.pb_memory_chapter_projection(c public.pb_memory_chapters) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('id',c.id,'title',c.title,'revision',c.revision,'createdAt',c.created_at)
$$;
CREATE OR REPLACE FUNCTION public.pb_memory_chapters_list(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_memory_actor(p_actor); RETURN jsonb_build_object('chapters',(SELECT coalesce(jsonb_agg(public.pb_memory_chapter_projection(c) ORDER BY c.id),'[]') FROM public.pb_memory_chapters c WHERE owner_id=p_actor)); END $$;
CREATE OR REPLACE FUNCTION public.pb_memory_chapter_put(p_actor uuid,p_id uuid,p_expected integer,p_title text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_memory_chapters;
BEGIN
  PERFORM public.pb_memory_actor(p_actor); IF p_id IS NULL OR p_title IS NULL OR length(p_title) NOT BETWEEN 1 AND 80 OR p_title<>btrim(p_title) OR p_title ~ '[[:cntrl:]]' OR p_expected IS NULL OR p_expected < -1 THEN RAISE EXCEPTION 'PB_MEMORY_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pb-memory:'||p_actor,0)); SELECT * INTO c FROM public.pb_memory_chapters WHERE id=p_id FOR UPDATE;
  IF FOUND THEN
    IF c.owner_id<>p_actor THEN RAISE EXCEPTION 'PB_MEMORY_DENIED'; END IF;
    IF c.revision<>p_expected THEN RAISE EXCEPTION 'PB_MEMORY_CONFLICT'; END IF;
    UPDATE public.pb_memory_chapters SET title=p_title,revision=revision+1 WHERE id=p_id RETURNING * INTO c;
  ELSE
    IF p_expected<>-1 THEN RAISE EXCEPTION 'PB_MEMORY_CONFLICT'; END IF;
    IF (SELECT count(*) FROM public.pb_memory_chapters WHERE owner_id=p_actor)>=100 THEN RAISE EXCEPTION 'PB_MEMORY_CAPACITY'; END IF;
    INSERT INTO public.pb_memory_chapters(id,owner_id,title) VALUES(p_id,p_actor,p_title) RETURNING * INTO c;
  END IF;
  RETURN public.pb_memory_chapter_projection(c);
END $$;
CREATE OR REPLACE FUNCTION public.pb_memory_annotate(p_actor uuid,p_id uuid,p_expected integer,p_chapter uuid,p_occasion text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.pb_memory_activity;
BEGIN
  PERFORM public.pb_memory_actor(p_actor); IF p_expected IS NULL OR p_expected<0 OR (p_occasion IS NOT NULL AND (length(p_occasion) NOT BETWEEN 1 AND 80 OR p_occasion<>btrim(p_occasion) OR p_occasion ~ '[[:cntrl:]]')) THEN RAISE EXCEPTION 'PB_MEMORY_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pb-memory:'||p_actor,0)); SELECT * INTO a FROM public.pb_memory_activity WHERE id=p_id AND subject_id=p_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PB_MEMORY_DENIED'; END IF;
  IF a.revision<>p_expected THEN RAISE EXCEPTION 'PB_MEMORY_CONFLICT'; END IF;
  IF p_chapter IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.pb_memory_chapters WHERE id=p_chapter AND owner_id=p_actor) THEN RAISE EXCEPTION 'PB_MEMORY_DENIED'; END IF;
  IF (p_chapter IS NOT NULL OR p_occasion IS NOT NULL) AND a.chapter_id IS NULL AND a.occasion IS NULL AND (SELECT count(*) FROM public.pb_memory_activity WHERE subject_id=p_actor AND (chapter_id IS NOT NULL OR occasion IS NOT NULL))>=500 THEN RAISE EXCEPTION 'PB_MEMORY_CAPACITY'; END IF;
  UPDATE public.pb_memory_activity SET chapter_id=p_chapter,occasion=p_occasion,revision=revision+1 WHERE id=p_id RETURNING * INTO a;
  DELETE FROM public.pb_memory_activity WHERE id IN (SELECT id FROM public.pb_memory_activity WHERE subject_id=p_actor AND chapter_id IS NULL AND occasion IS NULL ORDER BY (id=p_id) DESC,occurred_at DESC,id DESC OFFSET 2000);
  RETURN public.pb_memory_projection(a,p_actor);
END $$;
CREATE OR REPLACE FUNCTION public.pb_memory_chapter_delete(p_actor uuid,p_id uuid,p_expected integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_memory_chapters;
BEGIN
  PERFORM public.pb_memory_actor(p_actor); PERFORM pg_advisory_xact_lock(hashtextextended('pb-memory:'||p_actor,0)); SELECT * INTO c FROM public.pb_memory_chapters WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR c.owner_id<>p_actor THEN RAISE EXCEPTION 'PB_MEMORY_DENIED'; END IF;
  IF p_expected IS NULL OR c.revision<>p_expected THEN RAISE EXCEPTION 'PB_MEMORY_CONFLICT'; END IF;
  IF EXISTS(SELECT 1 FROM public.pb_memory_activity WHERE chapter_id=p_id) THEN RAISE EXCEPTION 'PB_MEMORY_NOT_EMPTY'; END IF;
  DELETE FROM public.pb_memory_chapters WHERE id=p_id; RETURN jsonb_build_object('deleted',true);
END $$;
CREATE OR REPLACE FUNCTION public.pb_memory_backfill(p_limit integer DEFAULT 25) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ids uuid[]; strips integer=0; assets integer=0;
BEGIN
  PERFORM public.pb_project_require_service(); IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'PB_MEMORY_INVALID'; END IF;
  SELECT array_agg(id) INTO ids FROM (SELECT id FROM public.pb_strips WHERE activity_recorded_at IS NULL ORDER BY id LIMIT p_limit FOR UPDATE SKIP LOCKED) batch;
  UPDATE public.pb_strips SET activity_recorded_at=NULL WHERE id=ANY(ids); GET DIAGNOSTICS strips=ROW_COUNT;
  IF strips<p_limit THEN
    SELECT array_agg(id) INTO ids FROM (SELECT id FROM public.pb_project_assets WHERE kind='photo' AND status='ready' AND activity_recorded_at IS NULL ORDER BY id LIMIT p_limit-strips FOR UPDATE SKIP LOCKED) batch;
    UPDATE public.pb_project_assets SET activity_recorded_at=NULL WHERE id=ANY(ids); GET DIAGNOSTICS assets=ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('processed',strips+assets);
END $$;

DO $$ DECLARE t text; f record;
BEGIN
  FOREACH t IN ARRAY ARRAY['pb_memory_activity','pb_memory_months','pb_memory_chapters'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'pb_memory_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature); END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.pb_memory_capabilities(),public.pb_memory_list(uuid,uuid,integer),public.pb_memory_summary(uuid,integer),public.pb_memory_chapters_list(uuid),public.pb_memory_chapter_put(uuid,uuid,integer,text),public.pb_memory_annotate(uuid,uuid,integer,uuid,text),public.pb_memory_chapter_delete(uuid,uuid,integer),public.pb_memory_backfill(integer) TO service_role;
COMMIT;
