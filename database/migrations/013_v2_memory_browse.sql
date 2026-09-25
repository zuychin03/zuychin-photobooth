BEGIN;

CREATE INDEX IF NOT EXISTS pb_memory_activity_chronological ON public.pb_memory_activity(occurred_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS pb_memory_activity_chapter_time ON public.pb_memory_activity(subject_id,chapter_id,occurred_at DESC,id DESC);

CREATE OR REPLACE FUNCTION public.pb_memory_browse_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_project_require_service(); RETURN jsonb_build_object('version',1,'pageLimit',50,'order','occurred_at_desc_id_desc'); END $$;

CREATE OR REPLACE FUNCTION public.pb_memory_browse(p_actor uuid,p_start timestamptz,p_end timestamptz,p_chapter uuid DEFAULT NULL,p_after_at timestamptz DEFAULT NULL,p_after_id uuid DEFAULT NULL,p_limit integer DEFAULT 20) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE rows jsonb; cursor jsonb=NULL;
BEGIN
  PERFORM public.pb_memory_actor(p_actor);
  IF p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_end<=p_start OR p_end-p_start NOT BETWEEN interval '364 days' AND interval '367 days' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR (p_after_at IS NULL)<>(p_after_id IS NULL) OR (p_after_at IS NOT NULL AND (NOT isfinite(p_after_at) OR p_after_at<p_start OR p_after_at>=p_end)) THEN RAISE EXCEPTION 'PB_MEMORY_INVALID'; END IF;
  IF p_chapter IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.pb_memory_chapters WHERE id=p_chapter AND owner_id=p_actor) THEN RAISE EXCEPTION 'PB_MEMORY_DENIED'; END IF;
  SELECT coalesce(jsonb_agg(item ORDER BY occurred_at DESC,id DESC),'[]') INTO rows FROM (
    SELECT a.id,a.occurred_at,public.pb_memory_projection(a,p_actor) item FROM public.pb_memory_activity a
    WHERE a.occurred_at>=p_start AND a.occurred_at<p_end
      AND (p_after_id IS NULL OR (a.occurred_at,a.id)<(p_after_at,p_after_id))
      AND (p_chapter IS NULL OR a.subject_id=p_actor AND a.chapter_id=p_chapter)
      AND (a.subject_id=p_actor OR public.pb_memory_scope_visible(a,p_actor))
    ORDER BY a.occurred_at DESC,a.id DESC LIMIT p_limit+1
  ) bounded;
  IF jsonb_array_length(rows)>p_limit THEN
    rows=rows-(jsonb_array_length(rows)-1);
    cursor=jsonb_build_object('id',rows->(p_limit-1)->>'id','occurredAt',rows->(p_limit-1)->>'occurredAt');
  END IF;
  RETURN jsonb_build_object('items',rows,'nextCursor',cursor);
END $$;

REVOKE ALL ON FUNCTION public.pb_memory_browse_capabilities(),public.pb_memory_browse(uuid,timestamptz,timestamptz,uuid,timestamptz,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pb_memory_browse_capabilities(),public.pb_memory_browse(uuid,timestamptz,timestamptz,uuid,timestamptz,uuid,integer) TO service_role;

COMMIT;
