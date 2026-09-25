BEGIN;

CREATE OR REPLACE FUNCTION public.pb_event_review_capabilities() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
SELECT jsonb_build_object('version',1,'pageItems',12,'thumbnailBytes',100000,'thumbnailEdge',400)
$$;

CREATE OR REPLACE FUNCTION public.pb_event_review_subject(p_actor uuid,p_event uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events;
BEGIN
  PERFORM public.pb_event_require_service();
  SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR SHARE;
  PERFORM public.pb_event_require_actor(p_event,p_actor,false);
  IF e.id IS NULL OR e.status='deleted' OR e.expires_at<=clock_timestamp() OR e.allocation_released THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_review_thumbnail(p_event uuid,p_submission uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.pb_event_submissions; object_size bigint;
BEGIN
  PERFORM public.pb_event_require_service();
  SELECT * INTO s FROM public.pb_event_submissions WHERE event_id=p_event AND id=p_submission;
  IF NOT FOUND OR s.state<>'ready' OR s.promised_expires_at<=clock_timestamp()
    OR EXISTS(SELECT 1 FROM public.pb_event_publication_grants g JOIN public.pb_event_guests v ON v.id=g.guest_id WHERE g.submission_id=s.id AND (v.revoked OR NOT g.submission_consent))
    OR NOT EXISTS(SELECT 1 FROM public.pb_event_publication_grants WHERE submission_id=s.id)
    OR NOT EXISTS(SELECT 1 FROM public.pb_event_jobs WHERE submission_id=s.id AND kind='finalise' AND status='complete' AND checkpoint->'decoded'='true'::jsonb AND checkpoint->'objectsVerified'='true'::jsonb AND checkpoint->>'mime'='image/jpeg') THEN RETURN NULL; END IF;
  SELECT CASE WHEN metadata->>'size' ~ '^[0-9]{1,6}$' THEN (metadata->>'size')::bigint ELSE NULL END INTO object_size FROM storage.objects WHERE bucket_id='photobooth-events-v2' AND name=s.thumbnail_path;
  IF object_size IS NULL OR object_size NOT BETWEEN 1 AND 100000 THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('submissionId',s.id,'bucket','photobooth-events-v2','path',s.thumbnail_path,'bytes',object_size,'mime','image/jpeg','sha256',NULL,
    'expiresAt',to_char(s.promised_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'maxAgeSeconds',least(300,greatest(0,floor(extract(epoch FROM s.promised_expires_at-clock_timestamp())))));
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_review_list(p_actor uuid,p_event uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 12) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE rows jsonb; more boolean; cursor_id uuid;
BEGIN
  PERFORM public.pb_event_review_subject(p_actor,p_event);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 12 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  WITH selected AS (SELECT s.*,row_number() OVER(ORDER BY id) n FROM public.pb_event_submissions s WHERE event_id=p_event AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT p_limit+1)
  SELECT coalesce(jsonb_agg(public.pb_event_receipt_json(id)||jsonb_build_object('createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'logicalExpiresAt',to_char(logical_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'eventExpiresAt',to_char(promised_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'thumbnailAvailable',public.pb_event_review_thumbnail(p_event,id) IS NOT NULL) ORDER BY id) FILTER(WHERE n<=p_limit),'[]'),count(*)>p_limit,(array_agg(id ORDER BY id) FILTER(WHERE n<=p_limit))[p_limit]
  INTO rows,more,cursor_id FROM selected;
  RETURN jsonb_build_object('version',1,'eventId',p_event,'entries',rows,'nextCursor',CASE WHEN more THEN cursor_id ELSE NULL END);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_review_access(p_actor uuid,p_event uuid,p_submission uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.pb_event_review_subject(p_actor,p_event);
  result=public.pb_event_review_thumbnail(p_event,p_submission);
  IF result IS NULL OR (result->>'maxAgeSeconds')::integer<1 THEN RAISE EXCEPTION 'PB_EVENT_DENIED' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.pb_event_review_capabilities(),public.pb_event_review_subject(uuid,uuid),public.pb_event_review_thumbnail(uuid,uuid),public.pb_event_review_list(uuid,uuid,uuid,integer),public.pb_event_review_access(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pb_event_review_capabilities(),public.pb_event_review_list(uuid,uuid,uuid,integer),public.pb_event_review_access(uuid,uuid,uuid) TO service_role;
COMMIT;
