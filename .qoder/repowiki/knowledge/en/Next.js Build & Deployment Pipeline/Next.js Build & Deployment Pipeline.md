---
kind: build_system
name: Next.js Build & Deployment Pipeline
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - next.config.ts
    - tsconfig.json
    - postcss.config.mjs
    - .env.example
    - README.md
---

This project uses a standard Next.js 16 (App Router) build pipeline with no custom Makefiles, Dockerfiles, or CI/CD configurations. The build system is entirely driven by npm scripts and Next.js's built-in tooling.

**Build System Components:**
- **Framework**: Next.js 16.2.10 with React 19 and TypeScript 5
- **Package Manager**: npm (using package-lock.json for dependency resolution)
- **TypeScript Configuration**: Strict mode enabled with bundler module resolution and path aliases (@/* mapping to root)
- **Styling Pipeline**: Tailwind CSS v4 with PostCSS processing
- **Linting**: ESLint 9 with next/eslint-config-next preset

**Build Scripts:**
The `package.json` defines four core scripts:
- `npm run dev`: Development server with hot reloading
- `npm run build`: Production build generation
- `npm run start`: Serve the production build
- `npm run lint`: Code quality checks via ESLint
- `npm run typecheck`: TypeScript validation without emitting files

**Build Configuration:**
- `next.config.ts`: Minimal configuration that sets strict cache-control headers for the service worker (`sw.js`) to prevent stale builds from being cached indefinitely
- `tsconfig.json`: Configured for Next.js with strict TypeScript settings, JSX transform, and incremental compilation
- `postcss.config.mjs`: PostCSS configuration for Tailwind CSS processing

**Environment Management:**
- Environment variables are split between client-side (`NEXT_PUBLIC_*` prefixed, baked into the build at compile time) and server-only variables
- `.env.example` provides the template for required configuration
- Variables like Supabase URLs, Cloudinary credentials, VAPID keys, and API secrets control feature availability

**Service Worker & PWA:**
- Custom service worker at `public/sw.js` handles offline caching and push notifications
- Service worker registration occurs in production only via `components/PwaRegister.tsx`
- Web app manifest defined in `app/manifest.ts`
- Static assets include icons, stickers, ML models (MediaPipe WASM), and offline fallback HTML

**Deployment Model:**
- The README documents deployment to any platform that supports Node.js applications
- No containerization or platform-specific deployment configurations are included
- External services (Supabase, Cloudinary, Resend) are configured via environment variables rather than build-time configuration
- Cron jobs for retention and reminders are expected to be set up externally (e.g., cron-job.org) pointing to the deployed API routes