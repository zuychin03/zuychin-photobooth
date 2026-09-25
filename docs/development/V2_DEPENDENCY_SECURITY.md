# V2 dependency security maintenance

23/09/2026. The approved plan retains the stack unless a demonstrated compatibility or security requirement warrants an update. The P6 image-verifier work prompted a fresh npm advisory audit. That audit reported eight affected packages, including the installed Next.js 16.2.10 and Sharp 0.34.5.

The maintainer's [Windows server advisory](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36), published 25/08/2026, marks Next.js 16 before 16.3.3 affected by unauthenticated remote code execution when hosted on a Windows filesystem. This workspace runs on Windows. No exploitation was observed or tested. The local development server was stopped before dependency replacement.

Sharp's maintainer [libvips advisory](https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj) identifies affected versions before 0.35.0. Its [libheif advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c) requires 0.35.4 or later for the bundled fix. Strict upload format rejection is useful but does not replace keeping the native decoder patched.

Selected maintenance versions are Next.js and matching ESLint configuration 16.3.6, plus direct pinned Sharp 0.35.4. This is a security exception within the approved stack, not a new product architecture. No hosted environment, deployment or user media changes are authorised by this note.

Installed versions are Next.js 16.3.6, matching ESLint configuration 16.3.6, Sharp 0.35.4 and bundled libvips 8.18.6. The package is an explicit pinned Sharp dependency for the new verifier. Non-breaking transitive fixes reduced the fresh npm audit to **zero known vulnerabilities**. This is the advisory database result at this check, not a guarantee against all vulnerabilities. React remains 19.2.4.

Installation used `--ignore-scripts`; no install scripts, commits or hosted actions ran. An initial offline manifest-only update lacked a cached public dependency, so npm fetched the missing registry data. The earlier development server was stopped before runtime replacement. The current Node runtime was verified as 25.6.0. Relevant installed Next route-handler documentation was reread.

Post-update regression passed whole TypeScript, full ESLint and **518/518 tests**, followed by the production build. The initial lint failure was corrected before this consolidated run. Subsequent legacy-partial handling passed nine focused tests and the complete disposable challenge SQL harness; four file-picker positioning fixes passed focused ESLint and rendered keyboard checks. The production build includes these final changes.

The temporary production server on loopback port 3006 returned 200 for the home, booth, editor, library, template, timeline and sign-in routes. Both development lab routes returned 404. Project HTTP and maintenance endpoints returned 503 with activation flags unchanged. The manifest and revised standard, maskable, Apple, favicon and badge assets returned 200 with their expected content types. Sharp 0.35.4 reproduced the checked-in brand rasters with `generate-brand.cjs --check`. Development preview on 3005 is restored.

This passes the local security-maintenance checkpoint. Earlier P0–P5 results remain historical evidence against their recorded versions. It does not complete P6 or establish hosted, installed-PWA, phone or release acceptance.
