---
kind: error_handling
name: Error Handling in Next.js API Routes and Libraries
category: error_handling
scope:
    - '**'
source_files:
    - app/api/keep/route.ts
    - app/api/push/notify/route.ts
    - app/api/reminders/route.ts
    - app/api/retention/route.ts
    - lib/cloudinary.ts
    - lib/push.ts
    - lib/auth.tsx
    - app/auth/callback/route.ts
---

This repository uses a straightforward, HTTP-centric error handling approach centered on Next.js App Router API routes. Errors are represented as JSON responses with explicit status codes rather than custom error classes or centralized middleware.

**API Route Error Patterns**
- All server-side endpoints (`app/api/**/*.ts`) return `NextResponse.json()` objects with typed payloads and appropriate HTTP status codes (400 for bad requests, 401 for unauthorized, 404 for not found, 409 for conflicts, 500 for server errors).
- Input validation is done inline with early returns: request bodies are parsed with `.catch(() => ({})` to handle malformed JSON gracefully, then field types are checked before proceeding.
- Authentication checks use Supabase's session client to verify user identity, returning 401 when no user is present.
- Authorization is enforced through Row Level Security (RLS) in Supabase, with additional ownership checks in the application layer that return 404 when users try to access resources they don't own.

**Library-Level Error Handling**
- External service calls (Cloudinary, web push) use try-catch blocks with best-effort error handling. Failures are logged implicitly by continuing execution rather than failing fast.
- Optional features like Cloudinary storage and push notifications are guarded by `hasCloudinary()` and `hasPush()` functions that check environment configuration before attempting operations.
- The push notification system specifically handles expired subscriptions by catching 404/410 status codes and cleaning up stale entries from the database.

**Cron Job Error Handling**
- Scheduled endpoints (`reminders/route.ts`, `retention/route.ts`) validate access via `CRON_SECRET` tokens and return 401 if authentication fails.
- These jobs implement graceful degradation: if email sending fails, they continue to attempt push notifications; if neither channel succeeds, they leave records for retry on the next run.
- Database operations within cron jobs catch errors and return them as JSON responses with 500 status codes.

**Client-Side Error Handling**
- React hooks throw errors when used outside their providers (e.g., `useAuth()`, `useBoothSession()`), providing clear debugging information.
- The auth callback route redirects with query parameters indicating failure states rather than throwing errors.
- Client components rely on React's built-in error boundaries and component-level state management rather than global error handlers.