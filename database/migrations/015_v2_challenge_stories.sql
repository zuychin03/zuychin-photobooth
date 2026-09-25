BEGIN;

CREATE OR REPLACE FUNCTION public.pb_challenge_story_valid(p_story jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_story IS NULL OR jsonb_typeof(p_story) IS DISTINCT FROM 'object' OR octet_length(p_story::text)>512
    OR NOT p_story ?& ARRAY['version','deckId','seed','relaxedSteps'] OR p_story-ARRAY['version','deckId','seed','relaxedSteps']<>'{}'
    OR p_story->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(p_story->'deckId') IS DISTINCT FROM 'string'
    OR p_story->>'deckId' NOT IN ('little-hello','our-little-ritual','movie-moment','same-energy','album-cover','passing-a-smile','birthday-wish','we-did-it','a-new-chapter','soft-expressions','quiet-company','four-moods')
    OR jsonb_typeof(p_story->'seed') IS DISTINCT FROM 'number' OR p_story->>'seed' !~ '^[0-9]+$' OR (p_story->>'seed')::numeric>4294967295
    OR jsonb_typeof(p_story->'relaxedSteps') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p_story->'relaxedSteps')>4 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_story->'relaxedSteps') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'number' OR x::text !~ '^[0-3]$') THEN RETURN false; END IF;
  RETURN p_story->'relaxedSteps'=(SELECT coalesce(jsonb_agg(x ORDER BY x),'[]') FROM (SELECT DISTINCT x FROM jsonb_array_elements(p_story->'relaxedSteps') x) s);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

ALTER TABLE public.pb_challenges ADD COLUMN IF NOT EXISTS story jsonb;
ALTER TABLE public.pb_challenges DROP CONSTRAINT IF EXISTS pb_challenge_story_valid;
ALTER TABLE public.pb_challenges ADD CONSTRAINT pb_challenge_story_valid CHECK (story IS NULL OR public.pb_challenge_story_valid(story));

CREATE OR REPLACE FUNCTION public.pb_challenge_recipe_hash(p_design jsonb,p_members jsonb,p_assignments jsonb,p_story jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
  SELECT public.pb_challenge_hash(jsonb_build_object('design',p_design,'members',p_members,'assignments',p_assignments) || CASE WHEN p_story IS NULL OR p_story='null'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('story',p_story) END);
$$;

CREATE OR REPLACE FUNCTION public.pb_challenge_view(p_actor uuid,p_challenge uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_challenges;
BEGIN c=public.pb_challenge_require_actor(p_actor,p_challenge,false);
  IF c.design IS NULL THEN RETURN jsonb_build_object('id',c.id,'projectId',c.project_id,'unsupported',true,'reason','recipe_unavailable'); END IF;
  RETURN jsonb_build_object('id',c.id,'projectId',c.project_id,'status',CASE WHEN c.status IN ('draft','open') AND c.expires_at<=clock_timestamp() THEN 'expired' ELSE c.status END,'policy',c.policy,'recipeHash',c.recipe_hash,'design',c.design,'expiresAt',c.expires_at,'revealedAt',c.revealed_at,'revealHash',CASE WHEN public.pb_challenge_roster_available(c.id) AND public.pb_challenge_sources_available(c.id) THEN c.reveal_hash ELSE NULL END,
    'accessLost',c.frozen_at IS NOT NULL AND (NOT public.pb_challenge_roster_available(c.id) OR NOT public.pb_challenge_sources_available(c.id)),
    'members',(SELECT jsonb_agg(jsonb_build_object('userId',m.user_id,'role',m.role,'status',m.status,'submitted',EXISTS(SELECT 1 FROM public.pb_challenge_submissions WHERE challenge_id=c.id AND user_id=m.user_id)) ORDER BY m.role) FROM public.pb_challenge_members m WHERE m.challenge_id=c.id),
    'assignments',(SELECT jsonb_agg(jsonb_build_object('slot',slot,'userId',user_id,'sourceIndex',source_index) ORDER BY slot) FROM public.pb_challenge_assignments WHERE challenge_id=c.id),
    'visibleSources',(SELECT coalesce(jsonb_agg(jsonb_build_object('userId',s.user_id,'sourceIndex',s.source_index,'assetId',s.asset_id) ORDER BY s.user_id,s.source_index),'[]') FROM public.pb_challenge_submission_assets s JOIN public.pb_project_assets a ON a.id=s.asset_id WHERE s.challenge_id=c.id AND a.status='ready' AND EXISTS(SELECT 1 FROM public.pb_project_members WHERE project_id=c.project_id AND user_id=p_actor AND status='accepted') AND public.pb_project_protection_read(s.asset_id,p_actor))) || CASE WHEN c.story IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('story',c.story) END;
END $$;

CREATE OR REPLACE FUNCTION public.pb_challenge_create(p_actor uuid,p_project uuid,p_body jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_challenges; m jsonb; a jsonb; v_challenge uuid; assignments jsonb; recipe_hash text;
BEGIN
  PERFORM public.pb_project_require_service(); PERFORM 1 FROM public.pb_projects WHERE id=p_project FOR UPDATE; PERFORM public.pb_project_require_actor(p_project,p_actor,true);
  IF public.pb_challenge_capabilities()->'ready' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'PB_CHALLENGE_NOT_READY'; END IF;
  IF jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR octet_length(p_body::text)>65536 OR NOT p_body ?& ARRAY['id','design','policy','expiresAt','members','assignments'] OR p_body-ARRAY['id','design','policy','expiresAt','members','assignments','story']<>'{}' OR jsonb_typeof(p_body->'members') IS DISTINCT FROM 'array' OR jsonb_typeof(p_body->'assignments') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  IF jsonb_array_length(p_body->'members') NOT BETWEEN 2 AND 4 OR jsonb_array_length(p_body->'assignments') NOT BETWEEN 2 AND 16 OR p_body->>'policy' NOT IN ('immediate','all_submitted') OR (p_body->>'expiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  IF p_body->'story'='null'::jsonb THEN p_body=p_body-'story'; END IF;
  IF p_body ? 'story' AND NOT public.pb_challenge_story_valid(p_body->'story') THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  p_body=jsonb_set(p_body,'{members}',(SELECT jsonb_agg(member_row ORDER BY member_row->>'role') FROM jsonb_array_elements(p_body->'members') member_row));
  assignments=public.pb_challenge_recipe_assignments(p_body->'design',p_body->'members');
  IF assignments IS DISTINCT FROM p_body->'assignments' THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  IF p_body ? 'story' AND (SELECT array_agg(DISTINCT (x->>'sourceIndex')::integer ORDER BY (x->>'sourceIndex')::integer) FROM jsonb_array_elements(assignments) x) IS DISTINCT FROM ARRAY[0,1,2,3] THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  recipe_hash=public.pb_challenge_recipe_hash(p_body->'design',p_body->'members',assignments,p_body->'story');
  v_challenge=(p_body->>'id')::uuid; SELECT * INTO c FROM public.pb_challenges WHERE pb_challenges.id=v_challenge;
  IF FOUND THEN IF c.project_id<>p_project OR c.initiator_id<>p_actor OR c.fingerprint<>p_body THEN RAISE EXCEPTION 'PB_CHALLENGE_CONFLICT'; END IF; RETURN public.pb_challenge_view(p_actor,c.id); END IF;
  IF (SELECT count(*) FROM public.pb_challenges WHERE project_id=p_project)>=32 THEN RAISE EXCEPTION 'PB_CHALLENGE_CAPACITY'; END IF;
  IF public.pb_challenge_recipe_available(p_project,p_body->'design') IS DISTINCT FROM true THEN RAISE EXCEPTION 'PB_CHALLENGE_DENIED'; END IF;
  INSERT INTO public.pb_challenges(id,project_id,initiator_id,fingerprint,recipe_hash,design,policy,expires_at,story) VALUES(v_challenge,p_project,p_actor,p_body,recipe_hash,p_body->'design',p_body->>'policy',(p_body->>'expiresAt')::timestamptz,p_body->'story');
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

CREATE OR REPLACE FUNCTION public.pb_challenge_partial_details(p_actor uuid,p_partial uuid,p_digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.pb_challenge_partials; c public.pb_challenges; users uuid[]; roles text[]; lost boolean; included boolean; result jsonb=NULL; members jsonb;
BEGIN
  PERFORM public.pb_project_require_service();
  SELECT * INTO r FROM public.pb_challenge_partials WHERE id=p_partial;
  SELECT * INTO c FROM public.pb_challenges WHERE id=r.challenge_id;
  PERFORM 1 FROM public.pb_projects WHERE id=c.project_id FOR SHARE;
  SELECT * INTO c FROM public.pb_challenges WHERE id=r.challenge_id FOR SHARE;
  SELECT * INTO r FROM public.pb_challenge_partials WHERE id=p_partial FOR SHARE;
  PERFORM public.pb_challenge_require_actor(p_actor,c.id);
  included=EXISTS(SELECT 1 FROM public.pb_challenge_partial_members WHERE partial_id=r.id AND user_id=p_actor);
  IF r.id IS NULL OR (NOT included AND r.proposer_id<>p_actor) OR r.digest IS DISTINCT FROM p_digest THEN RAISE EXCEPTION 'PB_CHALLENGE_DENIED'; END IF;
  IF c.design IS NULL THEN RETURN jsonb_build_object('version',1,'id',r.id,'challengeId',c.id,'projectId',c.project_id,'unsupported',true,'reason','recipe_unavailable'); END IF;
  SELECT array_agg(m.user_id ORDER BY m.user_id),array_agg(cm.role ORDER BY cm.role) INTO users,roles FROM public.pb_challenge_partial_members m JOIN public.pb_challenge_members cm ON cm.challenge_id=c.id AND cm.user_id=m.user_id WHERE m.partial_id=r.id;
  lost=cardinality(users) IS NULL OR NOT public.pb_challenge_roster_available(c.id,users) OR NOT public.pb_challenge_sources_available(c.id,users)
    OR r.snapshot IS DISTINCT FROM public.pb_challenge_snapshot(c.id,users)
    OR r.digest IS DISTINCT FROM public.pb_challenge_hash(jsonb_build_object('partialId',r.id,'snapshot',r.snapshot))
    OR c.recipe_hash IS DISTINCT FROM public.pb_challenge_recipe_hash(c.design,c.fingerprint->'members',c.fingerprint->'assignments',c.story)
    OR (r.revealed_at IS NOT NULL AND r.status<>'revealed')
    OR (r.status='revealed' AND EXISTS(SELECT 1 FROM public.pb_challenge_partial_members WHERE partial_id=r.id AND consent IS DISTINCT FROM true));
  SELECT jsonb_agg(jsonb_build_object('userId',m.user_id,'role',cm.role,'consent',m.consent,'status',CASE WHEN public.pb_challenge_roster_available(c.id,ARRAY[m.user_id]) AND public.pb_challenge_sources_available(c.id,ARRAY[m.user_id]) THEN 'available' ELSE 'access_lost' END) ORDER BY cm.role) INTO members
    FROM public.pb_challenge_partial_members m JOIN public.pb_challenge_members cm ON cm.challenge_id=c.id AND cm.user_id=m.user_id WHERE m.partial_id=r.id;
  IF included AND r.status='revealed' AND NOT lost AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(r.snapshot->'members') m CROSS JOIN LATERAL jsonb_array_elements(m->'sources') s WHERE public.pb_project_protection_read((s->>'assetId')::uuid,p_actor) IS DISTINCT FROM true
  ) THEN
    result=jsonb_build_object('projectionVersion',1,'recipeHash',c.recipe_hash,'design',public.pb_challenge_partial_design(c.design,roles),
      'sources',(SELECT jsonb_agg(jsonb_build_object('userId',m->>'userId','role',m->>'role','sourceIndex',(s->>'sourceIndex')::integer,'assetId',s->>'assetId') ORDER BY m->>'role',(s->>'sourceIndex')::integer) FROM jsonb_array_elements(r.snapshot->'members') m CROSS JOIN LATERAL jsonb_array_elements(m->'sources') s));
  END IF;
  RETURN jsonb_build_object('version',1,'id',r.id,'challengeId',c.id,'projectId',c.project_id,'digest',r.digest,'status',r.status,'createdAt',r.created_at,'revealedAt',r.revealed_at,
    'accessLost',lost,'actorIncluded',included,'actorConsent',(SELECT consent FROM public.pb_challenge_partial_members WHERE partial_id=r.id AND user_id=p_actor),'contributors',members,'result',result);
END $$;

CREATE OR REPLACE FUNCTION public.pb_challenge_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.pb_project_require_service();
  RETURN jsonb_build_object('version',2,'recipeVersion',1,'ready',public.pb_project_capabilities()->'ready'='true'::jsonb,'members',4,'slots',16,'sourcesPerMember',4,'proposals',20,'challengesPerProject',32,'discoveryVersion',1,'listMaximum',20,'partialVersion',1,'partialListMaximum',20,'ownUploadsVersion',1,'uploadListMaximum',20,'storyVersion',1);
END $$;
REVOKE ALL ON FUNCTION public.pb_challenge_story_valid(jsonb),public.pb_challenge_recipe_hash(jsonb,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.pb_challenge_create(uuid,uuid,jsonb),public.pb_challenge_view(uuid,uuid),public.pb_challenge_partial_details(uuid,uuid,text),public.pb_challenge_capabilities() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pb_challenge_create(uuid,uuid,jsonb),public.pb_challenge_view(uuid,uuid),public.pb_challenge_partial_details(uuid,uuid,text),public.pb_challenge_capabilities() TO service_role;
COMMIT;
