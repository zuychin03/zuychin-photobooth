---
kind: logging_system
name: No Centralized Logging System
category: logging_system
scope:
    - '**'
source_files:
    - app/room/[code]/page.tsx
    - app/timeline/page.tsx
---

This repository does not implement a centralized logging system. All application code uses the native browser `console` API (`console.log`, `console.warn`, `console.error`) directly for output, with no dedicated logger library, log-level management, structured logging, or log routing configuration. The only logging-related dependency present is the `debug` package, which appears only as a transitive dependency of ESLint tooling and is not imported anywhere in the application source. There are no files under `lib/`, `app/`, or any other directory that initialize or configure a logging framework. Log output is ad-hoc: a few `console.log` calls appear in client-side pages (e.g., sync timing in `app/room/[code]/page.tsx`, album load errors in `app/timeline/page.tsx`), and the MediaPipe WebAssembly bundles bundled under `public/mediapipe/wasm/` also emit their own `console.log`/`console.warn`/`console.error` calls. No server-side logging middleware, Winston/Pino/Bunyan setup, or structured log fields exist.