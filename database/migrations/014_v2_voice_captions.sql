BEGIN;
CREATE TABLE IF NOT EXISTS public.pb_voice_configuration(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),deployment_bytes bigint NOT NULL DEFAULT 0 CHECK(deployment_bytes>=0));
INSERT INTO public.pb_voice_configuration(singleton) VALUES(true) ON CONFLICT DO NOTHING;
ALTER TABLE public.pb_voice_configuration ADD COLUMN IF NOT EXISTS scan_actor uuid;
ALTER TABLE public.pb_voice_configuration ADD COLUMN IF NOT EXISTS scan_activity uuid;
CREATE TABLE IF NOT EXISTS public.pb_voice_captions(
  actor uuid NOT NULL,activity_id uuid NOT NULL,revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),text_value text NOT NULL DEFAULT '' CHECK(length(text_value)<=2000),
  generation uuid,pending uuid,PRIMARY KEY(actor,activity_id)
);
CREATE TABLE IF NOT EXISTS public.pb_voice_receipts(
  actor uuid NOT NULL,request_id uuid NOT NULL,activity_id uuid NOT NULL,fingerprint text NOT NULL CHECK(fingerprint~'^[a-f0-9]{64}$'),
  status text NOT NULL CHECK(status IN('pending','complete','expired')),result_revision integer,PRIMARY KEY(actor,request_id)
);
CREATE TABLE IF NOT EXISTS public.pb_voice_generations(
  id uuid PRIMARY KEY,actor uuid NOT NULL,activity_id uuid NOT NULL,path text NOT NULL UNIQUE,bytes integer NOT NULL CHECK(bytes BETWEEN 46 AND 2880044),
  samples integer NOT NULL CHECK(samples BETWEEN 1 AND 1440000),sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
  status text NOT NULL CHECK(status IN('staged','ready','deleting','absent')),pending_text text CHECK(length(pending_text)<=2000),
  expires_at timestamptz NOT NULL,attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),lease uuid,lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),cleanup_failed boolean NOT NULL DEFAULT false,
  CHECK(bytes=44+samples*2),CHECK(path=actor::text||'/'||activity_id::text||'/'||id::text||'.wav')
);
CREATE INDEX IF NOT EXISTS pb_voice_cleanup ON public.pb_voice_generations(status,available_at,id);
CREATE INDEX IF NOT EXISTS pb_voice_activity_heads ON public.pb_voice_captions(activity_id);
CREATE OR REPLACE FUNCTION public.pb_voice_activity_pinned(p_activity uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.pb_voice_captions WHERE activity_id=p_activity AND (text_value<>'' OR generation IS NOT NULL OR pending IS NOT NULL))
$$;
CREATE OR REPLACE FUNCTION public.pb_memory_record(p_subject uuid,p_kind text,p_source uuid,p_scope_kind text,p_scope uuid,p_at timestamptz,p_provenance text,p_state text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE inserted uuid; month integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pb-memory:'||p_subject,0));
  INSERT INTO public.pb_memory_activity(subject_id,source_kind,source_id,scope_kind,scope_id,occurred_at,provenance,state)
    VALUES(p_subject,p_kind,p_source,p_scope_kind,p_scope,p_at,p_provenance,p_state) ON CONFLICT(source_kind,source_id,subject_id) DO NOTHING RETURNING id INTO inserted;
  IF inserted IS NULL THEN RETURN; END IF;
  month=CASE WHEN extract(year FROM p_at AT TIME ZONE 'UTC') BETWEEN 1970 AND 2199 THEN extract(year FROM p_at AT TIME ZONE 'UTC')::integer*100+extract(month FROM p_at AT TIME ZONE 'UTC')::integer ELSE 0 END;
  INSERT INTO public.pb_memory_months(subject_id,month_key,total) VALUES(p_subject,month,1) ON CONFLICT(subject_id,month_key) DO UPDATE SET total=pb_memory_months.total+1;
  DELETE FROM public.pb_memory_activity WHERE id IN(SELECT id FROM public.pb_memory_activity WHERE subject_id=p_subject AND chapter_id IS NULL AND occasion IS NULL AND NOT public.pb_voice_activity_pinned(id) ORDER BY occurred_at DESC,id DESC OFFSET 2000);
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
  DELETE FROM public.pb_memory_activity WHERE id IN(SELECT id FROM public.pb_memory_activity WHERE subject_id=p_actor AND chapter_id IS NULL AND occasion IS NULL AND NOT public.pb_voice_activity_pinned(id) ORDER BY (id=p_id) DESC,occurred_at DESC,id DESC OFFSET 2000);
  RETURN public.pb_memory_projection(a,p_actor);
END $$;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES('photobooth-voice-captions','photobooth-voice-captions',false,2880044,ARRAY['audio/wav'])
  ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=2880044,allowed_mime_types=ARRAY['audio/wav'];

CREATE OR REPLACE FUNCTION public.pb_voice_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_project_require_service(); RETURN jsonb_build_object('version',1,'ready',(SELECT deployment_bytes>0 FROM public.pb_voice_configuration WHERE singleton),'actorBytes',57600880,'generations',20,'heads',500,'receipts',100); END $$;
CREATE OR REPLACE FUNCTION public.pb_voice_configure(p_bytes bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_project_require_service(); PERFORM 1 FROM public.pb_voice_configuration WHERE singleton FOR UPDATE;
  IF p_bytes IS NULL OR p_bytes<0 OR p_bytes<(SELECT coalesce(sum(bytes),0) FROM public.pb_voice_generations WHERE status<>'absent') THEN RAISE EXCEPTION 'PB_VOICE_CAPACITY'; END IF;
  UPDATE public.pb_voice_configuration SET deployment_bytes=p_bytes WHERE singleton; RETURN public.pb_voice_capabilities(); END $$;
CREATE OR REPLACE FUNCTION public.pb_voice_source(p_actor uuid,p_activity uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.pb_memory_activity; projection jsonb;
BEGIN PERFORM public.pb_memory_actor(p_actor); SELECT * INTO a FROM public.pb_memory_activity WHERE id=p_activity;
  IF a.id IS NULL THEN RAISE EXCEPTION 'PB_VOICE_DENIED'; END IF;
  IF a.scope_kind='project' THEN PERFORM 1 FROM public.pb_projects WHERE id=a.scope_id FOR SHARE;
  ELSIF a.scope_kind='couple' THEN PERFORM 1 FROM public.pb_couples WHERE id=a.scope_id FOR SHARE; END IF;
  projection=public.pb_memory_projection(a,p_actor);
  IF projection IS NULL OR NOT(projection ? 'sourceId') OR projection->>'availability' NOT IN('available','archived','archive_pending') THEN RAISE EXCEPTION 'PB_VOICE_DENIED'; END IF;
  IF a.source_kind='strip' THEN PERFORM 1 FROM public.pb_strips WHERE id=a.source_id FOR SHARE; PERFORM public.pb_retained_strip_read(p_actor,a.source_id);
  ELSIF a.source_kind='project_asset' THEN PERFORM 1 FROM public.pb_project_assets WHERE id=a.source_id FOR SHARE; PERFORM public.pb_project_asset_access(p_actor,a.source_id);
  ELSE RAISE EXCEPTION 'PB_VOICE_DENIED'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.pb_voice_projection(p_actor uuid,p_activity uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object('version',1,'activityId',p_activity,'revision',coalesce(c.revision,0),'text',coalesce(c.text_value,''),'audio',
    CASE WHEN g.id IS NOT NULL AND g.status='ready' THEN jsonb_build_object('generation',g.id,'bytes',g.bytes,'samples',g.samples,'sha256',g.sha256,'mime','audio/wav') ELSE NULL END)
  FROM (SELECT 1) seed LEFT JOIN public.pb_voice_captions c ON c.actor=p_actor AND c.activity_id=p_activity LEFT JOIN public.pb_voice_generations g ON g.id=c.generation
$$;
CREATE OR REPLACE FUNCTION public.pb_voice_read(p_actor uuid,p_activity uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_voice_source(p_actor,p_activity); RETURN public.pb_voice_projection(p_actor,p_activity); END $$;

CREATE OR REPLACE FUNCTION public.pb_voice_save(p_actor uuid,p_activity uuid,p_request uuid,p_revision integer,p_text text,p_operation text,p_audio jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_voice_captions;r public.pb_voice_receipts;g public.pb_voice_generations; fingerprint text;budget bigint;count_receipts integer;subject uuid;
BEGIN PERFORM public.pb_project_require_service(); SELECT deployment_bytes INTO budget FROM public.pb_voice_configuration WHERE singleton FOR UPDATE;
  IF budget IS NULL THEN RAISE EXCEPTION 'PB_VOICE_CAPACITY'; END IF;
  IF p_operation='delete' THEN PERFORM public.pb_memory_actor(p_actor); ELSE PERFORM public.pb_voice_source(p_actor,p_activity); END IF;
  SELECT subject_id INTO subject FROM public.pb_memory_activity WHERE id=p_activity;
  IF subject IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('pb-memory:'||subject,0)); END IF;
  IF p_operation IS DISTINCT FROM 'delete' THEN PERFORM public.pb_voice_source(p_actor,p_activity); END IF;
  IF p_request IS NULL OR p_revision IS NULL OR p_revision<0 OR p_revision>2147483646 OR p_text IS NULL OR length(p_text)>2000 OR p_text~'[\x01-\x08\x0b\x0c\x0e-\x1f]' OR p_operation IS NULL OR p_operation NOT IN('keep','remove','replace','delete') THEN RAISE EXCEPTION 'PB_VOICE_INVALID'; END IF;
  IF p_operation='replace' THEN
    IF p_audio IS NULL OR jsonb_typeof(p_audio)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(p_audio))<>3 OR NOT(p_audio ?& ARRAY['bytes','samples','sha256'])
      OR (p_audio->>'samples')::bigint NOT BETWEEN 1 AND 1440000 OR (p_audio->>'bytes')::bigint<>44+(p_audio->>'samples')::bigint*2 OR p_audio->>'sha256' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PB_VOICE_INVALID'; END IF;
  ELSIF p_audio IS NOT NULL THEN RAISE EXCEPTION 'PB_VOICE_INVALID'; END IF;
  IF p_operation='delete' AND p_text<>'' THEN RAISE EXCEPTION 'PB_VOICE_INVALID'; END IF;
  fingerprint=encode(sha256(convert_to(jsonb_build_object('activity',p_activity,'revision',p_revision,'text',p_text,'operation',p_operation,'audio',p_audio)::text,'UTF8')),'hex');
  SELECT * INTO r FROM public.pb_voice_receipts WHERE actor=p_actor AND request_id=p_request;
  IF FOUND THEN
    IF r.fingerprint<>fingerprint OR r.activity_id<>p_activity THEN RAISE EXCEPTION 'PB_VOICE_CONFLICT'; END IF;
    IF r.status='expired' THEN RAISE EXCEPTION 'PB_VOICE_EXPIRED'; END IF;
    IF r.status='complete' THEN
      IF p_operation='delete' AND EXISTS(SELECT 1 FROM public.pb_voice_captions WHERE actor=p_actor AND activity_id=p_activity AND (text_value<>'' OR generation IS NOT NULL OR pending IS NOT NULL)) THEN RAISE EXCEPTION 'PB_VOICE_CONFLICT'; END IF;
      RETURN jsonb_build_object('status','complete','snapshot',public.pb_voice_projection(p_actor,p_activity));
    END IF;
    SELECT * INTO g FROM public.pb_voice_generations WHERE id=p_request;
    IF g.status<>'staged' OR g.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PB_VOICE_EXPIRED'; END IF;
    RETURN jsonb_build_object('status','staged','generation',g.id,'actor',g.actor,'activityId',g.activity_id,'path',g.path,'bytes',g.bytes,'samples',g.samples,'sha256',g.sha256,'expiresAt',g.expires_at);
  END IF;
  SELECT * INTO c FROM public.pb_voice_captions WHERE actor=p_actor AND activity_id=p_activity FOR UPDATE;
  IF NOT FOUND THEN
    IF p_revision<>0 THEN RAISE EXCEPTION 'PB_VOICE_CONFLICT'; END IF;
    IF p_operation='delete' THEN RETURN jsonb_build_object('status','complete','snapshot',public.pb_voice_projection(p_actor,p_activity)); END IF;
    IF (SELECT count(*) FROM public.pb_voice_captions WHERE actor=p_actor)>=500 THEN RAISE EXCEPTION 'PB_VOICE_CAPACITY'; END IF;
    INSERT INTO public.pb_voice_captions(actor,activity_id) VALUES(p_actor,p_activity) RETURNING * INTO c;
  END IF;
  IF c.revision<>p_revision OR (c.pending IS NOT NULL AND p_operation<>'delete') THEN RAISE EXCEPTION 'PB_VOICE_CONFLICT'; END IF;
  SELECT count(*) INTO count_receipts FROM public.pb_voice_receipts WHERE actor=p_actor AND activity_id=p_activity;
  IF count_receipts>=100 AND p_operation<>'delete' THEN RAISE EXCEPTION 'PB_VOICE_CAPACITY'; END IF;
  IF p_operation='delete' AND c.generation IS NULL AND c.pending IS NULL AND c.text_value='' THEN RETURN jsonb_build_object('status','complete','snapshot',public.pb_voice_projection(p_actor,p_activity)); END IF;
  IF p_operation<>'delete' AND (p_text<>'' OR p_operation='replace') AND NOT public.pb_voice_activity_pinned(p_activity)
    AND (SELECT count(*) FROM public.pb_memory_activity WHERE subject_id=subject AND public.pb_voice_activity_pinned(id))>=500 THEN RAISE EXCEPTION 'PB_VOICE_CAPACITY'; END IF;
  IF p_operation='replace' THEN
    IF budget<=0 OR (SELECT count(*) FROM public.pb_voice_generations WHERE actor=p_actor AND status<>'absent')>=20
      OR (SELECT coalesce(sum(bytes),0) FROM public.pb_voice_generations WHERE actor=p_actor AND status<>'absent')+(p_audio->>'bytes')::bigint>57600880
      OR (SELECT coalesce(sum(bytes),0) FROM public.pb_voice_generations WHERE status<>'absent')+(p_audio->>'bytes')::bigint>budget THEN RAISE EXCEPTION 'PB_VOICE_CAPACITY'; END IF;
    INSERT INTO public.pb_voice_generations(id,actor,activity_id,path,bytes,samples,sha256,status,pending_text,expires_at)
      VALUES(p_request,p_actor,p_activity,p_actor::text||'/'||p_activity::text||'/'||p_request::text||'.wav',(p_audio->>'bytes')::integer,(p_audio->>'samples')::integer,p_audio->>'sha256','staged',p_text,clock_timestamp()+interval '10 minutes') RETURNING * INTO g;
    UPDATE public.pb_voice_captions SET pending=p_request WHERE actor=p_actor AND activity_id=p_activity;
    INSERT INTO public.pb_voice_receipts VALUES(p_actor,p_request,p_activity,fingerprint,'pending',NULL);
    RETURN jsonb_build_object('status','staged','generation',g.id,'actor',g.actor,'activityId',g.activity_id,'path',g.path,'bytes',g.bytes,'samples',g.samples,'sha256',g.sha256,'expiresAt',g.expires_at);
  END IF;
  IF p_operation IN('remove','delete') THEN
    UPDATE public.pb_voice_generations SET status='deleting',pending_text=NULL WHERE id IN(c.generation,c.pending) AND status IN('ready','staged');
    UPDATE public.pb_voice_receipts SET status='expired' WHERE actor=p_actor AND request_id=c.pending AND status='pending';
  END IF;
  UPDATE public.pb_voice_captions SET revision=revision+1,text_value=p_text,generation=CASE WHEN p_operation='keep' THEN generation ELSE NULL END,pending=NULL WHERE actor=p_actor AND activity_id=p_activity RETURNING * INTO c;
  INSERT INTO public.pb_voice_receipts VALUES(p_actor,p_request,p_activity,fingerprint,'complete',c.revision);
  RETURN jsonb_build_object('status','complete','snapshot',public.pb_voice_projection(p_actor,p_activity));
END $$;

CREATE OR REPLACE FUNCTION public.pb_voice_finish(p_actor uuid,p_activity uuid,p_request uuid,p_sha256 text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_voice_captions;g public.pb_voice_generations;r public.pb_voice_receipts;
BEGIN PERFORM public.pb_project_require_service(); PERFORM 1 FROM public.pb_voice_configuration WHERE singleton FOR UPDATE; PERFORM public.pb_voice_source(p_actor,p_activity);
  SELECT * INTO r FROM public.pb_voice_receipts WHERE actor=p_actor AND activity_id=p_activity AND request_id=p_request;
  SELECT * INTO c FROM public.pb_voice_captions WHERE actor=p_actor AND activity_id=p_activity FOR UPDATE;
  SELECT * INTO g FROM public.pb_voice_generations WHERE id=p_request AND actor=p_actor AND activity_id=p_activity FOR UPDATE;
  IF g.id IS NULL OR g.sha256 IS DISTINCT FROM p_sha256 THEN RAISE EXCEPTION 'PB_VOICE_CONFLICT'; END IF;
  IF r.status='complete' THEN RETURN public.pb_voice_projection(p_actor,p_activity); END IF;
  IF r.status IS DISTINCT FROM 'pending' OR c.pending IS DISTINCT FROM g.id OR g.status<>'staged' OR g.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PB_VOICE_EXPIRED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='photobooth-voice-captions' AND name=g.path AND user_metadata->>'voice_sha256'=g.sha256) THEN RAISE EXCEPTION 'PB_VOICE_NOT_READY'; END IF;
  UPDATE public.pb_voice_generations SET status='deleting' WHERE id=c.generation AND status='ready';
  UPDATE public.pb_voice_captions SET revision=revision+1,text_value=g.pending_text,generation=g.id,pending=NULL WHERE actor=p_actor AND activity_id=p_activity RETURNING * INTO c;
  UPDATE public.pb_voice_generations SET status='ready',pending_text=NULL WHERE id=g.id;
  UPDATE public.pb_voice_receipts SET status='complete',result_revision=c.revision WHERE actor=p_actor AND request_id=p_request;
  RETURN public.pb_voice_projection(p_actor,p_activity);
END $$;

CREATE OR REPLACE FUNCTION public.pb_voice_sweep(p_limit integer DEFAULT 25) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE g public.pb_voice_generations;c public.pb_voice_captions;lost boolean;n integer=0;scanned integer=0;cursor_actor uuid;cursor_activity uuid;failure text;
BEGIN PERFORM public.pb_project_require_service(); IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'PB_VOICE_INVALID'; END IF;
  PERFORM 1 FROM public.pb_voice_configuration WHERE singleton FOR UPDATE;
  FOR g IN SELECT * FROM public.pb_voice_generations WHERE status='staged' AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT p_limit FOR UPDATE LOOP
    UPDATE public.pb_voice_generations SET status='deleting',pending_text=NULL WHERE id=g.id;
    UPDATE public.pb_voice_captions SET pending=NULL WHERE actor=g.actor AND activity_id=g.activity_id AND pending=g.id;
    UPDATE public.pb_voice_receipts SET status='expired' WHERE actor=g.actor AND request_id=g.id AND status='pending'; n=n+1;
  END LOOP;
  SELECT scan_actor,scan_activity INTO cursor_actor,cursor_activity FROM public.pb_voice_configuration WHERE singleton;
  FOR c IN SELECT * FROM public.pb_voice_captions WHERE (generation IS NOT NULL OR pending IS NOT NULL OR text_value<>'') AND (cursor_actor IS NULL OR (actor,activity_id)>(cursor_actor,cursor_activity)) ORDER BY actor,activity_id LIMIT p_limit LOOP
    scanned=scanned+1; UPDATE public.pb_voice_configuration SET scan_actor=c.actor,scan_activity=c.activity_id WHERE singleton;
    lost=false;
    BEGIN PERFORM public.pb_voice_source(c.actor,c.activity_id);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS failure=MESSAGE_TEXT;
      IF failure NOT IN('PB_VOICE_DENIED','PB_MEMORY_DENIED','PB_PROJECT_DENIED','PB_RETAINED_DENIED','PB_RETAINED_UNAVAILABLE') THEN RAISE; END IF;
      lost=NOT EXISTS(SELECT 1 FROM auth.users WHERE id=c.actor) OR NOT EXISTS(SELECT 1 FROM public.pb_memory_activity WHERE id=c.activity_id)
        OR EXISTS(SELECT 1 FROM public.pb_memory_activity a WHERE a.id=c.activity_id AND (a.state IN('deleted','expired') OR public.pb_memory_scope_visible(a,c.actor) IS DISTINCT FROM true));
    END;
    IF lost THEN
      UPDATE public.pb_voice_generations SET status='deleting',pending_text=NULL WHERE actor=c.actor AND activity_id=c.activity_id AND status IN('ready','staged');
      UPDATE public.pb_voice_receipts SET status='expired' WHERE actor=c.actor AND activity_id=c.activity_id AND status='pending';
      UPDATE public.pb_voice_captions SET generation=NULL,pending=NULL,text_value='',revision=revision+1 WHERE actor=c.actor AND activity_id=c.activity_id; n=n+1;
    END IF;
  END LOOP;
  IF scanned<p_limit THEN UPDATE public.pb_voice_configuration SET scan_actor=NULL,scan_activity=NULL WHERE singleton; END IF;
  RETURN jsonb_build_object('queued',n);
END $$;
CREATE OR REPLACE FUNCTION public.pb_voice_claim_cleanup() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE g public.pb_voice_generations;
BEGIN PERFORM public.pb_project_require_service(); PERFORM 1 FROM public.pb_voice_configuration WHERE singleton FOR UPDATE;
  UPDATE public.pb_voice_generations SET cleanup_failed=true,lease=NULL,lease_until=NULL WHERE id IN(SELECT id FROM public.pb_voice_generations WHERE status='deleting' AND NOT cleanup_failed AND attempts>=8 AND coalesce(lease_until,'-infinity')<=clock_timestamp() ORDER BY available_at,id LIMIT 25);
  SELECT * INTO g FROM public.pb_voice_generations WHERE status='deleting' AND NOT cleanup_failed AND attempts<8 AND available_at<=clock_timestamp() AND coalesce(lease_until,'-infinity')<=clock_timestamp() ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
  UPDATE public.pb_voice_generations SET attempts=attempts+1,lease=gen_random_uuid(),lease_until=clock_timestamp()+interval '60 seconds' WHERE id=g.id RETURNING * INTO g;
  RETURN jsonb_build_object('generation',g.id,'actor',g.actor,'activityId',g.activity_id,'path',g.path,'bytes',g.bytes,'samples',g.samples,'sha256',g.sha256,'lease',g.lease,'leaseUntil',g.lease_until,'attempts',g.attempts);
END $$;
CREATE OR REPLACE FUNCTION public.pb_voice_finish_cleanup(p_generation uuid,p_lease uuid,p_absent boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE g public.pb_voice_generations;
BEGIN PERFORM public.pb_project_require_service(); PERFORM 1 FROM public.pb_voice_configuration WHERE singleton FOR UPDATE; SELECT * INTO g FROM public.pb_voice_generations WHERE id=p_generation FOR UPDATE;
  IF g.status IS DISTINCT FROM 'deleting' OR g.lease IS DISTINCT FROM p_lease OR g.lease_until<=clock_timestamp() OR g.lease IS NULL THEN RAISE EXCEPTION 'PB_VOICE_LEASE'; END IF;
  IF p_absent IS TRUE THEN
    IF EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='photobooth-voice-captions' AND name=g.path) THEN RAISE EXCEPTION 'PB_VOICE_NOT_READY'; END IF;
    UPDATE public.pb_voice_generations SET status='absent',lease=NULL,lease_until=NULL WHERE id=g.id;
  ELSE UPDATE public.pb_voice_generations SET cleanup_failed=attempts>=8,lease=NULL,lease_until=NULL,available_at=clock_timestamp()+interval '60 seconds' WHERE id=g.id; END IF;
  RETURN jsonb_build_object('complete',p_absent IS TRUE);
END $$;
CREATE OR REPLACE FUNCTION public.pb_voice_object_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE g public.pb_voice_generations;
BEGIN IF TG_OP='UPDATE' AND OLD.bucket_id='photobooth-voice-captions' THEN RAISE EXCEPTION 'PB_VOICE_DENIED'; END IF;
  IF NEW.bucket_id<>'photobooth-voice-captions' THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.pb_voice_configuration WHERE singleton FOR UPDATE; SELECT * INTO g FROM public.pb_voice_generations WHERE path=NEW.name;
  IF g.id IS NULL THEN RAISE EXCEPTION 'PB_VOICE_DENIED'; END IF; PERFORM public.pb_voice_source(g.actor,g.activity_id);
  IF TG_OP='UPDATE' OR g.status<>'staged' OR g.expires_at<=clock_timestamp() OR NEW.user_metadata->>'voice_sha256' IS DISTINCT FROM g.sha256 OR NOT EXISTS(SELECT 1 FROM public.pb_voice_captions WHERE actor=g.actor AND activity_id=g.activity_id AND pending=g.id) THEN RAISE EXCEPTION 'PB_VOICE_DENIED'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pb_voice_object_fence ON storage.objects;
CREATE TRIGGER pb_voice_object_fence BEFORE INSERT OR UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION public.pb_voice_object_fence();
DROP POLICY IF EXISTS pb_voice_storage_boundary ON storage.objects;
CREATE POLICY pb_voice_storage_boundary ON storage.objects AS RESTRICTIVE FOR ALL TO anon,authenticated USING(bucket_id<>'photobooth-voice-captions') WITH CHECK(bucket_id<>'photobooth-voice-captions');
DO $$ DECLARE t text;f record; BEGIN
  FOREACH t IN ARRAY ARRAY['pb_voice_configuration','pb_voice_captions','pb_voice_receipts','pb_voice_generations'] LOOP EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t); END LOOP;
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'pb_voice_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature); END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.pb_voice_capabilities(),public.pb_voice_configure(bigint),public.pb_voice_read(uuid,uuid),public.pb_voice_save(uuid,uuid,uuid,integer,text,text,jsonb),public.pb_voice_finish(uuid,uuid,uuid,text),public.pb_voice_sweep(integer),public.pb_voice_claim_cleanup(),public.pb_voice_finish_cleanup(uuid,uuid,boolean) TO service_role;
COMMIT;
