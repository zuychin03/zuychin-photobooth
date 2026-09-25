BEGIN;

CREATE OR REPLACE FUNCTION public.pb_retained_strip_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_project_require_service(); RETURN jsonb_build_object('version',1,'ready',EXISTS(SELECT 1 FROM public.pb_lifecycle_settings WHERE singleton AND quota_timezone IS NOT NULL),'maximumBytes',16777216); END $$;

CREATE OR REPLACE FUNCTION public.pb_retained_strip_read(p_actor uuid,p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.pb_strips; l public.pb_strip_quota_ledger; original_couple uuid; availability text;
BEGIN
  PERFORM public.pb_memory_actor(p_actor);
  SELECT * INTO s FROM public.pb_strips WHERE id=p_id;
  SELECT * INTO l FROM public.pb_strip_quota_ledger WHERE strip_id=p_id;
  IF s.id IS NULL OR l.strip_id IS NULL OR l.owner<>s.owner OR l.storage_path<>s.storage_path THEN RAISE EXCEPTION 'PB_RETAINED_DENIED'; END IF;
  IF l.scope_key ~ '^couple:[0-9a-f-]{36}$' THEN original_couple:=substring(l.scope_key FROM 8)::uuid;
  ELSIF l.scope_key<>'owner:'||s.owner::text THEN RAISE EXCEPTION 'PB_RETAINED_UNAVAILABLE'; END IF;
  IF p_actor<>s.owner AND (original_couple IS NULL OR s.couple_id IS DISTINCT FROM original_couple OR NOT EXISTS(
    SELECT 1 FROM public.pb_couples c WHERE c.id=original_couple AND p_actor IN(c.member_a,c.member_b) AND s.owner IN(c.member_a,c.member_b)
  )) THEN RAISE EXCEPTION 'PB_RETAINED_DENIED'; END IF;
  IF EXISTS(SELECT 1 FROM public.pb_media_jobs WHERE source_type='strip' AND source_id=s.id AND kind='delete' AND status<>'complete') THEN RAISE EXCEPTION 'PB_RETAINED_UNAVAILABLE'; END IF;
  IF s.storage_path<>s.owner::text||'/'||s.id::text||'.png' THEN RAISE EXCEPTION 'PB_RETAINED_UNAVAILABLE'; END IF;
  availability:=CASE WHEN NOT s.purged THEN CASE WHEN s.kept AND s.archive_verified_at IS NULL THEN 'archive_pending' ELSE 'available' END
    WHEN s.kept AND s.archive_verified_at IS NOT NULL AND s.cloudinary_public_id='zuychin-photobooth/'||s.owner::text||'/'||s.id::text AND s.cloudinary_url IS NOT NULL THEN 'archived'
    WHEN s.cloudinary_public_id IS NULL THEN 'expired' ELSE 'unknown' END;
  IF availability IN('expired','unknown') THEN RAISE EXCEPTION 'PB_RETAINED_UNAVAILABLE'; END IF;
  RETURN jsonb_build_object('version',1,'id',s.id,'ownerId',s.owner,'originalCoupleId',original_couple,'storagePath',s.storage_path,'availability',availability,
    'archive',CASE WHEN availability='archived' THEN jsonb_build_object('publicId',s.cloudinary_public_id,'url',s.cloudinary_url,'verifiedAt',s.archive_verified_at) ELSE NULL END);
END $$;

CREATE OR REPLACE FUNCTION public.pb_memory_scope_visible(a public.pb_memory_activity,p_actor uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT CASE WHEN a.source_kind='strip' AND a.subject_id=p_actor AND EXISTS(
      SELECT 1 FROM public.pb_strips s WHERE s.id=a.source_id AND s.owner=p_actor AND (NOT s.purged OR s.kept AND s.archive_verified_at IS NOT NULL AND s.cloudinary_public_id IS NOT NULL AND s.cloudinary_url IS NOT NULL)
    ) THEN true
    WHEN a.scope_kind='personal' THEN a.subject_id=p_actor
    WHEN a.scope_kind='couple' THEN EXISTS(SELECT 1 FROM public.pb_couples c WHERE c.id=a.scope_id AND p_actor IN (c.member_a,c.member_b) AND a.subject_id IN (c.member_a,c.member_b))
    WHEN a.scope_kind='project' THEN EXISTS(SELECT 1 FROM public.pb_projects p JOIN public.pb_project_members m ON m.project_id=p.id JOIN public.pb_project_members author ON author.project_id=p.id WHERE p.id=a.scope_id AND p.status='active' AND m.user_id=p_actor AND m.status='accepted' AND author.user_id=a.subject_id AND author.status='accepted')
      AND public.pb_project_protection_read(a.source_id,p_actor)
    ELSE false END
$$;
REVOKE ALL ON FUNCTION public.pb_retained_strip_capabilities(),public.pb_retained_strip_read(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pb_retained_strip_capabilities(),public.pb_retained_strip_read(uuid,uuid) TO service_role;
COMMIT;
