BEGIN;

CREATE INDEX IF NOT EXISTS pb_challenge_partial_cursor ON public.pb_challenge_partials(challenge_id,id);
CREATE INDEX IF NOT EXISTS pb_challenge_own_upload_cursor ON public.pb_project_assets(protection_id,owner_id,id) WHERE protection='challenge' AND kind='photo' AND status='ready';

CREATE OR REPLACE FUNCTION public.pb_challenge_upload_list(p_actor uuid,p_challenge uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 20) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_challenges; rows jsonb; cursor_id uuid;
BEGIN
  PERFORM public.pb_project_require_service();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  SELECT * INTO c FROM public.pb_challenges WHERE id=p_challenge;
  PERFORM 1 FROM public.pb_projects WHERE id=c.project_id FOR SHARE;
  PERFORM public.pb_project_require_actor(c.project_id,p_actor);
  IF NOT EXISTS(SELECT 1 FROM public.pb_challenge_members WHERE challenge_id=c.id AND user_id=p_actor) THEN RAISE EXCEPTION 'PB_CHALLENGE_DENIED'; END IF;
  IF c.design IS NULL THEN RAISE EXCEPTION 'PB_CHALLENGE_UPDATE_REQUIRED'; END IF;
  SELECT coalesce(jsonb_agg(x.asset ORDER BY x.id),'[]') INTO rows FROM (
    SELECT a.id,jsonb_build_object('id',a.id,'ownerId',a.owner_id,'kind',a.kind,'mime',a.mime,'bytes',a.bytes,'width',a.width,'height',a.height,'sha256',a.sha256) asset
    FROM public.pb_project_assets a WHERE a.project_id=c.project_id AND a.owner_id=p_actor AND a.protection='challenge' AND a.protection_id=c.id AND a.kind='photo' AND a.status='ready'
      AND (p_after IS NULL OR a.id>p_after) AND public.pb_project_protection_read(a.id,p_actor)
    ORDER BY a.id LIMIT p_limit+1
  ) x;
  IF jsonb_array_length(rows)>p_limit THEN rows=rows-p_limit; cursor_id=(rows->(p_limit-1)->>'id')::uuid; END IF;
  RETURN jsonb_build_object('version',1,'uploads',rows,'nextCursor',cursor_id);
END $$;

CREATE OR REPLACE FUNCTION public.pb_challenge_partial_design(p_design jsonb,p_roles text[]) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE cell jsonb; sources jsonb; slots jsonb='[]'; required jsonb; places jsonb; result jsonb;
BEGIN
  IF p_design IS NULL THEN RETURN NULL; END IF;
  FOR cell IN SELECT * FROM jsonb_array_elements(p_design->'slots') LOOP
    SELECT jsonb_agg(source ORDER BY position) INTO sources FROM (
      SELECT cell-ARRAY['id','x','y','width','height','companions','splitFallback'] source,0 position
      UNION ALL SELECT value,ordinality::integer FROM jsonb_array_elements(coalesce(cell->'companions','[]')) WITH ORDINALITY
    ) s WHERE source->>'role'=ANY(p_roles);
    IF sources IS NOT NULL THEN
      cell=(cell-ARRAY['role','sourceIndex','crop','sliceX','filterId','companions'])||(sources->0);
      IF jsonb_array_length(sources)>1 THEN cell=cell||jsonb_build_object('companions',sources-0); ELSE cell=cell-'splitFallback'; END IF;
      slots=slots||jsonb_build_array(cell);
    END IF;
  END LOOP;
  SELECT jsonb_object_agg(key,value) INTO required FROM jsonb_each(p_design->'requiredSources') WHERE key=ANY(p_roles);
  result=jsonb_set(jsonb_set(p_design,'{slots}',slots),'{requiredSources}',coalesce(required,'{}'));
  result=jsonb_set(result,'{layers}',(SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]') FROM jsonb_array_elements(p_design->'layers') WITH ORDINALITY WHERE value->>'kind'<>'text' OR value->'personal'='false'));
  result=jsonb_set(result,'{defaults,caption}','""');
  IF result ? 'places' THEN
    SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO places FROM jsonb_each(result->'places') WHERE key=ANY(p_roles);
    result=jsonb_set(result,'{places}',places);
  END IF;
  RETURN result;
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
    OR c.recipe_hash IS DISTINCT FROM public.pb_challenge_hash(jsonb_build_object('design',c.design,'members',c.fingerprint->'members','assignments',c.fingerprint->'assignments'))
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

CREATE OR REPLACE FUNCTION public.pb_challenge_partial_list(p_actor uuid,p_challenge uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 20) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.pb_challenges; rows jsonb='[]'; r public.pb_challenge_partials; item jsonb; cursor_id uuid;
BEGIN
  PERFORM public.pb_project_require_service();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  c=public.pb_challenge_require_actor(p_actor,p_challenge);
  FOR r IN SELECT p.* FROM public.pb_challenge_partials p WHERE p.challenge_id=c.id AND (p_after IS NULL OR p.id>p_after)
    AND (p.proposer_id=p_actor OR EXISTS(SELECT 1 FROM public.pb_challenge_partial_members WHERE partial_id=p.id AND user_id=p_actor)) ORDER BY p.id LIMIT p_limit+1 LOOP
    IF jsonb_array_length(rows)=p_limit THEN cursor_id=(rows->(p_limit-1)->>'id')::uuid; EXIT; END IF;
    item=public.pb_challenge_partial_details(p_actor,r.id,r.digest)-ARRAY['version','result'];
    rows=rows||jsonb_build_array(item);
  END LOOP;
  RETURN jsonb_build_object('version',1,'partials',rows,'nextCursor',cursor_id);
END $$;

CREATE OR REPLACE FUNCTION public.pb_challenge_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.pb_project_require_service();
  RETURN jsonb_build_object('version',2,'recipeVersion',1,'ready',public.pb_project_capabilities()->'ready'='true'::jsonb,'members',4,'slots',16,'sourcesPerMember',4,'proposals',20,'challengesPerProject',32,'discoveryVersion',1,'listMaximum',20,'partialVersion',1,'partialListMaximum',20,'ownUploadsVersion',1,'uploadListMaximum',20);
END $$;

REVOKE ALL ON FUNCTION public.pb_challenge_partial_design(jsonb,text[]) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.pb_challenge_upload_list(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pb_challenge_upload_list(uuid,uuid,uuid,integer) TO service_role;
REVOKE ALL ON FUNCTION public.pb_challenge_partial_details(uuid,uuid,text),public.pb_challenge_partial_list(uuid,uuid,uuid,integer),public.pb_challenge_capabilities() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pb_challenge_partial_details(uuid,uuid,text),public.pb_challenge_partial_list(uuid,uuid,uuid,integer),public.pb_challenge_capabilities() TO service_role;
COMMIT;
