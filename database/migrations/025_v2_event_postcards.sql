BEGIN;
CREATE TABLE IF NOT EXISTS public.pb_event_postcard_tickets (
 event_id uuid NOT NULL REFERENCES public.pb_events,guest_id uuid NOT NULL,postcard_id uuid NOT NULL,request_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),guest_hash text NOT NULL CHECK(guest_hash ~ '^[a-f0-9]{64}$'),expires_at timestamptz NOT NULL,
 PRIMARY KEY(event_id,guest_id),FOREIGN KEY(event_id,guest_id) REFERENCES public.pb_event_guests(event_id,id)
);
CREATE TABLE IF NOT EXISTS public.pb_event_postcards (
 id uuid PRIMARY KEY,event_id uuid NOT NULL REFERENCES public.pb_events,submission_id uuid NOT NULL UNIQUE,initiator_guest uuid NOT NULL,
 source jsonb NOT NULL,proof jsonb NOT NULL,design jsonb NOT NULL,design_hash text NOT NULL CHECK(design_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','reserved','candidate','ready','revoked')),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),candidate jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 CHECK(octet_length(design::text)<=65536 AND octet_length(proof::text)<=16384),FOREIGN KEY(event_id,initiator_guest) REFERENCES public.pb_event_guests(event_id,id)
);
CREATE INDEX IF NOT EXISTS pb_event_postcard_source ON public.pb_event_postcards((source->>'kind'),(source->>'id'));
CREATE TABLE IF NOT EXISTS public.pb_event_postcard_people (
 postcard_id uuid NOT NULL REFERENCES public.pb_event_postcards ON DELETE CASCADE,principal_id uuid NOT NULL,role text NOT NULL CHECK(role IN ('A','B','C','D')),
 guest_id uuid,consent boolean NOT NULL DEFAULT false,gallery boolean NOT NULL DEFAULT false,wall boolean NOT NULL DEFAULT false,approved_hash text CHECK(approved_hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(postcard_id,principal_id),UNIQUE(postcard_id,role),UNIQUE(postcard_id,guest_id)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['pb_event_postcard_tickets','pb_event_postcards','pb_event_postcard_people'] LOOP EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t); END LOOP; END $$;

CREATE OR REPLACE FUNCTION public.pb_event_postcard_capabilities() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.pb_event_require_service(); RETURN '{"version":1,"participants":4,"draftsPerEvent":100,"draftsPerSource":100,"ticketSeconds":300,"logicalSeconds":600,"candidateBytes":2000000,"journalEntries":8}'::jsonb; END $$;

CREATE OR REPLACE FUNCTION public.pb_event_postcard_ticket(p_event uuid,p_hash text,p_guest uuid,p_postcard uuid,p_request uuid,p_ticket_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.pb_event_tokens; old public.pb_event_postcard_tickets; e public.pb_events;
BEGIN
 PERFORM public.pb_event_require_service(); SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE; t=public.pb_event_token(p_event,p_hash,'contribute');
 IF t.guest_id IS DISTINCT FROM p_guest THEN RAISE EXCEPTION 'PB_EVENT_IDENTITY_CHANGED'; END IF;
 IF p_postcard IS NULL OR p_request IS NULL OR coalesce(p_ticket_hash,'') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 SELECT * INTO old FROM public.pb_event_postcard_tickets WHERE event_id=p_event AND guest_id=p_guest;
 IF old.request_id=p_request THEN
  IF old.postcard_id<>p_postcard OR old.token_hash<>p_ticket_hash OR old.guest_hash<>p_hash THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 ELSE
  IF e.status<>'open' OR e.contribution_closes_at<=clock_timestamp() OR e.starts_at>clock_timestamp() THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
  INSERT INTO public.pb_event_postcard_tickets VALUES(p_event,p_guest,p_postcard,p_request,p_ticket_hash,p_hash,least(clock_timestamp()+interval '5 minutes',t.expires_at,e.expires_at))
  ON CONFLICT(event_id,guest_id) DO UPDATE SET postcard_id=EXCLUDED.postcard_id,request_id=EXCLUDED.request_id,token_hash=EXCLUDED.token_hash,guest_hash=EXCLUDED.guest_hash,expires_at=EXCLUDED.expires_at;
 END IF;
 SELECT * INTO old FROM public.pb_event_postcard_tickets WHERE event_id=p_event AND guest_id=p_guest;
 IF old.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
 RETURN jsonb_build_object('postcardId',p_postcard,'expiresAt',public.pb_event_publication_instant(old.expires_at));
END $$;



CREATE OR REPLACE FUNCTION public.pb_event_postcard_source(p_source jsonb,p_design jsonb,p_actor uuid,p_room_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE kind text=p_source->>'kind'; source_id uuid=(p_source->>'id')::uuid; self_id uuid; people jsonb='[]'; assets jsonb='[]'; source_hash text; room_member public.pb_room_members; capture public.pb_room_captures; c public.pb_challenges; partial public.pb_challenge_partials; users uuid[]; person record; pair record;
BEGIN
 PERFORM public.pb_event_require_service();
 IF p_source-ARRAY['kind','id','captureId']<>'{}' OR p_design IS NULL OR jsonb_typeof(p_design) IS DISTINCT FROM 'object' OR octet_length(p_design::text)>65536 OR jsonb_typeof(p_design->'requiredSources') IS DISTINCT FROM 'object' OR jsonb_typeof(p_design->'slots') IS DISTINCT FROM 'array' OR jsonb_array_length(p_design->'slots') NOT BETWEEN 1 AND 16 THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 IF kind='room' THEN
  room_member=public.pb_room_auth(source_id,p_room_hash); self_id=room_member.id;
  SELECT * INTO capture FROM public.pb_room_captures WHERE id=(p_source->>'captureId')::uuid AND room_id=source_id AND state='committed';
  IF capture.id IS NULL OR NOT self_id=ANY(capture.member_ids) THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
  source_hash=capture.proposal->>'recipeHash';
  FOR person IN SELECT m.id,m.role FROM public.pb_room_members m WHERE m.room_id=source_id AND m.id=ANY(capture.member_ids) AND p_design->'requiredSources' ? m.role ORDER BY m.role LOOP
   IF NOT EXISTS(SELECT 1 FROM public.pb_room_members WHERE id=person.id AND status='admitted') OR (p_design->'requiredSources'->>person.role)::integer NOT BETWEEN 1 AND jsonb_array_length(capture.proposal->'shotIds') THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
   people=people||jsonb_build_array(jsonb_build_object('principalId',person.id,'role',person.role));
  END LOOP;
 ELSIF kind IN ('challenge','partial') AND NOT p_source ? 'captureId' THEN
  IF kind='partial' THEN
   SELECT * INTO partial FROM public.pb_challenge_partials WHERE id=source_id AND status='revealed';
   IF partial.id IS NULL THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
   SELECT array_agg(user_id ORDER BY user_id) INTO users FROM public.pb_challenge_partial_members WHERE partial_id=partial.id;
   IF NOT p_actor=ANY(users) OR EXISTS(SELECT 1 FROM public.pb_challenge_partial_members WHERE partial_id=partial.id AND consent IS DISTINCT FROM true) OR partial.snapshot IS DISTINCT FROM public.pb_challenge_snapshot(partial.challenge_id,users) THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
   c=public.pb_challenge_require_actor(p_actor,partial.challenge_id); source_hash=partial.digest;
  ELSE
   c=public.pb_challenge_require_actor(p_actor,source_id);
   IF c.status<>'revealed' OR c.reveal_hash IS NULL THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
   source_hash=c.reveal_hash;
  END IF;
  IF NOT public.pb_challenge_roster_available(c.id,users) OR NOT public.pb_challenge_sources_available(c.id,users) OR NOT public.pb_challenge_recipe_available(c.project_id,p_design) THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
  self_id=p_actor;
  FOR person IN SELECT user_id id,role FROM public.pb_challenge_members WHERE challenge_id=c.id AND (users IS NULL OR user_id=ANY(users)) AND p_design->'requiredSources' ? role ORDER BY role LOOP people=people||jsonb_build_array(jsonb_build_object('principalId',person.id,'role',person.role)); END LOOP;
  FOR pair IN SELECT DISTINCT source->>'role' role,(source->>'sourceIndex')::integer position FROM jsonb_array_elements(p_design->'slots') cell CROSS JOIN LATERAL (SELECT cell source UNION ALL SELECT value FROM jsonb_array_elements(coalesce(cell->'companions','[]'))) sources ORDER BY role,position LOOP
   SELECT assets||jsonb_build_array(jsonb_build_object('assetId',a.id,'ownerId',a.owner_id,'role',pair.role,'sourceIndex',pair.position,'sha256',a.sha256)) INTO assets FROM public.pb_challenge_submission_assets s JOIN public.pb_project_assets a ON a.id=s.asset_id JOIN public.pb_challenge_members m ON m.challenge_id=s.challenge_id AND m.user_id=s.user_id WHERE s.challenge_id=c.id AND m.role=pair.role AND s.source_index=pair.position AND (users IS NULL OR s.user_id=ANY(users)) AND public.pb_project_protection_read(a.id,p_actor);
   IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
  END LOOP;
 ELSE RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 IF coalesce(source_hash,'') !~ '^[a-f0-9]{64}$' OR jsonb_array_length(people) NOT BETWEEN 1 AND 4 OR jsonb_array_length(people)<>(SELECT count(*) FROM jsonb_object_keys(p_design->'requiredSources')) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(people) x WHERE x->>'principalId'=self_id::text) THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 RETURN jsonb_build_object('selfId',self_id,'proof',jsonb_build_object('sourceHash',source_hash,'people',people,'assets',assets,'challengeId',c.id,'projectId',c.project_id));
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_postcard_source_current(p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.pb_event_postcards; c public.pb_challenges; r public.pb_challenge_partials; users uuid[]; room public.pb_rooms; capture public.pb_room_captures;
BEGIN
 SELECT * INTO p FROM public.pb_event_postcards WHERE id=p_id;
 IF p.id IS NULL OR p.state='revoked' THEN RETURN false; END IF;
 IF p.source->>'kind'='room' THEN
  SELECT * INTO room FROM public.pb_rooms WHERE id=(p.source->>'id')::uuid;
  IF room.id IS NULL THEN RETURN p.state<>'draft'; END IF;
  SELECT * INTO capture FROM public.pb_room_captures WHERE id=(p.source->>'captureId')::uuid AND room_id=room.id;
  RETURN capture.state='committed' AND capture.proposal->>'recipeHash'=p.proof->>'sourceHash' AND NOT EXISTS(SELECT 1 FROM public.pb_event_postcard_people bound LEFT JOIN public.pb_room_members m ON m.id=bound.principal_id WHERE bound.postcard_id=p.id AND (m.id IS NULL OR m.status='removed' OR m.role<>bound.role));
 END IF;
 SELECT * INTO c FROM public.pb_challenges WHERE id=(p.proof->>'challengeId')::uuid;
 SELECT array_agg(principal_id ORDER BY principal_id) INTO users FROM public.pb_event_postcard_people WHERE postcard_id=p.id;
 IF c.id IS NULL OR NOT public.pb_challenge_roster_available(c.id,users) OR NOT public.pb_challenge_sources_available(c.id,users) OR NOT public.pb_challenge_recipe_available(c.project_id,p.design) THEN RETURN false; END IF;
 IF p.source->>'kind'='partial' THEN
  SELECT * INTO r FROM public.pb_challenge_partials WHERE id=(p.source->>'id')::uuid;
  IF r.status IS DISTINCT FROM 'revealed' OR r.digest IS DISTINCT FROM p.proof->>'sourceHash' OR EXISTS(SELECT 1 FROM public.pb_challenge_partial_members WHERE partial_id=r.id AND consent IS DISTINCT FROM true) OR r.snapshot IS DISTINCT FROM public.pb_challenge_snapshot(c.id,(SELECT array_agg(user_id ORDER BY user_id) FROM public.pb_challenge_partial_members WHERE partial_id=r.id)) THEN RETURN false; END IF;
 ELSIF c.status<>'revealed' OR c.reveal_hash IS DISTINCT FROM p.proof->>'sourceHash' THEN RETURN false; END IF;
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.proof->'assets') x LEFT JOIN public.pb_project_assets a ON a.id=(x->>'assetId')::uuid WHERE a.id IS NULL OR a.status<>'ready' OR a.sha256 IS DISTINCT FROM x->>'sha256' OR a.owner_id::text<>x->>'ownerId' OR a.protection<>'challenge' OR a.protection_id<>c.id);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_postcard_view(p_event uuid,p_hash text,p_guest uuid,p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.pb_event_tokens; p public.pb_event_postcards; person public.pb_event_postcard_people; s public.pb_event_submissions;
BEGIN
 t=public.pb_event_token(p_event,p_hash,'contribute'); IF t.guest_id IS DISTINCT FROM p_guest THEN RAISE EXCEPTION 'PB_EVENT_IDENTITY_CHANGED'; END IF;
 SELECT * INTO p FROM public.pb_event_postcards WHERE id=p_id AND event_id=p_event; SELECT * INTO person FROM public.pb_event_postcard_people WHERE postcard_id=p_id AND guest_id=p_guest;
 IF p.id IS NULL OR person.principal_id IS NULL THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 SELECT * INTO s FROM public.pb_event_submissions WHERE id=p.submission_id;
 RETURN jsonb_build_object('version',1,'eventId',p_event,'postcardId',p.id,'submissionId',p.submission_id,'revision',p.revision,'state',CASE WHEN p.state='revoked' OR s.state='deleted' THEN 'revoked' WHEN p.expires_at<=clock_timestamp() OR s.state IN ('expired','failed') OR s.state<>'ready' AND s.logical_expires_at<=clock_timestamp() THEN 'expired' ELSE p.state END,'source',p.source,'design',p.design,'designHash',p.design_hash,'expiresAt',public.pb_event_publication_instant(p.expires_at),'logicalExpiresAt',public.pb_event_publication_instant(s.logical_expires_at),'selfPrincipalId',person.principal_id,'canSubmit',p.initiator_guest=p_guest,'selfConsent',jsonb_build_object('submission',person.consent,'gallery',person.gallery,'wall',person.wall),'participants',(SELECT jsonb_agg(jsonb_build_object('principalId',principal_id,'role',role,'bound',guest_id IS NOT NULL,'consent',consent,'approved',approved_hash IS NOT NULL AND approved_hash=p.candidate->>'sha256') ORDER BY role) FROM public.pb_event_postcard_people WHERE postcard_id=p.id),'candidate',p.candidate);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_postcard_proposal(p_id uuid,p_source jsonb,p_actor uuid DEFAULT NULL,p_room_hash text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.pb_event_postcards; fresh jsonb;
BEGIN
 PERFORM public.pb_event_require_service(); SELECT * INTO p FROM public.pb_event_postcards WHERE id=p_id AND source=p_source;
 IF p.id IS NULL OR p.state='revoked' OR p.expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM public.pb_events WHERE id=p.event_id AND status<>'deleted' AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 fresh=public.pb_event_postcard_source(p.source,p.design,p_actor,p_room_hash);
 IF fresh->'proof' IS DISTINCT FROM p.proof THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 RETURN jsonb_build_object('eventId',p.event_id,'proposal',jsonb_build_object('postcardId',p.id,'submissionId',p.submission_id,'source',p.source,'design',p.design));
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_postcard_attach(p_event uuid,p_ticket_hash text,p_id uuid,p_submission uuid,p_source jsonb,p_design jsonb,p_actor uuid DEFAULT NULL,p_room_hash text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ticket public.pb_event_postcard_tickets; p public.pb_event_postcards; proof jsonb; self_id uuid; t public.pb_event_tokens; e public.pb_events; person jsonb;
BEGIN
 PERFORM public.pb_event_require_service(); proof=public.pb_event_postcard_source(p_source,p_design,p_actor,p_room_hash); self_id=(proof->>'selfId')::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended('pb-postcard-source:'||(p_source->>'kind')||':'||(p_source->>'id'),0));
 SELECT * INTO e FROM public.pb_events WHERE id=p_event FOR UPDATE; SELECT * INTO ticket FROM public.pb_event_postcard_tickets WHERE event_id=p_event AND postcard_id=p_id AND token_hash=p_ticket_hash AND expires_at>clock_timestamp();
 IF ticket.guest_id IS NULL THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF; t=public.pb_event_token(p_event,ticket.guest_hash,'contribute'); IF t.guest_id<>ticket.guest_id THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 SELECT * INTO p FROM public.pb_event_postcards WHERE id=p_id;
 IF FOUND THEN
  IF p.event_id<>p_event OR p.submission_id<>p_submission OR p.source<>p_source OR p.design<>p_design OR p.proof<>proof->'proof' OR p.state<>'draft' THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.pb_event_submissions WHERE id=p_submission) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
  IF e.status<>'open' OR e.contribution_closes_at<=clock_timestamp() OR e.starts_at>clock_timestamp() THEN RAISE EXCEPTION 'PB_EVENT_EXPIRED'; END IF;
  IF (SELECT count(*) FROM public.pb_event_postcards WHERE event_id=p_event)>=100 OR (SELECT count(*) FROM public.pb_event_postcards WHERE source->>'kind'=p_source->>'kind' AND source->>'id'=p_source->>'id')>=100 THEN RAISE EXCEPTION 'PB_EVENT_CAPACITY'; END IF;
  INSERT INTO public.pb_event_postcards(id,event_id,submission_id,initiator_guest,source,proof,design,design_hash,expires_at) VALUES(p_id,p_event,p_submission,t.guest_id,p_source,proof->'proof',p_design,public.pb_challenge_hash(p_design),least(e.expires_at,clock_timestamp()+interval '24 hours')) RETURNING * INTO p;
  FOR person IN SELECT * FROM jsonb_array_elements(proof->'proof'->'people') LOOP INSERT INTO public.pb_event_postcard_people(postcard_id,principal_id,role) VALUES(p_id,(person->>'principalId')::uuid,person->>'role'); END LOOP;
 END IF;
 IF EXISTS(SELECT 1 FROM public.pb_event_postcard_people WHERE postcard_id=p_id AND (principal_id=self_id AND guest_id IS NOT NULL AND guest_id<>t.guest_id OR principal_id<>self_id AND guest_id=t.guest_id)) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 UPDATE public.pb_event_postcard_people SET guest_id=t.guest_id WHERE postcard_id=p_id AND principal_id=self_id; IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 RETURN public.pb_event_postcard_view(p_event,ticket.guest_hash,t.guest_id,p_id);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_postcard_revoke(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.pb_event_postcards;
BEGIN
 SELECT * INTO p FROM public.pb_event_postcards WHERE id=p_id; PERFORM 1 FROM public.pb_events WHERE id=p.event_id FOR UPDATE;
 UPDATE public.pb_event_postcards SET state='revoked',revision=revision+1 WHERE id=p_id AND state<>'revoked';
 UPDATE public.pb_event_postcard_people SET consent=false,approved_hash=NULL WHERE postcard_id=p_id;
 UPDATE public.pb_event_submissions SET state='deleted',gallery_state='private',wall_state='private' WHERE id=p.submission_id AND state NOT IN ('deleted','expired');
 IF FOUND THEN PERFORM public.pb_event_queue_cleanup(p.submission_id); END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_postcard_grant_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.pb_event_postcards;
BEGIN
 IF (NEW.submission_consent,NEW.gallery_consent,NEW.wall_consent) IS NOT DISTINCT FROM (OLD.submission_consent,OLD.gallery_consent,OLD.wall_consent) THEN RETURN NEW; END IF;
 SELECT * INTO p FROM public.pb_event_postcards WHERE submission_id=NEW.submission_id FOR UPDATE;
 IF p.id IS NULL THEN RETURN NEW; END IF;
 UPDATE public.pb_event_postcard_people SET consent=NEW.submission_consent,gallery=NEW.gallery_consent,wall=NEW.wall_consent,approved_hash=CASE WHEN NEW.submission_consent THEN approved_hash ELSE NULL END WHERE postcard_id=p.id AND guest_id=NEW.guest_id;
 UPDATE public.pb_event_postcards SET revision=revision+1 WHERE id=p.id;
 IF NOT NEW.submission_consent THEN PERFORM public.pb_event_postcard_revoke(p.id); END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pb_event_postcard_grant_changed ON public.pb_event_publication_grants;
CREATE TRIGGER pb_event_postcard_grant_changed AFTER UPDATE ON public.pb_event_publication_grants FOR EACH ROW EXECUTE FUNCTION public.pb_event_postcard_grant_changed();

CREATE OR REPLACE FUNCTION public.pb_event_postcard_consent(p_event uuid,p_hash text,p_guest uuid,p_id uuid,p_revision bigint,p_consent jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.pb_event_postcards;
BEGIN
 PERFORM public.pb_event_require_service(); PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE; PERFORM public.pb_event_postcard_view(p_event,p_hash,p_guest,p_id);
 SELECT * INTO p FROM public.pb_event_postcards WHERE id=p_id FOR UPDATE;
 IF p_consent IS NULL OR p_consent-ARRAY['submission','gallery','wall']<>'{}' OR jsonb_typeof(p_consent->'submission') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_consent->'gallery') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_consent->'wall') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'PB_EVENT_INVALID'; END IF;
 IF p_consent->'submission'='false' THEN PERFORM public.pb_event_postcard_revoke(p_id); RETURN public.pb_event_postcard_view(p_event,p_hash,p_guest,p_id); END IF;
 IF p.state='revoked' OR p.expires_at<=clock_timestamp() OR public.pb_event_postcard_source_current(p_id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 IF p.revision<>p_revision THEN
  IF NOT EXISTS(SELECT 1 FROM public.pb_event_postcard_people WHERE postcard_id=p_id AND guest_id=p_guest AND consent AND gallery=(p_consent->>'gallery')::boolean AND wall=(p_consent->>'wall')::boolean) THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 ELSE
  UPDATE public.pb_event_postcard_people SET consent=true,gallery=(p_consent->>'gallery')::boolean,wall=(p_consent->>'wall')::boolean WHERE postcard_id=p_id AND guest_id=p_guest;
  IF p.state<>'draft' THEN
   UPDATE public.pb_event_publication_grants SET gallery_consent=(p_consent->>'gallery')::boolean,wall_consent=(p_consent->>'wall')::boolean,revision=revision+1,updated_at=clock_timestamp() WHERE submission_id=p.submission_id AND guest_id=p_guest AND submission_consent;
   IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
   UPDATE public.pb_event_submissions SET gallery_state=CASE WHEN p_consent->'gallery'='false' THEN 'private' WHEN state='ready' AND gallery_state='private' AND NOT EXISTS(SELECT 1 FROM public.pb_event_publication_grants WHERE submission_id=p.submission_id AND NOT gallery_consent) THEN 'awaiting_approval' ELSE gallery_state END,wall_state=CASE WHEN p_consent->'wall'='false' THEN 'private' WHEN state='ready' AND wall_state='private' AND NOT EXISTS(SELECT 1 FROM public.pb_event_publication_grants WHERE submission_id=p.submission_id AND NOT wall_consent) THEN 'awaiting_approval' ELSE wall_state END WHERE id=p.submission_id AND state NOT IN ('deleted','expired','failed');
   IF NOT FOUND THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
  END IF;
  UPDATE public.pb_event_postcards SET revision=revision+1 WHERE id=p_id;
 END IF;
 RETURN public.pb_event_postcard_view(p_event,p_hash,p_guest,p_id);
END $$;

DO $$ BEGIN
 IF to_regprocedure('public.pb_event_reserve_before_postcard(uuid,text,uuid,uuid,text,uuid[],jsonb)') IS NULL THEN ALTER FUNCTION public.pb_event_reserve(uuid,text,uuid,uuid,text,uuid[],jsonb) RENAME TO pb_event_reserve_before_postcard; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_reserve(p_event uuid,p_token text,p_submission uuid,p_request uuid,p_receipt_hash text,p_contributors uuid[],p_consent jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.pb_event_require_service();
 PERFORM pg_advisory_xact_lock(hashtextextended('pb-event-admission-v1',0));
 PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.pb_event_postcards WHERE submission_id=p_submission) THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 RETURN public.pb_event_reserve_before_postcard(p_event,p_token,p_submission,p_request,p_receipt_hash,p_contributors,p_consent);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_postcard_reserve(p_event uuid,p_hash text,p_guest uuid,p_id uuid,p_request uuid,p_receipt_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.pb_event_postcards; people uuid[]; own public.pb_event_postcard_people; result jsonb; existing public.pb_event_submissions;
BEGIN
 PERFORM public.pb_event_require_service(); PERFORM pg_advisory_xact_lock(hashtextextended('pb-event-admission-v1',0)); PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE;
 PERFORM public.pb_event_postcard_view(p_event,p_hash,p_guest,p_id); SELECT * INTO p FROM public.pb_event_postcards WHERE id=p_id FOR UPDATE;
 SELECT * INTO existing FROM public.pb_event_submissions WHERE id=p.submission_id;
 IF existing.id IS NOT NULL THEN
  IF p.initiator_guest<>p_guest OR existing.guest_id<>p_guest OR existing.request_id<>p_request OR NOT EXISTS(SELECT 1 FROM public.pb_event_tokens WHERE hash=p_receipt_hash AND event_id=p_event AND submission_id=existing.id AND kind='receipt') THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
  RETURN public.pb_event_receipt_json(existing.id)||jsonb_build_object('stagingPath',existing.staging_path,'stagingHeldBytes',existing.staging_held_bytes,'derivativeHeldBytes',existing.derivative_held_bytes);
 END IF;
 IF p.initiator_guest<>p_guest OR p.state NOT IN ('draft','reserved') OR p.expires_at<=clock_timestamp() OR public.pb_event_postcard_source_current(p.id) IS DISTINCT FROM true OR EXISTS(SELECT 1 FROM public.pb_event_postcard_people b LEFT JOIN public.pb_event_guests g ON g.id=b.guest_id AND g.event_id=p_event WHERE b.postcard_id=p.id AND (NOT b.consent OR g.id IS NULL OR g.revoked)) THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 SELECT array_agg(guest_id ORDER BY guest_id) INTO people FROM public.pb_event_postcard_people WHERE postcard_id=p.id; SELECT * INTO own FROM public.pb_event_postcard_people WHERE postcard_id=p.id AND guest_id=p_guest;
 result=public.pb_event_reserve_before_postcard(p_event,p_hash,p.submission_id,p_request,p_receipt_hash,people,jsonb_build_object('submission',true,'gallery',own.gallery,'wall',own.wall));
 IF p.state='draft' THEN
  UPDATE public.pb_event_publication_grants g SET submission_consent=true,gallery_consent=b.gallery,wall_consent=b.wall FROM public.pb_event_postcard_people b WHERE b.postcard_id=p.id AND g.submission_id=p.submission_id AND g.guest_id=b.guest_id;
  UPDATE public.pb_event_postcards SET state='reserved',revision=revision+1,expires_at=(SELECT promised_expires_at FROM public.pb_event_submissions WHERE id=p.submission_id) WHERE id=p.id;
 END IF;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_postcard_live(p_id uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.pb_event_postcard_source_current(p.id) AND p.state<>'revoked' AND e.status<>'deleted' AND e.expires_at>clock_timestamp() AND s.state NOT IN ('failed','expired','deleted') AND (s.state='ready' OR clock_timestamp()<least(s.logical_expires_at,coalesce(e.closed_at+interval '10 minutes',s.logical_expires_at))) AND NOT EXISTS(SELECT 1 FROM public.pb_event_postcard_people b LEFT JOIN public.pb_event_guests g ON g.id=b.guest_id LEFT JOIN public.pb_event_publication_grants grant_row ON grant_row.submission_id=s.id AND grant_row.guest_id=b.guest_id WHERE b.postcard_id=p.id AND (NOT b.consent OR g.id IS NULL OR g.revoked OR grant_row.submission_consent IS DISTINCT FROM true))
 FROM public.pb_event_postcards p JOIN public.pb_events e ON e.id=p.event_id JOIN public.pb_event_submissions s ON s.id=p.submission_id WHERE p.id=p_id
$$;

CREATE OR REPLACE FUNCTION public.pb_event_postcard_ready_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.pb_event_postcards; j public.pb_event_jobs; bytes bigint;
BEGIN
 SELECT * INTO p FROM public.pb_event_postcards WHERE submission_id=NEW.id FOR UPDATE;
 IF p.id IS NULL OR NEW.state<>'ready' OR OLD.state='ready' THEN RETURN NEW; END IF;
 IF public.pb_event_postcard_live(p.id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 SELECT * INTO j FROM public.pb_event_jobs WHERE submission_id=NEW.id AND kind='finalise';
 IF p.state='reserved' THEN
  SELECT (metadata->>'size')::bigint INTO bytes FROM storage.objects WHERE bucket_id='photobooth-events-v2' AND name=NEW.delivery_path;
  IF j.status<>'running' OR j.checkpoint->'objectsVerified' IS DISTINCT FROM 'true' OR j.checkpoint->>'mime'<>'image/jpeg' OR coalesce(j.checkpoint->>'sha256','') !~ '^[a-f0-9]{64}$' OR bytes NOT BETWEEN 1 AND 2000000 THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
  UPDATE public.pb_event_postcards SET state='candidate',revision=revision+1,candidate=jsonb_build_object('revision',1,'sha256',j.checkpoint->>'sha256','bytes',bytes,'width',(j.checkpoint->>'width')::integer,'height',(j.checkpoint->>'height')::integer,'mime','image/jpeg') WHERE id=p.id;
  UPDATE public.pb_event_jobs SET checkpoint=checkpoint||'{"postcardCandidate":true}'::jsonb WHERE id=j.id;
  NEW.state='finalising'; NEW.gallery_state='private'; NEW.wall_state='private';
 ELSIF p.state='candidate' THEN
  IF j.status<>'complete' OR EXISTS(SELECT 1 FROM public.pb_event_postcard_people WHERE postcard_id=p.id AND approved_hash IS DISTINCT FROM p.candidate->>'sha256') THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
  UPDATE public.pb_event_postcards SET state='ready',revision=revision+1 WHERE id=p.id;
 ELSE RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pb_event_postcard_ready_fence ON public.pb_event_submissions;
CREATE TRIGGER pb_event_postcard_ready_fence BEFORE UPDATE OF state ON public.pb_event_submissions FOR EACH ROW EXECUTE FUNCTION public.pb_event_postcard_ready_fence();

CREATE OR REPLACE FUNCTION public.pb_event_postcard_approve(p_event uuid,p_hash text,p_guest uuid,p_id uuid,p_digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.pb_event_postcards;
BEGIN
 PERFORM public.pb_event_require_service(); PERFORM 1 FROM public.pb_events WHERE id=p_event FOR UPDATE; PERFORM public.pb_event_postcard_view(p_event,p_hash,p_guest,p_id); SELECT * INTO p FROM public.pb_event_postcards WHERE id=p_id FOR UPDATE;
 IF p.candidate->>'sha256' IS DISTINCT FROM p_digest OR p.state NOT IN ('candidate','ready') THEN RAISE EXCEPTION 'PB_EVENT_CONFLICT'; END IF;
 IF p.state='ready' THEN RETURN public.pb_event_postcard_view(p_event,p_hash,p_guest,p_id); END IF;
 IF public.pb_event_postcard_live(p.id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 UPDATE public.pb_event_postcard_people SET approved_hash=p_digest WHERE postcard_id=p.id AND guest_id=p_guest;
 IF NOT EXISTS(SELECT 1 FROM public.pb_event_postcard_people WHERE postcard_id=p.id AND approved_hash IS DISTINCT FROM p_digest) THEN
  UPDATE public.pb_event_submissions SET state='ready',gallery_state=CASE WHEN NOT EXISTS(SELECT 1 FROM public.pb_event_publication_grants WHERE submission_id=p.submission_id AND NOT gallery_consent) THEN 'awaiting_approval' ELSE 'private' END,wall_state=CASE WHEN NOT EXISTS(SELECT 1 FROM public.pb_event_publication_grants WHERE submission_id=p.submission_id AND NOT wall_consent) THEN 'awaiting_approval' ELSE 'private' END WHERE id=p.submission_id;
 END IF;
 RETURN public.pb_event_postcard_view(p_event,p_hash,p_guest,p_id);
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_postcard_candidate(p_event uuid,p_hash text,p_guest uuid,p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.pb_event_postcards; s public.pb_event_submissions; expiry timestamptz;
BEGIN
 PERFORM public.pb_event_require_service(); PERFORM public.pb_event_postcard_view(p_event,p_hash,p_guest,p_id); SELECT * INTO p FROM public.pb_event_postcards WHERE id=p_id;
 IF p.state NOT IN ('candidate','ready') OR public.pb_event_postcard_live(p.id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 SELECT * INTO s FROM public.pb_event_submissions WHERE id=p.submission_id;
 IF NOT EXISTS(SELECT 1 FROM public.pb_event_jobs WHERE submission_id=s.id AND kind='finalise' AND status='complete' AND checkpoint->>'sha256'=p.candidate->>'sha256') OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='photobooth-events-v2' AND name=s.delivery_path AND (metadata->>'size')::bigint=(p.candidate->>'bytes')::bigint) THEN RAISE EXCEPTION 'PB_EVENT_NOT_READY'; END IF;
 SELECT CASE WHEN p.state='ready' THEN least(s.promised_expires_at,expires_at) ELSE least(s.logical_expires_at,coalesce(closed_at+interval '10 minutes',s.logical_expires_at),expires_at) END INTO expiry FROM public.pb_events WHERE id=p_event;
 RETURN p.candidate||jsonb_build_object('submissionId',s.id,'bucket','photobooth-events-v2','path',s.delivery_path,'expiresAt',public.pb_event_publication_instant(expiry),'maxAgeSeconds',least(300,floor(extract(epoch FROM expiry-clock_timestamp()))::integer));
END $$;

CREATE OR REPLACE FUNCTION public.pb_event_postcard_source_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p record; row_value jsonb=to_jsonb(NEW); project_id text; room_id text; challenge_id text;
BEGIN
 IF TG_TABLE_NAME IN ('pb_room_members','pb_room_captures') THEN room_id=row_value->>'room_id';
 ELSIF TG_TABLE_NAME='pb_projects' THEN project_id=row_value->>'id';
 ELSIF TG_TABLE_NAME IN ('pb_project_members','pb_project_assets') THEN project_id=row_value->>'project_id';
 ELSIF TG_TABLE_NAME='pb_challenges' THEN challenge_id=row_value->>'id';
 ELSIF TG_TABLE_NAME IN ('pb_challenge_members','pb_challenge_partials') THEN challenge_id=row_value->>'challenge_id';
 ELSIF TG_TABLE_NAME='pb_challenge_partial_members' THEN SELECT c.challenge_id::text INTO challenge_id FROM public.pb_challenge_partials c WHERE c.id=(row_value->>'partial_id')::uuid;
 END IF;
 FOR p IN SELECT id,event_id FROM public.pb_event_postcards WHERE state<>'revoked' AND (room_id IS NOT NULL AND source->>'kind'='room' AND source->>'id'=room_id OR project_id IS NOT NULL AND proof->>'projectId'=project_id OR challenge_id IS NOT NULL AND proof->>'challengeId'=challenge_id) ORDER BY event_id,id LOOP
  IF public.pb_event_postcard_source_current(p.id) IS DISTINCT FROM true THEN PERFORM public.pb_event_postcard_revoke(p.id); END IF;
 END LOOP;
 RETURN NEW;
END $$;

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['pb_room_members','pb_room_captures','pb_projects','pb_project_members','pb_project_assets','pb_challenges','pb_challenge_members','pb_challenge_partials','pb_challenge_partial_members'] LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS pb_event_postcard_source_changed ON public.%I',t);
 EXECUTE format('CREATE TRIGGER pb_event_postcard_source_changed AFTER UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.pb_event_postcard_source_changed()',t);
END LOOP; END $$;

CREATE OR REPLACE FUNCTION public.pb_event_postcard_object_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.pb_event_postcards;
BEGIN
 IF NEW.bucket_id NOT IN ('photobooth-events-v2','photobooth-event-images-staging-v2') THEN RETURN NEW; END IF;
 SELECT x.* INTO p FROM public.pb_event_postcards x JOIN public.pb_event_submissions s ON s.id=x.submission_id WHERE NEW.name IN(s.staging_path,s.delivery_path,s.thumbnail_path);
 IF p.id IS NOT NULL AND public.pb_event_postcard_live(p.id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pb_event_postcard_object_fence ON storage.objects;
CREATE TRIGGER pb_event_postcard_object_fence BEFORE INSERT OR UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION public.pb_event_postcard_object_fence();

DO $$ BEGIN
 IF to_regprocedure('public.pb_event_checkpoint_before_postcard(uuid,uuid,jsonb)') IS NULL THEN ALTER FUNCTION public.pb_event_checkpoint_job(uuid,uuid,jsonb) RENAME TO pb_event_checkpoint_before_postcard; END IF;
 IF to_regprocedure('public.pb_event_sweep_before_postcard(integer)') IS NULL THEN ALTER FUNCTION public.pb_event_sweep(integer) RENAME TO pb_event_sweep_before_postcard; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_checkpoint_job(p_job uuid,p_lease uuid,p_checkpoint jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.pb_event_postcards; j public.pb_event_jobs;
BEGIN
 PERFORM public.pb_event_require_service(); SELECT * INTO j FROM public.pb_event_jobs WHERE id=p_job; PERFORM 1 FROM public.pb_events WHERE id=j.event_id FOR UPDATE;
 SELECT * INTO p FROM public.pb_event_postcards WHERE submission_id=j.submission_id;
 IF j.kind='finalise' AND p.id IS NOT NULL AND public.pb_event_postcard_live(p.id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'PB_EVENT_DENIED'; END IF;
 RETURN public.pb_event_checkpoint_before_postcard(p_job,p_lease,p_checkpoint);
END $$;
CREATE OR REPLACE FUNCTION public.pb_event_sweep(p_limit integer DEFAULT 25) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
 result=public.pb_event_sweep_before_postcard(p_limit);
 DELETE FROM public.pb_event_postcard_tickets WHERE ctid IN(SELECT ctid FROM public.pb_event_postcard_tickets WHERE expires_at<=clock_timestamp() LIMIT 100);
 DELETE FROM public.pb_event_postcards WHERE id IN(SELECT p.id FROM public.pb_event_postcards p JOIN public.pb_events e ON e.id=p.event_id WHERE e.expires_at<=clock_timestamp() OR e.status='deleted' ORDER BY p.id LIMIT 100);
 RETURN result;
END $$;

DO $$ DECLARE r record; BEGIN FOR r IN SELECT oid::regprocedure f FROM pg_proc WHERE pronamespace='public'::regnamespace AND (proname LIKE 'pb_event_postcard_%' OR proname IN ('pb_event_reserve_before_postcard','pb_event_reserve','pb_event_checkpoint_before_postcard','pb_event_sweep_before_postcard','pb_event_checkpoint_job','pb_event_sweep')) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.f); END LOOP; END $$;
GRANT EXECUTE ON FUNCTION public.pb_event_reserve(uuid,text,uuid,uuid,text,uuid[],jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.pb_event_postcard_proposal(uuid,jsonb,uuid,text),public.pb_event_postcard_capabilities(),public.pb_event_postcard_ticket(uuid,text,uuid,uuid,uuid,text),public.pb_event_postcard_attach(uuid,text,uuid,uuid,jsonb,jsonb,uuid,text),public.pb_event_postcard_view(uuid,text,uuid,uuid),public.pb_event_postcard_consent(uuid,text,uuid,uuid,bigint,jsonb),public.pb_event_postcard_reserve(uuid,text,uuid,uuid,uuid,text),public.pb_event_postcard_approve(uuid,text,uuid,uuid,text),public.pb_event_postcard_candidate(uuid,text,uuid,uuid),public.pb_event_checkpoint_job(uuid,uuid,jsonb),public.pb_event_sweep(integer) TO service_role;
COMMIT;
