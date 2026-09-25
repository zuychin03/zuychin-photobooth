BEGIN;

CREATE TABLE IF NOT EXISTS public.pb_lifecycle_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  quota_timezone text,
  configured_at timestamptz,
  legacy_retention_not_before timestamptz NOT NULL DEFAULT (now() + interval '8 days'),
  max_object_bytes bigint NOT NULL DEFAULT 16777216 CHECK (max_object_bytes = 16777216),
  weekly_bytes bigint NOT NULL DEFAULT 184549376 CHECK (weekly_bytes = 184549376)
);
INSERT INTO public.pb_lifecycle_settings(singleton) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.pb_strip_quota_ledger (
  strip_id uuid PRIMARY KEY,
  owner uuid NOT NULL,
  scope_key text NOT NULL,
  accepted_at timestamptz NOT NULL,
  week_start date NOT NULL,
  category text NOT NULL CHECK (category IN ('strip', 'recap')),
  charged_bytes bigint NOT NULL CHECK (charged_bytes > 0),
  storage_path text NOT NULL,
  legacy boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS pb_strip_quota_scope_week ON public.pb_strip_quota_ledger(scope_key, week_start);
CREATE INDEX IF NOT EXISTS pb_strip_quota_owner_week ON public.pb_strip_quota_ledger(owner, week_start);
ALTER TABLE public.pb_strip_quota_ledger ADD COLUMN IF NOT EXISTS quota_released_at timestamptz;

CREATE TABLE IF NOT EXISTS public.pb_media_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('archive','retention_archive','release','delete','relay_cleanup','upload_cleanup')),
  source_type text NOT NULL CHECK (source_type IN ('strip','relay','upload')),
  source_id uuid,
  owner uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  checkpoint jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(checkpoint) = 'object'),
  stage text NOT NULL DEFAULT 'pending' CHECK (stage IN ('pending','uploaded','reference_verified','storage_removed','cloudinary_removed','row_deleted','complete')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','retry','complete','failed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
  lease_token uuid,
  lease_owner uuid,
  lease_until timestamptz,
  retry_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner, idempotency_key),
  CHECK ((source_type = 'upload') OR source_id IS NOT NULL),
  CHECK (octet_length(snapshot::text) <= 32768 AND octet_length(checkpoint::text) <= 32768)
);
CREATE INDEX IF NOT EXISTS pb_media_jobs_due ON public.pb_media_jobs(status, retry_at, lease_until);
CREATE INDEX IF NOT EXISTS pb_media_jobs_source ON public.pb_media_jobs(source_type, source_id);
ALTER TABLE public.pb_media_jobs ALTER COLUMN created_at SET DEFAULT clock_timestamp();

CREATE TABLE IF NOT EXISTS public.pb_job_leases (
  job text PRIMARY KEY CHECK (length(job) BETWEEN 1 AND 80),
  token uuid NOT NULL,
  lease_until timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS public.pb_reminder_deliveries (
  date_id uuid NOT NULL,
  scheduled_at timestamptz NOT NULL,
  channel text NOT NULL CHECK (channel = 'email' OR channel ~ '^push:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  delivered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(date_id, scheduled_at, channel)
);

ALTER TABLE public.pb_strips ADD COLUMN IF NOT EXISTS lifecycle_legacy boolean NOT NULL DEFAULT true;
ALTER TABLE public.pb_strips ADD COLUMN IF NOT EXISTS archive_verified_at timestamptz;
ALTER TABLE public.pb_strips ADD COLUMN IF NOT EXISTS media_bytes bigint;
ALTER TABLE public.pb_relays ADD COLUMN IF NOT EXISTS lifecycle_verified boolean NOT NULL DEFAULT false;
REVOKE UPDATE ON public.pb_strips FROM PUBLIC,anon,authenticated;
REVOKE UPDATE(id,owner,couple_id,storage_path,layout_id,kept,cloudinary_public_id,cloudinary_url,purged,created_at,lifecycle_legacy,archive_verified_at,media_bytes) ON public.pb_strips FROM PUBLIC,anon,authenticated;
GRANT UPDATE(caption) ON public.pb_strips TO authenticated;

ALTER TABLE public.pb_lifecycle_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pb_strip_quota_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pb_media_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pb_job_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pb_reminder_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pb_lifecycle_settings, public.pb_strip_quota_ledger, public.pb_media_jobs,
  public.pb_job_leases, public.pb_reminder_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.pb_lifecycle_settings, public.pb_strip_quota_ledger, public.pb_media_jobs,
  public.pb_job_leases, public.pb_reminder_deliveries TO service_role;

CREATE OR REPLACE FUNCTION public.pb_require_service()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'PB_SERVICE_REQUIRED' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_lifecycle_capabilities()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('version', 1, 'configured', quota_timezone IS NOT NULL,
    'ready', quota_timezone IS NOT NULL, 'retention_timezone', quota_timezone,
    'week_start', date_trunc('week', statement_timestamp() AT TIME ZONE quota_timezone) AT TIME ZONE quota_timezone,
    'object_byte_limit', max_object_bytes, 'weekly_byte_limit', weekly_bytes, 'strip_limit', 10, 'recap_limit', 1,
    'quota_timezone', quota_timezone, 'max_object_bytes', max_object_bytes,
    'weekly_strip_cap', 10, 'weekly_recap_cap', 1, 'weekly_bytes', weekly_bytes,
    'legacy_retention_not_before', legacy_retention_not_before)
  FROM public.pb_lifecycle_settings WHERE singleton;
$$;

CREATE OR REPLACE FUNCTION public.pb_configure_lifecycle(p_timezone text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_settings public.pb_lifecycle_settings;
BEGIN
  PERFORM public.pb_require_service();
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = p_timezone) THEN
    RAISE EXCEPTION 'PB_INVALID_TIMEZONE';
  END IF;
  SELECT * INTO v_settings FROM public.pb_lifecycle_settings WHERE singleton FOR UPDATE;
  IF v_settings.quota_timezone IS NOT NULL AND v_settings.quota_timezone <> p_timezone THEN
    RAISE EXCEPTION 'PB_TIMEZONE_RECONCILIATION_REQUIRED';
  END IF;
  INSERT INTO public.pb_strip_quota_ledger(strip_id, owner, scope_key, accepted_at, week_start, category, charged_bytes, storage_path, legacy)
  SELECT s.id, s.owner, CASE WHEN s.couple_id IS NULL THEN 'owner:' || s.owner ELSE 'couple:' || s.couple_id END,
    s.created_at, date_trunc('week', s.created_at AT TIME ZONE p_timezone)::date,
    CASE WHEN s.layout_id = 'recap' THEN 'recap' ELSE 'strip' END,
    CASE WHEN o.metadata->>'size' ~ '^[0-9]{1,12}$' AND (o.metadata->>'size')::bigint > 0
      THEN (o.metadata->>'size')::bigint ELSE v_settings.max_object_bytes END,
    s.storage_path, true
  FROM public.pb_strips s LEFT JOIN storage.objects o ON o.bucket_id = 'photobooth-strips' AND o.name = s.storage_path
  ON CONFLICT (strip_id) DO NOTHING;
  UPDATE public.pb_lifecycle_settings SET quota_timezone = p_timezone, configured_at = coalesce(configured_at, now()) WHERE singleton;
  RETURN public.pb_lifecycle_capabilities();
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_guard_strip_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_settings public.pb_lifecycle_settings;
  v_couple public.pb_couples;
  v_members uuid[];
  v_member uuid;
  v_scope text;
  v_week date;
  v_category text;
  v_size_text text;
  v_bytes bigint;
  v_count integer;
  v_total bigint;
  v_service boolean := coalesce(auth.role(), '') = 'service_role' OR current_setting('role') IN ('none','postgres','supabase_admin');
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.owner <> OLD.owner OR NEW.created_at <> OLD.created_at
      OR NEW.storage_path <> OLD.storage_path OR NEW.layout_id IS DISTINCT FROM OLD.layout_id
      OR (NEW.couple_id IS DISTINCT FROM OLD.couple_id AND (NEW.couple_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.pb_couples WHERE id=OLD.couple_id)))
      OR NEW.lifecycle_legacy <> OLD.lifecycle_legacy OR NEW.media_bytes IS DISTINCT FROM OLD.media_bytes THEN
      RAISE EXCEPTION 'PB_IMMUTABLE_STRIP_IDENTITY' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT v_service AND (auth.uid() IS NULL OR auth.uid() <> NEW.owner) THEN
    RAISE EXCEPTION 'PB_OWNER_REQUIRED' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_settings FROM public.pb_lifecycle_settings WHERE singleton;
  IF v_settings.quota_timezone IS NULL THEN RAISE EXCEPTION 'PB_LIFECYCLE_NOT_CONFIGURED'; END IF;
  IF NEW.kept OR NEW.purged OR NEW.cloudinary_public_id IS NOT NULL OR NEW.cloudinary_url IS NOT NULL OR NEW.archive_verified_at IS NOT NULL THEN
    RAISE EXCEPTION 'PB_INVALID_INITIAL_MEDIA_STATE';
  END IF;
  SELECT * INTO v_couple FROM public.pb_couples
    WHERE member_b IS NOT NULL AND (member_a = NEW.owner OR member_b = NEW.owner)
    ORDER BY created_at DESC, id LIMIT 1 FOR SHARE;
  IF v_couple.id IS NOT NULL THEN
    IF NEW.couple_id IS DISTINCT FROM v_couple.id THEN RAISE EXCEPTION 'PB_COUPLE_MISMATCH'; END IF;
    v_members := ARRAY[v_couple.member_a, v_couple.member_b];
    v_scope := 'couple:' || v_couple.id;
  ELSE
    IF NEW.couple_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.pb_couples WHERE id = NEW.couple_id AND member_a = NEW.owner AND member_b IS NULL
    ) THEN RAISE EXCEPTION 'PB_COUPLE_MISMATCH'; END IF;
    v_members := ARRAY[NEW.owner];
    v_scope := 'owner:' || NEW.owner;
  END IF;
  FOR v_member IN SELECT unnest(v_members) ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('pb-quota-owner:' || v_member, 0));
  END LOOP;
  PERFORM pg_advisory_xact_lock(hashtextextended('pb-quota:' || v_scope, 0));
  IF EXISTS (SELECT 1 FROM public.pb_strip_quota_ledger WHERE strip_id = NEW.id) THEN RAISE EXCEPTION 'PB_STRIP_ID_ALREADY_CONSUMED'; END IF;
  IF NEW.storage_path <> NEW.owner::text || '/' || NEW.id::text || '.png' THEN RAISE EXCEPTION 'PB_INVALID_STORAGE_PATH'; END IF;
  SELECT metadata->>'size' INTO v_size_text FROM storage.objects
    WHERE bucket_id = 'photobooth-strips' AND name = NEW.storage_path FOR SHARE;
  IF v_size_text IS NULL OR v_size_text !~ '^[0-9]{1,12}$' THEN RAISE EXCEPTION 'PB_OBJECT_SIZE_UNVERIFIED'; END IF;
  v_bytes := v_size_text::bigint;
  IF v_bytes < 1 OR v_bytes > v_settings.max_object_bytes THEN RAISE EXCEPTION 'PB_OBJECT_TOO_LARGE'; END IF;
  NEW.created_at := statement_timestamp();
  NEW.lifecycle_legacy := false;
  NEW.media_bytes := v_bytes;
  v_week := date_trunc('week', NEW.created_at AT TIME ZONE v_settings.quota_timezone)::date;
  v_category := CASE WHEN NEW.layout_id = 'recap' THEN 'recap' ELSE 'strip' END;
  SELECT count(*) FILTER (WHERE category = v_category), coalesce(sum(charged_bytes), 0)
    INTO v_count, v_total FROM public.pb_strip_quota_ledger
    WHERE week_start = v_week AND quota_released_at IS NULL AND (scope_key = v_scope OR owner = ANY(v_members));
  IF v_count >= (CASE WHEN v_category = 'recap' THEN 1 ELSE 10 END) OR v_total + v_bytes > v_settings.weekly_bytes THEN
    RAISE EXCEPTION 'PB_WEEKLY_QUOTA_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.pb_strip_quota_ledger(strip_id,owner,scope_key,accepted_at,week_start,category,charged_bytes,storage_path)
    VALUES (NEW.id,NEW.owner,v_scope,NEW.created_at,v_week,v_category,v_bytes,NEW.storage_path);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pb_strips_quota_guard ON public.pb_strips;
CREATE TRIGGER pb_strips_quota_guard BEFORE INSERT OR UPDATE ON public.pb_strips FOR EACH ROW EXECUTE FUNCTION public.pb_guard_strip_write();

CREATE OR REPLACE FUNCTION public.pb_guard_consumed_object()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.bucket_id = 'photobooth-strips' AND EXISTS (
    SELECT 1 FROM public.pb_strip_quota_ledger WHERE storage_path = NEW.name
  ) OR TG_OP = 'UPDATE' AND OLD.bucket_id = 'photobooth-strips' AND EXISTS (
    SELECT 1 FROM public.pb_strip_quota_ledger WHERE storage_path = OLD.name
  )) AND (TG_OP = 'INSERT' OR NEW.metadata IS DISTINCT FROM OLD.metadata OR NEW.name <> OLD.name OR NEW.bucket_id <> OLD.bucket_id) THEN
    RAISE EXCEPTION 'PB_CONSUMED_OBJECT_IMMUTABLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pb_consumed_object_guard ON storage.objects;
CREATE TRIGGER pb_consumed_object_guard BEFORE INSERT OR UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION public.pb_guard_consumed_object();

CREATE OR REPLACE FUNCTION public.pb_queue_media_job(p_kind text,p_source_type text,p_source_id uuid,p_owner uuid,p_key text,p_snapshot jsonb)
RETURNS public.pb_media_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_job public.pb_media_jobs;
BEGIN
  IF p_kind='delete' AND coalesce(p_snapshot->>'cloudinary_public_id','')='' AND EXISTS(
    SELECT 1 FROM public.pb_media_jobs WHERE source_type='strip' AND source_id=p_source_id AND kind IN('archive','retention_archive') AND attempts>0
  ) THEN
    p_snapshot:=p_snapshot || jsonb_build_object('cloudinary_public_id','zuychin-photobooth/' || p_owner || '/' || p_source_id,'archive_attempted',true);
  END IF;
  INSERT INTO public.pb_media_jobs(kind,source_type,source_id,owner,idempotency_key,snapshot)
    VALUES(p_kind,p_source_type,p_source_id,p_owner,p_key,p_snapshot)
    ON CONFLICT(owner,idempotency_key) DO NOTHING RETURNING * INTO v_job;
  IF v_job.id IS NULL THEN
    SELECT * INTO v_job FROM public.pb_media_jobs WHERE owner=p_owner AND idempotency_key=p_key;
    IF v_job.kind <> p_kind OR v_job.source_type <> p_source_type OR v_job.source_id IS DISTINCT FROM p_source_id THEN
      RAISE EXCEPTION 'PB_IDEMPOTENCY_CONFLICT';
    END IF;
    IF p_kind='delete' AND v_job.status<>'complete' THEN
      UPDATE public.pb_media_jobs SET snapshot=v_job.snapshot || p_snapshot,updated_at=now() WHERE id=v_job.id RETURNING * INTO v_job;
    END IF;
  END IF;
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_capture_strip_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_key text;
BEGIN
  IF coalesce(auth.role(),'')='service_role' THEN
    SELECT idempotency_key INTO v_key FROM public.pb_media_jobs WHERE source_type='strip' AND source_id=OLD.id AND kind='delete' AND status='running' AND lease_until>clock_timestamp() LIMIT 1;
  END IF;
  PERFORM public.pb_queue_media_job('delete','strip',OLD.id,OLD.owner,coalesce(v_key,'strip-delete:' || OLD.id),to_jsonb(OLD));
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS pb_strips_delete_provenance ON public.pb_strips;
CREATE TRIGGER pb_strips_delete_provenance BEFORE DELETE ON public.pb_strips FOR EACH ROW EXECUTE FUNCTION public.pb_capture_strip_delete();

CREATE OR REPLACE FUNCTION public.pb_capture_relay_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.pb_queue_media_job('relay_cleanup','relay',OLD.id,OLD.initiator,'relay-delete:' || OLD.id,
    CASE WHEN OLD.lifecycle_verified THEN to_jsonb(OLD) ELSE to_jsonb(OLD) || jsonb_build_object('partner',NULL,'legacy_partner_cleanup_unverified',true) END);
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS pb_relays_delete_provenance ON public.pb_relays;
CREATE TRIGGER pb_relays_delete_provenance BEFORE DELETE ON public.pb_relays FOR EACH ROW EXECUTE FUNCTION public.pb_capture_relay_delete();

CREATE OR REPLACE FUNCTION public.pb_enqueue_strip_operation(p_strip_id uuid,p_operation text,p_request_id uuid)
RETURNS public.pb_media_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_strip public.pb_strips; v_existing public.pb_media_jobs; v_key text;
BEGIN
  IF auth.uid() IS NULL OR p_operation NOT IN ('archive','release','delete') OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'PB_INVALID_OPERATION' USING ERRCODE = '42501';
  END IF;
  v_key:=CASE WHEN p_operation='delete' THEN 'strip-delete:' || p_strip_id ELSE 'request:' || p_request_id END;
  PERFORM pg_advisory_xact_lock(hashtextextended('pb-user-jobs:' || auth.uid(),0));
  SELECT * INTO v_existing FROM public.pb_media_jobs WHERE owner=auth.uid() AND idempotency_key=v_key;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.kind<>p_operation OR v_existing.source_id IS DISTINCT FROM p_strip_id THEN RAISE EXCEPTION 'PB_IDEMPOTENCY_CONFLICT'; END IF;
    RETURN v_existing;
  END IF;
  IF (SELECT count(*) FROM public.pb_media_jobs WHERE owner=auth.uid() AND snapshot->>'user_requested'='true' AND status IN('queued','running','retry'))>=32 THEN RAISE EXCEPTION 'PB_QUEUE_LIMIT'; END IF;
  SELECT * INTO v_strip FROM public.pb_strips WHERE id=p_strip_id AND owner=auth.uid() FOR UPDATE;
  IF v_strip.id IS NULL THEN RAISE EXCEPTION 'PB_OWNER_REQUIRED' USING ERRCODE = '42501'; END IF;
  IF p_operation='archive' THEN
    IF EXISTS(SELECT 1 FROM public.pb_media_jobs WHERE source_type='strip' AND source_id=v_strip.id AND kind='delete'
      AND snapshot->>'retention'='true' AND status='running' AND lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'PB_SOURCE_BUSY'; END IF;
    UPDATE public.pb_strips SET kept=true WHERE id=v_strip.id RETURNING * INTO v_strip;
  END IF;
  RETURN public.pb_queue_media_job(p_operation,'strip',v_strip.id,v_strip.owner,
    v_key,to_jsonb(v_strip) || jsonb_build_object('user_requested',true));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_enqueue_media_job(p_kind text,p_source_type text,p_source_id uuid,p_idempotency_key text,p_payload jsonb)
RETURNS public.pb_media_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_strip public.pb_strips; v_relay public.pb_relays; v_owner uuid; v_path text; v_snapshot jsonb;
BEGIN
  PERFORM public.pb_require_service();
  IF p_source_type='strip' AND p_kind IN ('archive','retention_archive','release','delete') THEN
    SELECT * INTO v_strip FROM public.pb_strips WHERE id=p_source_id FOR UPDATE;
    IF v_strip.id IS NULL THEN RAISE EXCEPTION 'PB_SOURCE_NOT_FOUND'; END IF;
    IF p_kind IN('archive','retention_archive') THEN
      UPDATE public.pb_strips SET kept=true WHERE id=v_strip.id RETURNING * INTO v_strip;
    END IF;
    v_owner:=v_strip.owner; v_snapshot:=to_jsonb(v_strip);
    IF p_kind='delete' AND p_idempotency_key='retention:' || v_strip.id THEN
      v_snapshot:=v_snapshot || jsonb_build_object('retention',true);
    ELSIF p_kind='delete' THEN p_idempotency_key:='strip-delete:' || v_strip.id; END IF;
  ELSIF p_source_type='relay' AND p_kind='relay_cleanup' THEN
    SELECT * INTO v_relay FROM public.pb_relays WHERE id=p_source_id FOR UPDATE;
    IF v_relay.id IS NULL THEN RAISE EXCEPTION 'PB_SOURCE_NOT_FOUND'; END IF;
    v_owner:=v_relay.initiator; v_snapshot:=to_jsonb(v_relay);
  ELSIF p_source_type='upload' AND p_kind='upload_cleanup' THEN
    v_owner:=(p_payload->>'owner')::uuid; v_path:=p_payload->>'storage_path';
    IF v_owner IS NULL OR v_path IS NULL OR split_part(v_path,'/',1) <> v_owner::text
      OR v_path ~ '(^|/)\.\.(/|$)' OR length(v_path)>512
      OR EXISTS(SELECT 1 FROM public.pb_strips WHERE storage_path=v_path) THEN RAISE EXCEPTION 'PB_INVALID_ORPHAN_PATH'; END IF;
    v_snapshot:=jsonb_build_object('owner',v_owner,'storage_path',v_path,'bucket','photobooth-strips');
  ELSE RAISE EXCEPTION 'PB_INVALID_OPERATION'; END IF;
  RETURN public.pb_queue_media_job(p_kind,p_source_type,p_source_id,v_owner,p_idempotency_key,v_snapshot);
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_claim_media_jobs(p_worker_id uuid,p_limit integer DEFAULT 10,p_lease_seconds integer DEFAULT 60,p_job_id uuid DEFAULT NULL)
RETURNS SETOF public.pb_media_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_job public.pb_media_jobs; v_count integer:=0; v_source text;
BEGIN
  PERFORM public.pb_require_service();
  IF p_worker_id IS NULL OR p_limit NOT BETWEEN 1 AND 25 OR p_lease_seconds NOT BETWEEN 1 AND 900 THEN RAISE EXCEPTION 'PB_INVALID_LEASE'; END IF;
  FOR v_job IN SELECT * FROM public.pb_media_jobs
    WHERE (p_job_id IS NULL OR id=p_job_id) AND ((status IN ('queued','retry') AND retry_at<=clock_timestamp()) OR (status='running' AND lease_until<=clock_timestamp()))
    ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 100
  LOOP
    v_source:=v_job.source_type || ':' || coalesce(v_job.source_id::text,v_job.snapshot->>'storage_path');
    IF NOT pg_try_advisory_xact_lock(hashtextextended('pb-job-source:' || v_source,0)) THEN CONTINUE; END IF;
    IF (v_job.kind='retention_archive' OR v_job.snapshot->>'retention'='true') AND EXISTS(
      SELECT 1 FROM public.pb_media_jobs newer WHERE newer.source_type='strip' AND newer.source_id=v_job.source_id
      AND ((newer.kind IN('archive','release') AND newer.idempotency_key LIKE 'request:%') OR (newer.kind='delete' AND newer.snapshot->>'retention' IS DISTINCT FROM 'true'))
      AND (newer.created_at,newer.id)>(v_job.created_at,v_job.id)
    ) THEN
      UPDATE public.pb_media_jobs SET status='failed',last_error='retention_superseded',lease_token=NULL,lease_until=NULL,lease_owner=NULL,updated_at=now() WHERE id=v_job.id;
      CONTINUE;
    END IF;
    IF EXISTS(SELECT 1 FROM public.pb_media_jobs j WHERE j.id<>v_job.id
      AND j.source_type=v_job.source_type AND coalesce(j.source_id::text,j.snapshot->>'storage_path')=coalesce(v_job.source_id::text,v_job.snapshot->>'storage_path')
      AND j.status='running' AND j.lease_until>clock_timestamp()) THEN CONTINUE; END IF;
    IF EXISTS(SELECT 1 FROM public.pb_media_jobs j WHERE j.id<>v_job.id
      AND j.source_type=v_job.source_type AND coalesce(j.source_id::text,j.snapshot->>'storage_path')=coalesce(v_job.source_id::text,v_job.snapshot->>'storage_path')
      AND j.status IN('queued','retry','running') AND (j.created_at,j.id)<(v_job.created_at,v_job.id)) THEN CONTINUE; END IF;
    IF v_job.attempts>=v_job.max_attempts THEN
      UPDATE public.pb_media_jobs SET status='failed',last_error='attempt limit reached',lease_token=NULL,lease_until=NULL,lease_owner=NULL,updated_at=now() WHERE id=v_job.id;
      CONTINUE;
    END IF;
    UPDATE public.pb_media_jobs SET status='running',attempts=attempts+1,lease_owner=p_worker_id,lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),updated_at=now() WHERE id=v_job.id RETURNING * INTO v_job;
    RETURN NEXT v_job;
    v_count:=v_count+1;
    IF v_count>=p_limit THEN EXIT; END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_discover_retention(p_limit integer DEFAULT 25)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_settings public.pb_lifecycle_settings; v_strip public.pb_strips; v_kind text; v_count integer:=0; v_cutoff timestamptz;
BEGIN
  PERFORM public.pb_require_service();
  IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'PB_INVALID_LIMIT'; END IF;
  SELECT * INTO v_settings FROM public.pb_lifecycle_settings WHERE singleton;
  IF v_settings.quota_timezone IS NULL THEN RETURN 0; END IF;
  v_cutoff:=date_trunc('week',clock_timestamp() AT TIME ZONE v_settings.quota_timezone) AT TIME ZONE v_settings.quota_timezone;
  FOR v_strip IN SELECT s.* FROM public.pb_strips s WHERE NOT s.purged AND s.created_at<v_cutoff
    AND (NOT s.lifecycle_legacy OR clock_timestamp()>=v_settings.legacy_retention_not_before)
    AND NOT EXISTS(SELECT 1 FROM public.pb_media_jobs j WHERE j.source_type='strip' AND j.source_id=s.id
      AND j.kind=(CASE WHEN s.kept OR s.layout_id='recap' THEN 'retention_archive' ELSE 'delete' END)
      AND (j.kind='retention_archive' OR j.snapshot->>'retention'='true'))
    AND NOT EXISTS(SELECT 1 FROM public.pb_media_jobs j WHERE j.source_type='strip' AND j.source_id=s.id
      AND j.status IN('queued','retry','running'))
    ORDER BY s.created_at,s.id FOR UPDATE SKIP LOCKED LIMIT p_limit
  LOOP
    v_kind:=CASE WHEN v_strip.kept OR v_strip.layout_id='recap' THEN 'retention_archive' ELSE 'delete' END;
    PERFORM public.pb_enqueue_media_job(v_kind,'strip',v_strip.id,
      CASE WHEN v_kind='delete' THEN 'retention:' ELSE 'retention-archive:' END || v_strip.id,'{}');
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_checkpoint_media_job(p_job_id uuid,p_lease_token uuid,p_stage text,p_checkpoint jsonb DEFAULT '{}')
RETURNS public.pb_media_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_job public.pb_media_jobs; v_strip public.pb_strips; v_steps text[]; v_data jsonb;
BEGIN
  PERFORM public.pb_require_service();
  SELECT * INTO v_job FROM public.pb_media_jobs WHERE id=p_job_id FOR UPDATE;
  IF v_job.id IS NULL OR v_job.status<>'running' OR v_job.lease_token IS DISTINCT FROM p_lease_token OR v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'PB_STALE_LEASE'; END IF;
  IF v_job.kind='retention_archive' OR v_job.snapshot->>'retention'='true' THEN
    SELECT * INTO v_strip FROM public.pb_strips WHERE id=v_job.source_id;
    IF v_strip.id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM public.pb_lifecycle_settings WHERE singleton AND quota_timezone IS NOT NULL
      AND v_strip.created_at < (date_trunc('week',clock_timestamp() AT TIME ZONE quota_timezone) AT TIME ZONE quota_timezone)
      AND (NOT v_strip.lifecycle_legacy OR clock_timestamp()>=legacy_retention_not_before))
      OR (v_job.kind='delete' AND (v_strip.kept OR v_strip.layout_id='recap'))) THEN RAISE EXCEPTION 'PB_RETENTION_PROTECTED'; END IF;
    IF EXISTS(SELECT 1 FROM public.pb_media_jobs newer WHERE newer.source_type='strip' AND newer.source_id=v_job.source_id
      AND ((newer.kind IN('archive','release') AND newer.idempotency_key LIKE 'request:%') OR (newer.kind='delete' AND newer.snapshot->>'retention' IS DISTINCT FROM 'true'))
      AND (newer.created_at,newer.id)>(v_job.created_at,v_job.id)) THEN RAISE EXCEPTION 'PB_RETENTION_SUPERSEDED'; END IF;
  END IF;
  IF jsonb_typeof(p_checkpoint)<>'object' OR octet_length(p_checkpoint::text)>16384 THEN RAISE EXCEPTION 'PB_INVALID_CHECKPOINT'; END IF;
  v_steps:=CASE v_job.kind
    WHEN 'archive' THEN ARRAY['pending','uploaded','reference_verified','complete']
    WHEN 'retention_archive' THEN ARRAY['pending','uploaded','reference_verified','storage_removed','complete']
    WHEN 'release' THEN ARRAY['pending','cloudinary_removed','complete']
    WHEN 'delete' THEN ARRAY['pending','storage_removed','cloudinary_removed','row_deleted','complete']
    ELSE ARRAY['pending','storage_removed','complete'] END;
  IF array_position(v_steps,p_stage) IS NULL OR array_position(v_steps,p_stage)<array_position(v_steps,v_job.stage)
    OR (array_position(v_steps,p_stage)>array_position(v_steps,v_job.stage)+1 AND NOT(v_job.stage='pending' AND p_stage='reference_verified' AND v_job.kind IN('archive','retention_archive'))) THEN RAISE EXCEPTION 'PB_INVALID_STAGE'; END IF;
  v_data:=v_job.checkpoint || p_checkpoint;
  IF p_stage='uploaded' AND (coalesce(v_data->>'cloudinary_public_id','')='' OR coalesce(v_data->>'cloudinary_url','') !~ '^https://') THEN RAISE EXCEPTION 'PB_ARCHIVE_REFERENCE_REQUIRED'; END IF;
  IF p_stage='reference_verified' THEN
    SELECT * INTO v_strip FROM public.pb_strips WHERE id=v_job.source_id;
    IF v_strip.id IS NULL OR v_strip.cloudinary_public_id IS DISTINCT FROM v_data->>'cloudinary_public_id'
      OR v_strip.cloudinary_url IS DISTINCT FROM v_data->>'cloudinary_url' OR v_strip.archive_verified_at IS NULL
      OR v_data->>'archive_verified' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'PB_ARCHIVE_NOT_DURABLE'; END IF;
  END IF;
  IF p_stage='storage_removed' AND v_data->>'storage_removed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'PB_STORAGE_CONFIRMATION_REQUIRED'; END IF;
  IF p_stage='storage_removed' AND v_job.kind='retention_archive' AND v_job.checkpoint->>'archive_verified' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'PB_ARCHIVE_NOT_DURABLE'; END IF;
  IF p_stage='cloudinary_removed' AND v_data->>'cloudinary_removed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'PB_CLOUDINARY_CONFIRMATION_REQUIRED'; END IF;
  IF p_stage='row_deleted' AND (v_data->>'row_deleted' IS DISTINCT FROM 'true' OR EXISTS(SELECT 1 FROM public.pb_strips WHERE id=v_job.source_id)) THEN RAISE EXCEPTION 'PB_ROW_DELETE_CONFIRMATION_REQUIRED'; END IF;
  UPDATE public.pb_media_jobs SET checkpoint=v_data,stage=p_stage,lease_until=clock_timestamp()+interval '120 seconds',updated_at=now() WHERE id=v_job.id RETURNING * INTO v_job;
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_finish_media_job(p_job_id uuid,p_lease_token uuid,p_outcome text,p_error text DEFAULT NULL,p_retry_after_seconds integer DEFAULT 60)
RETURNS public.pb_media_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_job public.pb_media_jobs; v_charge public.pb_strip_quota_ledger;
BEGIN
  PERFORM public.pb_require_service();
  SELECT * INTO v_job FROM public.pb_media_jobs WHERE id=p_job_id FOR UPDATE;
  IF v_job.id IS NULL OR v_job.status<>'running' OR v_job.lease_token IS DISTINCT FROM p_lease_token OR v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'PB_STALE_LEASE'; END IF;
  IF p_outcome NOT IN ('complete','retry','failed') OR p_retry_after_seconds NOT BETWEEN 0 AND 86400 THEN RAISE EXCEPTION 'PB_INVALID_OUTCOME'; END IF;
  IF p_outcome='complete' THEN
    IF v_job.stage<>'complete' AND v_job.stage<>(CASE v_job.kind WHEN 'archive' THEN 'reference_verified' WHEN 'delete' THEN 'row_deleted' WHEN 'release' THEN 'cloudinary_removed' ELSE 'storage_removed' END) THEN RAISE EXCEPTION 'PB_INCOMPLETE_JOB'; END IF;
    IF v_job.kind='retention_archive' AND (v_job.checkpoint->>'storage_removed' IS DISTINCT FROM 'true'
      OR NOT EXISTS(SELECT 1 FROM public.pb_strips WHERE id=v_job.source_id AND purged AND archive_verified_at IS NOT NULL)) THEN RAISE EXCEPTION 'PB_INCOMPLETE_JOB'; END IF;
    IF v_job.kind='release' AND (v_job.checkpoint->>'cloudinary_removed' IS DISTINCT FROM 'true'
      OR NOT EXISTS(SELECT 1 FROM public.pb_strips WHERE id=v_job.source_id AND NOT kept AND cloudinary_public_id IS NULL AND cloudinary_url IS NULL)) THEN RAISE EXCEPTION 'PB_INCOMPLETE_JOB'; END IF;
    IF v_job.kind='delete' AND (v_job.checkpoint->>'storage_removed' IS DISTINCT FROM 'true' OR v_job.checkpoint->>'cloudinary_removed' IS DISTINCT FROM 'true'
      OR v_job.checkpoint->>'row_deleted' IS DISTINCT FROM 'true') THEN RAISE EXCEPTION 'PB_INCOMPLETE_JOB'; END IF;
    IF v_job.kind='delete' THEN
      SELECT * INTO v_charge FROM public.pb_strip_quota_ledger WHERE strip_id=v_job.source_id;
      IF v_charge.strip_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('pb-quota-owner:' || v_charge.owner,0));
        PERFORM pg_advisory_xact_lock(hashtextextended('pb-quota:' || v_charge.scope_key,0));
        UPDATE public.pb_strip_quota_ledger SET quota_released_at=coalesce(quota_released_at,clock_timestamp()) WHERE strip_id=v_charge.strip_id;
      END IF;
    END IF;
  END IF;
  UPDATE public.pb_media_jobs SET status=CASE WHEN p_outcome='retry' AND attempts>=max_attempts THEN 'failed' ELSE p_outcome END,
    stage=CASE WHEN p_outcome='complete' THEN 'complete' ELSE stage END,
    retry_at=clock_timestamp()+make_interval(secs=>p_retry_after_seconds),last_error=left(p_error,500),lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=now()
    WHERE id=v_job.id RETURNING * INTO v_job;
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_update_media_strip(p_job_id uuid,p_lease_token uuid,p_fields jsonb)
RETURNS public.pb_strips LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_job public.pb_media_jobs; v_strip public.pb_strips;
BEGIN
  PERFORM public.pb_require_service();
  SELECT * INTO v_job FROM public.pb_media_jobs WHERE id=p_job_id FOR UPDATE;
  IF v_job.id IS NULL OR v_job.source_type<>'strip' THEN RAISE EXCEPTION 'PB_INVALID_OPERATION'; END IF;
  PERFORM public.pb_checkpoint_media_job(p_job_id,p_lease_token,v_job.stage,'{}');
  IF jsonb_typeof(p_fields)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_fields) AS key
    WHERE key NOT IN('kept','purged','cloudinary_public_id','cloudinary_url','archive_verified_at')) THEN RAISE EXCEPTION 'PB_INVALID_MEDIA_FIELDS'; END IF;
  SELECT * INTO v_strip FROM public.pb_strips WHERE id=v_job.source_id AND owner=v_job.owner FOR UPDATE;
  IF v_strip.id IS NULL THEN RAISE EXCEPTION 'PB_SOURCE_NOT_FOUND'; END IF;
  IF p_fields ? 'purged' AND (p_fields->>'purged')::boolean AND (v_job.kind<>'retention_archive' OR v_job.checkpoint->>'storage_removed' IS DISTINCT FROM 'true') THEN RAISE EXCEPTION 'PB_STORAGE_CONFIRMATION_REQUIRED'; END IF;
  IF v_job.kind='release' AND v_job.checkpoint->>'cloudinary_removed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'PB_CLOUDINARY_CONFIRMATION_REQUIRED'; END IF;
  v_strip:=jsonb_populate_record(v_strip,p_fields);
  UPDATE public.pb_strips SET kept=v_strip.kept,purged=v_strip.purged,cloudinary_public_id=v_strip.cloudinary_public_id,
    cloudinary_url=v_strip.cloudinary_url,archive_verified_at=CASE WHEN p_fields ? 'archive_verified_at' AND p_fields->>'archive_verified_at' IS NOT NULL THEN clock_timestamp() ELSE v_strip.archive_verified_at END
    WHERE id=v_strip.id RETURNING * INTO v_strip;
  RETURN v_strip;
END;
$$;
CREATE OR REPLACE FUNCTION public.pb_delete_media_strip(p_job_id uuid,p_lease_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_job public.pb_media_jobs;
BEGIN
  PERFORM public.pb_require_service();
  SELECT * INTO v_job FROM public.pb_media_jobs WHERE id=p_job_id FOR UPDATE;
  IF v_job.id IS NULL OR v_job.kind<>'delete' THEN RAISE EXCEPTION 'PB_INVALID_OPERATION'; END IF;
  PERFORM public.pb_checkpoint_media_job(p_job_id,p_lease_token,v_job.stage,'{}');
  IF v_job.checkpoint->>'storage_removed' IS DISTINCT FROM 'true' OR v_job.checkpoint->>'cloudinary_removed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'PB_DELETE_CONFIRMATION_REQUIRED'; END IF;
  DELETE FROM public.pb_strips WHERE id=v_job.source_id AND owner=v_job.owner;
  RETURN true;
END;
$$;
CREATE OR REPLACE FUNCTION public.pb_retry_media_job(p_job_id uuid)
RETURNS public.pb_media_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_job public.pb_media_jobs;
BEGIN
  PERFORM public.pb_require_service();
  SELECT * INTO v_job FROM public.pb_media_jobs WHERE id=p_job_id FOR UPDATE;
  IF v_job.id IS NULL OR v_job.status<>'failed' OR v_job.max_attempts>=20 THEN RAISE EXCEPTION 'PB_RETRY_LIMIT'; END IF;
  UPDATE public.pb_media_jobs SET status='retry',retry_at=now(),max_attempts=least(max_attempts+4,20),updated_at=now() WHERE id=p_job_id RETURNING * INTO v_job;
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_acquire_job_lease(p_job text,p_token uuid,p_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_updated integer;
BEGIN
  PERFORM public.pb_require_service();
  IF p_token IS NULL OR p_seconds NOT BETWEEN 1 AND 900 THEN RAISE EXCEPTION 'PB_INVALID_LEASE'; END IF;
  INSERT INTO public.pb_job_leases(job,token,lease_until) VALUES(p_job,p_token,clock_timestamp()+make_interval(secs=>p_seconds))
    ON CONFLICT(job) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until
    WHERE public.pb_job_leases.lease_until<=clock_timestamp() OR public.pb_job_leases.token=p_token;
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  RETURN v_updated=1;
END;
$$;
CREATE OR REPLACE FUNCTION public.pb_release_job_lease(p_job text,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_updated integer;
BEGIN
  PERFORM public.pb_require_service();
  DELETE FROM public.pb_job_leases WHERE job=p_job AND token=p_token;
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  RETURN v_updated=1;
END;
$$;
CREATE OR REPLACE FUNCTION public.pb_record_reminder_delivery(p_date_id uuid,p_scheduled_at timestamptz,p_channel text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.pb_require_service();
  INSERT INTO public.pb_reminder_deliveries(date_id,scheduled_at,channel) VALUES(p_date_id,p_scheduled_at,p_channel) ON CONFLICT DO NOTHING;
  RETURN true;
END;
$$;

CREATE TABLE IF NOT EXISTS public.pb_upload_intents (
  id uuid PRIMARY KEY,
  owner uuid NOT NULL,
  source_id uuid NOT NULL,
  source_type text NOT NULL CHECK(source_type IN ('strip','relay')),
  paths text[] NOT NULL CHECK(cardinality(paths) BETWEEN 1 AND 4),
  status text NOT NULL DEFAULT 'registered' CHECK(status IN ('registered','complete','failed')),
  expires_at timestamptz NOT NULL DEFAULT(now()+interval '2 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner,source_type,source_id)
);
ALTER TABLE public.pb_upload_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pb_upload_intents FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.pb_upload_intents TO service_role;
CREATE INDEX IF NOT EXISTS pb_upload_intents_expiry ON public.pb_upload_intents(status,expires_at);
ALTER TABLE public.pb_upload_intents ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 8);
CREATE INDEX IF NOT EXISTS pb_upload_intents_paths ON public.pb_upload_intents USING gin(paths);
CREATE OR REPLACE FUNCTION public.pb_guard_upload_object()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_intent public.pb_upload_intents;
BEGIN
  IF NEW.bucket_id='photobooth-strips' THEN
    FOR v_intent IN SELECT * FROM public.pb_upload_intents WHERE paths @> ARRAY[NEW.name] FOR SHARE LOOP
      IF v_intent.status='failed' OR (v_intent.status='registered' AND v_intent.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'PB_UPLOAD_EXPIRED'; END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pb_upload_object_fence ON storage.objects;
CREATE TRIGGER pb_upload_object_fence BEFORE INSERT OR UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION public.pb_guard_upload_object();

CREATE OR REPLACE FUNCTION public.pb_upload_has_reference(p_intent public.pb_upload_intents)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN p_intent.source_type='strip' THEN EXISTS(
    SELECT 1 FROM public.pb_strips WHERE id=p_intent.source_id AND owner=p_intent.owner AND storage_path=ANY(p_intent.paths)
  ) ELSE EXISTS(
    SELECT 1 FROM public.pb_relays WHERE id=p_intent.source_id AND (
      initiator=p_intent.owner AND a_done AND p_intent.paths[1] LIKE p_intent.owner::text || '/relay-' || p_intent.source_id::text || '/A-%'
      OR partner=p_intent.owner AND b_done AND p_intent.paths[1] LIKE p_intent.owner::text || '/relay-' || p_intent.source_id::text || '/B-%')
  ) END;
$$;

CREATE OR REPLACE FUNCTION public.pb_register_upload(p_request_id uuid,p_source_id uuid,p_source_type text,p_paths text[])
RETURNS public.pb_upload_intents LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_intent public.pb_upload_intents; v_path text; v_prefix text; v_role text;
BEGIN
  IF auth.uid() IS NULL OR p_request_id IS NULL OR p_source_id IS NULL OR p_source_type NOT IN ('strip','relay')
    OR cardinality(p_paths) NOT BETWEEN 1 AND 4 OR array_position(p_paths,NULL) IS NOT NULL THEN RAISE EXCEPTION 'PB_INVALID_UPLOAD'; END IF;
  SELECT * INTO v_intent FROM public.pb_upload_intents WHERE id=p_request_id FOR UPDATE;
  IF v_intent.id IS NOT NULL THEN
    IF v_intent.owner<>auth.uid() OR v_intent.source_id<>p_source_id OR v_intent.source_type<>p_source_type OR v_intent.paths IS DISTINCT FROM p_paths THEN RAISE EXCEPTION 'PB_IDEMPOTENCY_CONFLICT'; END IF;
    IF v_intent.status='failed' THEN
      IF v_intent.generation>=8 OR EXISTS(SELECT 1 FROM public.pb_strip_quota_ledger WHERE strip_id=p_source_id)
        OR (SELECT count(*) FROM public.pb_media_jobs WHERE kind='upload_cleanup' AND snapshot->>'intent_id'=v_intent.id::text
          AND coalesce((snapshot->>'generation')::integer,1)=v_intent.generation AND status='complete')<>cardinality(v_intent.paths)
        OR EXISTS(SELECT 1 FROM public.pb_media_jobs WHERE kind='upload_cleanup' AND snapshot->>'intent_id'=v_intent.id::text
          AND coalesce((snapshot->>'generation')::integer,1)=v_intent.generation AND (status<>'complete' OR lease_until>clock_timestamp())) THEN RAISE EXCEPTION 'PB_UPLOAD_CLEANUP_PENDING'; END IF;
      UPDATE public.pb_upload_intents SET status='registered',generation=generation+1,expires_at=clock_timestamp()+interval '2 hours' WHERE id=v_intent.id RETURNING * INTO v_intent;
    ELSIF v_intent.status='registered' AND v_intent.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PB_UPLOAD_EXPIRED'; END IF;
    RETURN v_intent;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pb-upload-intents:' || auth.uid(),0));
  IF (SELECT count(*) FROM public.pb_upload_intents WHERE owner=auth.uid() AND status='registered')>=32 THEN RAISE EXCEPTION 'PB_UPLOAD_LIMIT'; END IF;
  v_prefix:=auth.uid()::text || '/';
  IF p_source_type='strip' THEN
    IF cardinality(p_paths)<>1 OR p_paths[1]<>v_prefix || p_source_id::text || '.png' THEN RAISE EXCEPTION 'PB_INVALID_UPLOAD_PATH'; END IF;
  ELSE
    v_role:=CASE WHEN p_paths[1] LIKE v_prefix || 'relay-' || p_source_id::text || '/A-%' THEN 'A' ELSE 'B' END;
    FOREACH v_path IN ARRAY p_paths LOOP
      IF v_path !~ ('^' || v_prefix || 'relay-' || p_source_id::text || '/' || v_role || '-[0-3]\.jpg$') THEN RAISE EXCEPTION 'PB_INVALID_UPLOAD_PATH'; END IF;
    END LOOP;
    IF (SELECT count(DISTINCT p) FROM unnest(p_paths) AS p)<>cardinality(p_paths) THEN RAISE EXCEPTION 'PB_DUPLICATE_UPLOAD_PATH'; END IF;
    IF v_role='B' AND NOT EXISTS(SELECT 1 FROM public.pb_relays r JOIN public.pb_couples c ON c.id=r.couple_id
      WHERE r.id=p_source_id AND r.initiator<>auth.uid() AND auth.uid() IN(c.member_a,c.member_b) AND r.status='pending') THEN RAISE EXCEPTION 'PB_RELAY_MEMBERSHIP_REQUIRED'; END IF;
  END IF;
  INSERT INTO public.pb_upload_intents(id,owner,source_id,source_type,paths) VALUES(p_request_id,auth.uid(),p_source_id,p_source_type,p_paths)
    ON CONFLICT(id) DO NOTHING RETURNING * INTO v_intent;
  IF v_intent.id IS NULL THEN
    SELECT * INTO v_intent FROM public.pb_upload_intents WHERE id=p_request_id AND owner=auth.uid() FOR UPDATE;
    IF v_intent.id IS NULL OR v_intent.source_id<>p_source_id OR v_intent.source_type<>p_source_type OR v_intent.paths IS DISTINCT FROM p_paths THEN RAISE EXCEPTION 'PB_IDEMPOTENCY_CONFLICT'; END IF;
  END IF;
  IF v_intent.status='failed' OR (v_intent.status='registered' AND v_intent.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'PB_UPLOAD_EXPIRED'; END IF;
  RETURN v_intent;
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_resolve_upload(p_intent_id uuid,p_success boolean)
RETURNS public.pb_upload_intents LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_intent public.pb_upload_intents; v_path text;
BEGIN
  SELECT * INTO v_intent FROM public.pb_upload_intents WHERE id=p_intent_id FOR UPDATE;
  IF v_intent.id IS NULL THEN RAISE EXCEPTION 'PB_UPLOAD_NOT_FOUND'; END IF;
  IF public.pb_upload_has_reference(v_intent) THEN
    UPDATE public.pb_upload_intents SET status='complete' WHERE id=v_intent.id RETURNING * INTO v_intent;
    RETURN v_intent;
  END IF;
  IF p_success THEN RAISE EXCEPTION 'PB_UPLOAD_REFERENCE_MISSING'; END IF;
  UPDATE public.pb_upload_intents SET status='failed' WHERE id=v_intent.id RETURNING * INTO v_intent;
  FOREACH v_path IN ARRAY v_intent.paths LOOP
    PERFORM public.pb_queue_media_job('upload_cleanup','upload',v_intent.source_id,v_intent.owner,
      'upload:' || v_intent.id || ':' || v_intent.generation || ':' || md5(v_path),jsonb_build_object('owner',v_intent.owner,'storage_path',v_path,'bucket','photobooth-strips','intent_id',v_intent.id,'generation',v_intent.generation));
  END LOOP;
  RETURN v_intent;
END;
$$;
DROP FUNCTION IF EXISTS public.pb_finish_upload(uuid,boolean);
CREATE OR REPLACE FUNCTION public.pb_finish_upload(p_request_id uuid,p_success boolean,p_generation integer DEFAULT NULL)
RETURNS public.pb_upload_intents LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_intent public.pb_upload_intents;
BEGIN
  SELECT * INTO v_intent FROM public.pb_upload_intents WHERE id=p_request_id AND owner=auth.uid() FOR UPDATE;
  IF auth.uid() IS NULL OR p_success IS NULL OR v_intent.id IS NULL THEN RAISE EXCEPTION 'PB_OWNER_REQUIRED' USING ERRCODE='42501'; END IF;
  IF p_generation IS DISTINCT FROM v_intent.generation THEN RAISE EXCEPTION 'PB_UPLOAD_GENERATION_MISMATCH'; END IF;
  RETURN public.pb_resolve_upload(p_request_id,p_success);
END;
$$;
CREATE OR REPLACE FUNCTION public.pb_enqueue_expired_uploads(p_limit integer DEFAULT 25)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_intent public.pb_upload_intents; v_count integer:=0;
BEGIN
  PERFORM public.pb_require_service();
  IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'PB_INVALID_LIMIT'; END IF;
  FOR v_intent IN SELECT * FROM public.pb_upload_intents WHERE status='registered' AND expires_at<=clock_timestamp()
    ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT p_limit
  LOOP
    PERFORM public.pb_resolve_upload(v_intent.id,false); v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_guard_upload_reference()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_intent public.pb_upload_intents; v_owner uuid; v_source text;
BEGIN
  v_source:=CASE WHEN TG_TABLE_NAME='pb_strips' THEN 'strip' ELSE 'relay' END;
  IF v_source='strip' THEN v_owner:=NEW.owner;
  ELSIF TG_OP='INSERT' THEN v_owner:=NEW.initiator;
  ELSIF NEW.b_done AND NOT OLD.b_done THEN v_owner:=NEW.partner;
  ELSE RETURN NEW; END IF;
  FOR v_intent IN SELECT * FROM public.pb_upload_intents WHERE source_type=v_source AND source_id=NEW.id AND owner=v_owner FOR UPDATE LOOP
    IF v_intent.status='failed' OR (v_intent.status='registered' AND v_intent.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'PB_UPLOAD_EXPIRED'; END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pb_strip_upload_fence ON public.pb_strips;
CREATE TRIGGER pb_strip_upload_fence BEFORE INSERT ON public.pb_strips FOR EACH ROW EXECUTE FUNCTION public.pb_guard_upload_reference();
DROP TRIGGER IF EXISTS pb_relay_upload_fence ON public.pb_relays;
CREATE TRIGGER pb_relay_upload_fence BEFORE INSERT OR UPDATE ON public.pb_relays FOR EACH ROW EXECUTE FUNCTION public.pb_guard_upload_reference();

CREATE OR REPLACE FUNCTION public.pb_guard_relay_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_couple public.pb_couples; v_service boolean:=coalesce(auth.role(),'')='service_role' OR current_setting('role') IN('none','postgres','supabase_admin');
BEGIN
  SELECT * INTO v_couple FROM public.pb_couples WHERE id=NEW.couple_id FOR SHARE;
  IF v_couple.id IS NULL OR NOT coalesce(NEW.initiator=v_couple.member_a OR NEW.initiator=v_couple.member_b,false)
    OR (NEW.partner IS NOT NULL AND (NEW.partner=NEW.initiator OR NOT coalesce(NEW.partner=v_couple.member_a OR NEW.partner=v_couple.member_b,false)))
    OR NEW.shots NOT BETWEEN 1 AND 4 OR NEW.status NOT IN('pending','complete') OR (NEW.status='complete')<>NEW.b_done THEN RAISE EXCEPTION 'PB_INVALID_RELAY'; END IF;
  IF TG_OP='INSERT' THEN
    IF NOT v_service AND NEW.initiator IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'PB_OWNER_REQUIRED'; END IF;
    IF NEW.b_done OR NEW.partner IS NOT NULL OR EXISTS(SELECT 1 FROM public.pb_media_jobs WHERE source_type='relay' AND source_id=NEW.id) THEN RAISE EXCEPTION 'PB_INVALID_RELAY'; END IF;
    NEW.created_at:=statement_timestamp(); NEW.lifecycle_verified:=true;
  ELSE
    IF NEW.id<>OLD.id OR NEW.initiator<>OLD.initiator OR NEW.couple_id<>OLD.couple_id OR NEW.created_at<>OLD.created_at
      OR NEW.shots<>OLD.shots OR NEW.layout_id<>OLD.layout_id OR NEW.filter_id<>OLD.filter_id OR NEW.scene_id IS DISTINCT FROM OLD.scene_id
      OR NEW.lifecycle_verified<>OLD.lifecycle_verified OR (OLD.a_done AND NOT NEW.a_done) OR (OLD.b_done AND NOT NEW.b_done)
      OR (OLD.partner IS NOT NULL AND NEW.partner IS DISTINCT FROM OLD.partner) THEN RAISE EXCEPTION 'PB_IMMUTABLE_RELAY_IDENTITY'; END IF;
    IF NEW.b_done AND NOT OLD.b_done AND (NEW.partner IS NULL OR (NOT v_service AND NEW.partner IS DISTINCT FROM auth.uid())) THEN RAISE EXCEPTION 'PB_RELAY_PARTNER_REQUIRED'; END IF;
    IF NEW.partner IS DISTINCT FROM OLD.partner AND NOT NEW.b_done THEN RAISE EXCEPTION 'PB_RELAY_PARTNER_REQUIRED'; END IF;
    IF NEW.a_done AND NOT OLD.a_done AND NOT v_service AND NEW.initiator IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'PB_OWNER_REQUIRED'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pb_relay_identity_guard ON public.pb_relays;
CREATE TRIGGER pb_relay_identity_guard BEFORE INSERT OR UPDATE ON public.pb_relays FOR EACH ROW EXECUTE FUNCTION public.pb_guard_relay_write();

CREATE OR REPLACE FUNCTION public.pb_media_cleanup_paths(p_job_id uuid,p_lease_token uuid)
RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_job public.pb_media_jobs; v_intent public.pb_upload_intents; v_paths text[]:=ARRAY[]::text[]; v_n integer; v_partner uuid;
BEGIN
  PERFORM public.pb_require_service();
  SELECT * INTO v_job FROM public.pb_media_jobs WHERE id=p_job_id FOR UPDATE;
  IF v_job.id IS NULL OR v_job.status<>'running' OR v_job.lease_token IS DISTINCT FROM p_lease_token OR v_job.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'PB_STALE_LEASE'; END IF;
  IF v_job.kind='upload_cleanup' THEN
    SELECT * INTO v_intent FROM public.pb_upload_intents WHERE id=(v_job.snapshot->>'intent_id')::uuid FOR UPDATE;
    IF v_intent.id IS NULL OR v_intent.status<>'failed' OR v_intent.owner<>v_job.owner
      OR NOT(v_job.snapshot->>'storage_path'=ANY(v_intent.paths)) THEN RAISE EXCEPTION 'PB_CLEANUP_PROVENANCE_REQUIRED'; END IF;
    IF coalesce((v_job.snapshot->>'generation')::integer,1)<>v_intent.generation THEN RAISE EXCEPTION 'PB_CLEANUP_GENERATION_MISMATCH'; END IF;
    IF public.pb_upload_has_reference(v_intent) THEN RETURN v_paths; END IF;
    RETURN ARRAY[v_job.snapshot->>'storage_path'];
  ELSIF v_job.kind='relay_cleanup' THEN
    IF EXISTS(SELECT 1 FROM public.pb_relays WHERE id=v_job.source_id) THEN RETURN v_paths; END IF;
    IF (v_job.snapshot->>'shots')::integer NOT BETWEEN 1 AND 4 OR v_job.snapshot->>'initiator'<>v_job.owner::text THEN RAISE EXCEPTION 'PB_CLEANUP_PROVENANCE_REQUIRED'; END IF;
    v_partner:=(v_job.snapshot->>'partner')::uuid;
    IF v_partner IS NOT NULL AND v_job.snapshot->>'lifecycle_verified' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'PB_CLEANUP_PROVENANCE_REQUIRED'; END IF;
    FOR v_n IN 0..(v_job.snapshot->>'shots')::integer-1 LOOP
      v_paths:=array_append(v_paths,v_job.owner::text || '/relay-' || v_job.source_id || '/A-' || v_n || '.jpg');
      IF v_partner IS NOT NULL THEN v_paths:=array_append(v_paths,v_partner::text || '/relay-' || v_job.source_id || '/B-' || v_n || '.jpg'); END IF;
    END LOOP;
    RETURN v_paths;
  END IF;
  RAISE EXCEPTION 'PB_INVALID_OPERATION';
END;
$$;

REVOKE ALL ON FUNCTION public.pb_require_service(),public.pb_queue_media_job(text,text,uuid,uuid,text,jsonb),
  public.pb_guard_strip_write(),public.pb_guard_consumed_object(),public.pb_capture_strip_delete(),public.pb_capture_relay_delete(),
  public.pb_upload_has_reference(public.pb_upload_intents),public.pb_resolve_upload(uuid,boolean),public.pb_guard_upload_reference(),public.pb_guard_relay_write(),public.pb_guard_upload_object()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.pb_lifecycle_capabilities(),public.pb_configure_lifecycle(text),
  public.pb_enqueue_strip_operation(uuid,text,uuid),public.pb_enqueue_media_job(text,text,uuid,text,jsonb),
  public.pb_claim_media_jobs(uuid,integer,integer,uuid),public.pb_checkpoint_media_job(uuid,uuid,text,jsonb),public.pb_finish_media_job(uuid,uuid,text,text,integer),
  public.pb_acquire_job_lease(text,uuid,integer),public.pb_release_job_lease(text,uuid),public.pb_record_reminder_delivery(uuid,timestamptz,text),
  public.pb_register_upload(uuid,uuid,text,text[]),public.pb_finish_upload(uuid,boolean,integer),public.pb_enqueue_expired_uploads(integer),public.pb_media_cleanup_paths(uuid,uuid),
  public.pb_update_media_strip(uuid,uuid,jsonb),public.pb_delete_media_strip(uuid,uuid),public.pb_retry_media_job(uuid),public.pb_discover_retention(integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pb_lifecycle_capabilities() TO anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pb_enqueue_strip_operation(uuid,text,uuid),public.pb_register_upload(uuid,uuid,text,text[]),public.pb_finish_upload(uuid,boolean,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pb_configure_lifecycle(text),public.pb_enqueue_media_job(text,text,uuid,text,jsonb),
  public.pb_claim_media_jobs(uuid,integer,integer,uuid),public.pb_checkpoint_media_job(uuid,uuid,text,jsonb),public.pb_finish_media_job(uuid,uuid,text,text,integer),
  public.pb_acquire_job_lease(text,uuid,integer),public.pb_release_job_lease(text,uuid),public.pb_record_reminder_delivery(uuid,timestamptz,text),
  public.pb_enqueue_expired_uploads(integer),public.pb_media_cleanup_paths(uuid,uuid),
  public.pb_update_media_strip(uuid,uuid,jsonb),public.pb_delete_media_strip(uuid,uuid),public.pb_retry_media_job(uuid),public.pb_discover_retention(integer) TO service_role;

COMMIT;
