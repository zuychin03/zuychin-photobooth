BEGIN;

CREATE TABLE IF NOT EXISTS public.pb_project_configuration (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), deployment_bytes bigint NOT NULL DEFAULT 0 CHECK(deployment_bytes>=0)
);
INSERT INTO public.pb_project_configuration(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.pb_projects (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES auth.users, kind text NOT NULL CHECK(kind IN ('personal','friend')),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 100), max_bytes bigint NOT NULL CHECK(max_bytes BETWEEN 10485760 AND 67108864),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')), allocation_released boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS public.pb_project_members (
  project_id uuid NOT NULL REFERENCES public.pb_projects, user_id uuid NOT NULL REFERENCES auth.users,
  status text NOT NULL CHECK(status IN ('invited','accepted','revoked')), PRIMARY KEY(project_id,user_id)
);
CREATE INDEX IF NOT EXISTS pb_project_members_discovery ON public.pb_project_members(user_id,status,project_id);
CREATE TABLE IF NOT EXISTS public.pb_project_rates (
  actor_id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  minute_start timestamptz NOT NULL,
  read_count integer NOT NULL DEFAULT 0 CHECK(read_count BETWEEN 0 AND 120),
  write_count integer NOT NULL DEFAULT 0 CHECK(write_count BETWEEN 0 AND 30),
  upload_count integer NOT NULL DEFAULT 0 CHECK(upload_count BETWEEN 0 AND 12)
);
CREATE TABLE IF NOT EXISTS public.pb_project_assets (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES public.pb_projects, owner_id uuid NOT NULL REFERENCES auth.users,
  request_id uuid NOT NULL, fingerprint jsonb NOT NULL, kind text NOT NULL CHECK(kind IN ('photo','decoration')),
  mime text NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp')), bytes bigint NOT NULL CHECK(bytes BETWEEN 1 AND 10485760),
  width integer NOT NULL CHECK(width BETWEEN 1 AND 4096), height integer NOT NULL CHECK(height BETWEEN 1 AND 4096), sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  held_bytes bigint NOT NULL DEFAULT 10485760 CHECK(held_bytes BETWEEN 1 AND 10485760),
  protection text NOT NULL CHECK(protection IN ('none','challenge')), protection_id uuid,
  path text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','ready','deleted','expired')),
  reserved_until timestamptz NOT NULL, mint_before timestamptz, upload_until timestamptz, cleanup_after timestamptz NOT NULL,
  charge_released boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,owner_id,request_id), CHECK((protection='none')=(protection_id IS NULL)),
  CHECK(width::bigint*height<=12582912), CHECK(kind<>'decoration' OR (mime='image/png' AND bytes<=4194304 AND width<=2048 AND height<=2048))
);
CREATE INDEX IF NOT EXISTS pb_project_assets_scope ON public.pb_project_assets(project_id,status);
CREATE INDEX IF NOT EXISTS pb_project_assets_expiry ON public.pb_project_assets(status,reserved_until);
CREATE TABLE IF NOT EXISTS public.pb_project_cleanup (
  asset_id uuid PRIMARY KEY REFERENCES public.pb_project_assets, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','retry','complete','failed')),
  lease_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), available_at timestamptz NOT NULL,
  confirmed_absent boolean NOT NULL DEFAULT false
);
ALTER TABLE public.pb_project_cleanup DROP CONSTRAINT IF EXISTS pb_project_cleanup_status_check;
ALTER TABLE public.pb_project_cleanup ADD CONSTRAINT pb_project_cleanup_status_check CHECK(status IN ('queued','running','retry','complete','failed'));
CREATE TABLE IF NOT EXISTS public.pb_project_finalisations (
  asset_id uuid PRIMARY KEY REFERENCES public.pb_project_assets,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','retry','complete','failed')),
  lease_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  failure text CHECK(failure IN ('invalid_image','deadline','access_lost','attempts_exhausted','provider_retry'))
);
CREATE INDEX IF NOT EXISTS pb_project_finalisations_due ON public.pb_project_finalisations(status,available_at);
CREATE TABLE IF NOT EXISTS public.pb_saved_templates (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES auth.users, revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  recipe jsonb NOT NULL CHECK(jsonb_typeof(recipe)='object' AND octet_length(recipe::text)<=65536)
);

CREATE OR REPLACE FUNCTION public.pb_project_require_service() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN IF coalesce(auth.role(),'')<>'service_role' THEN RAISE EXCEPTION 'PB_PROJECT_DENIED' USING ERRCODE='42501'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.pb_project_require_actor(p_project uuid,p_actor uuid,p_owner boolean DEFAULT false) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.pb_project_require_service();
  IF p_actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.pb_projects p JOIN public.pb_project_members m ON m.project_id=p.id WHERE p.id=p_project AND p.status='active' AND m.user_id=p_actor AND m.status='accepted' AND (NOT p_owner OR p.owner_id=p_actor)) THEN RAISE EXCEPTION 'PB_PROJECT_DENIED' USING ERRCODE='42501'; END IF;
END $$;
-- Migration 004 must replace these gates using authoritative challenge state, never client flags.
CREATE OR REPLACE FUNCTION public.pb_project_protection_write(p_project uuid,p_actor uuid,p_kind text,p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT p_kind='none' AND p_id IS NULL $$;
CREATE OR REPLACE FUNCTION public.pb_project_protection_read(p_asset uuid,p_actor uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT coalesce((SELECT CASE WHEN protection='none' THEN true WHEN protection='challenge' THEN owner_id=p_actor ELSE false END FROM public.pb_project_assets WHERE id=p_asset),false)
$$;
CREATE OR REPLACE FUNCTION public.pb_project_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE budget bigint; bucket_ready boolean=false;
BEGIN PERFORM public.pb_project_require_service(); SELECT deployment_bytes INTO budget FROM public.pb_project_configuration WHERE singleton;
  IF to_regclass('storage.buckets') IS NOT NULL THEN EXECUTE 'SELECT EXISTS(SELECT 1 FROM storage.buckets WHERE id=''photobooth-projects-v2'' AND NOT public AND file_size_limit=10485760)' INTO bucket_ready; END IF;
  RETURN jsonb_build_object('version',1,'ready',budget>0 AND bucket_ready,'deploymentBytes',budget,'allocatedBytes',(SELECT coalesce(sum(max_bytes),0) FROM public.pb_projects WHERE NOT allocation_released),'members',4,'files',24,'projectBytes',67108864,'readSeconds',300,'uploadSeconds',7200,'challengeWrites',false,'finalisationVersion',1,'apiVersion',1);
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_rate(p_actor uuid,p_operation text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.pb_project_rates; stamp timestamptz; current_time_value timestamptz; used integer; ceiling integer;
BEGIN PERFORM public.pb_project_require_service();
  IF p_actor IS NULL OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_actor) THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
  IF p_operation IS NULL OR p_operation NOT IN ('read','write','upload') THEN RAISE EXCEPTION 'PB_PROJECT_INVALID'; END IF;
  IF (SELECT deployment_bytes>0 FROM public.pb_project_configuration WHERE singleton) IS DISTINCT FROM true THEN RAISE EXCEPTION 'PB_PROJECT_NOT_READY'; END IF;
  stamp=date_trunc('minute',clock_timestamp());
  INSERT INTO public.pb_project_rates(actor_id,minute_start) VALUES(p_actor,stamp) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.pb_project_rates WHERE actor_id=p_actor FOR UPDATE;
  current_time_value=clock_timestamp(); stamp=date_trunc('minute',current_time_value);
  IF r.minute_start<stamp THEN
    UPDATE public.pb_project_rates SET minute_start=stamp,read_count=0,write_count=0,upload_count=0 WHERE actor_id=p_actor RETURNING * INTO r;
  END IF;
  used=CASE p_operation WHEN 'read' THEN r.read_count WHEN 'write' THEN r.write_count ELSE r.upload_count END;
  ceiling=CASE p_operation WHEN 'read' THEN 120 WHEN 'write' THEN 30 ELSE 12 END;
  IF used>=ceiling THEN RETURN jsonb_build_object('allowed',false,'retryAfterSeconds',greatest(1,least(60,ceil(extract(epoch FROM r.minute_start+interval '1 minute'-current_time_value))::integer))); END IF;
  UPDATE public.pb_project_rates SET read_count=read_count+CASE WHEN p_operation='read' THEN 1 ELSE 0 END,
    write_count=write_count+CASE WHEN p_operation='write' THEN 1 ELSE 0 END,
    upload_count=upload_count+CASE WHEN p_operation='upload' THEN 1 ELSE 0 END WHERE actor_id=p_actor;
  RETURN jsonb_build_object('allowed',true,'retryAfterSeconds',0);
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_list(p_actor uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 20) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN PERFORM public.pb_project_require_service();
  IF p_actor IS NULL OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_actor) THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'PB_PROJECT_INVALID'; END IF;
  WITH visible AS (
    SELECT p.id,p.owner_id,p.kind,p.title,p.created_at,m.status FROM public.pb_project_members m JOIN public.pb_projects p ON p.id=m.project_id
    WHERE m.user_id=p_actor AND m.status IN ('accepted','invited') AND p.status='active' AND (p_after IS NULL OR p.id>p_after)
    ORDER BY p.id LIMIT p_limit+1
  ), numbered AS (SELECT *,row_number() OVER(ORDER BY id) AS position FROM visible)
  SELECT jsonb_build_object('projects',coalesce(jsonb_agg(jsonb_build_object('id',id,'ownerId',owner_id,'kind',kind,'title',title,'createdAt',created_at,'membership',status) ORDER BY id) FILTER(WHERE position<=p_limit),'[]'::jsonb),
    'nextCursor',CASE WHEN count(*)>p_limit THEN (SELECT id::text FROM numbered WHERE position=p_limit) ELSE NULL END) INTO result FROM numbered;
  RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_configure(p_bytes bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_project_require_service(); PERFORM 1 FROM public.pb_project_configuration WHERE singleton FOR UPDATE;
  IF p_bytes IS NULL OR p_bytes<0 OR p_bytes>9007199254740991 THEN RAISE EXCEPTION 'PB_PROJECT_INVALID'; END IF;
  IF p_bytes<(SELECT coalesce(sum(max_bytes),0) FROM public.pb_projects WHERE NOT allocation_released) THEN RAISE EXCEPTION 'PB_PROJECT_CAPACITY'; END IF;
  UPDATE public.pb_project_configuration SET deployment_bytes=p_bytes WHERE singleton; RETURN public.pb_project_capabilities();
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_create(p_actor uuid,p_project uuid,p_kind text,p_title text,p_max_bytes bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.pb_projects; budget bigint;
BEGIN PERFORM public.pb_project_require_service();
  IF p_actor IS NULL OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_actor) OR p_project IS NULL OR p_kind IS NULL OR p_kind NOT IN ('personal','friend') OR p_title IS NULL OR length(p_title) NOT BETWEEN 1 AND 100 OR p_max_bytes IS NULL OR p_max_bytes NOT BETWEEN 10485760 AND 67108864 THEN RAISE EXCEPTION 'PB_PROJECT_INVALID'; END IF;
  SELECT deployment_bytes INTO budget FROM public.pb_project_configuration WHERE singleton FOR UPDATE;
  IF coalesce(budget,0)<=0 THEN RAISE EXCEPTION 'PB_PROJECT_NOT_READY'; END IF;
  SELECT * INTO p FROM public.pb_projects WHERE id=p_project;
  IF FOUND THEN
    IF p.owner_id<>p_actor OR p.kind<>p_kind OR p.title<>p_title OR p.max_bytes<>p_max_bytes OR p.status<>'active' THEN RAISE EXCEPTION 'PB_PROJECT_CONFLICT'; END IF; RETURN to_jsonb(p);
  END IF;
  IF p_max_bytes+(SELECT coalesce(sum(max_bytes),0) FROM public.pb_projects WHERE NOT allocation_released)>budget THEN RAISE EXCEPTION 'PB_PROJECT_CAPACITY'; END IF;
  INSERT INTO public.pb_projects(id,owner_id,kind,title,max_bytes) VALUES(p_project,p_actor,p_kind,p_title,p_max_bytes) RETURNING * INTO p;
  INSERT INTO public.pb_project_members VALUES(p_project,p_actor,'accepted'); RETURN to_jsonb(p);
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_member(p_actor uuid,p_project uuid,p_user uuid,p_action text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.pb_projects; m public.pb_project_members;
BEGIN PERFORM public.pb_project_require_service(); SELECT * INTO p FROM public.pb_projects WHERE id=p_project FOR UPDATE;
  IF p.id IS NULL OR p.status<>'active' OR p_user IS NULL OR p_action IS NULL OR p_action NOT IN ('invite','accept','revoke') THEN RAISE EXCEPTION 'PB_PROJECT_INVALID'; END IF;
  IF p_action='accept' THEN
    IF p_actor IS DISTINCT FROM p_user THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
    UPDATE public.pb_project_members SET status='accepted' WHERE project_id=p_project AND user_id=p_actor AND status IN ('invited','accepted') RETURNING * INTO m;
    IF NOT FOUND THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
  ELSE
    PERFORM public.pb_project_require_actor(p_project,p_actor,true);
    IF p_user=p.owner_id OR p.kind<>'friend' THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
    SELECT * INTO m FROM public.pb_project_members WHERE project_id=p_project AND user_id=p_user;
    IF p_action='invite' THEN
      IF m.status='revoked' THEN RAISE EXCEPTION 'PB_PROJECT_CONFLICT'; END IF;
      IF m.user_id IS NULL AND (SELECT count(*) FROM public.pb_project_members WHERE project_id=p_project)>=4 THEN RAISE EXCEPTION 'PB_PROJECT_CAPACITY'; END IF;
      INSERT INTO public.pb_project_members VALUES(p_project,p_user,'invited') ON CONFLICT DO NOTHING;
    ELSE UPDATE public.pb_project_members SET status='revoked' WHERE project_id=p_project AND user_id=p_user; END IF;
    SELECT * INTO m FROM public.pb_project_members WHERE project_id=p_project AND user_id=p_user;
  END IF;
  RETURN to_jsonb(m);
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_reserve(p_actor uuid,p_project uuid,p_body jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.pb_projects; a public.pb_project_assets; expiry timestamptz=clock_timestamp()+interval '10 minutes'; protection text; protection_id uuid;
BEGIN PERFORM public.pb_project_require_service(); SELECT * INTO p FROM public.pb_projects WHERE id=p_project FOR UPDATE; PERFORM public.pb_project_require_actor(p_project,p_actor);
  IF (SELECT deployment_bytes>0 FROM public.pb_project_configuration WHERE singleton) IS DISTINCT FROM true THEN RAISE EXCEPTION 'PB_PROJECT_NOT_READY'; END IF;
  IF jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR NOT p_body ?& ARRAY['id','requestId','kind','mime','bytes','width','height','sha256','protection'] OR (p_body-ARRAY['id','requestId','kind','mime','bytes','width','height','sha256','protection'])<>'{}' OR jsonb_typeof(p_body->'protection') IS DISTINCT FROM 'object' OR NOT (p_body->'protection') ?& ARRAY['kind','id'] OR ((p_body->'protection')-ARRAY['kind','id'])<>'{}' THEN RAISE EXCEPTION 'PB_PROJECT_INVALID'; END IF;
  protection=p_body->'protection'->>'kind'; protection_id=(p_body->'protection'->>'id')::uuid;
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['bytes','width','height']) k WHERE jsonb_typeof(p_body->k) IS DISTINCT FROM 'number' OR p_body->>k !~ '^[0-9]+$') THEN RAISE EXCEPTION 'PB_PROJECT_INVALID'; END IF;
  IF public.pb_project_protection_write(p_project,p_actor,protection,protection_id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'PB_PROJECT_PROTECTED'; END IF;
  SELECT * INTO a FROM public.pb_project_assets WHERE project_id=p_project AND owner_id=p_actor AND request_id=(p_body->>'requestId')::uuid;
  IF FOUND THEN
    IF a.fingerprint<>p_body THEN RAISE EXCEPTION 'PB_PROJECT_CONFLICT'; END IF;
    IF a.status NOT IN ('reserved','ready') OR (a.status='reserved' AND a.reserved_until<=clock_timestamp()) THEN RAISE EXCEPTION 'PB_PROJECT_EXPIRED'; END IF;
    RETURN to_jsonb(a);
  END IF;
  IF (SELECT count(*) FROM public.pb_project_assets WHERE project_id=p_project AND NOT charge_released)>=24 OR
     10485760+(SELECT coalesce(sum(held_bytes),0) FROM public.pb_project_assets WHERE project_id=p_project AND NOT charge_released)>p.max_bytes OR
     (p_body->>'width')::bigint*(p_body->>'height')::bigint+(SELECT coalesce(sum(width::bigint*height),0) FROM public.pb_project_assets WHERE project_id=p_project AND NOT charge_released)>50331648 OR
     (p_body->>'kind'='decoration' AND (SELECT count(*) FROM public.pb_project_assets WHERE project_id=p_project AND kind='decoration' AND NOT charge_released)>=8) THEN RAISE EXCEPTION 'PB_PROJECT_CAPACITY'; END IF;
  INSERT INTO public.pb_project_assets(id,project_id,owner_id,request_id,fingerprint,kind,mime,bytes,width,height,sha256,protection,protection_id,path,reserved_until,cleanup_after)
  VALUES((p_body->>'id')::uuid,p_project,p_actor,(p_body->>'requestId')::uuid,p_body,p_body->>'kind',p_body->>'mime',(p_body->>'bytes')::bigint,(p_body->>'width')::integer,(p_body->>'height')::integer,p_body->>'sha256',protection,protection_id,p_project::text||'/'||p_actor::text||'/'||(p_body->>'id')::uuid::text,expiry,expiry) RETURNING * INTO a;
  RETURN to_jsonb(a);
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_authorise_upload(p_actor uuid,p_asset uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.pb_project_assets; mint_deadline timestamptz=clock_timestamp()+interval '60 seconds';
BEGIN PERFORM public.pb_project_require_service(); SELECT * INTO a FROM public.pb_project_assets WHERE id=p_asset; PERFORM 1 FROM public.pb_projects WHERE id=a.project_id FOR UPDATE; SELECT * INTO a FROM public.pb_project_assets WHERE id=p_asset FOR UPDATE; PERFORM public.pb_project_require_actor(a.project_id,p_actor);
  IF a.owner_id IS DISTINCT FROM p_actor OR a.status<>'reserved' OR a.reserved_until<=clock_timestamp() OR public.pb_project_protection_write(a.project_id,p_actor,a.protection,a.protection_id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
  IF a.mint_before IS NULL THEN UPDATE public.pb_project_assets SET mint_before=mint_deadline,upload_until=mint_deadline+interval '120 minutes',cleanup_after=mint_deadline+interval '125 minutes' WHERE id=a.id RETURNING * INTO a; END IF;
  IF a.mint_before<=clock_timestamp() THEN RAISE EXCEPTION 'PB_PROJECT_EXPIRED'; END IF;
  RETURN jsonb_build_object('bucket','photobooth-projects-v2','path',a.path,'maxBytes',a.bytes,'overwrite',false,'mintBefore',a.mint_before,'uploadUntil',a.upload_until,'cleanupAfter',a.cleanup_after);
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_finalise(p_actor uuid,p_asset uuid,p_verified jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.pb_project_assets; actual bigint;
BEGIN PERFORM public.pb_project_require_service(); SELECT * INTO a FROM public.pb_project_assets WHERE id=p_asset; PERFORM 1 FROM public.pb_projects WHERE id=a.project_id FOR UPDATE; SELECT * INTO a FROM public.pb_project_assets WHERE id=p_asset FOR UPDATE; PERFORM public.pb_project_require_actor(a.project_id,p_actor);
  IF a.owner_id IS DISTINCT FROM p_actor OR public.pb_project_protection_write(a.project_id,p_actor,a.protection,a.protection_id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
  IF p_verified IS DISTINCT FROM jsonb_build_object('bytes',a.bytes,'width',a.width,'height',a.height,'mime',a.mime,'sha256',a.sha256,'decoded',true) THEN RAISE EXCEPTION 'PB_PROJECT_INVALID'; END IF;
  IF a.status='ready' THEN RETURN to_jsonb(a); END IF;
  IF a.status<>'reserved' OR a.reserved_until<=clock_timestamp() OR a.upload_until IS NULL THEN RAISE EXCEPTION 'PB_PROJECT_EXPIRED'; END IF;
  SELECT (metadata->>'size')::bigint INTO actual FROM storage.objects WHERE bucket_id='photobooth-projects-v2' AND name=a.path;
  IF actual IS DISTINCT FROM a.bytes THEN RAISE EXCEPTION 'PB_PROJECT_NOT_READY'; END IF;
  UPDATE public.pb_project_assets SET status='ready',held_bytes=bytes WHERE id=a.id RETURNING * INTO a; RETURN to_jsonb(a);
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_finalisation_projection(p_asset uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object('assetId',a.id,'status',coalesce(j.status,CASE WHEN a.status='ready' THEN 'complete' ELSE 'not_queued' END),'assetStatus',a.status,'attempts',coalesce(j.attempts,0),'failure',j.failure,'reservedUntil',a.reserved_until)
  FROM public.pb_project_assets a LEFT JOIN public.pb_project_finalisations j ON j.asset_id=a.id WHERE a.id=p_asset
$$;
CREATE OR REPLACE FUNCTION public.pb_project_finalisation_status(p_actor uuid,p_asset uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.pb_project_assets;
BEGIN PERFORM public.pb_project_require_service(); SELECT * INTO a FROM public.pb_project_assets WHERE id=p_asset; PERFORM public.pb_project_require_actor(a.project_id,p_actor);
  IF a.owner_id IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
  RETURN public.pb_project_finalisation_projection(a.id);
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_enqueue_finalisation(p_actor uuid,p_asset uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.pb_project_assets;
BEGIN PERFORM public.pb_project_require_service(); SELECT * INTO a FROM public.pb_project_assets WHERE id=p_asset;
  PERFORM 1 FROM public.pb_projects WHERE id=a.project_id FOR UPDATE; SELECT * INTO a FROM public.pb_project_assets WHERE id=p_asset FOR UPDATE;
  PERFORM public.pb_project_require_actor(a.project_id,p_actor);
  IF a.owner_id IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
  IF a.status='ready' THEN RETURN public.pb_project_finalisation_projection(a.id); END IF;
  IF public.pb_project_protection_write(a.project_id,p_actor,a.protection,a.protection_id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
  IF a.status<>'reserved' OR a.reserved_until<=clock_timestamp() OR a.upload_until IS NULL THEN RAISE EXCEPTION 'PB_PROJECT_EXPIRED'; END IF;
  INSERT INTO public.pb_project_finalisations(asset_id) VALUES(a.id) ON CONFLICT DO NOTHING;
  RETURN public.pb_project_finalisation_projection(a.id);
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_claim_finalisation() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE candidate record; a public.pb_project_assets; j public.pb_project_finalisations; failure_code text;
BEGIN PERFORM public.pb_project_require_service();
  FOR candidate IN SELECT x.asset_id,pa.project_id FROM public.pb_project_finalisations x JOIN public.pb_project_assets pa ON pa.id=x.asset_id
    WHERE x.status IN ('queued','retry','running') AND x.available_at<=clock_timestamp() AND coalesce(x.lease_until,'-infinity')<=clock_timestamp() ORDER BY x.available_at,x.asset_id LIMIT 25 LOOP
    PERFORM 1 FROM public.pb_projects WHERE id=candidate.project_id FOR UPDATE SKIP LOCKED; IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO a FROM public.pb_project_assets WHERE id=candidate.asset_id FOR UPDATE SKIP LOCKED; IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO j FROM public.pb_project_finalisations WHERE asset_id=a.id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND OR j.status NOT IN ('queued','retry','running') OR j.available_at>clock_timestamp() OR coalesce(j.lease_until,'-infinity')>clock_timestamp() THEN CONTINUE; END IF;
    failure_code=NULL;
    IF a.status<>'reserved' OR a.reserved_until<=clock_timestamp() THEN failure_code='deadline';
    ELSIF NOT EXISTS(SELECT 1 FROM public.pb_projects p JOIN public.pb_project_members m ON m.project_id=p.id WHERE p.id=a.project_id AND p.status='active' AND m.user_id=a.owner_id AND m.status='accepted') OR public.pb_project_protection_write(a.project_id,a.owner_id,a.protection,a.protection_id) IS DISTINCT FROM true THEN failure_code='access_lost';
    ELSIF j.attempts>=8 THEN failure_code='attempts_exhausted'; END IF;
    IF failure_code IS NOT NULL THEN UPDATE public.pb_project_finalisations SET status='failed',failure=failure_code,lease_token=NULL,lease_until=NULL WHERE asset_id=a.id; CONTINUE; END IF;
    UPDATE public.pb_project_finalisations SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=least(clock_timestamp()+interval '120 seconds',a.reserved_until),failure=NULL WHERE asset_id=a.id RETURNING * INTO j;
    RETURN jsonb_build_object('assetId',a.id,'projectId',a.project_id,'ownerId',a.owner_id,'requestId',a.request_id,'bucket','photobooth-projects-v2','path',a.path,'kind',a.kind,'mime',a.mime,'bytes',a.bytes,'width',a.width,'height',a.height,'sha256',a.sha256,'protection',jsonb_build_object('kind',a.protection,'id',a.protection_id),'reservedUntil',a.reserved_until,'leaseToken',j.lease_token,'leaseUntil',j.lease_until,'attempts',j.attempts);
  END LOOP;
  RETURN '{}'::jsonb;
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_finish_finalisation(p_asset uuid,p_lease uuid,p_outcome text,p_verified jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.pb_project_assets; j public.pb_project_finalisations; failure_code text;
BEGIN PERFORM public.pb_project_require_service(); SELECT * INTO a FROM public.pb_project_assets WHERE id=p_asset;
  PERFORM 1 FROM public.pb_projects WHERE id=a.project_id FOR UPDATE; SELECT * INTO a FROM public.pb_project_assets WHERE id=p_asset FOR UPDATE;
  SELECT * INTO j FROM public.pb_project_finalisations WHERE asset_id=p_asset FOR UPDATE;
  IF j.status IS DISTINCT FROM 'running' OR j.lease_token IS DISTINCT FROM p_lease OR j.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'PB_PROJECT_LEASE'; END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('verified','retry','reject') OR (p_outcome<>'verified' AND p_verified IS NOT NULL) THEN RAISE EXCEPTION 'PB_PROJECT_INVALID'; END IF;
  failure_code=NULL;
  IF a.status<>'reserved' OR a.reserved_until<=clock_timestamp() THEN failure_code='deadline';
  ELSIF NOT EXISTS(SELECT 1 FROM public.pb_projects p JOIN public.pb_project_members m ON m.project_id=p.id WHERE p.id=a.project_id AND p.status='active' AND m.user_id=a.owner_id AND m.status='accepted') OR public.pb_project_protection_write(a.project_id,a.owner_id,a.protection,a.protection_id) IS DISTINCT FROM true THEN failure_code='access_lost'; END IF;
  IF failure_code IS NOT NULL THEN
    UPDATE public.pb_project_finalisations SET status='failed',failure=failure_code,lease_token=NULL,lease_until=NULL WHERE asset_id=a.id;
  ELSIF p_outcome='verified' THEN
    PERFORM public.pb_project_finalise(a.owner_id,a.id,p_verified);
    UPDATE public.pb_project_finalisations SET status='complete',failure=NULL,lease_token=NULL,lease_until=NULL WHERE asset_id=a.id;
  ELSE
    UPDATE public.pb_project_finalisations SET status=CASE WHEN p_outcome='reject' OR attempts>=8 THEN 'failed' ELSE 'retry' END,
      failure=CASE WHEN p_outcome='reject' THEN 'invalid_image' WHEN attempts>=8 THEN 'attempts_exhausted' ELSE 'provider_retry' END,
      available_at=clock_timestamp()+interval '5 seconds',lease_token=NULL,lease_until=NULL WHERE asset_id=a.id;
  END IF;
  RETURN public.pb_project_finalisation_projection(a.id);
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_asset_access(p_actor uuid,p_asset uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.pb_project_assets;
BEGIN PERFORM public.pb_project_require_service(); SELECT * INTO a FROM public.pb_project_assets WHERE id=p_asset; PERFORM public.pb_project_require_actor(a.project_id,p_actor);
  IF a.status<>'ready' OR public.pb_project_protection_read(a.id,p_actor) IS DISTINCT FROM true THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
  RETURN jsonb_build_object('assetId',a.id,'bucket','photobooth-projects-v2','path',a.path,'bytes',a.bytes,'mime',a.mime,'sha256',a.sha256,'expiresIn',300);
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_view(p_actor uuid,p_project uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_project_require_actor(p_project,p_actor);
  RETURN jsonb_build_object('project',(SELECT to_jsonb(p) FROM public.pb_projects p WHERE id=p_project),
    'members',(SELECT coalesce(jsonb_agg(jsonb_build_object('userId',user_id,'status',status) ORDER BY user_id),'[]') FROM public.pb_project_members WHERE project_id=p_project),
    'assets',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'ownerId',owner_id,'kind',kind,'mime',mime,'bytes',bytes,'width',width,'height',height,'sha256',sha256) ORDER BY created_at,id),'[]') FROM public.pb_project_assets WHERE project_id=p_project AND status='ready' AND public.pb_project_protection_read(id,p_actor)));
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_queue_cleanup(p_asset uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  INSERT INTO public.pb_project_cleanup(asset_id,available_at) SELECT id,greatest(clock_timestamp(),cleanup_after) FROM public.pb_project_assets WHERE id=p_asset AND status IN ('deleted','expired') ON CONFLICT DO NOTHING
$$;
CREATE OR REPLACE FUNCTION public.pb_project_delete(p_actor uuid,p_project uuid,p_asset uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.pb_project_assets; p public.pb_projects;
BEGIN PERFORM public.pb_project_require_service(); SELECT * INTO p FROM public.pb_projects WHERE id=p_project FOR UPDATE;
  IF p_asset IS NULL THEN
    IF p.owner_id IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
    UPDATE public.pb_projects SET status='deleted' WHERE id=p_project;
    FOR a IN UPDATE public.pb_project_assets SET status='deleted' WHERE project_id=p_project RETURNING * LOOP PERFORM public.pb_project_queue_cleanup(a.id); END LOOP;
  ELSE
    PERFORM public.pb_project_require_actor(p_project,p_actor);
    SELECT * INTO a FROM public.pb_project_assets WHERE id=p_asset AND project_id=p_project FOR UPDATE;
    IF a.id IS NULL OR a.owner_id<>p_actor THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
    UPDATE public.pb_project_assets SET status='deleted' WHERE id=a.id; PERFORM public.pb_project_queue_cleanup(a.id);
  END IF;
  IF p_asset IS NULL AND NOT EXISTS(SELECT 1 FROM public.pb_project_assets WHERE project_id=p_project AND NOT charge_released) THEN UPDATE public.pb_projects SET allocation_released=true WHERE id=p_project; END IF;
  RETURN jsonb_build_object('pending',EXISTS(SELECT 1 FROM public.pb_project_assets WHERE project_id=p_project AND (p_asset IS NULL OR id=p_asset) AND NOT charge_released));
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_sweep(p_limit integer DEFAULT 25) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.pb_project_assets; n integer=0;
BEGIN PERFORM public.pb_project_require_service(); IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'PB_PROJECT_INVALID'; END IF;
  FOR a IN SELECT * FROM public.pb_project_assets WHERE status='reserved' AND reserved_until<=clock_timestamp() ORDER BY reserved_until,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
    UPDATE public.pb_project_assets SET status='expired' WHERE id=a.id; PERFORM public.pb_project_queue_cleanup(a.id); n=n+1;
  END LOOP; RETURN jsonb_build_object('expired',n);
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_claim_cleanup() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.pb_project_cleanup; a public.pb_project_assets;
BEGIN PERFORM public.pb_project_require_service();
  UPDATE public.pb_project_cleanup SET status='failed',lease_token=NULL,lease_until=NULL WHERE asset_id IN (SELECT asset_id FROM public.pb_project_cleanup WHERE status IN ('queued','retry','running') AND attempts>=8 AND coalesce(lease_until,'-infinity')<=clock_timestamp() ORDER BY available_at,asset_id LIMIT 25 FOR UPDATE SKIP LOCKED);
  SELECT * INTO j FROM public.pb_project_cleanup WHERE status IN ('queued','retry','running') AND attempts<8 AND available_at<=clock_timestamp() AND coalesce(lease_until,'-infinity')<=clock_timestamp() ORDER BY available_at,asset_id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
  UPDATE public.pb_project_cleanup SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '120 seconds' WHERE asset_id=j.asset_id RETURNING * INTO j;
  SELECT * INTO a FROM public.pb_project_assets WHERE id=j.asset_id;
  RETURN to_jsonb(j)||jsonb_build_object('bucket','photobooth-projects-v2','path',a.path);
END $$;
CREATE OR REPLACE FUNCTION public.pb_project_finish_cleanup(p_asset uuid,p_lease uuid,p_confirmed_absent boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE j public.pb_project_cleanup; a public.pb_project_assets;
BEGIN PERFORM public.pb_project_require_service(); SELECT * INTO a FROM public.pb_project_assets WHERE id=p_asset;
  PERFORM 1 FROM public.pb_projects WHERE id=a.project_id FOR UPDATE;
  SELECT * INTO j FROM public.pb_project_cleanup WHERE asset_id=p_asset FOR UPDATE; SELECT * INTO a FROM public.pb_project_assets WHERE id=p_asset FOR UPDATE;
  IF j.status IS DISTINCT FROM 'running' OR j.lease_token IS DISTINCT FROM p_lease OR j.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'PB_PROJECT_LEASE'; END IF;
  IF p_confirmed_absent IS TRUE THEN
    IF a.status NOT IN ('deleted','expired') OR a.cleanup_after>clock_timestamp() OR EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='photobooth-projects-v2' AND name=a.path) THEN RAISE EXCEPTION 'PB_PROJECT_NOT_READY'; END IF;
    UPDATE public.pb_project_assets SET charge_released=true WHERE id=a.id;
    UPDATE public.pb_project_cleanup SET status='complete',confirmed_absent=true,lease_token=NULL,lease_until=NULL WHERE asset_id=a.id;
    UPDATE public.pb_projects SET allocation_released=true WHERE id=a.project_id AND status='deleted' AND NOT EXISTS(SELECT 1 FROM public.pb_project_assets WHERE project_id=a.project_id AND NOT charge_released);
  ELSE UPDATE public.pb_project_cleanup SET status=CASE WHEN attempts>=8 THEN 'failed' ELSE 'retry' END,lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()+interval '60 seconds' WHERE asset_id=a.id; END IF;
  RETURN jsonb_build_object('complete',p_confirmed_absent IS TRUE);
END $$;

CREATE OR REPLACE FUNCTION public.pb_project_object_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.pb_project_assets;
BEGIN
  IF TG_OP='UPDATE' AND OLD.bucket_id='photobooth-projects-v2' AND (NEW.bucket_id<>OLD.bucket_id OR NEW.name<>OLD.name) THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
  IF NEW.bucket_id<>'photobooth-projects-v2' THEN RETURN NEW; END IF;
  SELECT * INTO a FROM public.pb_project_assets WHERE path=NEW.name FOR UPDATE;
  IF TG_OP='UPDATE' OR a.id IS NULL OR a.status<>'reserved' OR a.reserved_until<=clock_timestamp() OR public.pb_project_protection_write(a.project_id,a.owner_id,a.protection,a.protection_id) IS DISTINCT FROM true OR a.upload_until IS NULL OR a.upload_until<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM public.pb_projects p JOIN public.pb_project_members m ON m.project_id=p.id WHERE p.id=a.project_id AND p.status='active' AND m.user_id=a.owner_id AND m.status='accepted') THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pb_project_object_fence ON storage.objects;
CREATE TRIGGER pb_project_object_fence BEFORE INSERT OR UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION public.pb_project_object_fence();

-- A restrictive policy also fences any unrelated permissive Storage policy.
DROP POLICY IF EXISTS pb_project_storage_boundary ON storage.objects;
CREATE POLICY pb_project_storage_boundary ON storage.objects AS RESTRICTIVE FOR ALL TO anon,authenticated USING(bucket_id<>'photobooth-projects-v2') WITH CHECK(bucket_id<>'photobooth-projects-v2');
DO $$ DECLARE t text; f record;
BEGIN
  FOREACH t IN ARRAY ARRAY['pb_project_configuration','pb_projects','pb_project_members','pb_project_rates','pb_project_assets','pb_project_cleanup','pb_project_finalisations','pb_saved_templates'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'pb_project_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature); END LOOP;
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES('photobooth-projects-v2','photobooth-projects-v2',false,10485760,ARRAY['image/jpeg','image/png','image/webp']) ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.pb_project_capabilities(),public.pb_project_rate(uuid,text),public.pb_project_list(uuid,uuid,integer),public.pb_project_configure(bigint),public.pb_project_create(uuid,uuid,text,text,bigint),public.pb_project_member(uuid,uuid,uuid,text),public.pb_project_reserve(uuid,uuid,jsonb),public.pb_project_authorise_upload(uuid,uuid),public.pb_project_enqueue_finalisation(uuid,uuid),public.pb_project_finalisation_status(uuid,uuid),public.pb_project_claim_finalisation(),public.pb_project_finish_finalisation(uuid,uuid,text,jsonb),public.pb_project_asset_access(uuid,uuid),public.pb_project_view(uuid,uuid),public.pb_project_delete(uuid,uuid,uuid),public.pb_project_sweep(integer),public.pb_project_claim_cleanup(),public.pb_project_finish_cleanup(uuid,uuid,boolean) TO service_role;
COMMIT;
