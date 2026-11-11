# Security policy

## Supported versions

Security fixes go into the latest release on `main`, currently 3.x. Older versions don't get separate fixes.

## Reporting a vulnerability

Please report vulnerabilities privately. Don't open a public issue, discussion or pull request.

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include what's affected, the steps to reproduce it, the impact you expect, and the version or commit you tested.

This is a small project maintained in spare time, so a reply may take a few days. You'll hear back once the report has been looked at, and again when a fix is ready. Please keep the details private until then.

## Scope

In scope:

- The app in this repository, including its API routes, server handlers and service worker.
- The SQL migrations, policies and functions in `database/`.
- The maintenance scheduler in `workers/`.

Out of scope:

- Deployments run by other people. Report those to whoever runs them.
- Problems in Supabase, Cloudinary, Resend, browsers or other third-party services, unless this code uses them unsafely.
- Findings that need an already compromised device, browser or server credential.

## For people running their own copy

- Keep `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `VAPID_PRIVATE_KEY`, `CLOUDINARY_API_SECRET` and the room and event secrets on the server. Never put them in a `NEXT_PUBLIC_*` variable.
- Make your proxy overwrite the trusted client-IP headers on every request.
- Leave hosted feature switches off until their migrations and checks are done. See [Self-hosting](docs/SELF_HOSTING.md).
