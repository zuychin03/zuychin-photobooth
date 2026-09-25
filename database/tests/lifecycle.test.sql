\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION public.pb_test_assert(value boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'assertion failed: %',label; END IF; END $$;
CREATE FUNCTION public.pb_test_error(query text,expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE query;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%' || expected || '%' THEN RAISE EXCEPTION 'expected %, got %',expected,SQLERRM; END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'expected rejection: %',expected;
END $$;
INSERT INTO auth.users(id,email) VALUES
 ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','a@example.invalid'),
 ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','b@example.invalid'),
 ('cccccccc-cccc-cccc-cccc-cccccccccccc','c@example.invalid');
INSERT INTO public.pb_couples(id,member_a,member_b) VALUES('dddddddd-dddd-dddd-dddd-dddddddddddd','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
INSERT INTO storage.objects(bucket_id,name,metadata)
 SELECT 'photobooth-strips',owner || '/' || ('10000000-0000-0000-0000-' || lpad(n::text,12,'0')) || '.png',
 CASE WHEN n=24 THEN '{}'::jsonb ELSE jsonb_build_object('size',CASE WHEN n=23 THEN 16777217 ELSE 1000 END) END
 FROM unnest(ARRAY['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','cccccccc-cccc-cccc-cccc-cccccccccccc']) AS owner CROSS JOIN generate_series(1,25) AS n;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',true);
SELECT public.pb_test_assert((public.pb_lifecycle_capabilities()->>'ready')::boolean=false,'configuration fails closed');
SELECT public.pb_test_error($q$INSERT INTO public.pb_strips(id,owner,couple_id,storage_path) VALUES('10000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dddddddd-dddd-dddd-dddd-dddddddddddd','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/10000000-0000-0000-0000-000000000001.png')$q$,'PB_LIFECYCLE_NOT_CONFIGURED');
SELECT public.pb_test_error($q$SELECT public.pb_configure_lifecycle('UTC')$q$,'permission denied');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT public.pb_configure_lifecycle('Australia/Sydney');
SELECT public.pb_configure_lifecycle('Australia/Sydney');
SELECT public.pb_test_error($q$SELECT public.pb_configure_lifecycle('UTC')$q$,'PB_TIMEZONE_RECONCILIATION_REQUIRED');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT public.pb_test_error($q$INSERT INTO public.pb_strips(id,owner,storage_path) VALUES('10000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/10000000-0000-0000-0000-000000000001.png')$q$,'PB_COUPLE_MISMATCH');
DO $$ DECLARE n integer; sid uuid;
BEGIN FOR n IN 1..10 LOOP
 sid:=('10000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid;
 INSERT INTO public.pb_strips(id,owner,couple_id,storage_path,created_at,layout_id)
 VALUES(sid,auth.uid(),'dddddddd-dddd-dddd-dddd-dddddddddddd',auth.uid()::text || '/' || sid || '.png','2000-01-01','classic');
END LOOP; END $$;
SELECT public.pb_test_assert((SELECT min(created_at)>now()-interval '1 minute' FROM public.pb_strips),'server acceptance timestamp');
SELECT public.pb_test_error($q$UPDATE public.pb_strips SET layout_id='recap'$q$,'permission denied');
SELECT public.pb_test_error($q$UPDATE public.pb_strips SET owner='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'$q$,'permission denied');
SELECT public.pb_test_error($q$UPDATE public.pb_strips SET couple_id=NULL,created_at='2000-01-01',purged=true$q$,'permission denied');
SELECT public.pb_test_error($q$UPDATE public.pb_strips SET kept=true,cloudinary_public_id='foreign/private',cloudinary_url='https://example.invalid/private',archive_verified_at=now()$q$,'permission denied');
UPDATE public.pb_strips SET caption='caption remains editable' WHERE id='10000000-0000-0000-0000-000000000001';
SELECT public.pb_test_error($q$INSERT INTO public.pb_strips(id,owner,couple_id,storage_path) VALUES('10000000-0000-0000-0000-000000000011','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dddddddd-dddd-dddd-dddd-dddddddddddd','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/10000000-0000-0000-0000-000000000011.png')$q$,'PB_WEEKLY_QUOTA_EXCEEDED');
SELECT set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',true);
SELECT public.pb_test_error($q$INSERT INTO public.pb_strips(id,owner,couple_id,storage_path) VALUES('10000000-0000-0000-0000-000000000012','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','dddddddd-dddd-dddd-dddd-dddddddddddd','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/10000000-0000-0000-0000-000000000012.png')$q$,'PB_WEEKLY_QUOTA_EXCEEDED');
SELECT public.pb_test_assert((SELECT count(*)=10 FROM public.pb_strips),'legacy partner SELECT unchanged');
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',true);
INSERT INTO public.pb_strips(id,owner,couple_id,storage_path,layout_id) VALUES('10000000-0000-0000-0000-000000000011',auth.uid(),'dddddddd-dddd-dddd-dddd-dddddddddddd',auth.uid()::text || '/10000000-0000-0000-0000-000000000011.png','recap');
SELECT public.pb_test_error($q$INSERT INTO public.pb_strips(id,owner,couple_id,storage_path,layout_id) VALUES('10000000-0000-0000-0000-000000000012','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dddddddd-dddd-dddd-dddd-dddddddddddd','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/10000000-0000-0000-0000-000000000012.png','recap')$q$,'PB_WEEKLY_QUOTA_EXCEEDED');
DELETE FROM public.pb_strips WHERE id='10000000-0000-0000-0000-000000000001';
SELECT public.pb_test_error($q$INSERT INTO public.pb_strips(id,owner,couple_id,storage_path) VALUES('10000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dddddddd-dddd-dddd-dddd-dddddddddddd','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/10000000-0000-0000-0000-000000000001.png')$q$,'PB_STRIP_ID_ALREADY_CONSUMED');
SELECT public.pb_test_error($q$INSERT INTO public.pb_strips(id,owner,couple_id,storage_path) VALUES('10000000-0000-0000-0000-000000000012','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','dddddddd-dddd-dddd-dddd-dddddddddddd','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/10000000-0000-0000-0000-000000000012.png')$q$,'PB_WEEKLY_QUOTA_EXCEEDED');
SELECT public.pb_test_error($q$SELECT * FROM public.pb_strip_quota_ledger$q$,'permission denied');
SELECT public.pb_test_error($q$SELECT public.pb_claim_media_jobs(gen_random_uuid(),1,60)$q$,'permission denied');
SELECT public.pb_enqueue_strip_operation('10000000-0000-0000-0000-000000000002','archive','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
SELECT public.pb_enqueue_strip_operation('10000000-0000-0000-0000-000000000002','archive','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
SELECT public.pb_test_assert((SELECT kept FROM public.pb_strips WHERE id='10000000-0000-0000-0000-000000000002'),'queued keep protects original');
SELECT set_config('request.jwt.claim.sub','cccccccc-cccc-cccc-cccc-cccccccccccc',true);
SELECT public.pb_test_assert((SELECT count(*)=0 FROM public.pb_strips),'foreign audience denied');
SELECT public.pb_test_error($q$SELECT public.pb_enqueue_strip_operation('10000000-0000-0000-0000-000000000002','delete',gen_random_uuid())$q$,'PB_OWNER_REQUIRED');
INSERT INTO public.pb_strips(id,owner,storage_path,media_bytes) VALUES('10000000-0000-0000-0000-000000000020',auth.uid(),auth.uid()::text || '/10000000-0000-0000-0000-000000000020.png',1);
SELECT public.pb_test_assert((SELECT media_bytes=1000 FROM public.pb_strips WHERE id='10000000-0000-0000-0000-000000000020'),'guest byte claim ignored');
SELECT public.pb_test_error($q$INSERT INTO public.pb_strips(id,owner,storage_path) VALUES('10000000-0000-0000-0000-000000000023','cccccccc-cccc-cccc-cccc-cccccccccccc','cccccccc-cccc-cccc-cccc-cccccccccccc/10000000-0000-0000-0000-000000000023.png')$q$,'PB_OBJECT_TOO_LARGE');
SELECT public.pb_test_error($q$INSERT INTO public.pb_strips(id,owner,storage_path) VALUES('10000000-0000-0000-0000-000000000024','cccccccc-cccc-cccc-cccc-cccccccccccc','cccccccc-cccc-cccc-cccc-cccccccccccc/10000000-0000-0000-0000-000000000024.png')$q$,'PB_OBJECT_SIZE_UNVERIFIED');
SELECT public.pb_register_upload('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1','10000000-0000-0000-0000-000000000021','strip',ARRAY[auth.uid()::text || '/10000000-0000-0000-0000-000000000021.png']);
INSERT INTO public.pb_strips(id,owner,storage_path) VALUES('10000000-0000-0000-0000-000000000021',auth.uid(),auth.uid()::text || '/10000000-0000-0000-0000-000000000021.png');
SELECT public.pb_test_assert((public.pb_finish_upload('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1',false,1)).status='complete','ambiguous committed upload is preserved');
SELECT public.pb_register_upload('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2','10000000-0000-0000-0000-000000000022','strip',ARRAY[auth.uid()::text || '/10000000-0000-0000-0000-000000000022.png']);
SELECT public.pb_finish_upload('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2',false,1);
SELECT public.pb_test_error($q$INSERT INTO public.pb_strips(id,owner,storage_path) VALUES('10000000-0000-0000-0000-000000000022','cccccccc-cccc-cccc-cccc-cccccccccccc','cccccccc-cccc-cccc-cccc-cccccccccccc/10000000-0000-0000-0000-000000000022.png')$q$,'PB_UPLOAD_EXPIRED');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT public.pb_test_error($q$UPDATE storage.objects SET metadata='{"size":2000}' WHERE name='cccccccc-cccc-cccc-cccc-cccccccccccc/10000000-0000-0000-0000-000000000022.png'$q$,'PB_UPLOAD_EXPIRED');
SELECT public.pb_test_assert((SELECT count(*)=1 FROM public.pb_media_jobs WHERE idempotency_key='request:eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),'idempotent queue');
SELECT public.pb_test_assert((SELECT snapshot->>'storage_path' IS NOT NULL FROM public.pb_media_jobs WHERE idempotency_key='strip-delete:10000000-0000-0000-0000-000000000001'),'legacy delete durable provenance');
SELECT public.pb_test_assert((SELECT count(*)=11 AND sum(charged_bytes)=11000 FROM public.pb_strip_quota_ledger WHERE owner='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),'quota survives deletion with verified bytes');
SELECT public.pb_test_assert(public.pb_acquire_job_lease('reminders','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',60),'lease acquired');
SELECT public.pb_test_assert(NOT public.pb_acquire_job_lease('reminders','ffffffff-ffff-ffff-ffff-ffffffffffff',60),'other lease denied');
SELECT public.pb_test_assert(public.pb_acquire_job_lease('reminders','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',60),'same lease renewed');
SELECT public.pb_test_assert(NOT public.pb_release_job_lease('reminders','ffffffff-ffff-ffff-ffff-ffffffffffff'),'wrong release denied');
SELECT public.pb_record_reminder_delivery('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',now(),'email');
SELECT public.pb_record_reminder_delivery('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',now(),'email');
SELECT public.pb_test_assert((SELECT count(*)=1 FROM public.pb_reminder_deliveries),'delivery checkpoint idempotent');
DO $$ DECLARE j public.pb_media_jobs; rejected boolean:=false;
BEGIN
 SELECT * INTO j FROM public.pb_claim_media_jobs('ffffffff-ffff-ffff-ffff-ffffffffffff',1,60,(SELECT id FROM public.pb_media_jobs WHERE idempotency_key='request:eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'));
 PERFORM public.pb_test_assert(j.id IS NOT NULL,'specific job claimed');
 BEGIN PERFORM public.pb_checkpoint_media_job(j.id,gen_random_uuid(),'uploaded','{}'); EXCEPTION WHEN OTHERS THEN rejected:=SQLERRM LIKE '%PB_STALE_LEASE%'; END;
 PERFORM public.pb_test_assert(rejected,'stale fencing token rejected');
 PERFORM public.pb_test_error(format('SELECT public.pb_finish_media_job(%L,%L,''complete'')',j.id,j.lease_token),'PB_INCOMPLETE_JOB');
 PERFORM public.pb_checkpoint_media_job(j.id,j.lease_token,'uploaded','{"cloudinary_public_id":"test/archive","cloudinary_url":"https://example.invalid/archive"}');
 PERFORM public.pb_test_error(format('SELECT public.pb_checkpoint_media_job(%L,%L,''reference_verified'',''{"archive_verified":true}'')',j.id,j.lease_token),'PB_ARCHIVE_NOT_DURABLE');
 PERFORM public.pb_update_media_strip(j.id,j.lease_token,'{"cloudinary_public_id":"test/archive","cloudinary_url":"https://example.invalid/archive","archive_verified_at":"2026-01-01T00:00:00Z"}');
 PERFORM public.pb_checkpoint_media_job(j.id,j.lease_token,'reference_verified','{"archive_verified":true}');
 PERFORM public.pb_checkpoint_media_job(j.id,j.lease_token,'complete','{}');
 PERFORM public.pb_finish_media_job(j.id,j.lease_token,'complete');
END $$;
DO $$ DECLARE j public.pb_media_jobs; paths text[];
BEGIN
 SELECT * INTO j FROM public.pb_claim_media_jobs('ffffffff-ffff-ffff-ffff-ffffffffffff',1,60,(SELECT id FROM public.pb_media_jobs WHERE snapshot->>'intent_id'='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2'));
 paths:=public.pb_media_cleanup_paths(j.id,j.lease_token);
 PERFORM public.pb_test_assert(paths=ARRAY['cccccccc-cccc-cccc-cccc-cccccccccccc/10000000-0000-0000-0000-000000000022.png'],'cleanup uses exact recorded path');
 DELETE FROM storage.objects WHERE bucket_id='photobooth-strips' AND name=ANY(paths);
 PERFORM public.pb_checkpoint_media_job(j.id,j.lease_token,'storage_removed','{"storage_removed":true}');
 PERFORM public.pb_finish_media_job(j.id,j.lease_token,'complete');
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub','cccccccc-cccc-cccc-cccc-cccccccccccc',true);
SELECT public.pb_test_assert((public.pb_register_upload('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2','10000000-0000-0000-0000-000000000022','strip',ARRAY[auth.uid()::text || '/10000000-0000-0000-0000-000000000022.png'])).generation=2,'cleaned failed intent safely rearms');
SELECT public.pb_test_error($q$SELECT public.pb_finish_upload('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2',false,1)$q$,'PB_UPLOAD_GENERATION_MISMATCH');
RESET ROLE;
SELECT 'P1 lifecycle SQL assertions passed' AS result;
ROLLBACK;
