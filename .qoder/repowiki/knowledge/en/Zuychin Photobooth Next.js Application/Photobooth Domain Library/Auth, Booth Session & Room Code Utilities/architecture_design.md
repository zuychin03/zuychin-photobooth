Three small, self-contained React client modules that each follow the same Provider + hook pattern:
- `auth.tsx` exposes `AuthProvider` and `useAuth`, wrapping Supabase's `onAuthStateChange` listener to keep a `User | null` in context with loading/enable flags.
- `session.tsx` exposes `SessionProvider` and `useBoothSession`, holding a `BoothSession` object (mode, role, layoutId, filterId, shots map, members, promptSeed, roomCode, sceneId) via local `useState` and exposing immutable-style `update`/`setShot`/`reset` mutators.
- `room-code.ts` is a pure utility module with no React dependencies, providing `newRoomCode`, `normalizeRoomCode`, and `isValidRoomCode` over an ambiguity-free base32-like alphabet.

Dependency direction is one-way: `auth.tsx` depends on `./supabase/client`, `session.tsx` depends on `./layouts` for the `Role` type, and `room-code.ts` has no internal dependencies. All three are marked `"use client"` so they can only be consumed from client components.