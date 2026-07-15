-- ═══════════════════════════════════════════════════════════
-- ZUYCHIN-PHOTOBOOTH: complete Supabase setup (end-to-end)
-- Run once in: Supabase Dashboard -> SQL Editor -> New Query.
--
-- This is the whole schema in one script: identity, pairing, the shared
-- vault, relays, photo dates, weekly retention, and the Cloudinary archive
-- columns, plus every RLS and Storage policy. Everything is additive and
-- pb_-prefixed (with a `profiles` identity table only when the project has
-- none), so it coexists with other apps on the same project, and the whole
-- script is safe to re-run.
--
-- One manual step it cannot do for you: create the Storage bucket. Before or
-- after running this, go to Storage -> New bucket -> name `photobooth-strips`
-- -> Private. The bucket's policies are included below and take effect once it
-- exists.
-- ═══════════════════════════════════════════════════════════


-- ─── 0. Identity (profiles) ─────────────────────────────
-- One row per account, mirrored from auth.users. Created only when the project
-- has no profiles table yet; a shared project keeps its existing table and
-- mirror trigger, making this block a no-op there.
DO $do$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    RETURN;
  END IF;

  CREATE TABLE profiles (
    id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

  CREATE POLICY "Users can view their own profile"
    ON profiles FOR SELECT
    USING (auth.uid() = id);

  CREATE FUNCTION public.pb_handle_new_user()
  RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
  AS $fn$
  BEGIN
    INSERT INTO profiles (id, email) VALUES (NEW.id, NEW.email)
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
  END;
  $fn$;

  CREATE TRIGGER pb_on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.pb_handle_new_user();

  -- users that signed up before this schema ran
  INSERT INTO profiles (id, email)
  SELECT id, email FROM auth.users
  ON CONFLICT (id) DO NOTHING;
END $do$;


-- ─── 1. Couples (pairing) ───────────────────────────────
-- One row per couple. member_b is null until the partner joins with the code.
CREATE TABLE IF NOT EXISTS pb_couples (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_a   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  member_b   UUID REFERENCES profiles(id) ON DELETE CASCADE,
  pair_code  TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─── 2. Strips (the shared vault) ───────────────────────
-- storage_path points into the photobooth-strips bucket (<owner>/<id>.png).
-- kept / cloudinary_* / purged support weekly retention and the archive; they
-- are defined here (not in a later migration) so the whole table exists at once.
CREATE TABLE IF NOT EXISTS pb_strips (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner                UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  couple_id            UUID REFERENCES pb_couples(id) ON DELETE SET NULL,
  storage_path         TEXT NOT NULL,
  layout_id            TEXT,
  caption              TEXT,
  kept                 BOOLEAN NOT NULL DEFAULT false,
  cloudinary_public_id TEXT,
  cloudinary_url       TEXT,
  purged               BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Columns added defensively so re-running against an older install upgrades it.
ALTER TABLE pb_strips ADD COLUMN IF NOT EXISTS kept                 BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE pb_strips ADD COLUMN IF NOT EXISTS cloudinary_public_id TEXT;
ALTER TABLE pb_strips ADD COLUMN IF NOT EXISTS cloudinary_url       TEXT;
ALTER TABLE pb_strips ADD COLUMN IF NOT EXISTS purged               BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_pb_strips_couple  ON pb_strips(couple_id);
CREATE INDEX IF NOT EXISTS idx_pb_strips_owner   ON pb_strips(owner);
CREATE INDEX IF NOT EXISTS idx_pb_strips_created ON pb_strips(created_at DESC);
-- Speeds the weekly clear (non-kept strips ordered by age).
CREATE INDEX IF NOT EXISTS idx_pb_strips_purge   ON pb_strips(created_at) WHERE NOT kept;
-- Companion reads list only archived strips.
CREATE INDEX IF NOT EXISTS idx_pb_strips_cloudinary
  ON pb_strips(created_at DESC) WHERE cloudinary_public_id IS NOT NULL;


-- ─── 3. Relays (async duo strips) ───────────────────────
-- The initiator (role A) shoots now; the partner (role B) finishes later.
-- Frames live in each user's own bucket folder, so the strip storage policies
-- already cover them:
--   initiator: <initiator-uid>/relay-<id>/A-<shot>.jpg
--   partner:   <partner-uid>/relay-<id>/B-<shot>.jpg
CREATE TABLE IF NOT EXISTS pb_relays (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id   UUID NOT NULL REFERENCES pb_couples(id) ON DELETE CASCADE,
  initiator   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  partner     UUID REFERENCES profiles(id) ON DELETE CASCADE,
  layout_id   TEXT NOT NULL,
  filter_id   TEXT NOT NULL DEFAULT 'none',
  scene_id    TEXT,
  shots       INT NOT NULL DEFAULT 4,
  a_done      BOOLEAN NOT NULL DEFAULT false,
  b_done      BOOLEAN NOT NULL DEFAULT false,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pb_relays_couple ON pb_relays(couple_id);
CREATE INDEX IF NOT EXISTS idx_pb_relays_status ON pb_relays(status);


-- ─── 4. Photo dates (scheduled reminders) ───────────────
-- A cron job (app/api/reminders) emails both members when scheduled_at is due,
-- then advances scheduled_at by the cadence (or deactivates a one-off).
CREATE TABLE IF NOT EXISTS pb_photo_dates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id    UUID NOT NULL REFERENCES pb_couples(id) ON DELETE CASCADE,
  created_by   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  cadence      TEXT NOT NULL DEFAULT 'once',   -- once | weekly | monthly | yearly
  active       BOOLEAN NOT NULL DEFAULT true,
  last_sent_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pb_photo_dates_couple ON pb_photo_dates(couple_id);
CREATE INDEX IF NOT EXISTS idx_pb_photo_dates_due
  ON pb_photo_dates(scheduled_at) WHERE active;


-- ─── 5. Membership helper + join RPC ────────────────────
-- True when u1 and u2 are the two members of a completed couple.
CREATE OR REPLACE FUNCTION public.pb_are_paired(u1 UUID, u2 UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pb_couples c
    WHERE c.member_b IS NOT NULL
      AND ((c.member_a = u1 AND c.member_b = u2)
        OR (c.member_a = u2 AND c.member_b = u1))
  );
$$;

-- SECURITY DEFINER so the joiner can attach without SELECT on all couples.
CREATE OR REPLACE FUNCTION public.pb_join_couple(code TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  target pb_couples;
BEGIN
  SELECT * INTO target FROM pb_couples
  WHERE pair_code = code AND member_b IS NULL AND member_a <> auth.uid()
  LIMIT 1;

  IF target.id IS NULL THEN
    RAISE EXCEPTION 'invalid or already-used code';
  END IF;

  UPDATE pb_couples
  SET member_b = auth.uid(), pair_code = NULL
  WHERE id = target.id;

  RETURN target.id;
END;
$$;


-- ─── 6. Row-level security ──────────────────────────────
ALTER TABLE pb_couples     ENABLE ROW LEVEL SECURITY;
ALTER TABLE pb_strips      ENABLE ROW LEVEL SECURITY;
ALTER TABLE pb_relays      ENABLE ROW LEVEL SECURITY;
ALTER TABLE pb_photo_dates ENABLE ROW LEVEL SECURITY;

-- couples: a member sees/creates/deletes their own; joining is via the RPC.
DROP POLICY IF EXISTS "Members can view their couple" ON pb_couples;
CREATE POLICY "Members can view their couple"
  ON pb_couples FOR SELECT
  USING (auth.uid() = member_a OR auth.uid() = member_b);

DROP POLICY IF EXISTS "Users can create a couple as member_a" ON pb_couples;
CREATE POLICY "Users can create a couple as member_a"
  ON pb_couples FOR INSERT
  WITH CHECK (auth.uid() = member_a);

DROP POLICY IF EXISTS "Members can delete their couple" ON pb_couples;
CREATE POLICY "Members can delete their couple"
  ON pb_couples FOR DELETE
  USING (auth.uid() = member_a OR auth.uid() = member_b);

-- strips: visible to the owner and their partner; written by the owner. The
-- weekly clear runs as the service role (bypasses RLS), so it needs no policy.
DROP POLICY IF EXISTS "Owner or partner can view strips" ON pb_strips;
CREATE POLICY "Owner or partner can view strips"
  ON pb_strips FOR SELECT
  USING (owner = auth.uid() OR pb_are_paired(owner, auth.uid()));

DROP POLICY IF EXISTS "Users insert their own strips" ON pb_strips;
CREATE POLICY "Users insert their own strips"
  ON pb_strips FOR INSERT
  WITH CHECK (owner = auth.uid());

DROP POLICY IF EXISTS "Owner can update their strips" ON pb_strips;
CREATE POLICY "Owner can update their strips"
  ON pb_strips FOR UPDATE
  USING (owner = auth.uid())
  WITH CHECK (owner = auth.uid());

DROP POLICY IF EXISTS "Owner can delete their strips" ON pb_strips;
CREATE POLICY "Owner can delete their strips"
  ON pb_strips FOR DELETE
  USING (owner = auth.uid());

-- relays
DROP POLICY IF EXISTS "Couple members view relays" ON pb_relays;
CREATE POLICY "Couple members view relays"
  ON pb_relays FOR SELECT
  USING (initiator = auth.uid() OR pb_are_paired(initiator, auth.uid()));

DROP POLICY IF EXISTS "Members create relays as initiator" ON pb_relays;
CREATE POLICY "Members create relays as initiator"
  ON pb_relays FOR INSERT
  WITH CHECK (initiator = auth.uid());

DROP POLICY IF EXISTS "Couple members update relays" ON pb_relays;
CREATE POLICY "Couple members update relays"
  ON pb_relays FOR UPDATE
  USING (initiator = auth.uid() OR pb_are_paired(initiator, auth.uid()));

DROP POLICY IF EXISTS "Initiator deletes relays" ON pb_relays;
CREATE POLICY "Initiator deletes relays"
  ON pb_relays FOR DELETE
  USING (initiator = auth.uid());

-- photo dates (the reminder cron uses the service role, so no policy for it)
DROP POLICY IF EXISTS "Members view their photo dates" ON pb_photo_dates;
CREATE POLICY "Members view their photo dates"
  ON pb_photo_dates FOR SELECT
  USING (created_by = auth.uid() OR pb_are_paired(created_by, auth.uid()));

DROP POLICY IF EXISTS "Members create photo dates" ON pb_photo_dates;
CREATE POLICY "Members create photo dates"
  ON pb_photo_dates FOR INSERT
  WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS "Members update their photo dates" ON pb_photo_dates;
CREATE POLICY "Members update their photo dates"
  ON pb_photo_dates FOR UPDATE
  USING (created_by = auth.uid() OR pb_are_paired(created_by, auth.uid()));

DROP POLICY IF EXISTS "Members delete their photo dates" ON pb_photo_dates;
CREATE POLICY "Members delete their photo dates"
  ON pb_photo_dates FOR DELETE
  USING (created_by = auth.uid() OR pb_are_paired(created_by, auth.uid()));


-- ─── 7. Storage bucket policies ─────────────────────────
-- Create the bucket first: Storage -> New bucket -> `photobooth-strips` -> Private.
-- Paths are <owner-uid>/<strip-id>.png, so folder[1] is the owner; a partner
-- reads via pb_are_paired.
DROP POLICY IF EXISTS "Owner can upload strips" ON storage.objects;
CREATE POLICY "Owner can upload strips"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'photobooth-strips'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "Owner or partner can read strips" ON storage.objects;
CREATE POLICY "Owner or partner can read strips"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'photobooth-strips'
    AND (
      auth.uid()::text = (storage.foldername(name))[1]
      OR pb_are_paired((storage.foldername(name))[1]::uuid, auth.uid())
    )
  );

DROP POLICY IF EXISTS "Owner can delete strips" ON storage.objects;
CREATE POLICY "Owner can delete strips"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'photobooth-strips'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );


-- ═══════════════════════════════════════════════════════════
-- DONE. Point the app at this project via NEXT_PUBLIC_SUPABASE_URL /
-- NEXT_PUBLIC_SUPABASE_ANON_KEY. Crons (weekly clear, reminders) and the
-- Cloudinary archive are optional — see the README.
-- ═══════════════════════════════════════════════════════════
