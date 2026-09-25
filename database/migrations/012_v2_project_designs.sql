BEGIN;

ALTER TABLE public.pb_project_assets DROP CONSTRAINT IF EXISTS pb_project_assets_kind_check;
ALTER TABLE public.pb_project_assets ADD CONSTRAINT pb_project_assets_kind_check CHECK(kind IN ('photo','decoration','reference'));
ALTER TABLE public.pb_project_assets DROP CONSTRAINT IF EXISTS pb_project_reference_unprotected;
ALTER TABLE public.pb_project_assets ADD CONSTRAINT pb_project_reference_unprotected CHECK(kind<>'reference' OR (protection='none' AND protection_id IS NULL));

CREATE TABLE IF NOT EXISTS public.pb_project_designs (
  project_id uuid PRIMARY KEY REFERENCES public.pb_projects,
  revision integer NOT NULL CHECK(revision BETWEEN 0 AND 99),
  snapshot jsonb NOT NULL CHECK(octet_length(snapshot::text)<=98304),
  receipt jsonb NOT NULL,
  previous_snapshot jsonb CHECK(octet_length(previous_snapshot::text)<=98304),
  previous_receipt jsonb
);
CREATE TABLE IF NOT EXISTS public.pb_project_design_receipts (
  project_id uuid NOT NULL REFERENCES public.pb_projects, request_id uuid NOT NULL,
  expected_revision integer CHECK(expected_revision BETWEEN 0 AND 99),
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL, PRIMARY KEY(project_id,request_id)
);

ALTER TABLE public.pb_project_designs ADD COLUMN IF NOT EXISTS binding_ledger jsonb;
ALTER TABLE public.pb_project_designs ADD COLUMN IF NOT EXISTS participant_ledger jsonb;
-- Older snapshots retained every prior identity; initialise only missing ledgers.
UPDATE public.pb_project_designs SET binding_ledger=snapshot->'bindings' WHERE binding_ledger IS NULL;
UPDATE public.pb_project_designs SET participant_ledger=snapshot->'participants' WHERE participant_ledger IS NULL;
ALTER TABLE public.pb_project_designs ALTER COLUMN binding_ledger SET NOT NULL;
ALTER TABLE public.pb_project_designs ALTER COLUMN participant_ledger SET NOT NULL;
ALTER TABLE public.pb_project_designs DROP CONSTRAINT IF EXISTS pb_project_design_binding_ledger;
ALTER TABLE public.pb_project_designs ADD CONSTRAINT pb_project_design_binding_ledger CHECK(jsonb_typeof(binding_ledger)='array' AND jsonb_array_length(binding_ledger)<=24 AND octet_length(binding_ledger::text)<=16384);
ALTER TABLE public.pb_project_designs DROP CONSTRAINT IF EXISTS pb_project_design_participant_ledger;
ALTER TABLE public.pb_project_designs ADD CONSTRAINT pb_project_design_participant_ledger CHECK(jsonb_typeof(participant_ledger)='array' AND jsonb_array_length(participant_ledger) BETWEEN 1 AND 4 AND octet_length(participant_ledger::text)<=2048);

CREATE OR REPLACE FUNCTION public.pb_project_design_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_project_require_service();
  RETURN jsonb_build_object('designVersion',1,'retirementVersion',1,'snapshotBytes',81920,'bindings',24,'checkpoints',2,'receipts',100,'referenceAssets',true);
END $$;

-- The service validates the full current PhotoProject schema; SQL owns scope and asset authority.
CREATE OR REPLACE FUNCTION public.pb_project_design_require_assets(p_actor uuid,p_project uuid,p_snapshot jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b jsonb; m jsonb; person jsonb; a public.pb_project_assets;
BEGIN
  PERFORM public.pb_project_require_actor(p_project,p_actor);
  IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR p_snapshot->>'version' IS DISTINCT FROM '1' OR p_snapshot-ARRAY['version','project','bindings','participants']<>'{}'
    OR jsonb_typeof(p_snapshot->'bindings') IS DISTINCT FROM 'array' OR jsonb_array_length(p_snapshot->'bindings')>24
    OR jsonb_typeof(p_snapshot->'participants') IS DISTINCT FROM 'array' OR jsonb_array_length(p_snapshot->'participants') NOT BETWEEN 1 AND 4
    OR jsonb_typeof(p_snapshot->'project'->'media') IS DISTINCT FROM 'array' OR jsonb_array_length(p_snapshot->'project'->'media')<>jsonb_array_length(p_snapshot->'bindings')
    OR octet_length(p_snapshot::text)>98304 THEN RAISE EXCEPTION 'PB_PROJECT_INVALID'; END IF;
  IF (SELECT count(DISTINCT entry->>'mediaId') FROM jsonb_array_elements(p_snapshot->'bindings') entry)<>jsonb_array_length(p_snapshot->'bindings') OR
    (SELECT count(DISTINCT entry->>'assetId') FROM jsonb_array_elements(p_snapshot->'bindings') entry)<>jsonb_array_length(p_snapshot->'bindings') OR
    (SELECT count(DISTINCT entry->>'participantId') FROM jsonb_array_elements(p_snapshot->'participants') entry)<>jsonb_array_length(p_snapshot->'participants') THEN RAISE EXCEPTION 'PB_PROJECT_INVALID'; END IF;
  FOR person IN SELECT * FROM jsonb_array_elements(p_snapshot->'participants') LOOP
    IF NOT EXISTS(SELECT 1 FROM public.pb_project_members WHERE project_id=p_project AND user_id=(person->>'ownerId')::uuid AND status='accepted') THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
  END LOOP;
  FOR b IN SELECT * FROM jsonb_array_elements(p_snapshot->'bindings') LOOP
    SELECT * INTO a FROM public.pb_project_assets WHERE id=(b->>'assetId')::uuid;
    SELECT value INTO m FROM jsonb_array_elements(p_snapshot->'project'->'media') WHERE value->>'id'=b->>'mediaId';
    IF a.id IS NULL OR a.project_id<>p_project OR a.status<>'ready' OR a.owner_id::text IS DISTINCT FROM b->>'ownerId'
      OR a.sha256 IS DISTINCT FROM b->>'sha256' OR m IS NULL OR m->>'kind' IS DISTINCT FROM a.kind OR m->>'mime' IS DISTINCT FROM a.mime
      OR (m->>'bytes')::bigint IS DISTINCT FROM a.bytes OR (m->>'width')::integer IS DISTINCT FROM a.width OR (m->>'height')::integer IS DISTINCT FROM a.height
      OR NOT EXISTS(SELECT 1 FROM public.pb_project_members WHERE project_id=p_project AND user_id=a.owner_id AND status='accepted')
      OR public.pb_project_protection_read(a.id,p_actor) IS DISTINCT FROM true THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
    IF m->>'participantId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_snapshot->'participants') p WHERE p->>'participantId'=m->>'participantId' AND p->>'ownerId'=a.owner_id::text) THEN RAISE EXCEPTION 'PB_PROJECT_DENIED'; END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.pb_project_design_read(p_actor uuid,p_project uuid,p_checkpoint text DEFAULT 'current') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.pb_project_designs; s jsonb; r jsonb;
BEGIN
  PERFORM public.pb_project_require_service(); PERFORM 1 FROM public.pb_projects WHERE id=p_project FOR UPDATE; PERFORM public.pb_project_require_actor(p_project,p_actor);
  IF p_checkpoint IS NULL OR p_checkpoint NOT IN ('current','previous') THEN RAISE EXCEPTION 'PB_PROJECT_INVALID'; END IF;
  SELECT * INTO d FROM public.pb_project_designs WHERE project_id=p_project;
  s=CASE WHEN p_checkpoint='current' THEN d.snapshot ELSE d.previous_snapshot END; r=CASE WHEN p_checkpoint='current' THEN d.receipt ELSE d.previous_receipt END;
  IF s IS NULL THEN RETURN jsonb_build_object('record',NULL); END IF;
  PERFORM public.pb_project_design_require_assets(p_actor,p_project,s);
  RETURN jsonb_build_object('record',jsonb_build_object('snapshot',s,'receipt',r));
END $$;

CREATE OR REPLACE FUNCTION public.pb_project_design_save(p_actor uuid,p_project uuid,p_request uuid,p_expected integer,p_snapshot jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d public.pb_project_designs; old public.pb_project_design_receipts; h text; result jsonb; next_revision integer; b jsonb; bindings jsonb; participants jsonb;
BEGIN
  PERFORM public.pb_project_require_service(); PERFORM 1 FROM public.pb_projects WHERE id=p_project FOR UPDATE; PERFORM public.pb_project_require_actor(p_project,p_actor,true);
  IF p_request IS NULL OR (p_expected IS NOT NULL AND p_expected NOT BETWEEN 0 AND 99) OR p_snapshot->'project'->>'schemaVersion' IS DISTINCT FROM '3'
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

CREATE OR REPLACE FUNCTION public.pb_project_design_head(p_actor uuid,p_project uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.pb_project_require_service(); PERFORM 1 FROM public.pb_projects WHERE id=p_project FOR UPDATE; PERFORM public.pb_project_require_actor(p_project,p_actor,true);
  RETURN jsonb_build_object('receipt',(SELECT receipt FROM public.pb_project_designs WHERE project_id=p_project));
END $$;

CREATE OR REPLACE FUNCTION public.pb_project_design_status(p_actor uuid,p_project uuid,p_request uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.pb_project_require_actor(p_project,p_actor,true);
  IF p_request IS NULL THEN RAISE EXCEPTION 'PB_PROJECT_INVALID'; END IF;
  RETURN jsonb_build_object('receipt',(SELECT receipt FROM public.pb_project_design_receipts WHERE project_id=p_project AND request_id=p_request));
END $$;

ALTER TABLE public.pb_project_designs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pb_project_design_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pb_project_designs,public.pb_project_design_receipts FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.pb_project_design_capabilities(),public.pb_project_design_require_assets(uuid,uuid,jsonb),public.pb_project_design_read(uuid,uuid,text),public.pb_project_design_save(uuid,uuid,uuid,integer,jsonb),public.pb_project_design_status(uuid,uuid,uuid),public.pb_project_design_head(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pb_project_design_capabilities(),public.pb_project_design_read(uuid,uuid,text),public.pb_project_design_save(uuid,uuid,uuid,integer,jsonb),public.pb_project_design_status(uuid,uuid,uuid),public.pb_project_design_head(uuid,uuid) TO service_role;
COMMIT;
