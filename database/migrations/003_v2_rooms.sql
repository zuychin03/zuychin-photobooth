BEGIN;

CREATE TABLE IF NOT EXISTS public.pb_rooms (
  id uuid PRIMARY KEY, code text NOT NULL UNIQUE CHECK(code ~ '^[A-Z2-9]{6}$'),
  session_id uuid NOT NULL DEFAULT gen_random_uuid(), host_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','ended')),
  locked boolean NOT NULL DEFAULT false, roster_revision integer NOT NULL DEFAULT 1,
  next_cursor bigint NOT NULL DEFAULT 0, signal_floor bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS public.pb_room_members (
  id uuid PRIMARY KEY, room_id uuid NOT NULL REFERENCES public.pb_rooms ON DELETE CASCADE,
  role text CHECK(role IN ('A','B','C','D')), display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 40),
  status text NOT NULL CHECK(status IN ('pending','admitted','removed')),
  connection_epoch uuid NOT NULL DEFAULT gen_random_uuid(),
  expires_at timestamptz NOT NULL, lease_until timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS pb_room_active_role ON public.pb_room_members(room_id,role) WHERE status='admitted';
CREATE INDEX IF NOT EXISTS pb_room_members_status ON public.pb_room_members(room_id,status,expires_at);
CREATE TABLE IF NOT EXISTS public.pb_room_capabilities (
  hash text PRIMARY KEY CHECK(hash ~ '^[a-f0-9]{64}$'), room_id uuid NOT NULL REFERENCES public.pb_rooms ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.pb_room_members ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('host','admission','member')), expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS pb_room_cap_member ON public.pb_room_capabilities(room_id,member_id);
CREATE TABLE IF NOT EXISTS public.pb_room_signals (
  room_id uuid NOT NULL REFERENCES public.pb_rooms ON DELETE CASCADE, cursor bigint NOT NULL,
  message_id uuid NOT NULL, sender_id uuid NOT NULL REFERENCES public.pb_room_members,
  recipient_id uuid NOT NULL REFERENCES public.pb_room_members, connection_epoch uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('sdp','ice')), payload text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  PRIMARY KEY(room_id,cursor), UNIQUE(room_id,sender_id,message_id),
  CHECK(octet_length(payload) BETWEEN 1 AND CASE WHEN kind='sdp' THEN 32768 ELSE 4096 END)
);
CREATE INDEX IF NOT EXISTS pb_room_signal_inbox ON public.pb_room_signals(room_id,recipient_id,cursor);
CREATE TABLE IF NOT EXISTS public.pb_room_captures (
  id uuid PRIMARY KEY, room_id uuid NOT NULL REFERENCES public.pb_rooms ON DELETE CASCADE,
  proposal jsonb NOT NULL CHECK(octet_length(proposal::text)<=8192), member_ids uuid[] NOT NULL,
  acks uuid[] NOT NULL DEFAULT '{}', state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','committed','aborted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS pb_room_capture_state ON public.pb_room_captures(room_id,created_at DESC);
CREATE INDEX IF NOT EXISTS pb_room_expiry ON public.pb_rooms(expires_at);
CREATE TABLE IF NOT EXISTS public.pb_room_rate_limits (
  key text NOT NULL, bucket timestamptz NOT NULL, hits integer NOT NULL,
  PRIMARY KEY(key,bucket)
);

CREATE OR REPLACE FUNCTION public.pb_room_require_service() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF coalesce(auth.role(),'')<>'service_role' THEN RAISE EXCEPTION 'PB_ROOM_DENIED' USING ERRCODE='42501'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pb_room_rate(p_key text,p_limit integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n integer;
BEGIN
  DELETE FROM public.pb_room_rate_limits WHERE ctid IN (SELECT ctid FROM public.pb_room_rate_limits WHERE bucket<clock_timestamp()-interval '2 minutes' LIMIT 100);
  INSERT INTO public.pb_room_rate_limits(key,bucket,hits) VALUES(p_key,date_trunc('minute',clock_timestamp()),1)
  ON CONFLICT(key,bucket) DO UPDATE SET hits=pb_room_rate_limits.hits+1 RETURNING hits INTO n;
  IF n>p_limit THEN RAISE EXCEPTION 'PB_ROOM_RATE_LIMIT' USING ERRCODE='P0001'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pb_room_capabilities() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.pb_room_require_service();
  RETURN jsonb_build_object('version',1,'protocol',2,'ready',true,'maxMembers',4,'roomSeconds',7200,'admissionSeconds',300,'signalBytes',32768,'iceBytes',4096,'signalsPerRoom',64,'signalsPerMember',16,'signalPage',16,'signalTtlSeconds',60,'totalPhotoBytes',50331648,'totalPhotoPixels',37748736);
END $$;

CREATE OR REPLACE FUNCTION public.pb_room_check_rate(p_rate_hash text,p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.pb_room_require_service();
  IF p_rate_hash IS NULL OR p_rate_hash !~ '^[a-f0-9]{64}$' OR p_action IS NULL OR p_action NOT IN ('create','join','call') THEN RAISE EXCEPTION 'PB_ROOM_INVALID'; END IF;
  PERFORM public.pb_room_rate('http-global:'||p_action,CASE p_action WHEN 'create' THEN 20 WHEN 'join' THEN 120 ELSE 1200 END);
  PERFORM public.pb_room_rate('http-ip:'||p_action||':'||p_rate_hash,CASE p_action WHEN 'create' THEN 3 WHEN 'join' THEN 12 ELSE 300 END);
  RETURN '{"allowed":true}'::jsonb;
END $$;

CREATE OR REPLACE FUNCTION public.pb_expire_rooms(p_limit integer DEFAULT 25) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n integer;
BEGIN
  PERFORM public.pb_room_require_service();
  IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'PB_ROOM_INVALID'; END IF;
  DELETE FROM public.pb_rooms WHERE id IN (SELECT id FROM public.pb_rooms WHERE expires_at<clock_timestamp()-interval '10 minutes' ORDER BY expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.pb_room_auth(p_room_id uuid,p_hash text,p_admission boolean DEFAULT false)
RETURNS public.pb_room_members LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.pb_rooms; c public.pb_room_capabilities; m public.pb_room_members;
BEGIN
  PERFORM public.pb_room_require_service();
  SELECT * INTO r FROM public.pb_rooms WHERE id=p_room_id FOR UPDATE;
  SELECT * INTO c FROM public.pb_room_capabilities WHERE hash=p_hash AND room_id=p_room_id;
  SELECT * INTO m FROM public.pb_room_members WHERE id=c.member_id AND room_id=p_room_id;
  IF r.id IS NULL OR r.status<>'open' OR r.expires_at<=clock_timestamp() OR c.hash IS NULL OR c.revoked OR c.expires_at<=clock_timestamp()
    OR m.id IS NULL OR m.status='removed' OR m.expires_at<=clock_timestamp()
    OR (NOT p_admission AND (m.status<>'admitted' OR c.kind='admission'))
    OR (c.kind='host' AND r.host_id<>m.id) THEN
    RAISE EXCEPTION 'PB_ROOM_DENIED' USING ERRCODE='42501';
  END IF;
  RETURN m;
END $$;

CREATE OR REPLACE FUNCTION public.pb_room_snapshot(p_room_id uuid,p_member_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.pb_rooms; m public.pb_room_members; c public.pb_room_captures; members jsonb;
BEGIN
  SELECT * INTO r FROM public.pb_rooms WHERE id=p_room_id;
  SELECT * INTO m FROM public.pb_room_members WHERE id=p_member_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'role',role,'displayName',display_name,'status',status,'connectionEpoch',connection_epoch) ORDER BY created_at,id),'[]') INTO members
  FROM public.pb_room_members WHERE room_id=r.id AND status<>'removed' AND expires_at>clock_timestamp()
    AND (m.id=r.host_id OR (m.status='admitted' AND status='admitted') OR id=m.id);
  SELECT * INTO c FROM public.pb_room_captures WHERE room_id=r.id ORDER BY created_at DESC,id LIMIT 1;
  RETURN jsonb_build_object('roomId',r.id,'code',r.code,'sessionId',r.session_id,'hostId',r.host_id,'selfId',m.id,'selfRole',m.role,
    'connectionEpoch',m.connection_epoch,'status',r.status,'locked',r.locked,'rosterRevision',r.roster_revision,
    'expiresAt',floor(extract(epoch FROM r.expires_at)*1000),'serverNow',floor(extract(epoch FROM clock_timestamp())*1000),'members',members,
    'capture',CASE WHEN c.id IS NULL OR m.status='pending' THEN NULL ELSE c.proposal||jsonb_build_object('memberIds',c.member_ids,'acks',c.acks,'state',c.state) END);
END $$;

CREATE OR REPLACE FUNCTION public.pb_room_create(p_room_id uuid,p_member_id uuid,p_code text,p_hash text,p_name text,p_rate_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE expiry timestamptz:=clock_timestamp()+interval '2 hours';
BEGIN
  PERFORM public.pb_room_require_service();
  IF p_rate_hash !~ '^[a-f0-9]{64}$' OR p_hash !~ '^[a-f0-9]{64}$' OR p_name IS NULL OR length(p_name) NOT BETWEEN 1 AND 40 THEN RAISE EXCEPTION 'PB_ROOM_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(720003);
  PERFORM public.pb_expire_rooms(25);
  PERFORM public.pb_room_rate('create:global',20); PERFORM public.pb_room_rate('create:'||p_rate_hash,3);
  IF (SELECT count(*) FROM public.pb_rooms)>=250 THEN RAISE EXCEPTION 'PB_ROOM_CAPACITY'; END IF;
  INSERT INTO public.pb_rooms(id,code,host_id,expires_at) VALUES(p_room_id,p_code,p_member_id,expiry);
  INSERT INTO public.pb_room_members(id,room_id,role,display_name,status,expires_at,lease_until) VALUES(p_member_id,p_room_id,'A',p_name,'admitted',expiry,clock_timestamp()+interval '15 seconds');
  INSERT INTO public.pb_room_capabilities(hash,room_id,member_id,kind,expires_at) VALUES(p_hash,p_room_id,p_member_id,'host',expiry);
  RETURN public.pb_room_snapshot(p_room_id,p_member_id);
END $$;

CREATE OR REPLACE FUNCTION public.pb_room_join(p_code text,p_member_id uuid,p_hash text,p_name text,p_rate_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.pb_rooms; expiry timestamptz;
BEGIN
  PERFORM public.pb_room_require_service();
  IF p_rate_hash !~ '^[a-f0-9]{64}$' OR p_hash !~ '^[a-f0-9]{64}$' OR p_name IS NULL OR length(p_name) NOT BETWEEN 1 AND 40 THEN RAISE EXCEPTION 'PB_ROOM_INVALID'; END IF;
  PERFORM public.pb_room_rate('join:global',120); PERFORM public.pb_room_rate('join:'||p_rate_hash,12);
  SELECT * INTO r FROM public.pb_rooms WHERE code=p_code FOR UPDATE;
  IF r.id IS NULL OR r.status<>'open' OR r.locked OR r.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PB_ROOM_DENIED' USING ERRCODE='42501'; END IF;
  UPDATE public.pb_room_members SET status='removed' WHERE room_id=r.id AND status='pending' AND expires_at<=clock_timestamp();
  IF (SELECT count(*) FROM public.pb_room_members WHERE room_id=r.id)>=32
     OR (SELECT count(*) FROM public.pb_room_members WHERE room_id=r.id AND status='pending')>=8
     OR (SELECT count(*) FROM public.pb_room_members WHERE room_id=r.id AND status='admitted')>=4 THEN RAISE EXCEPTION 'PB_ROOM_CAPACITY'; END IF;
  expiry:=least(r.expires_at,clock_timestamp()+interval '5 minutes');
  INSERT INTO public.pb_room_members(id,room_id,display_name,status,expires_at) VALUES(p_member_id,r.id,p_name,'pending',expiry);
  INSERT INTO public.pb_room_capabilities(hash,room_id,member_id,kind,expires_at) VALUES(p_hash,r.id,p_member_id,'admission',expiry);
  RETURN public.pb_room_snapshot(r.id,p_member_id);
END $$;

CREATE OR REPLACE FUNCTION public.pb_room_call(p_room_id uuid,p_hash text,p_action text,p_body jsonb DEFAULT '{}',p_next_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE m public.pb_room_members; r public.pb_rooms; target public.pb_room_members; c public.pb_room_captures;
  cap public.pb_room_capabilities; s public.pb_room_signals; role_name text; ids uuid[]; count_members integer;
  n integer; shots integer; body_keys text[]; allowed text[]; result jsonb; after_cursor bigint; next_cursor bigint; profile jsonb;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('state','admit','remove','lock','end','signal','poll','prepare','ack','commit','abort','capture')
    OR jsonb_typeof(p_body) IS DISTINCT FROM 'object' OR octet_length(p_body::text)>40000 THEN RAISE EXCEPTION 'PB_ROOM_INVALID'; END IF;
  m:=public.pb_room_auth(p_room_id,p_hash,p_action='state');
  SELECT * INTO r FROM public.pb_rooms WHERE id=p_room_id;
  SELECT * INTO cap FROM public.pb_room_capabilities WHERE hash=p_hash;
  PERFORM public.pb_room_rate('member:'||m.id||':'||p_action,CASE WHEN p_action IN ('poll','signal','capture') THEN 90 ELSE 30 END);
  allowed:=CASE p_action
    WHEN 'state' THEN ARRAY['renewConnection'] WHEN 'admit' THEN ARRAY['memberId'] WHEN 'remove' THEN ARRAY['memberId']
    WHEN 'lock' THEN ARRAY['locked'] WHEN 'end' THEN ARRAY[]::text[]
    WHEN 'signal' THEN ARRAY['messageId','toMemberId','connectionEpoch','kind','payload'] WHEN 'poll' THEN ARRAY['cursor','limit']
    WHEN 'prepare' THEN ARRAY['captureId','rosterRevision','recipeHash','shotIds','fireAt','intervalMs','profile']
    WHEN 'ack' THEN ARRAY['captureId','recipeHash','rosterRevision'] WHEN 'capture' THEN ARRAY['captureId','peerId'] ELSE ARRAY['captureId'] END;
  SELECT coalesce(array_agg(key),'{}') INTO body_keys FROM jsonb_object_keys(p_body) key;
  IF NOT body_keys<@allowed THEN RAISE EXCEPTION 'PB_ROOM_INVALID'; END IF;
  UPDATE public.pb_room_captures SET state='aborted' WHERE room_id=r.id AND state='prepared' AND (proposal->>'fireAt')::numeric<=extract(epoch FROM clock_timestamp())*1000+1000;

  IF p_action='state' THEN
    IF cap.kind='admission' AND m.status='admitted' THEN
      IF p_next_hash IS NULL OR p_next_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PB_ROOM_INVALID'; END IF;
      INSERT INTO public.pb_room_capabilities(hash,room_id,member_id,kind,expires_at) VALUES(p_next_hash,r.id,m.id,'member',r.expires_at) ON CONFLICT(hash) DO NOTHING;
      IF NOT EXISTS(SELECT 1 FROM public.pb_room_capabilities WHERE hash=p_next_hash AND room_id=r.id AND member_id=m.id AND kind='member' AND NOT revoked) THEN RAISE EXCEPTION 'PB_ROOM_DENIED' USING ERRCODE='42501'; END IF;
    END IF;
    IF p_body ? 'renewConnection' AND jsonb_typeof(p_body->'renewConnection')<>'boolean' THEN RAISE EXCEPTION 'PB_ROOM_INVALID'; END IF;
    IF p_body->>'renewConnection'='true' THEN
      IF m.status<>'admitted' THEN RAISE EXCEPTION 'PB_ROOM_DENIED' USING ERRCODE='42501'; END IF;
      UPDATE public.pb_room_members SET connection_epoch=gen_random_uuid() WHERE id=m.id;
      UPDATE public.pb_rooms SET signal_floor=pb_rooms.next_cursor WHERE id=r.id;
      DELETE FROM public.pb_room_signals WHERE room_id=r.id AND (sender_id=m.id OR recipient_id=m.id);
      UPDATE public.pb_room_captures SET state='aborted' WHERE room_id=r.id AND state='prepared';
    END IF;
    UPDATE public.pb_room_members SET lease_until=clock_timestamp()+interval '15 seconds' WHERE id=m.id;
    RETURN public.pb_room_snapshot(r.id,m.id)||jsonb_build_object('exchanged',cap.kind='admission' AND m.status='admitted');
  END IF;

  IF p_action IN ('admit','remove','lock','end','prepare','commit','abort') AND (m.id<>r.host_id OR cap.kind<>'host') THEN RAISE EXCEPTION 'PB_ROOM_DENIED' USING ERRCODE='42501'; END IF;
  IF p_action IN ('admit','remove') THEN
    SELECT * INTO target FROM public.pb_room_members WHERE id=(p_body->>'memberId')::uuid AND room_id=r.id;
    IF target.id IS NULL OR target.id=r.host_id THEN RAISE EXCEPTION 'PB_ROOM_DENIED' USING ERRCODE='42501'; END IF;
    IF p_action='admit' THEN
      IF target.status='admitted' THEN RETURN public.pb_room_snapshot(r.id,m.id); END IF;
      IF r.locked OR target.status<>'pending' OR target.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PB_ROOM_DENIED' USING ERRCODE='42501'; END IF;
      SELECT candidate.role INTO role_name FROM unnest(ARRAY['B','C','D']) AS candidate(role) WHERE NOT EXISTS(SELECT 1 FROM public.pb_room_members existing WHERE existing.room_id=r.id AND existing.status='admitted' AND existing.role=candidate.role) LIMIT 1;
      IF role_name IS NULL THEN RAISE EXCEPTION 'PB_ROOM_CAPACITY'; END IF;
      UPDATE public.pb_room_members SET role=role_name,status='admitted',expires_at=r.expires_at WHERE id=target.id;
    ELSE
      IF target.status='removed' THEN RETURN public.pb_room_snapshot(r.id,m.id); END IF;
      UPDATE public.pb_room_members SET status='removed' WHERE id=target.id;
      UPDATE public.pb_room_capabilities SET revoked=true WHERE member_id=target.id;
      DELETE FROM public.pb_room_signals WHERE room_id=r.id AND (sender_id=target.id OR recipient_id=target.id);
    END IF;
    UPDATE public.pb_rooms SET roster_revision=roster_revision+1 WHERE id=r.id;
    UPDATE public.pb_room_captures SET state='aborted' WHERE room_id=r.id AND state='prepared';
    RETURN public.pb_room_snapshot(r.id,m.id);
  ELSIF p_action='lock' THEN
    IF jsonb_typeof(p_body->'locked') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'PB_ROOM_INVALID'; END IF;
    UPDATE public.pb_rooms SET locked=(p_body->>'locked')::boolean WHERE id=r.id;
    RETURN public.pb_room_snapshot(r.id,m.id);
  ELSIF p_action='end' THEN
    UPDATE public.pb_rooms SET status='ended' WHERE id=r.id;
    UPDATE public.pb_room_capabilities SET revoked=true WHERE room_id=r.id;
    UPDATE public.pb_room_captures SET state='aborted' WHERE room_id=r.id AND state='prepared';
    DELETE FROM public.pb_room_signals WHERE room_id=r.id;
    RETURN jsonb_build_object('ended',true);
  ELSIF p_action='signal' THEN
    IF NOT p_body ?& ARRAY['messageId','toMemberId','connectionEpoch','kind','payload'] OR jsonb_typeof(p_body->'payload')<>'string'
      OR (p_body->>'connectionEpoch')::uuid<>m.connection_epoch OR p_body->>'kind' NOT IN ('sdp','ice')
      OR octet_length(p_body->>'payload') NOT BETWEEN 1 AND (CASE WHEN p_body->>'kind'='sdp' THEN 32768 ELSE 4096 END) THEN RAISE EXCEPTION 'PB_ROOM_INVALID'; END IF;
    SELECT * INTO target FROM public.pb_room_members WHERE id=(p_body->>'toMemberId')::uuid AND room_id=r.id AND status='admitted' AND expires_at>clock_timestamp();
    IF target.id IS NULL OR target.id=m.id THEN RAISE EXCEPTION 'PB_ROOM_DENIED' USING ERRCODE='42501'; END IF;
    UPDATE public.pb_rooms SET signal_floor=greatest(signal_floor,coalesce((SELECT max(cursor) FROM public.pb_room_signals WHERE room_id=r.id AND expires_at<=clock_timestamp()),0)) WHERE id=r.id;
    DELETE FROM public.pb_room_signals WHERE room_id=r.id AND expires_at<=clock_timestamp();
    SELECT * INTO s FROM public.pb_room_signals WHERE room_id=r.id AND sender_id=m.id AND message_id=(p_body->>'messageId')::uuid;
    IF s.message_id IS NOT NULL THEN
      IF s.recipient_id<>target.id OR s.connection_epoch<>m.connection_epoch OR s.kind<>p_body->>'kind' OR s.payload<>p_body->>'payload' THEN RAISE EXCEPTION 'PB_ROOM_CONFLICT'; END IF;
      RETURN jsonb_build_object('cursor',s.cursor);
    END IF;
    IF (SELECT count(*) FROM public.pb_room_signals WHERE room_id=r.id)>=64 OR (SELECT count(*) FROM public.pb_room_signals WHERE room_id=r.id AND sender_id=m.id)>=16 THEN RAISE EXCEPTION 'PB_ROOM_CAPACITY'; END IF;
    UPDATE public.pb_rooms SET next_cursor=pb_rooms.next_cursor+1 WHERE id=r.id RETURNING pb_rooms.next_cursor INTO next_cursor;
    INSERT INTO public.pb_room_signals(room_id,cursor,message_id,sender_id,recipient_id,connection_epoch,kind,payload,expires_at)
      VALUES(r.id,next_cursor,(p_body->>'messageId')::uuid,m.id,target.id,m.connection_epoch,p_body->>'kind',p_body->>'payload',clock_timestamp()+interval '60 seconds');
    RETURN jsonb_build_object('cursor',next_cursor);
  ELSIF p_action='poll' THEN
    after_cursor:=(p_body->>'cursor')::bigint; n:=coalesce((p_body->>'limit')::integer,16);
    IF after_cursor IS NULL OR after_cursor<0 OR after_cursor>r.next_cursor OR n NOT BETWEEN 1 AND 16 THEN RAISE EXCEPTION 'PB_ROOM_INVALID'; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',cursor,'messageId',message_id,'fromMemberId',sender_id,'toMemberId',recipient_id,'connectionEpoch',connection_epoch,'kind',kind,'payload',payload,'createdAt',floor(extract(epoch FROM created_at)*1000)) ORDER BY cursor),'[]'),max(cursor)
      INTO result,next_cursor FROM (SELECT * FROM public.pb_room_signals WHERE room_id=r.id AND recipient_id=m.id AND cursor>after_cursor AND expires_at>clock_timestamp() ORDER BY cursor LIMIT n) inbox;
    RETURN jsonb_build_object('signals',result,'cursor',coalesce(next_cursor,r.next_cursor),'serverNow',floor(extract(epoch FROM clock_timestamp())*1000),
      'resetRequired',after_cursor<r.signal_floor OR EXISTS(SELECT 1 FROM public.pb_room_signals WHERE room_id=r.id AND recipient_id=m.id AND cursor>after_cursor AND expires_at<=clock_timestamp()));
  ELSIF p_action='prepare' THEN
    IF NOT p_body ?& allowed OR jsonb_typeof(p_body->'shotIds') IS DISTINCT FROM 'array' OR jsonb_typeof(p_body->'profile') IS DISTINCT FROM 'object'
      OR coalesce(p_body->>'recipeHash','') !~ '^[a-f0-9]{64}$' OR coalesce(p_body->>'rosterRevision','') !~ '^[1-9][0-9]{0,8}$'
      OR coalesce(p_body->>'fireAt','') !~ '^[1-9][0-9]{0,15}$' OR coalesce(p_body->>'intervalMs','') !~ '^[1-9][0-9]{0,4}$'
      OR (p_body->>'rosterRevision')::integer<>r.roster_revision THEN RAISE EXCEPTION 'PB_ROOM_INVALID'; END IF;
    shots:=jsonb_array_length(p_body->'shotIds'); profile:=p_body->'profile';
    IF shots NOT BETWEEN 1 AND 4 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(p_body->'shotIds'))<>shots
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_body->'shotIds') v WHERE v !~ '^[a-zA-Z0-9_-]{1,64}$')
      OR NOT profile ?& ARRAY['maxPhotoBytes','maxPhotoPixels','shotsPerMember'] OR (SELECT count(*) FROM jsonb_object_keys(profile))<>3
      OR coalesce(profile->>'shotsPerMember','') !~ '^[1-4]$' OR coalesce(profile->>'maxPhotoBytes','') !~ '^[1-9][0-9]{0,7}$' OR coalesce(profile->>'maxPhotoPixels','') !~ '^[1-9][0-9]{0,7}$'
      OR (profile->>'shotsPerMember')::integer<>shots OR (profile->>'maxPhotoBytes')::integer NOT BETWEEN 1 AND 10485760
      OR (profile->>'maxPhotoPixels')::integer NOT BETWEEN 1 AND 12582912
      OR (p_body->>'intervalMs')::integer NOT BETWEEN 1000 AND 30000 THEN RAISE EXCEPTION 'PB_ROOM_INVALID'; END IF;
    SELECT array_agg(id ORDER BY role),count(*) INTO ids,count_members FROM public.pb_room_members WHERE room_id=r.id AND status='admitted' AND expires_at>clock_timestamp();
    IF count_members NOT BETWEEN 2 AND 4 OR count_members::bigint*shots*(profile->>'maxPhotoBytes')::integer>50331648
      OR count_members::bigint*shots*(profile->>'maxPhotoPixels')::integer>37748736 THEN RAISE EXCEPTION 'PB_ROOM_CAPACITY'; END IF;
    SELECT * INTO c FROM public.pb_room_captures WHERE id=(p_body->>'captureId')::uuid;
    IF c.id IS NOT NULL THEN
      IF c.room_id<>r.id OR c.proposal<>p_body THEN RAISE EXCEPTION 'PB_ROOM_CONFLICT'; END IF;
      RETURN c.proposal||jsonb_build_object('memberIds',c.member_ids,'acks',c.acks,'state',c.state);
    END IF;
    IF (p_body->>'fireAt')::numeric NOT BETWEEN extract(epoch FROM clock_timestamp())*1000+3000 AND extract(epoch FROM clock_timestamp())*1000+30000
      OR (p_body->>'fireAt')::numeric+(shots-1)*(p_body->>'intervalMs')::integer>=extract(epoch FROM r.expires_at)*1000
      OR (SELECT count(*) FROM public.pb_room_captures WHERE room_id=r.id)>=32
      OR EXISTS(SELECT 1 FROM public.pb_room_captures WHERE room_id=r.id AND (state='prepared' OR (state='committed' AND (proposal->>'fireAt')::numeric+((proposal->'profile'->>'shotsPerMember')::integer-1)*(proposal->>'intervalMs')::integer+5000>extract(epoch FROM clock_timestamp())*1000))) THEN RAISE EXCEPTION 'PB_ROOM_CONFLICT'; END IF;
    INSERT INTO public.pb_room_captures(id,room_id,proposal,member_ids) VALUES((p_body->>'captureId')::uuid,r.id,p_body,ids) RETURNING * INTO c;
  ELSE
    SELECT * INTO c FROM public.pb_room_captures WHERE id=(p_body->>'captureId')::uuid AND room_id=r.id FOR UPDATE;
    IF c.id IS NULL OR NOT m.id=ANY(c.member_ids) THEN RAISE EXCEPTION 'PB_ROOM_DENIED' USING ERRCODE='42501'; END IF;
    IF p_action='capture' THEN
      IF p_body ? 'peerId' AND NOT EXISTS(SELECT 1 FROM public.pb_room_members WHERE id=(p_body->>'peerId')::uuid AND room_id=r.id AND status='admitted' AND expires_at>clock_timestamp() AND id=ANY(c.member_ids)) THEN RAISE EXCEPTION 'PB_ROOM_DENIED' USING ERRCODE='42501'; END IF;
      RETURN c.proposal||jsonb_build_object('memberIds',c.member_ids,'acks',c.acks,'state',c.state);
    ELSIF p_action='abort' THEN
      IF c.state='committed' THEN RAISE EXCEPTION 'PB_ROOM_CONFLICT'; END IF;
      UPDATE public.pb_room_captures SET state='aborted' WHERE id=c.id RETURNING * INTO c;
    ELSIF p_action='ack' THEN
      IF c.state<>'prepared' OR NOT m.id=ANY(c.member_ids) OR p_body->>'recipeHash' IS DISTINCT FROM c.proposal->>'recipeHash'
        OR p_body->>'rosterRevision' IS DISTINCT FROM c.proposal->>'rosterRevision' THEN RAISE EXCEPTION 'PB_ROOM_CONFLICT'; END IF;
      UPDATE public.pb_room_members SET lease_until=clock_timestamp()+interval '15 seconds' WHERE id=m.id;
      UPDATE public.pb_room_captures SET acks=CASE WHEN m.id=ANY(acks) THEN acks ELSE array_append(acks,m.id) END WHERE id=c.id RETURNING * INTO c;
    ELSIF p_action='commit' THEN
      IF c.state='committed' THEN RETURN c.proposal||jsonb_build_object('memberIds',c.member_ids,'acks',c.acks,'state',c.state); END IF;
      IF c.state<>'prepared' OR cardinality(c.acks)<>cardinality(c.member_ids) OR (c.proposal->>'rosterRevision')::integer<>r.roster_revision
        OR (c.proposal->>'fireAt')::numeric<=extract(epoch FROM clock_timestamp())*1000+1000
        OR EXISTS(SELECT 1 FROM public.pb_room_members WHERE id=ANY(c.member_ids) AND (status<>'admitted' OR lease_until<=clock_timestamp())) THEN RAISE EXCEPTION 'PB_ROOM_NOT_READY'; END IF;
      UPDATE public.pb_room_captures SET state='committed' WHERE id=c.id RETURNING * INTO c;
    END IF;
  END IF;
  RETURN c.proposal||jsonb_build_object('memberIds',c.member_ids,'acks',c.acks,'state',c.state);
END $$;

DO $$ DECLARE t text; f record; BEGIN
  FOREACH t IN ARRAY ARRAY['pb_rooms','pb_room_members','pb_room_capabilities','pb_room_signals','pb_room_captures','pb_room_rate_limits'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'pb_room_%' OR p.proname='pb_expire_rooms') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.pb_room_capabilities(),public.pb_room_check_rate(text,text),public.pb_room_create(uuid,uuid,text,text,text,text),public.pb_room_join(text,uuid,text,text,text),public.pb_room_call(uuid,text,text,jsonb,text),public.pb_expire_rooms(integer) TO service_role;
COMMIT;
