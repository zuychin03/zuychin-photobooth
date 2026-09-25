BEGIN;

CREATE TABLE IF NOT EXISTS public.pb_event_exports (
  id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES public.pb_events,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), after_submission uuid,
  manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object' AND octet_length(manifest::text)<=131072),
  progress jsonb NOT NULL CHECK(jsonb_typeof(progress)='array' AND jsonb_array_length(progress)<=100 AND octet_length(progress::text)<=16384),
  revision integer NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 1000000),
  generation integer NOT NULL DEFAULT 0 CHECK(generation BETWEEN 0 AND 2147483646), retired boolean NOT NULL DEFAULT false, UNIQUE(event_id,id)
);
ALTER TABLE public.pb_event_exports ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 0 CHECK(generation BETWEEN 0 AND 2147483646);
ALTER TABLE public.pb_event_exports ADD COLUMN IF NOT EXISTS retired boolean NOT NULL DEFAULT false;
DROP FUNCTION IF EXISTS public.pb_event_export_create(uuid,uuid,uuid,uuid);
DROP FUNCTION IF EXISTS public.pb_event_export_page(uuid,uuid,uuid,integer,integer);
DROP FUNCTION IF EXISTS public.pb_event_export_access(uuid,uuid,uuid,integer);
DROP FUNCTION IF EXISTS public.pb_event_export_checkpoint(uuid,uuid,uuid,integer,jsonb);
ALTER TABLE public.pb_event_exports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pb_event_exports FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.pb_event_export_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_event_require_service(); RETURN '{"version":1,"retirementVersion":1,"manifests":8,"entries":100,"pageItems":10,"pageBytes":20000000,"manifestBytes":131072}'::jsonb; END $$;

CREATE OR REPLACE FUNCTION public.pb_event_export_owner(p_actor uuid,p_event uuid) RETURNS public.pb_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events;
BEGIN
  PERFORM public.pb_event_require_actor(p_event,p_actor,true);
  SELECT * INTO e FROM public.pb_events WHERE id=p_event;
  IF NOT FOUND OR e.owner_id IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  IF e.status='deleted' OR e.expires_at<=clock_timestamp() OR e.allocation_released THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
  RETURN e;
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_export_media(p_event uuid,p_submission uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.pb_event_submissions; c jsonb; size_text text; size_bytes bigint; w integer; h integer;
BEGIN
  PERFORM public.pb_event_require_service(); SELECT * INTO s FROM public.pb_event_submissions WHERE event_id=p_event AND id=p_submission;
  IF NOT FOUND OR s.state<>'ready' OR s.promised_expires_at<=clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM public.pb_event_publication_grants WHERE submission_id=s.id)
    OR EXISTS(SELECT 1 FROM public.pb_event_publication_grants g JOIN public.pb_event_guests v ON v.id=g.guest_id AND v.event_id=g.event_id WHERE g.submission_id=s.id AND (v.revoked OR NOT g.submission_consent)) THEN RETURN NULL; END IF;
  SELECT checkpoint INTO c FROM public.pb_event_jobs WHERE event_id=p_event AND submission_id=s.id AND kind='finalise' AND status='complete';
  IF c IS NULL OR c->'decoded' IS DISTINCT FROM 'true'::jsonb OR c->'objectsVerified' IS DISTINCT FROM 'true'::jsonb OR c->>'mime' IS DISTINCT FROM 'image/jpeg' OR coalesce(c->>'sha256','') !~ '^[a-f0-9]{64}$' OR coalesce(c->>'width','') !~ '^[0-9]{1,4}$' OR coalesce(c->>'height','') !~ '^[0-9]{1,4}$' THEN RETURN NULL; END IF;
  w=(c->>'width')::integer; h=(c->>'height')::integer;
  IF w NOT BETWEEN 1 AND 4096 OR h NOT BETWEEN 1 AND 4096 OR w::bigint*h>12582912 THEN RETURN NULL; END IF;
  SELECT metadata->>'size' INTO size_text FROM storage.objects WHERE bucket_id='photobooth-events-v2' AND name=s.delivery_path;
  IF size_text IS NULL OR size_text !~ '^[0-9]{1,7}$' THEN RETURN NULL; END IF;
  size_bytes=size_text::bigint; IF size_bytes NOT BETWEEN 1 AND 2000000 OR s.delivery_path IS DISTINCT FROM p_event||'/'||p_submission||'/image' THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('bucket','photobooth-events-v2','path',s.delivery_path,'bytes',size_bytes,'mime','image/jpeg','width',w,'height',h,'sha256',c->>'sha256');
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_export_summary(p_export public.pb_event_exports) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
SELECT (p_export.manifest-ARRAY['entries'])||jsonb_build_object('revision',p_export.revision,'generation',p_export.generation)
$$;

CREATE OR REPLACE FUNCTION public.pb_event_export_create(p_actor uuid,p_event uuid,p_export uuid,p_after uuid DEFAULT NULL,p_generation integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events; x public.pb_event_exports; s public.pb_event_submissions; entries jsonb='[]'; progress jsonb='[]'; media jsonb; i integer=0; last_id uuid; next_id uuid; stamp timestamptz=clock_timestamp();
BEGIN
  e=public.pb_event_export_owner(p_actor,p_event);
  IF p_export IS NULL OR p_generation IS NULL OR p_generation NOT BETWEEN 0 AND 2147483646 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE; e=public.pb_event_export_owner(p_actor,p_event);
  stamp=clock_timestamp();
  SELECT * INTO x FROM public.pb_event_exports WHERE id=p_export;
  IF FOUND THEN
    IF x.event_id<>p_event THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
    IF x.generation<>p_generation THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
    IF NOT x.retired THEN
      IF x.after_submission IS DISTINCT FROM p_after THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
      RETURN public.pb_event_export_summary(x);
    END IF;
  END IF;
  IF x.id IS NULL AND p_generation<>0 THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
  IF x.id IS NULL AND (SELECT count(*) FROM public.pb_event_exports WHERE event_id=p_event)>=8 THEN RAISE EXCEPTION 'PB_EVENT_CAPACITY'; END IF;
  FOR s IN SELECT * FROM public.pb_event_submissions WHERE event_id=p_event AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT 100 LOOP
    media=public.pb_event_export_media(p_event,s.id);
    entries=entries||jsonb_build_array(jsonb_build_object('index',i,'submissionId',s.id,'createdAt',s.created_at,'expiresAt',s.promised_expires_at,'state',s.state,'caption',NULL,'captionStatus','not_collected','media',media,'unavailable',CASE WHEN media IS NOT NULL THEN NULL WHEN s.state='ready' THEN 'unavailable' ELSE s.state END));
    progress=progress||jsonb_build_array(jsonb_build_object('status',CASE WHEN media IS NULL THEN 'failed' ELSE 'pending' END,'error',CASE WHEN media IS NULL THEN 'unavailable' ELSE NULL END));
    i=i+1; last_id=s.id;
  END LOOP;
  IF i=100 AND EXISTS(SELECT 1 FROM public.pb_event_submissions WHERE event_id=p_event AND id>last_id) THEN next_id=last_id; END IF;
  INSERT INTO public.pb_event_exports(id,event_id,created_at,after_submission,manifest,progress)
  VALUES(p_export,p_event,stamp,p_after,jsonb_build_object('version',1,'eventId',p_event,'exportId',p_export,'createdAt',stamp,'expiresAt',e.expires_at,'total',i,'afterSubmissionId',p_after,'nextSubmissionCursor',next_id,'entries',entries),progress) ON CONFLICT(id) DO UPDATE SET manifest=EXCLUDED.manifest,progress=EXCLUDED.progress,revision=0,created_at=stamp,after_submission=p_after,retired=false RETURNING * INTO x;
  RETURN public.pb_event_export_summary(x);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_export_list(p_actor uuid,p_event uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.pb_event_export_owner(p_actor,p_event);
  RETURN jsonb_build_object('version',1,'exports',(SELECT coalesce(jsonb_agg(public.pb_event_export_summary(x) ORDER BY x.created_at,x.id),'[]') FROM public.pb_event_exports x WHERE event_id=p_event AND NOT retired),'retired',(SELECT coalesce(jsonb_agg(jsonb_build_object('exportId',id,'generation',generation) ORDER BY id),'[]') FROM public.pb_event_exports WHERE event_id=p_event AND retired));
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_export_page(p_actor uuid,p_event uuid,p_export uuid,p_generation integer,p_after integer DEFAULT -1,p_limit integer DEFAULT 10) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE x public.pb_event_exports; items jsonb; n integer; total integer;
BEGIN
  PERFORM public.pb_event_export_owner(p_actor,p_event);
  IF p_after IS NULL OR p_after NOT BETWEEN -1 AND 99 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  SELECT * INTO x FROM public.pb_event_exports WHERE event_id=p_event AND id=p_export;
  IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  IF x.retired OR x.generation IS DISTINCT FROM p_generation THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
  total=jsonb_array_length(x.progress);
  SELECT coalesce(jsonb_agg(value||jsonb_build_object('progress',x.progress->((value->>'index')::integer)) ORDER BY (value->>'index')::integer),'[]') INTO items FROM (SELECT value FROM jsonb_array_elements(x.manifest->'entries') WHERE (value->>'index')::integer>p_after ORDER BY (value->>'index')::integer LIMIT p_limit) page;
  n=jsonb_array_length(items);
  RETURN jsonb_build_object('summary',public.pb_event_export_summary(x),'entries',items,'nextCursor',CASE WHEN p_after+n+1<total THEN p_after+n ELSE NULL END);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_export_access(p_actor uuid,p_event uuid,p_export uuid,p_generation integer,p_index integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE x public.pb_event_exports; entry jsonb; media jsonb; seconds integer;
BEGIN
  PERFORM public.pb_event_export_owner(p_actor,p_event);
  IF p_index IS NULL OR p_index NOT BETWEEN 0 AND 99 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  SELECT * INTO x FROM public.pb_event_exports WHERE event_id=p_event AND id=p_export;
  IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  IF x.retired OR x.generation IS DISTINCT FROM p_generation THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
  entry=x.manifest->'entries'->p_index;
  IF entry IS NULL OR entry->'media'='null'::jsonb THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  media=public.pb_event_export_media(p_event,(entry->>'submissionId')::uuid);
  IF media IS NULL OR media IS DISTINCT FROM entry->'media' THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  seconds=least(300,floor(extract(epoch FROM (entry->>'expiresAt')::timestamptz-clock_timestamp()))::integer);
  IF seconds<1 THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
  RETURN media||jsonb_build_object('submissionId',entry->>'submissionId','expiresAt',entry->>'expiresAt','maxAgeSeconds',seconds);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_export_checkpoint(p_actor uuid,p_event uuid,p_export uuid,p_generation integer,p_revision integer,p_updates jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE x public.pb_event_exports; u jsonb; desired jsonb; idx integer; seen integer[]='{}'; next_progress jsonb; same boolean=true;
BEGIN
  PERFORM public.pb_event_export_owner(p_actor,p_event);
  IF p_revision IS NULL OR p_revision NOT BETWEEN 0 AND 999999 OR p_updates IS NULL OR jsonb_typeof(p_updates)<>'array' OR jsonb_array_length(p_updates) NOT BETWEEN 1 AND 10 OR octet_length(p_updates::text)>4096 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  SELECT * INTO x FROM public.pb_event_exports WHERE event_id=p_event AND id=p_export FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  IF x.retired OR x.generation IS DISTINCT FROM p_generation THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
  PERFORM public.pb_event_export_owner(p_actor,p_event);
  next_progress=x.progress;
  FOR u IN SELECT value FROM jsonb_array_elements(p_updates) LOOP
    IF jsonb_typeof(u)<>'object' OR u-ARRAY['index','status','error']<>'{}'::jsonb OR NOT(u ?& ARRAY['index','status','error']) OR jsonb_typeof(u->'index') IS DISTINCT FROM 'number' OR coalesce(u->>'index','') !~ '^[0-9]{1,2}$' OR u->>'status' NOT IN ('prepared','confirmed_saved','failed') OR u->>'status' IS NULL THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
    idx=(u->>'index')::integer;
    IF idx>=jsonb_array_length(x.progress) OR idx=ANY(seen) OR (u->>'status'='failed' AND (u->>'error' IS NULL OR u->>'error' NOT IN ('unavailable','download_failed','integrity_failed','cancelled','zip_failed'))) OR (u->>'status'<>'failed' AND u->'error'<>'null'::jsonb) THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
    IF (x.manifest->'entries'->idx->'media'='null'::jsonb AND u->>'status'<>'failed') OR (x.progress->idx->>'status'='confirmed_saved' AND u->>'status'<>'confirmed_saved') OR (u->>'status'='confirmed_saved' AND x.progress->idx->>'status' NOT IN ('prepared','confirmed_saved')) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
    desired=u-'index'; same=same AND (x.progress->idx=desired); seen=array_append(seen,idx); next_progress=jsonb_set(next_progress,ARRAY[idx::text],desired,false);
  END LOOP;
  IF same THEN RETURN public.pb_event_export_summary(x); END IF;
  IF x.revision<>p_revision THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
  UPDATE public.pb_event_exports SET progress=next_progress,revision=revision+1 WHERE id=x.id RETURNING * INTO x;
  RETURN public.pb_event_export_summary(x);
END $$;


CREATE OR REPLACE FUNCTION public.pb_event_export_retire(p_actor uuid,p_event uuid,p_export uuid,p_generation integer,p_revision integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE x public.pb_event_exports;
BEGIN
  PERFORM public.pb_event_export_owner(p_actor,p_event);
  IF p_generation IS NULL OR p_generation NOT BETWEEN 0 AND 2147483645 OR p_revision IS NULL OR p_revision NOT BETWEEN 0 AND 1000000 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  SELECT * INTO x FROM public.pb_event_exports WHERE event_id=p_event AND id=p_export FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  PERFORM public.pb_event_export_owner(p_actor,p_event);
  IF x.retired AND x.generation=p_generation+1 THEN RETURN jsonb_build_object('exportId',x.id,'generation',x.generation); END IF;
  IF x.retired OR x.generation<>p_generation OR x.revision<>p_revision THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
  UPDATE public.pb_event_exports SET retired=true,generation=generation+1,manifest='{}',progress='[]',revision=0,after_submission=NULL WHERE id=x.id RETURNING * INTO x;
  RETURN jsonb_build_object('exportId',x.id,'generation',x.generation);
END $$;

REVOKE ALL ON FUNCTION public.pb_event_export_capabilities(),public.pb_event_export_owner(uuid,uuid),public.pb_event_export_media(uuid,uuid),public.pb_event_export_summary(public.pb_event_exports),public.pb_event_export_create(uuid,uuid,uuid,uuid,integer),public.pb_event_export_list(uuid,uuid),public.pb_event_export_page(uuid,uuid,uuid,integer,integer,integer),public.pb_event_export_access(uuid,uuid,uuid,integer,integer),public.pb_event_export_checkpoint(uuid,uuid,uuid,integer,integer,jsonb),public.pb_event_export_retire(uuid,uuid,uuid,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pb_event_export_capabilities(),public.pb_event_export_create(uuid,uuid,uuid,uuid,integer),public.pb_event_export_list(uuid,uuid),public.pb_event_export_page(uuid,uuid,uuid,integer,integer,integer),public.pb_event_export_access(uuid,uuid,uuid,integer,integer),public.pb_event_export_checkpoint(uuid,uuid,uuid,integer,integer,jsonb),public.pb_event_export_retire(uuid,uuid,uuid,integer,integer) TO service_role;

COMMIT;
