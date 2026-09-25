BEGIN;
CREATE OR REPLACE FUNCTION public.pb_event_guestbook_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_event_require_service(); RETURN '{"version":1,"messageCharacters":500,"signatureCharacters":80,"textBytes":4096,"receipts":32,"missions":6,"pageItems":25}'::jsonb; END $$;
REVOKE ALL ON FUNCTION public.pb_event_guestbook_capabilities() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pb_event_guestbook_capabilities() TO service_role;
CREATE TABLE IF NOT EXISTS public.pb_event_mission_catalogue(id text PRIMARY KEY,version integer NOT NULL CHECK(version=1),label text NOT NULL CHECK(length(label)<=200));
INSERT INTO public.pb_event_mission_catalogue VALUES
 ('same-energy-1',1,'Everyone picks their version of a calm face.'),
 ('same-energy-2',1,'The director names a happy mood. Show your version.'),
 ('same-energy-3',1,'Now try an exaggerated serious face, or a small thoughtful look.'),
 ('same-energy-4',1,'Drop the act and finish with a natural smile.'),
 ('album-cover-1',1,'Your debut cover: face the camera with quiet confidence.'),
 ('album-cover-2',1,'The acoustic edition: soften your expression and relax.') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.pb_event_missions(event_id uuid PRIMARY KEY REFERENCES public.pb_events ON DELETE CASCADE,revision integer NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 1000000),mission_ids text[] NOT NULL DEFAULT '{}' CHECK(cardinality(mission_ids)<=6),ends_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS public.pb_event_guestbook(
 submission_id uuid PRIMARY KEY REFERENCES public.pb_event_submissions ON DELETE CASCADE,event_id uuid NOT NULL REFERENCES public.pb_events ON DELETE CASCADE,
 revision integer NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 1000000),message text NOT NULL DEFAULT '' CHECK(length(message)<=500),signature text NOT NULL DEFAULT '' CHECK(length(signature)<=80),
 withdrawn boolean NOT NULL DEFAULT false,mission jsonb, CHECK(octet_length(message)+octet_length(signature)<=4096),CHECK(NOT withdrawn OR message='' AND signature='')
);
CREATE TABLE IF NOT EXISTS public.pb_event_guestbook_requests(submission_id uuid NOT NULL REFERENCES public.pb_event_guestbook ON DELETE CASCADE,request_id uuid NOT NULL,fingerprint text NOT NULL CHECK(length(fingerprint)=64),accepted_revision integer NOT NULL,PRIMARY KEY(submission_id,request_id));
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['pb_event_mission_catalogue','pb_event_missions','pb_event_guestbook','pb_event_guestbook_requests'] LOOP EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t); END LOOP; END $$;

CREATE OR REPLACE FUNCTION public.pb_event_missions_json(p_event uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('version',1,'eventId',e.id,'revision',coalesce(m.revision,0),'missionIds',coalesce(m.mission_ids,'{}'::text[]),'endsAt',coalesce(m.ends_at,e.contribution_closes_at),'locked',e.first_accepted_at IS NOT NULL OR e.status='deleted' OR e.expires_at<=clock_timestamp()) FROM public.pb_events e LEFT JOIN public.pb_event_missions m ON m.event_id=e.id WHERE e.id=p_event
$$;
CREATE OR REPLACE FUNCTION public.pb_event_missions_host(p_actor uuid,p_event uuid,p_revision integer DEFAULT NULL,p_ids text[] DEFAULT NULL,p_end timestamptz DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events; m public.pb_event_missions;
BEGIN
 PERFORM public.pb_event_require_service(); PERFORM public.pb_event_require_actor(p_event,p_actor,p_revision IS NOT NULL);
 SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE;
 IF e.status='deleted' OR e.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
 IF p_revision IS NOT NULL THEN
  IF p_revision<0 OR p_ids IS NULL OR cardinality(p_ids)>6 OR cardinality(p_ids)<>(SELECT count(DISTINCT x) FROM unnest(p_ids) x) OR EXISTS(SELECT 1 FROM unnest(p_ids) x WHERE NOT EXISTS(SELECT 1 FROM public.pb_event_mission_catalogue WHERE id=x)) OR p_end IS NULL OR p_end<=e.starts_at OR p_end>e.contribution_closes_at THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  INSERT INTO public.pb_event_missions(event_id,ends_at) VALUES(e.id,e.contribution_closes_at) ON CONFLICT DO NOTHING;
  SELECT * INTO m FROM public.pb_event_missions WHERE event_id=e.id FOR UPDATE;
  IF (m.mission_ids,m.ends_at) IS DISTINCT FROM (p_ids,p_end) THEN
   IF e.first_accepted_at IS NOT NULL OR m.revision<>p_revision THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
   UPDATE public.pb_event_missions SET mission_ids=p_ids,ends_at=p_end,revision=revision+1 WHERE event_id=e.id;
  ELSIF m.revision NOT IN (p_revision,p_revision+1) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 ELSIF p_ids IS NOT NULL OR p_end IS NOT NULL THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 RETURN public.pb_event_missions_json(e.id);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_guestbook_author(p_event uuid,p_hash text,p_kind text,p_submission uuid,p_guest uuid DEFAULT NULL) RETURNS public.pb_event_submissions LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.pb_event_tokens; s public.pb_event_submissions;
BEGIN
 PERFORM public.pb_event_require_service(); IF p_kind NOT IN ('contribute','receipt') OR p_kind IS NULL THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 t=public.pb_event_token(p_event,p_hash,p_kind,CASE WHEN p_kind='receipt' THEN p_submission ELSE NULL END);
 IF p_kind='contribute' AND t.guest_id IS DISTINCT FROM p_guest THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 SELECT * INTO s FROM public.pb_event_submissions WHERE event_id=p_event AND id=p_submission AND guest_id=t.guest_id;
 IF s.id IS NULL THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF; RETURN s;
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_guestbook_json(p_event uuid,p_submission uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.pb_event_submissions; n public.pb_event_guestbook;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.pb_events WHERE id=p_event AND status<>'deleted' AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 SELECT * INTO s FROM public.pb_event_submissions WHERE event_id=p_event AND id=p_submission;
 IF s.id IS NULL OR s.state IN ('deleted','expired') OR s.promised_expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM public.pb_event_publication_grants WHERE submission_id=s.id AND submission_consent) OR EXISTS(SELECT 1 FROM public.pb_event_publication_grants g JOIN public.pb_event_guests v ON v.id=g.guest_id WHERE g.submission_id=s.id AND (NOT g.submission_consent OR v.revoked)) THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 SELECT * INTO n FROM public.pb_event_guestbook WHERE submission_id=s.id;
 RETURN jsonb_build_object('version',1,'eventId',p_event,'submissionId',s.id,'revision',coalesce(n.revision,0),'message',coalesce(n.message,''),'signature',coalesce(n.signature,''),'withdrawn',coalesce(n.withdrawn,false),'mission',n.mission,'missionCompleted',n.mission IS NOT NULL AND s.state='ready');
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_guestbook_read(p_event uuid,p_hash text,p_kind text,p_submission uuid,p_guest uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_event_guestbook_author(p_event,p_hash,p_kind,p_submission,p_guest); RETURN public.pb_event_guestbook_json(p_event,p_submission); END $$;
CREATE OR REPLACE FUNCTION public.pb_event_missions_guest(p_event uuid,p_hash text,p_guest uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.pb_event_tokens;
BEGIN t=public.pb_event_token(p_event,p_hash,'contribute'); IF t.guest_id IS DISTINCT FROM p_guest THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF; RETURN public.pb_event_missions_json(p_event); END $$;

CREATE OR REPLACE FUNCTION public.pb_event_reserve_mission(p_event uuid,p_hash text,p_guest uuid,p_submission uuid,p_request uuid,p_receipt_hash text,p_consent jsonb,p_mission text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.pb_event_tokens; e public.pb_events; n public.pb_event_guestbook; mission jsonb; result jsonb;
BEGIN
 t=public.pb_event_token(p_event,p_hash,'contribute'); IF t.guest_id IS DISTINCT FROM p_guest THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pb-event-admission-v1',0));
 SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE;
 SELECT * INTO n FROM public.pb_event_guestbook WHERE submission_id=p_submission;
 IF n.submission_id IS NOT NULL THEN
  IF n.event_id<>p_event OR n.mission->>'id' IS DISTINCT FROM p_mission THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.pb_event_submissions WHERE id=p_submission) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
  IF p_mission IS NOT NULL THEN
   SELECT jsonb_build_object('id',c.id,'version',c.version,'label',c.label) INTO mission FROM public.pb_event_mission_catalogue c JOIN public.pb_event_missions m ON c.id=ANY(m.mission_ids) WHERE m.event_id=p_event AND c.id=p_mission AND m.ends_at>clock_timestamp() AND m.ends_at<=e.contribution_closes_at;
   IF mission IS NULL THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
  END IF;
 END IF;
 result=public.pb_event_reserve(p_event,p_hash,p_submission,p_request,p_receipt_hash,ARRAY[p_guest],p_consent);
 INSERT INTO public.pb_event_guestbook(submission_id,event_id,mission) VALUES(p_submission,p_event,mission) ON CONFLICT DO NOTHING;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_guestbook_save(p_event uuid,p_hash text,p_guest uuid,p_submission uuid,p_request uuid,p_revision integer,p_message text,p_signature text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.pb_event_submissions; n public.pb_event_guestbook; prior public.pb_event_guestbook_requests; fingerprint text; accepted integer;
BEGIN
 s=public.pb_event_guestbook_author(p_event,p_hash,'contribute',p_submission,p_guest);
 PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE;
 PERFORM public.pb_event_guestbook_author(p_event,p_hash,'contribute',p_submission,p_guest);
 PERFORM public.pb_event_guestbook_json(p_event,p_submission);
 IF p_request IS NULL OR p_revision IS NULL OR p_revision<0 OR p_message IS NULL OR p_signature IS NULL OR length(p_message)>500 OR length(p_signature)>80 OR octet_length(p_message)+octet_length(p_signature)>4096 OR p_message ~ '[\x01-\x08\x0b-\x1f\x7f-\x9f]' OR p_signature ~ '[\x01-\x1f\x7f-\x9f]' THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 INSERT INTO public.pb_event_guestbook(submission_id,event_id) VALUES(s.id,p_event) ON CONFLICT DO NOTHING;
 SELECT * INTO n FROM public.pb_event_guestbook WHERE submission_id=s.id FOR UPDATE;
 fingerprint=encode(sha256(convert_to(jsonb_build_array(p_revision,p_message,p_signature)::text,'UTF8')),'hex');
 SELECT * INTO prior FROM public.pb_event_guestbook_requests WHERE submission_id=s.id AND request_id=p_request;
 IF prior.request_id IS NOT NULL THEN
  IF prior.fingerprint<>fingerprint THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF; accepted=prior.accepted_revision;
 ELSE
  IF n.revision<>p_revision THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
  IF (SELECT count(*) FROM public.pb_event_guestbook_requests WHERE submission_id=s.id)>=32 THEN RAISE EXCEPTION 'PB_EVENT_CAPACITY'; END IF;
  UPDATE public.pb_event_guestbook SET message=p_message,signature=p_signature,withdrawn=false,revision=revision+1 WHERE submission_id=s.id RETURNING revision INTO accepted;
  INSERT INTO public.pb_event_guestbook_requests VALUES(s.id,p_request,fingerprint,accepted);
 END IF;
 RETURN jsonb_build_object('acceptedRequestId',p_request,'acceptedRevision',accepted,'current',public.pb_event_guestbook_json(p_event,s.id));
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_guestbook_withdraw(p_event uuid,p_hash text,p_kind text,p_submission uuid,p_guest uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.pb_event_submissions;
BEGIN
 s=public.pb_event_guestbook_author(p_event,p_hash,p_kind,p_submission,p_guest); PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE;
 PERFORM public.pb_event_guestbook_author(p_event,p_hash,p_kind,p_submission,p_guest);
 INSERT INTO public.pb_event_guestbook(submission_id,event_id,withdrawn) VALUES(s.id,p_event,true) ON CONFLICT(submission_id) DO UPDATE SET message='',signature='',withdrawn=true,revision=CASE WHEN pb_event_guestbook.withdrawn THEN pb_event_guestbook.revision ELSE least(pb_event_guestbook.revision+1,1000000) END;
 RETURN jsonb_build_object('submissionId',s.id,'withdrawn',true);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_guestbook_host(p_actor uuid,p_event uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 25) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.pb_events; s record; entries jsonb='[]'; note jsonb; last_id uuid; more boolean;
BEGIN
 PERFORM public.pb_event_require_service(); PERFORM public.pb_event_require_actor(p_event,p_actor,false); SELECT * INTO e FROM public.pb_events WHERE id=p_event;
 IF e.status='deleted' OR e.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 FOR s IN SELECT submission_id FROM public.pb_event_guestbook WHERE event_id=p_event AND (p_after IS NULL OR submission_id>p_after) ORDER BY submission_id LIMIT p_limit LOOP
  BEGIN note=public.pb_event_guestbook_json(p_event,s.submission_id); EXCEPTION WHEN SQLSTATE 'P0001' THEN note=NULL; END;
  entries=entries||jsonb_build_array(jsonb_build_object('submissionId',s.submission_id,'note',note,'unavailable',note IS NULL)); last_id=s.submission_id;
 END LOOP;
 SELECT EXISTS(SELECT 1 FROM public.pb_event_guestbook WHERE event_id=p_event AND submission_id>last_id) INTO more;
 RETURN jsonb_build_object('version',1,'entries',entries,'nextCursor',CASE WHEN more THEN last_id ELSE NULL END);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_guestbook_scrub() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.state IN ('deleted','expired') AND OLD.state NOT IN ('deleted','expired') THEN UPDATE public.pb_event_guestbook SET message='',signature='',withdrawn=true,revision=least(revision+1,1000000) WHERE submission_id=NEW.id; END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pb_event_guestbook_scrub ON public.pb_event_submissions;
CREATE TRIGGER pb_event_guestbook_scrub AFTER UPDATE OF state ON public.pb_event_submissions FOR EACH ROW EXECUTE FUNCTION public.pb_event_guestbook_scrub();
DO $$ DECLARE r record; BEGIN FOR r IN SELECT oid::regprocedure f FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('pb_event_missions_json','pb_event_missions_host','pb_event_guestbook_author','pb_event_guestbook_json','pb_event_guestbook_read','pb_event_missions_guest','pb_event_reserve_mission','pb_event_guestbook_save','pb_event_guestbook_withdraw','pb_event_guestbook_host','pb_event_guestbook_scrub') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.f); END LOOP; END $$;
GRANT EXECUTE ON FUNCTION public.pb_event_missions_host(uuid,uuid,integer,text[],timestamptz),public.pb_event_guestbook_read(uuid,text,text,uuid,uuid),public.pb_event_missions_guest(uuid,text,uuid),public.pb_event_reserve_mission(uuid,text,uuid,uuid,uuid,text,jsonb,text),public.pb_event_guestbook_save(uuid,text,uuid,uuid,uuid,integer,text,text),public.pb_event_guestbook_withdraw(uuid,text,text,uuid,uuid),public.pb_event_guestbook_host(uuid,uuid,uuid,integer) TO service_role;
CREATE TABLE IF NOT EXISTS public.pb_event_export_notes(export_id uuid NOT NULL REFERENCES public.pb_event_exports ON DELETE CASCADE,generation integer NOT NULL,item_index integer NOT NULL CHECK(item_index BETWEEN 0 AND 99),revision integer,PRIMARY KEY(export_id,generation,item_index));
ALTER TABLE public.pb_event_export_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pb_event_export_notes FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 IF to_regprocedure('public.pb_event_export_create_before_guestbook(uuid,uuid,uuid,uuid,integer)') IS NULL THEN ALTER FUNCTION public.pb_event_export_create(uuid,uuid,uuid,uuid,integer) RENAME TO pb_event_export_create_before_guestbook; END IF;
 IF to_regprocedure('public.pb_event_export_page_before_guestbook(uuid,uuid,uuid,integer,integer,integer)') IS NULL THEN ALTER FUNCTION public.pb_event_export_page(uuid,uuid,uuid,integer,integer,integer) RENAME TO pb_event_export_page_before_guestbook; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_export_create(p_actor uuid,p_event uuid,p_export uuid,p_after uuid DEFAULT NULL,p_generation integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE prior public.pb_event_exports; result jsonb; entry jsonb;
BEGIN
 PERFORM public.pb_event_export_owner(p_actor,p_event); PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE;
 SELECT * INTO prior FROM public.pb_event_exports WHERE id=p_export;
 result=public.pb_event_export_create_before_guestbook(p_actor,p_event,p_export,p_after,p_generation);
 IF prior.id IS NULL OR prior.retired THEN
  DELETE FROM public.pb_event_export_notes WHERE export_id=p_export;
  FOR entry IN SELECT jsonb_array_elements(manifest->'entries') FROM public.pb_event_exports WHERE id=p_export LOOP
   INSERT INTO public.pb_event_export_notes VALUES(p_export,p_generation,(entry->>'index')::integer,(SELECT revision FROM public.pb_event_guestbook WHERE submission_id=(entry->>'submissionId')::uuid));
  END LOOP;
 END IF; RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_export_page(p_actor uuid,p_event uuid,p_export uuid,p_generation integer,p_after integer DEFAULT -1,p_limit integer DEFAULT 10) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb; entry jsonb; entries jsonb='[]'; n public.pb_event_export_notes;
BEGIN
 result=public.pb_event_export_page_before_guestbook(p_actor,p_event,p_export,p_generation,p_after,p_limit);
 FOR entry IN SELECT jsonb_array_elements(result->'entries') LOOP
  SELECT * INTO n FROM public.pb_event_export_notes WHERE export_id=p_export AND generation=p_generation AND item_index=(entry->>'index')::integer;
  IF FOUND THEN entry=entry||jsonb_build_object('guestbookRevision',n.revision); END IF; entries=entries||jsonb_build_array(entry);
 END LOOP; RETURN result||jsonb_build_object('entries',entries);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_export_guestbook(p_actor uuid,p_event uuid,p_export uuid,p_generation integer,p_index integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE x public.pb_event_exports; ref public.pb_event_export_notes; entry jsonb; note jsonb; state text='not_collected';
BEGIN
 PERFORM public.pb_event_export_owner(p_actor,p_event); SELECT * INTO x FROM public.pb_event_exports WHERE id=p_export AND event_id=p_event AND generation=p_generation AND NOT retired;
 IF x.id IS NULL OR p_index IS NULL OR p_index NOT BETWEEN 0 AND 99 THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 entry=x.manifest->'entries'->p_index; IF entry IS NULL THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 SELECT * INTO ref FROM public.pb_event_export_notes WHERE export_id=p_export AND generation=p_generation AND item_index=p_index;
 IF ref.revision IS NOT NULL THEN
  state='unavailable';
  BEGIN note=public.pb_event_guestbook_json(p_event,(entry->>'submissionId')::uuid); EXCEPTION WHEN SQLSTATE 'P0001' THEN note=NULL; END;
  IF note IS NOT NULL AND (note->>'revision')::integer=ref.revision AND note->'withdrawn'='false'::jsonb THEN state='available'; ELSE note=NULL; END IF;
 END IF;
 RETURN jsonb_build_object('submissionId',entry->>'submissionId','revision',ref.revision,'status',state,'note',note);
END $$;
REVOKE ALL ON FUNCTION public.pb_event_export_create_before_guestbook(uuid,uuid,uuid,uuid,integer),public.pb_event_export_page_before_guestbook(uuid,uuid,uuid,integer,integer,integer),public.pb_event_export_create(uuid,uuid,uuid,uuid,integer),public.pb_event_export_page(uuid,uuid,uuid,integer,integer,integer),public.pb_event_export_guestbook(uuid,uuid,uuid,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pb_event_export_create(uuid,uuid,uuid,uuid,integer),public.pb_event_export_page(uuid,uuid,uuid,integer,integer,integer),public.pb_event_export_guestbook(uuid,uuid,uuid,integer,integer) TO service_role;
COMMIT;
