---
kind: configuration_system
name: Environment-Based Configuration with Feature Toggles
category: configuration_system
scope:
    - '**'
source_files:
    - .env.example
    - next.config.ts
    - lib/cloudinary.ts
    - lib/push.ts
    - lib/push-client.ts
    - app/api/reminders/route.ts
    - app/api/retention/route.ts
---

The application uses Next.js's built-in environment variable system as its configuration mechanism, with no dedicated config files or centralized configuration loader. Configuration is organized around three layers: public client variables (prefixed `NEXT_PUBLIC_`), server-only secrets, and feature flags implemented through boolean checks on environment presence.

**Configuration Sources and Organization**
- `.env.example` serves as the single source of truth for all required and optional environment variables, documenting each group with comments explaining purpose and dependencies
- Variables are grouped by service: Supabase (URL, anon key, service role key, cookie domain), Cloudinary (cloud name, API keys), TURN servers (for WebRTC relay), web push VAPID keys, Resend email service, and cron security
- No runtime configuration loading - variables are accessed directly via `process.env` throughout the codebase

**Client vs Server Variable Splitting**
The codebase strictly separates client-accessible and server-only configuration:
- Client variables use `NEXT_PUBLIC_` prefix (Supabase URL/key, Cloudinary cloud name, TURN credentials, VAPID public key)
- Server-only secrets never have the `NEXT_PUBLIC_` prefix (service role keys, API secrets, private VAPID key, Resend API key, cron secret)
- This separation is enforced at build time by Next.js, preventing accidental exposure of secrets to the browser

**Feature Toggle Pattern**
Optional features are enabled/disabled through boolean helper functions that check for the presence of required environment variables:
- `hasCloudinary()` in `lib/cloudinary.ts` checks for all three Cloudinary credentials
- `hasPush()` in `lib/push.ts` verifies VAPID keys and service role key
- `pushConfigured()` in `lib/push-client.ts` validates client-side push setup
- These toggles allow the application to gracefully degrade when optional services aren't configured

**Security and Access Control**
- Cron-triggered routes (`/api/reminders`, `/api/retention`) validate requests using `CRON_SECRET` via Authorization header or query parameter
- Service role keys bypass Row Level Security for scheduled tasks that need database-wide access
- All external service integrations require explicit configuration - features remain hidden when credentials are missing

**Runtime Configuration**
- `next.config.ts` contains only static Next.js configuration including service worker cache headers
- No dynamic runtime configuration loading - all settings must be available at build/start time
- The service worker (`sw.js`) is served with aggressive revalidation headers to prevent stale caching issues