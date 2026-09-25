BEGIN;

CREATE INDEX IF NOT EXISTS pb_challenge_project_cursor ON public.pb_challenges(project_id,id);

CREATE OR REPLACE FUNCTION public.pb_challenge_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.pb_project_require_service();
  RETURN jsonb_build_object('version',2,'recipeVersion',1,'ready',public.pb_project_capabilities()->'ready'='true'::jsonb,'members',4,'slots',16,'sourcesPerMember',4,'proposals',20,'challengesPerProject',32,'discoveryVersion',1,'listMaximum',20);
END $$;

CREATE OR REPLACE FUNCTION public.pb_challenge_list(p_actor uuid,p_project uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 20) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE rows jsonb; cursor_id uuid;
BEGIN
  PERFORM public.pb_project_require_service();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'PB_CHALLENGE_INVALID'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.pb_projects p JOIN public.pb_project_members m ON m.project_id=p.id WHERE p.id=p_project AND p.status='active' AND m.user_id=p_actor AND m.status IN ('accepted','invited')) THEN RAISE EXCEPTION 'PB_CHALLENGE_DENIED'; END IF;
  SELECT coalesce(jsonb_agg(x.summary ORDER BY x.id),'[]') INTO rows FROM (
    SELECT c.id,jsonb_build_object('id',c.id,'projectId',c.project_id,
      'status',CASE WHEN c.status IN ('draft','open') AND c.expires_at<=clock_timestamp() THEN 'expired' ELSE c.status END,
      'policy',c.policy,'membership',m.status,'createdAt',c.created_at,'expiresAt',c.expires_at,'unsupported',c.design IS NULL) summary
    FROM public.pb_challenges c
    JOIN public.pb_challenge_members m ON m.challenge_id=c.id AND m.user_id=p_actor
    JOIN public.pb_project_members pm ON pm.project_id=c.project_id AND pm.user_id=p_actor
    JOIN public.pb_projects p ON p.id=c.project_id AND p.status='active'
    WHERE c.project_id=p_project AND (p_after IS NULL OR c.id>p_after)
      AND (pm.status='accepted' OR (pm.status='invited' AND m.status='invited'))
    ORDER BY c.id LIMIT p_limit+1
  ) x;
  IF jsonb_array_length(rows)>p_limit THEN rows=rows-p_limit; cursor_id=(rows->(p_limit-1)->>'id')::uuid; END IF;
  RETURN jsonb_build_object('version',1,'challenges',rows,'nextCursor',cursor_id);
END $$;

REVOKE ALL ON FUNCTION public.pb_challenge_list(uuid,uuid,uuid,integer),public.pb_challenge_capabilities() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pb_challenge_list(uuid,uuid,uuid,integer),public.pb_challenge_capabilities() TO service_role;

COMMIT;
