BEGIN;
CREATE TABLE IF NOT EXISTS public.pb_challenges (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES public.pb_projects, initiator_id uuid NOT NULL REFERENCES auth.users,
  fingerprint jsonb NOT NULL, recipe_hash text NOT NULL CHECK(recipe_hash ~ '^[a-f0-9]{64}$'),
  policy text NOT NULL CHECK(policy IN ('immediate','all_submitted')), status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','revealed','cancelled','expired')),
  expires_at timestamptz NOT NULL, frozen_at timestamptz, revealed_at timestamptz, reveal_hash text, reveal_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), CHECK((revealed_at IS NULL)=(reveal_hash IS NULL)), CHECK(reveal_hash IS NULL OR reveal_hash ~ '^[a-f0-9]{64}$')
);
ALTER TABLE public.pb_challenges ADD COLUMN IF NOT EXISTS design jsonb;
CREATE INDEX IF NOT EXISTS pb_challenge_project ON public.pb_challenges(project_id);
CREATE INDEX IF NOT EXISTS pb_challenge_expiry ON public.pb_challenges(status,expires_at);
CREATE TABLE IF NOT EXISTS public.pb_challenge_members (
  challenge_id uuid NOT NULL REFERENCES public.pb_challenges, user_id uuid NOT NULL REFERENCES auth.users,
  role text NOT NULL CHECK(role IN ('A','B','C','D')), status text NOT NULL CHECK(status IN ('invited','accepted','declined','withdrawn')),
  PRIMARY KEY(challenge_id,user_id), UNIQUE(challenge_id,role)
);
CREATE TABLE IF NOT EXISTS public.pb_challenge_assignments (
  challenge_id uuid NOT NULL REFERENCES public.pb_challenges, slot integer NOT NULL CHECK(slot BETWEEN 0 AND 15),
  user_id uuid NOT NULL, source_index integer NOT NULL CHECK(source_index BETWEEN 0 AND 3), PRIMARY KEY(challenge_id,slot),
  FOREIGN KEY(challenge_id,user_id) REFERENCES public.pb_challenge_members(challenge_id,user_id)
);
CREATE TABLE IF NOT EXISTS public.pb_challenge_submissions (
  challenge_id uuid NOT NULL, user_id uuid NOT NULL, request_id uuid NOT NULL, fingerprint jsonb NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(challenge_id,user_id), UNIQUE(challenge_id,request_id),
  FOREIGN KEY(challenge_id,user_id) REFERENCES public.pb_challenge_members(challenge_id,user_id)
);
CREATE TABLE IF NOT EXISTS public.pb_challenge_submission_assets (
  challenge_id uuid NOT NULL, user_id uuid NOT NULL, source_index integer NOT NULL CHECK(source_index BETWEEN 0 AND 3), asset_id uuid NOT NULL UNIQUE REFERENCES public.pb_project_assets,
  PRIMARY KEY(challenge_id,user_id,source_index), FOREIGN KEY(challenge_id,user_id) REFERENCES public.pb_challenge_submissions(challenge_id,user_id)
);
CREATE TABLE IF NOT EXISTS public.pb_challenge_partials (
  id uuid PRIMARY KEY, challenge_id uuid NOT NULL REFERENCES public.pb_challenges, proposer_id uuid NOT NULL REFERENCES auth.users,
  snapshot jsonb NOT NULL, digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','rejected','revealed')), revealed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS public.pb_challenge_partial_members (
  partial_id uuid NOT NULL REFERENCES public.pb_challenge_partials, user_id uuid NOT NULL REFERENCES auth.users, consent boolean,
  PRIMARY KEY(partial_id,user_id)
);

CREATE OR REPLACE FUNCTION public.pb_challenge_hash(p_value jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT encode(sha256(convert_to(p_value::text,'UTF8')),'hex') $$;
CREATE OR REPLACE FUNCTION public.pb_challenge_recipe_assignments(p_design jsonb,p_members jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE cell jsonb; source jsonb; pairs jsonb='[]'; required jsonb; assignments jsonb;
BEGIN
  IF jsonb_typeof(p_design) IS DISTINCT FROM 'object' OR NOT p_design ?& ARRAY['canvas','requiredSources','slots','layers','decorations','look','defaults'] OR p_design-ARRAY['canvas','requiredSources','slots','layers','decorations','look','defaults','places']<>'{}'
    OR jsonb_typeof(p_design->'slots') IS DISTINCT FROM 'array' OR jsonb_array_length(p_design->'slots') NOT BETWEEN 1 AND 16 OR jsonb_typeof(p_design->'decorations') IS DISTINCT FROM 'array' OR jsonb_array_length(p_design->'decorations')>8 THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  FOR cell IN SELECT * FROM jsonb_array_elements(p_design->'slots') LOOP
    IF jsonb_typeof(cell) IS DISTINCT FROM 'object' OR (cell ? 'companions' AND (jsonb_typeof(cell->'companions') IS DISTINCT FROM 'array' OR jsonb_array_length(cell->'companions') NOT BETWEEN 1 AND 3)) THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
    FOR source IN SELECT cell UNION ALL SELECT * FROM jsonb_array_elements(coalesce(cell->'companions','[]')) LOOP
      IF source->>'role' IS NULL OR source->>'role' NOT IN ('A','B','C','D') OR jsonb_typeof(source->'sourceIndex') IS DISTINCT FROM 'number' OR source->>'sourceIndex' !~ '^[0-3]$' THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
      pairs=pairs||jsonb_build_array(jsonb_build_object('role',source->>'role','sourceIndex',(source->>'sourceIndex')::integer));
    END LOOP;
  END LOOP;
  SELECT jsonb_object_agg(r.role,r.maximum) INTO required FROM (SELECT x->>'role' role,max((x->>'sourceIndex')::integer)+1 maximum FROM jsonb_array_elements(pairs) x GROUP BY x->>'role') r;
  IF required IS DISTINCT FROM p_design->'requiredSources' OR EXISTS(SELECT 1 FROM jsonb_object_keys(required) role WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_members) m WHERE m->>'role'=role)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_members) m WHERE NOT required ? (m->>'role')) THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  SELECT jsonb_agg(jsonb_build_object('slot',r.slot,'userId',r.user_id,'sourceIndex',r.source_index) ORDER BY r.slot) INTO assignments FROM (
    SELECT row_number() OVER(ORDER BY x.role,x.source_index)-1 slot,m->>'userId' user_id,x.source_index FROM (SELECT DISTINCT x->>'role' role,(x->>'sourceIndex')::integer source_index FROM jsonb_array_elements(pairs) x) x JOIN jsonb_array_elements(p_members) m ON m->>'role'=x.role) r;
  IF jsonb_array_length(assignments) NOT BETWEEN 2 AND 16 THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  RETURN assignments;
END $$;
CREATE OR REPLACE FUNCTION public.pb_challenge_recipe_available(p_project uuid,p_design jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT p_design IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_design->'decorations') d WHERE NOT EXISTS(
    SELECT 1 FROM public.pb_project_assets a JOIN public.pb_project_members m ON m.project_id=a.project_id AND m.user_id=a.owner_id
    WHERE a.id=(d->>'id')::uuid AND a.project_id=p_project AND a.kind='decoration' AND a.status='ready' AND a.protection='none' AND a.protection_id IS NULL AND m.status='accepted'
      AND d=jsonb_build_object('id',a.id,'kind',a.kind,'mime',a.mime,'bytes',a.bytes,'width',a.width,'height',a.height)))
$$;
CREATE OR REPLACE FUNCTION public.pb_challenge_require_actor(p_actor uuid,p_challenge uuid,p_accepted boolean DEFAULT true) RETURNS public.pb_challenges LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_challenges;
BEGIN
  PERFORM public.pb_project_require_service(); SELECT * INTO c FROM public.pb_challenges WHERE id=p_challenge;
  IF c.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.pb_projects WHERE id=c.project_id AND status='active') OR NOT EXISTS(SELECT 1 FROM public.pb_challenge_members m JOIN public.pb_project_members p ON p.project_id=c.project_id AND p.user_id=m.user_id WHERE m.challenge_id=c.id AND m.user_id=p_actor AND p.status IN ('invited','accepted') AND (NOT p_accepted OR (m.status='accepted' AND p.status='accepted'))) THEN RAISE EXCEPTION 'PB_CHALLENGE_DENIED'; END IF;
  RETURN c;
END $$;
CREATE OR REPLACE FUNCTION public.pb_challenge_roster_available(p_challenge uuid,p_users uuid[] DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.pb_challenges c JOIN public.pb_projects p ON p.id=c.project_id WHERE c.id=p_challenge AND p.status='active') AND
    NOT EXISTS(SELECT 1 FROM public.pb_challenge_members m JOIN public.pb_challenges c ON c.id=m.challenge_id LEFT JOIN public.pb_project_members p ON p.project_id=c.project_id AND p.user_id=m.user_id WHERE m.challenge_id=p_challenge AND (p_users IS NULL OR m.user_id=ANY(p_users)) AND (m.status<>'accepted' OR p.status IS DISTINCT FROM 'accepted'))
$$;
CREATE OR REPLACE FUNCTION public.pb_challenge_snapshot(p_challenge uuid,p_users uuid[] DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object('challengeId',c.id,'recipeHash',c.recipe_hash,'members',(SELECT coalesce(jsonb_agg(jsonb_build_object('userId',m.user_id,'role',m.role,'requestId',s.request_id,'sources',(SELECT coalesce(jsonb_agg(jsonb_build_object('sourceIndex',a.source_index,'assetId',a.asset_id) ORDER BY a.source_index),'[]') FROM public.pb_challenge_submission_assets a WHERE a.challenge_id=m.challenge_id AND a.user_id=m.user_id)) ORDER BY m.role),'[]') FROM public.pb_challenge_members m JOIN public.pb_challenge_submissions s ON s.challenge_id=m.challenge_id AND s.user_id=m.user_id WHERE m.challenge_id=c.id AND (p_users IS NULL OR m.user_id=ANY(p_users)))) FROM public.pb_challenges c WHERE c.id=p_challenge
$$;
CREATE OR REPLACE FUNCTION public.pb_challenge_sources_available(p_challenge uuid,p_users uuid[] DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.pb_challenges c WHERE c.id=p_challenge AND public.pb_challenge_recipe_available(c.project_id,c.design)) AND NOT EXISTS(SELECT 1 FROM public.pb_challenge_submission_assets s JOIN public.pb_project_assets a ON a.id=s.asset_id WHERE s.challenge_id=p_challenge AND (p_users IS NULL OR s.user_id=ANY(p_users)) AND (a.status<>'ready' OR a.protection<>'challenge' OR a.protection_id IS DISTINCT FROM p_challenge OR a.owner_id<>s.user_id))
$$;
CREATE OR REPLACE FUNCTION public.pb_project_protection_write(p_project uuid,p_actor uuid,p_kind text,p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT CASE WHEN p_kind='none' THEN p_id IS NULL WHEN p_kind='challenge' THEN EXISTS(
    SELECT 1 FROM public.pb_challenges c JOIN public.pb_challenge_members m ON m.challenge_id=c.id WHERE c.id=p_id AND c.project_id=p_project AND c.design IS NOT NULL AND c.status='open' AND c.expires_at>clock_timestamp() AND m.user_id=p_actor AND m.status='accepted' AND public.pb_challenge_roster_available(c.id) AND NOT EXISTS(SELECT 1 FROM public.pb_challenge_submissions WHERE challenge_id=c.id AND user_id=p_actor)) ELSE false END
$$;
CREATE OR REPLACE FUNCTION public.pb_project_protection_read(p_asset uuid,p_actor uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.pb_project_assets; c public.pb_challenges; r public.pb_challenge_partials; users uuid[];
BEGIN
  SELECT * INTO a FROM public.pb_project_assets WHERE id=p_asset;
  IF a.id IS NULL THEN RETURN false; END IF;
  IF a.protection='none' THEN RETURN true; END IF;
  IF a.protection<>'challenge' THEN RETURN false; END IF;
  SELECT * INTO c FROM public.pb_challenges WHERE id=a.protection_id AND project_id=a.project_id;
  IF c.id IS NULL THEN RETURN false; END IF;
  IF a.owner_id=p_actor THEN RETURN true; END IF;
  IF c.design IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.pb_challenge_members WHERE challenge_id=c.id AND user_id=p_actor AND status='accepted') OR NOT EXISTS(SELECT 1 FROM public.pb_challenge_submission_assets WHERE challenge_id=c.id AND asset_id=a.id) THEN RETURN false; END IF;
  IF public.pb_challenge_roster_available(c.id) AND public.pb_challenge_sources_available(c.id) AND (c.status='revealed' OR (c.policy='immediate' AND c.status='open' AND c.expires_at>clock_timestamp())) THEN RETURN true; END IF;
  FOR r IN SELECT x.* FROM public.pb_challenge_partials x JOIN public.pb_challenge_partial_members recipient ON recipient.partial_id=x.id AND recipient.user_id=p_actor JOIN public.pb_challenge_partial_members author ON author.partial_id=x.id AND author.user_id=a.owner_id WHERE x.challenge_id=c.id AND x.status='revealed' LOOP
    SELECT array_agg(user_id ORDER BY user_id) INTO users FROM public.pb_challenge_partial_members WHERE partial_id=r.id;
    IF public.pb_challenge_roster_available(c.id,users) AND public.pb_challenge_sources_available(c.id,users) AND NOT EXISTS(SELECT 1 FROM public.pb_challenge_partial_members WHERE partial_id=r.id AND consent IS DISTINCT FROM true) AND r.snapshot=public.pb_challenge_snapshot(c.id,users) THEN RETURN true; END IF;
  END LOOP; RETURN false;
END $$;
CREATE OR REPLACE FUNCTION public.pb_challenge_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_project_require_service(); RETURN jsonb_build_object('version',2,'recipeVersion',1,'ready',public.pb_project_capabilities()->'ready'='true'::jsonb,'members',4,'slots',16,'sourcesPerMember',4,'proposals',20,'challengesPerProject',32); END $$;
CREATE OR REPLACE FUNCTION public.pb_project_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE budget bigint; bucket_ready boolean=false;
BEGIN PERFORM public.pb_project_require_service(); SELECT deployment_bytes INTO budget FROM public.pb_project_configuration WHERE singleton;
  IF to_regclass('storage.buckets') IS NOT NULL THEN EXECUTE 'SELECT EXISTS(SELECT 1 FROM storage.buckets WHERE id=''photobooth-projects-v2'' AND NOT public AND file_size_limit=10485760)' INTO bucket_ready; END IF;
  RETURN jsonb_build_object('version',1,'ready',budget>0 AND bucket_ready,'deploymentBytes',budget,'allocatedBytes',(SELECT coalesce(sum(max_bytes),0) FROM public.pb_projects WHERE NOT allocation_released),'members',4,'files',24,'projectBytes',67108864,'readSeconds',300,'uploadSeconds',7200,'challengeWrites',true,'finalisationVersion',1,'apiVersion',1);
END $$;
CREATE OR REPLACE FUNCTION public.pb_challenge_view(p_actor uuid,p_challenge uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_challenges;
BEGIN c=public.pb_challenge_require_actor(p_actor,p_challenge,false);
  IF c.design IS NULL THEN RETURN jsonb_build_object('id',c.id,'projectId',c.project_id,'unsupported',true,'reason','recipe_unavailable'); END IF;
  RETURN jsonb_build_object('id',c.id,'projectId',c.project_id,'status',CASE WHEN c.status IN ('draft','open') AND c.expires_at<=clock_timestamp() THEN 'expired' ELSE c.status END,'policy',c.policy,'recipeHash',c.recipe_hash,'design',c.design,'expiresAt',c.expires_at,'revealedAt',c.revealed_at,'revealHash',CASE WHEN public.pb_challenge_roster_available(c.id) AND public.pb_challenge_sources_available(c.id) THEN c.reveal_hash ELSE NULL END,
    'accessLost',c.frozen_at IS NOT NULL AND (NOT public.pb_challenge_roster_available(c.id) OR NOT public.pb_challenge_sources_available(c.id)),
    'members',(SELECT jsonb_agg(jsonb_build_object('userId',m.user_id,'role',m.role,'status',m.status,'submitted',EXISTS(SELECT 1 FROM public.pb_challenge_submissions WHERE challenge_id=c.id AND user_id=m.user_id)) ORDER BY m.role) FROM public.pb_challenge_members m WHERE m.challenge_id=c.id),
    'assignments',(SELECT jsonb_agg(jsonb_build_object('slot',slot,'userId',user_id,'sourceIndex',source_index) ORDER BY slot) FROM public.pb_challenge_assignments WHERE challenge_id=c.id),
    'visibleSources',(SELECT coalesce(jsonb_agg(jsonb_build_object('userId',s.user_id,'sourceIndex',s.source_index,'assetId',s.asset_id) ORDER BY s.user_id,s.source_index),'[]') FROM public.pb_challenge_submission_assets s JOIN public.pb_project_assets a ON a.id=s.asset_id WHERE s.challenge_id=c.id AND a.status='ready' AND EXISTS(SELECT 1 FROM public.pb_project_members WHERE project_id=c.project_id AND user_id=p_actor AND status='accepted') AND public.pb_project_protection_read(s.asset_id,p_actor)));
END $$;
CREATE OR REPLACE FUNCTION public.pb_challenge_create(p_actor uuid,p_project uuid,p_body jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_challenges; m jsonb; a jsonb; v_challenge uuid; assignments jsonb; recipe_hash text;
BEGIN
  PERFORM public.pb_project_require_service(); PERFORM 1 FROM public.pb_projects WHERE id=p_project FOR UPDATE; PERFORM public.pb_project_require_actor(p_project,p_actor,true);
  IF public.pb_challenge_capabilities()->'ready' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'PB_CHALLENGE_NOT_READY'; END IF;
  IF jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR octet_length(p_body::text)>65536 OR NOT p_body ?& ARRAY['id','design','policy','expiresAt','members','assignments'] OR p_body-ARRAY['id','design','policy','expiresAt','members','assignments']<>'{}' OR jsonb_typeof(p_body->'members') IS DISTINCT FROM 'array' OR jsonb_typeof(p_body->'assignments') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  IF jsonb_array_length(p_body->'members') NOT BETWEEN 2 AND 4 OR jsonb_array_length(p_body->'assignments') NOT BETWEEN 2 AND 16 OR p_body->>'policy' NOT IN ('immediate','all_submitted') OR (p_body->>'expiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  p_body=jsonb_set(p_body,'{members}',(SELECT jsonb_agg(member_row ORDER BY member_row->>'role') FROM jsonb_array_elements(p_body->'members') member_row));
  assignments=public.pb_challenge_recipe_assignments(p_body->'design',p_body->'members');
  IF assignments IS DISTINCT FROM p_body->'assignments' THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  recipe_hash=public.pb_challenge_hash(jsonb_build_object('design',p_body->'design','members',p_body->'members','assignments',assignments));
  v_challenge=(p_body->>'id')::uuid; SELECT * INTO c FROM public.pb_challenges WHERE pb_challenges.id=v_challenge;
  IF FOUND THEN IF c.project_id<>p_project OR c.initiator_id<>p_actor OR c.fingerprint<>p_body THEN RAISE EXCEPTION 'PB_CHALLENGE_CONFLICT'; END IF; RETURN public.pb_challenge_view(p_actor,c.id); END IF;
  IF (SELECT count(*) FROM public.pb_challenges WHERE project_id=p_project)>=32 THEN RAISE EXCEPTION 'PB_CHALLENGE_CAPACITY'; END IF;
  IF public.pb_challenge_recipe_available(p_project,p_body->'design') IS DISTINCT FROM true THEN RAISE EXCEPTION 'PB_CHALLENGE_DENIED'; END IF;
  INSERT INTO public.pb_challenges(id,project_id,initiator_id,fingerprint,recipe_hash,design,policy,expires_at) VALUES(v_challenge,p_project,p_actor,p_body,recipe_hash,p_body->'design',p_body->>'policy',(p_body->>'expiresAt')::timestamptz);
  FOR m IN SELECT * FROM jsonb_array_elements(p_body->'members') LOOP
    IF jsonb_typeof(m) IS DISTINCT FROM 'object' OR NOT m ?& ARRAY['userId','role'] OR m-ARRAY['userId','role']<>'{}' OR NOT EXISTS(SELECT 1 FROM public.pb_project_members WHERE project_id=p_project AND user_id=(m->>'userId')::uuid AND status IN ('invited','accepted')) THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
    INSERT INTO public.pb_challenge_members VALUES(v_challenge,(m->>'userId')::uuid,m->>'role',CASE WHEN (m->>'userId')::uuid=p_actor THEN 'accepted' ELSE 'invited' END);
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM public.pb_challenge_members WHERE challenge_id=v_challenge AND user_id=p_actor) THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  FOR a IN SELECT * FROM jsonb_array_elements(p_body->'assignments') LOOP
    IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT a ?& ARRAY['slot','userId','sourceIndex'] OR a-ARRAY['slot','userId','sourceIndex']<>'{}' OR jsonb_typeof(a->'slot') IS DISTINCT FROM 'number' OR jsonb_typeof(a->'sourceIndex') IS DISTINCT FROM 'number' OR a->>'slot' !~ '^[0-9]+$' OR a->>'sourceIndex' !~ '^[0-9]+$' THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
    INSERT INTO public.pb_challenge_assignments VALUES(v_challenge,(a->>'slot')::integer,(a->>'userId')::uuid,(a->>'sourceIndex')::integer);
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.pb_challenge_members m WHERE m.challenge_id=v_challenge AND NOT EXISTS(SELECT 1 FROM public.pb_challenge_assignments a WHERE a.challenge_id=v_challenge AND a.user_id=m.user_id)) THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  RETURN public.pb_challenge_view(p_actor,v_challenge);
END $$;
CREATE OR REPLACE FUNCTION public.pb_challenge_manage(p_actor uuid,p_challenge uuid,p_action text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_challenges;
BEGIN
  PERFORM public.pb_project_require_service(); SELECT * INTO c FROM public.pb_challenges WHERE id=p_challenge; PERFORM 1 FROM public.pb_projects WHERE id=c.project_id FOR UPDATE; SELECT * INTO c FROM public.pb_challenges WHERE id=p_challenge FOR UPDATE;
  PERFORM public.pb_challenge_require_actor(p_actor,p_challenge,false);
  IF c.design IS NULL THEN RAISE EXCEPTION 'PB_CHALLENGE_UPDATE_REQUIRED'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('accept','decline','open','cancel','withdraw') THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  IF p_action IN ('accept','decline') THEN
    IF c.status<>'draft' OR c.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PB_CHALLENGE_EXPIRED'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.pb_challenge_members WHERE challenge_id=c.id AND user_id=p_actor AND status IN ('invited',CASE WHEN p_action='accept' THEN 'accepted' ELSE 'declined' END)) THEN RAISE EXCEPTION 'PB_CHALLENGE_DENIED'; END IF;
    IF p_action='accept' THEN UPDATE public.pb_project_members SET status='accepted' WHERE project_id=c.project_id AND user_id=p_actor AND status='invited'; END IF;
    UPDATE public.pb_challenge_members SET status=CASE WHEN p_action='accept' THEN 'accepted' ELSE 'declined' END WHERE challenge_id=c.id AND user_id=p_actor;
  ELSIF p_action='open' THEN
    IF c.initiator_id<>p_actor THEN RAISE EXCEPTION 'PB_CHALLENGE_DENIED'; END IF;
    IF c.status='open' THEN RETURN public.pb_challenge_view(p_actor,c.id); END IF;
    IF c.status<>'draft' OR c.expires_at<=clock_timestamp() OR NOT public.pb_challenge_roster_available(c.id) OR NOT public.pb_challenge_recipe_available(c.project_id,c.design) THEN RAISE EXCEPTION 'PB_CHALLENGE_NOT_READY'; END IF;
    UPDATE public.pb_challenges SET status='open',frozen_at=clock_timestamp() WHERE id=c.id;
  ELSIF p_action='cancel' THEN
    IF c.initiator_id<>p_actor THEN RAISE EXCEPTION 'PB_CHALLENGE_DENIED'; END IF;
    IF c.status='revealed' THEN RAISE EXCEPTION 'PB_CHALLENGE_CONFLICT'; END IF;
    UPDATE public.pb_challenges SET status='cancelled' WHERE id=c.id AND status IN ('draft','open');
  ELSE
    UPDATE public.pb_challenge_members SET status='withdrawn' WHERE challenge_id=c.id AND user_id=p_actor;
    UPDATE public.pb_challenge_partial_members SET consent=false WHERE user_id=p_actor AND partial_id IN (SELECT id FROM public.pb_challenge_partials WHERE challenge_id=c.id);
    UPDATE public.pb_challenges SET status='cancelled' WHERE id=c.id AND status IN ('draft','open');
  END IF;
  RETURN public.pb_challenge_view(p_actor,c.id);
END $$;
CREATE OR REPLACE FUNCTION public.pb_challenge_submit(p_actor uuid,p_challenge uuid,p_body jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_challenges; s public.pb_challenge_submissions; v jsonb; a public.pb_project_assets; snapshot jsonb;
BEGIN
  PERFORM public.pb_project_require_service(); SELECT * INTO c FROM public.pb_challenges WHERE id=p_challenge; PERFORM 1 FROM public.pb_projects WHERE id=c.project_id FOR UPDATE; SELECT * INTO c FROM public.pb_challenges WHERE id=p_challenge FOR UPDATE; PERFORM public.pb_challenge_require_actor(p_actor,p_challenge);
  IF c.design IS NULL THEN RAISE EXCEPTION 'PB_CHALLENGE_UPDATE_REQUIRED'; END IF;
  IF jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR octet_length(p_body::text)>8192 OR NOT p_body ?& ARRAY['requestId','sources'] OR p_body-ARRAY['requestId','sources']<>'{}' OR jsonb_typeof(p_body->'sources') IS DISTINCT FROM 'array' OR jsonb_array_length(p_body->'sources') NOT BETWEEN 1 AND 4 THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  SELECT * INTO s FROM public.pb_challenge_submissions WHERE challenge_id=c.id AND user_id=p_actor;
  IF FOUND THEN IF s.fingerprint<>p_body THEN RAISE EXCEPTION 'PB_CHALLENGE_CONFLICT'; END IF; RETURN public.pb_challenge_view(p_actor,c.id); END IF;
  IF c.status<>'open' OR c.expires_at<=clock_timestamp() OR NOT public.pb_challenge_roster_available(c.id) THEN RAISE EXCEPTION 'PB_CHALLENGE_EXPIRED'; END IF;
  INSERT INTO public.pb_challenge_submissions(challenge_id,user_id,request_id,fingerprint) VALUES(c.id,p_actor,(p_body->>'requestId')::uuid,p_body);
  FOR v IN SELECT * FROM jsonb_array_elements(p_body->'sources') LOOP
    IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT v ?& ARRAY['sourceIndex','assetId'] OR v-ARRAY['sourceIndex','assetId']<>'{}' OR jsonb_typeof(v->'sourceIndex') IS DISTINCT FROM 'number' OR v->>'sourceIndex' !~ '^[0-9]+$' THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
    SELECT * INTO a FROM public.pb_project_assets WHERE id=(v->>'assetId')::uuid;
    IF a.id IS NULL OR a.project_id<>c.project_id OR a.owner_id<>p_actor OR a.kind<>'photo' OR a.status<>'ready' OR a.protection<>'challenge' OR a.protection_id IS DISTINCT FROM c.id OR NOT EXISTS(SELECT 1 FROM public.pb_challenge_assignments WHERE challenge_id=c.id AND user_id=p_actor AND source_index=(v->>'sourceIndex')::integer) THEN RAISE EXCEPTION 'PB_CHALLENGE_DENIED'; END IF;
    INSERT INTO public.pb_challenge_submission_assets VALUES(c.id,p_actor,(v->>'sourceIndex')::integer,a.id);
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.pb_challenge_assignments assignment WHERE assignment.challenge_id=c.id AND assignment.user_id=p_actor AND NOT EXISTS(SELECT 1 FROM public.pb_challenge_submission_assets link WHERE link.challenge_id=c.id AND link.user_id=p_actor AND link.source_index=assignment.source_index)) THEN RAISE EXCEPTION 'PB_CHALLENGE_NOT_READY'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.pb_challenge_members m WHERE m.challenge_id=c.id AND NOT EXISTS(SELECT 1 FROM public.pb_challenge_submissions submitted WHERE submitted.challenge_id=c.id AND submitted.user_id=m.user_id)) AND public.pb_challenge_sources_available(c.id) THEN
    snapshot=public.pb_challenge_snapshot(c.id); UPDATE public.pb_challenges SET status='revealed',revealed_at=clock_timestamp(),reveal_snapshot=snapshot,reveal_hash=public.pb_challenge_hash(snapshot) WHERE id=c.id AND revealed_at IS NULL;
  END IF;
  RETURN public.pb_challenge_view(p_actor,c.id);
END $$;
CREATE OR REPLACE FUNCTION public.pb_challenge_partial_view(p_actor uuid,p_partial uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.pb_challenge_partials; c public.pb_challenges; users uuid[];
BEGIN SELECT * INTO r FROM public.pb_challenge_partials WHERE id=p_partial; c=public.pb_challenge_require_actor(p_actor,r.challenge_id);
  IF c.design IS NULL THEN RETURN jsonb_build_object('id',r.id,'challengeId',c.id,'unsupported',true,'reason','recipe_unavailable'); END IF;
  SELECT array_agg(user_id ORDER BY user_id) INTO users FROM public.pb_challenge_partial_members WHERE partial_id=r.id;
  RETURN jsonb_build_object('id',r.id,'digest',r.digest,'status',r.status,'contributors',users,'accessLost',r.revealed_at IS NOT NULL AND (r.status<>'revealed' OR NOT public.pb_challenge_roster_available(r.challenge_id,users) OR NOT public.pb_challenge_sources_available(r.challenge_id,users) OR EXISTS(SELECT 1 FROM public.pb_challenge_partial_members WHERE partial_id=r.id AND consent IS DISTINCT FROM true)));
END $$;
CREATE OR REPLACE FUNCTION public.pb_challenge_propose_partial(p_actor uuid,p_challenge uuid,p_partial uuid,p_users uuid[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_challenges; r public.pb_challenge_partials; snapshot jsonb; member uuid;
BEGIN
  PERFORM public.pb_project_require_service(); SELECT * INTO c FROM public.pb_challenges WHERE id=p_challenge; PERFORM 1 FROM public.pb_projects WHERE id=c.project_id FOR UPDATE; SELECT * INTO c FROM public.pb_challenges WHERE id=p_challenge FOR UPDATE; PERFORM public.pb_challenge_require_actor(p_actor,p_challenge);
  IF c.design IS NULL THEN RAISE EXCEPTION 'PB_CHALLENGE_UPDATE_REQUIRED'; END IF;
  IF p_partial IS NULL OR p_users IS NULL OR cardinality(p_users) NOT BETWEEN 1 AND 4 OR cardinality(p_users)<>(SELECT count(DISTINCT x) FROM unnest(p_users) x) OR c.frozen_at IS NULL OR (SELECT count(*) FROM public.pb_challenge_submissions WHERE challenge_id=c.id AND user_id=ANY(p_users))<>cardinality(p_users) OR NOT public.pb_challenge_roster_available(c.id,p_users) OR NOT public.pb_challenge_sources_available(c.id,p_users) THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  snapshot=public.pb_challenge_snapshot(c.id,p_users); SELECT * INTO r FROM public.pb_challenge_partials WHERE id=p_partial;
  IF FOUND THEN IF r.challenge_id<>c.id OR r.proposer_id<>p_actor OR r.snapshot<>snapshot THEN RAISE EXCEPTION 'PB_CHALLENGE_CONFLICT'; END IF; RETURN public.pb_challenge_partial_view(p_actor,r.id); END IF;
  IF (SELECT count(*) FROM public.pb_challenge_partials WHERE challenge_id=c.id)>=20 THEN RAISE EXCEPTION 'PB_CHALLENGE_CAPACITY'; END IF;
  INSERT INTO public.pb_challenge_partials(id,challenge_id,proposer_id,snapshot,digest) VALUES(p_partial,c.id,p_actor,snapshot,public.pb_challenge_hash(jsonb_build_object('partialId',p_partial,'snapshot',snapshot)));
  FOREACH member IN ARRAY p_users LOOP INSERT INTO public.pb_challenge_partial_members(partial_id,user_id) VALUES(p_partial,member); END LOOP;
  RETURN public.pb_challenge_partial_view(p_actor,p_partial);
END $$;
CREATE OR REPLACE FUNCTION public.pb_challenge_partial_consent(p_actor uuid,p_partial uuid,p_digest text,p_consent boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.pb_challenge_partials; c public.pb_challenges;
BEGIN
  PERFORM public.pb_project_require_service(); SELECT * INTO r FROM public.pb_challenge_partials WHERE id=p_partial; SELECT * INTO c FROM public.pb_challenges WHERE id=r.challenge_id; PERFORM 1 FROM public.pb_projects WHERE id=c.project_id FOR UPDATE; PERFORM 1 FROM public.pb_challenges WHERE id=c.id FOR UPDATE; SELECT * INTO r FROM public.pb_challenge_partials WHERE id=p_partial FOR UPDATE; PERFORM public.pb_challenge_require_actor(p_actor,c.id);
  IF c.design IS NULL THEN RAISE EXCEPTION 'PB_CHALLENGE_UPDATE_REQUIRED'; END IF;
  IF r.digest IS DISTINCT FROM p_digest OR p_consent IS NULL OR NOT EXISTS(SELECT 1 FROM public.pb_challenge_partial_members WHERE partial_id=r.id AND user_id=p_actor) THEN RAISE EXCEPTION 'PB_CHALLENGE_DENIED'; END IF;
  IF r.status<>'pending' AND p_consent THEN RAISE EXCEPTION 'PB_CHALLENGE_CONFLICT'; END IF;
  UPDATE public.pb_challenge_partial_members SET consent=p_consent WHERE partial_id=r.id AND user_id=p_actor;
  IF NOT p_consent THEN UPDATE public.pb_challenge_partials SET status='rejected' WHERE id=r.id; END IF;
  RETURN public.pb_challenge_partial_view(p_actor,r.id);
END $$;
CREATE OR REPLACE FUNCTION public.pb_challenge_commit_partial(p_actor uuid,p_partial uuid,p_digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.pb_challenge_partials; c public.pb_challenges; users uuid[];
BEGIN
  PERFORM public.pb_project_require_service(); SELECT * INTO r FROM public.pb_challenge_partials WHERE id=p_partial; SELECT * INTO c FROM public.pb_challenges WHERE id=r.challenge_id; PERFORM 1 FROM public.pb_projects WHERE id=c.project_id FOR UPDATE; PERFORM 1 FROM public.pb_challenges WHERE id=c.id FOR UPDATE; SELECT * INTO r FROM public.pb_challenge_partials WHERE id=p_partial FOR UPDATE; PERFORM public.pb_challenge_require_actor(p_actor,c.id);
  IF c.design IS NULL THEN RAISE EXCEPTION 'PB_CHALLENGE_UPDATE_REQUIRED'; END IF;
  SELECT array_agg(user_id ORDER BY user_id) INTO users FROM public.pb_challenge_partial_members WHERE partial_id=r.id;
  IF r.digest IS DISTINCT FROM p_digest OR r.status='rejected' OR NOT public.pb_challenge_roster_available(c.id,users) OR NOT public.pb_challenge_sources_available(c.id,users) OR EXISTS(SELECT 1 FROM public.pb_challenge_partial_members WHERE partial_id=r.id AND consent IS DISTINCT FROM true) OR r.snapshot IS DISTINCT FROM public.pb_challenge_snapshot(c.id,users) THEN RAISE EXCEPTION 'PB_CHALLENGE_NOT_READY'; END IF;
  UPDATE public.pb_challenge_partials SET status='revealed',revealed_at=coalesce(revealed_at,clock_timestamp()) WHERE id=r.id;
  RETURN public.pb_challenge_partial_view(p_actor,r.id);
END $$;
CREATE OR REPLACE FUNCTION public.pb_challenge_expire(p_limit integer DEFAULT 25) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_challenges; n integer=0;
BEGIN PERFORM public.pb_project_require_service(); IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  FOR c IN SELECT * FROM public.pb_challenges WHERE status IN ('draft','open') AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP UPDATE public.pb_challenges SET status='expired' WHERE id=c.id; n=n+1; END LOOP;
  RETURN jsonb_build_object('expired',n);
END $$;

DO $$ DECLARE t text; f record;
BEGIN
  FOREACH t IN ARRAY ARRAY['pb_challenges','pb_challenge_members','pb_challenge_assignments','pb_challenge_submissions','pb_challenge_submission_assets','pb_challenge_partials','pb_challenge_partial_members'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'pb_challenge_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature); END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.pb_challenge_capabilities(),public.pb_challenge_view(uuid,uuid),public.pb_challenge_create(uuid,uuid,jsonb),public.pb_challenge_manage(uuid,uuid,text),public.pb_challenge_submit(uuid,uuid,jsonb),public.pb_challenge_partial_view(uuid,uuid),public.pb_challenge_propose_partial(uuid,uuid,uuid,uuid[]),public.pb_challenge_partial_consent(uuid,uuid,text,boolean),public.pb_challenge_commit_partial(uuid,uuid,text),public.pb_challenge_expire(integer) TO service_role;
COMMIT;
