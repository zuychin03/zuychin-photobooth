-- ═══════════════════════════════════════════════════════════
-- ZUYCHIN-PHOTOBOOTH: Supabase schema (Stage 3 foundation)
-- Run in: Supabase Dashboard -> SQL Editor -> New Query
--
-- Runs on the SAME project as zuychin-gallery. Everything here is
-- additive and pb_-prefixed, so it never touches the gallery schema.
-- Identity reuses the gallery's `profiles` table (mirrors auth.users).
-- ═══════════════════════════════════════════════════════════


-- ─── 1. Couples (pairing) ───────────────────────────────
-- One row per couple. member_b is null until the partner joins with the code.
CREATE TABLE IF NOT EXISTS pb_couples (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_a   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  member_b   UUID REFERENCES profiles(id) ON DELETE CASCADE,
  pair_code  TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 2. Strips (timeline) ───────────────────────────────
-- storage_path points into the photobooth-strips bucket (<owner>/<id>.png).
CREATE TABLE IF NOT EXISTS pb_strips (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner        UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  couple_id    UUID REFERENCES pb_couples(id) ON DELETE SET NULL,
  storage_path TEXT NOT NULL,
  layout_id    TEXT,
  caption      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pb_strips_couple ON pb_strips(couple_id);
CREATE INDEX IF NOT EXISTS idx_pb_strips_owner  ON pb_strips(owner);
CREATE INDEX IF NOT EXISTS idx_pb_strips_created ON pb_strips(created_at DESC);


-- ─── 3. Membership helper ───────────────────────────────
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


-- ─── 4. RLS ─────────────────────────────────────────────
ALTER TABLE pb_couples ENABLE ROW LEVEL SECURITY;
ALTER TABLE pb_strips  ENABLE ROW LEVEL SECURITY;

-- couples: a member sees and creates their own; joining happens via the RPC below
CREATE POLICY "Members can view their couple"
  ON pb_couples FOR SELECT
  USING (auth.uid() = member_a OR auth.uid() = member_b);

CREATE POLICY "Users can create a couple as member_a"
  ON pb_couples FOR INSERT
  WITH CHECK (auth.uid() = member_a);

CREATE POLICY "Members can delete their couple"
  ON pb_couples FOR DELETE
  USING (auth.uid() = member_a OR auth.uid() = member_b);

-- strips: visible to the owner and their partner; inserted/edited by the owner
CREATE POLICY "Owner or partner can view strips"
  ON pb_strips FOR SELECT
  USING (owner = auth.uid() OR pb_are_paired(owner, auth.uid()));

CREATE POLICY "Users insert their own strips"
  ON pb_strips FOR INSERT
  WITH CHECK (owner = auth.uid());

CREATE POLICY "Owner can delete their strips"
  ON pb_strips FOR DELETE
  USING (owner = auth.uid());


-- ─── 5. Join-by-code RPC ────────────────────────────────
-- SECURITY DEFINER so the joiner can attach without SELECT rights on all couples.
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


-- ═══════════════════════════════════════════════════════════
-- 6. STORAGE BUCKET: do this in the dashboard, then run the policies
--
--   Storage -> New bucket -> name: photobooth-strips -> Private
--
-- Then run the policies below. Paths are <owner-uid>/<strip-id>.png,
-- so folder[1] is the owner; a partner may read via pb_are_paired.
-- ═══════════════════════════════════════════════════════════

CREATE POLICY "Owner can upload strips"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'photobooth-strips'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Owner or partner can read strips"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'photobooth-strips'
    AND (
      auth.uid()::text = (storage.foldername(name))[1]
      OR pb_are_paired((storage.foldername(name))[1]::uuid, auth.uid())
    )
  );

CREATE POLICY "Owner can delete strips"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'photobooth-strips'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- ═══════════════════════════════════════════════════════════
-- DONE. Photobooth points at this same project via
-- NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.
-- ═══════════════════════════════════════════════════════════
