---
kind: dependency_management
name: Node.js/npm Dependency Management for Next.js Photobooth App
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - tsconfig.json
    - next.config.ts
---

This repository uses the standard Node.js/npm ecosystem for dependency management in a Next.js 16 application. Dependencies are declared in `package.json` and locked via `package-lock.json` (lockfileVersion 3), ensuring deterministic installs across environments.

**Package managers and lockfiles**
- npm is used as the package manager, with `package-lock.json` committed to version control to pin exact transitive dependency versions.
- No vendoring strategy (no `vendor/` directory) - all third-party packages are installed into `node_modules` at install time.
- No private registry configuration is present; dependencies resolve against the public npm registry.

**Dependency categories**
- Runtime dependencies include the Next.js framework (`next@16.2.10`), React 19 (`react`, `react-dom`), Supabase client (`@supabase/supabase-js`, `@supabase/ssr`), Cloudinary SDK (`cloudinary`), email service (`resend`), web push notifications (`web-push`), and MediaPipe vision tasks (`@mediapipe/tasks-vision`). UI icons come from `lucide-react`.
- Development dependencies cover TypeScript (`typescript@^5`), ESLint (`eslint@^9` with `eslint-config-next`), Tailwind CSS v4 (`tailwindcss`, `@tailwindcss/postcss`), and type definitions for Node, React, and web-push.

**Versioning strategy**
- Framework and runtime dependencies use caret ranges (`^`) for minor/patch updates (e.g., `"next": "16.2.10"`, `"@supabase/supabase-js": "^2.110.2"`), while React and ReactDOM are pinned to exact versions (`"react": "19.2.4"`, `"react-dom": "19.2.4"`).
- Dev dependencies generally use caret ranges to allow compatible updates.

**Build-time integration**
- TypeScript compilation targets ES2017 with `moduleResolution: "bundler"` and `isolatedModules: true`, configured through `tsconfig.json`.
- Next.js config (`next.config.ts`) sets HTTP headers for the service worker (`/sw.js`) to prevent stale caching, which is relevant since the service worker acts as a runtime dependency on static assets.

**Scripts and tooling**
- Standard npm scripts: `dev` (Next dev server), `build` (production build), `start` (production server), `lint` (ESLint), and `typecheck` (TypeScript type checking without emission).
- PostCSS is configured via `postcss.config.mjs` for Tailwind CSS processing.

**External service dependencies**
- Supabase (auth, database, storage) and Cloudinary (image upload/storage) are integrated through their respective SDKs, with configuration loaded from environment variables (see `.env.example`).
- Resend handles email delivery, and `web-push` manages browser push notification subscriptions.