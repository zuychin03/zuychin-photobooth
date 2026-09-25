BEGIN;

CREATE OR REPLACE FUNCTION public.pb_project_design_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_project_require_service();
  RETURN jsonb_build_object('designVersion',1,'retirementVersion',1,'snapshotBytes',81920,'bindings',24,'checkpoints',2,'receipts',100,'referenceAssets',true,'exportSettingsVersion',1);
END $$;

CREATE OR REPLACE FUNCTION public.pb_project_design_save(p_actor uuid,p_project uuid,p_request uuid,p_expected integer,p_snapshot jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.pb_project_designs; old public.pb_project_design_receipts; h text; result jsonb; next_revision integer; b jsonb; bindings jsonb; participants jsonb;
BEGIN
  PERFORM public.pb_project_require_service(); PERFORM 1 FROM public.pb_projects WHERE id=p_project FOR UPDATE; PERFORM public.pb_project_require_actor(p_project,p_actor,true);
  IF p_request IS NULL OR (p_expected IS NOT NULL AND p_expected NOT BETWEEN 0 AND 99) OR coalesce(p_snapshot->'project'->>'schemaVersion','') NOT IN ('3','4')
    OR p_snapshot->'project'->'scope' IS DISTINCT FROM '{"kind":"device"}'::jsonb OR p_snapshot->'project'->'capture'->'cameraId' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'PB_PROJECT_INVALID'; END IF;
  PERFORM public.pb_project_design_require_assets(p_actor,p_project,p_snapshot);
  h=encode(sha256(convert_to(p_snapshot::text,'UTF8')),'hex');
  SELECT * INTO old FROM public.pb_project_design_receipts WHERE project_id=p_project AND request_id=p_request;
  IF FOUND THEN
    IF old.content_hash<>h OR old.expected_revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'PB_PROJECT_CONFLICT'; END IF;
    RETURN old.receipt;
  END IF;
  SELECT * INTO d FROM public.pb_project_designs WHERE project_id=p_project;
  IF d.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'PB_PROJECT_CONFLICT'; END IF;
  IF (SELECT count(*) FROM public.pb_project_design_receipts WHERE project_id=p_project)>=100 THEN RAISE EXCEPTION 'PB_PROJECT_CAPACITY'; END IF;
  IF d.project_id IS NOT NULL THEN
    IF d.snapshot->'project'->'id' IS DISTINCT FROM p_snapshot->'project'->'id' OR d.snapshot->'project'->'createdAt' IS DISTINCT FROM p_snapshot->'project'->'createdAt'
      OR d.snapshot->'project'->'captureTimeZone' IS DISTINCT FROM p_snapshot->'project'->'captureTimeZone'
      OR (d.snapshot->'project'->>'capturedAt' IS NOT NULL AND d.snapshot->'project'->'capturedAt' IS DISTINCT FROM p_snapshot->'project'->'capturedAt') THEN RAISE EXCEPTION 'PB_PROJECT_CONFLICT'; END IF;
  END IF;
  bindings=coalesce(d.binding_ledger,'[]'::jsonb); participants=coalesce(d.participant_ledger,'[]'::jsonb);
  FOR b IN SELECT * FROM jsonb_array_elements(p_snapshot->'bindings') LOOP
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(bindings) old_binding WHERE (old_binding->>'mediaId'=b->>'mediaId' OR old_binding->>'assetId'=b->>'assetId') AND old_binding<>b) THEN RAISE EXCEPTION 'PB_PROJECT_CONFLICT'; END IF;
    IF NOT bindings @> jsonb_build_array(b) THEN bindings=bindings||jsonb_build_array(b); END IF;
  END LOOP;
  FOR b IN SELECT * FROM jsonb_array_elements(p_snapshot->'participants') LOOP
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(participants) old_person WHERE old_person->>'participantId'=b->>'participantId' AND old_person<>b) THEN RAISE EXCEPTION 'PB_PROJECT_CONFLICT'; END IF;
    IF NOT participants @> jsonb_build_array(b) THEN participants=participants||jsonb_build_array(b); END IF;
  END LOOP;
  IF jsonb_array_length(bindings)>24 OR jsonb_array_length(participants)>4 THEN RAISE EXCEPTION 'PB_PROJECT_CAPACITY'; END IF;
  next_revision=coalesce(d.revision+1,0);
  result=jsonb_build_object('version',1,'projectId',p_project,'requestId',p_request,'revision',next_revision,'contentHash',h,'savedAt',clock_timestamp());
  INSERT INTO public.pb_project_designs(project_id,revision,snapshot,receipt,previous_snapshot,previous_receipt,binding_ledger,participant_ledger) VALUES(p_project,next_revision,p_snapshot,result,d.snapshot,d.receipt,bindings,participants)
    ON CONFLICT(project_id) DO UPDATE SET revision=EXCLUDED.revision,snapshot=EXCLUDED.snapshot,receipt=EXCLUDED.receipt,previous_snapshot=EXCLUDED.previous_snapshot,previous_receipt=EXCLUDED.previous_receipt,binding_ledger=EXCLUDED.binding_ledger,participant_ledger=EXCLUDED.participant_ledger;
  INSERT INTO public.pb_project_design_receipts VALUES(p_project,p_request,p_expected,h,result);
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.pb_project_design_capabilities(),public.pb_project_design_save(uuid,uuid,uuid,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pb_project_design_capabilities(),public.pb_project_design_save(uuid,uuid,uuid,integer,jsonb) TO service_role;
COMMIT;
