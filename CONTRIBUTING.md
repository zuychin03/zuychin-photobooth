# Contributing

Thanks for your interest in Zuychin Photobooth. This guide covers setting up a copy, checking your work, and the conventions the code follows. If you're planning something large, open an issue first so we can agree on the approach.

Found a security problem? Don't open an issue. Follow the [security policy](SECURITY.md) instead.

## Set up

You need Node.js 22 or later. Docker is only needed for the database suites.

```bash
git clone https://github.com/<you>/zuychin-photobooth.git
cd zuychin-photobooth
npm ci
cp .env.example .env.local
npm run dev
```

The example env file runs in `local` mode, so the booth, editor, projects, templates and exports work without any services. To work on cloud features, set up a Supabase project as described in [Self-hosting](docs/SELF_HOSTING.md). Use a project you don't mind breaking.

Next.js 16 only allows one `next dev` per folder. If the server won't start, check for another one already running on port 3000.

### Next.js 16

This app uses Next.js 16 and React 19. Some APIs, conventions and file names differ from older versions and from many tutorials. Before writing framework code, read the matching guide in `node_modules/next/dist/docs/`, and take deprecation notices seriously.

## Check your work

Run the same checks CI runs before you open a pull request:

```bash
npm run check            # typecheck, lint and tests
npm run test:rehearsal   # service worker, fallback and rollback rehearsals
npm run build
```

If you change SQL, run the database suites too. They use Docker through the `desktop-linux` context that Docker Desktop creates. Most suites in `database/tests/` need a PostgreSQL 16 container named `pb-v2-p1-postgres`. They create and remove their own uniquely named databases inside it, never publish a port and never touch a hosted database:

```bash
docker --context desktop-linux run --detach --name pb-v2-p1-postgres --env POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine
node database/tests/run-local.mjs
node database/tests/run-full-chain.mjs
```

Run the suite that matches the area you changed, such as `run-events.mjs` or `run-projects.mjs`. `run-rest.mjs` and `run-room-rest.mjs` start their own PostgreSQL and PostgREST containers and remove them afterwards.

For UI changes, check the page in a browser at phone and desktop widths, in light and dark themes. `/v2-lab` has rehearsal pages for screens that need rooms, events or cloud data, and they never ask for the camera.

ESLint ignores `.tmp-*` files in the repo root, so you can keep local scratch scripts there.

## Data compatibility

People's projects live in their browsers and in other people's clouds, sometimes opened by an older version of the app. A few rules keep that safe.

- **Formats are versioned.** Projects (schema 3 to 5), templates (1 to 2), room recipes (1 to 2) and event looks (1 to 2) all carry a version.
- **Write a newer version only when it's needed.** A project moves to schema 5 only when it uses a V3 feature, such as a new layout, a strip style or a chosen strip date. Untouched projects stay readable by older versions.
- **Never lower a version.** Once a project is schema 5, it stays schema 5.
- **Keep validators strict.** Each format has a validator that rejects unknown fields. When you add a field, gate it on the version that introduced it, store it only when it differs from the default, and add tests for old and new data.
- **Migrations are forward-only.** Add a new numbered file in `database/migrations/` instead of editing one that may already be applied. Make the server refuse the new feature until the migration reports its capability.
- **New hosted features need a switch.** Add a `PB_*` flag that defaults to `false`, and make the server handlers fail closed when it's off or the schema is missing.

## Code style

- TypeScript is strict, and the React Compiler lint rules apply. Keep components pure during render.
- Write comments only when they're needed: a constraint, a non-obvious reason, an external contract or where a magic number comes from. Don't describe what the next line does.
- Commit LF line endings.
- Keep changes focused. Unrelated clean-ups belong in their own pull request.

## UI conventions

The app uses Liquid Glass, a soft and playful style inspired by Apple's design language.

- **Glass is for controls only:** the nav, menus, sheets, slim toolbars and buttons over photos. Content sits on solid `panel` surfaces, with `panel-muted` inside them.
- **Buttons are pills.** Use `btn` with a variant (`btn-primary`, `btn-glass`, `btn-tinted`, `btn-quiet`, `btn-plain`, `btn-danger`), including for icon buttons. Inputs and dropdown triggers use the `field` shape. Rounded rectangles are only for tiles that preview content, such as thumbnails and swatches.
- **Side-by-side panels match the tallest one.** Don't top-align a grid of panels. A column with several panels uses `tile-stack`. A narrow sidebar next to a long page is sticky instead, through `useStickyTop`.
- **The navs switch by measured fit, not breakpoints.** The bottom tab bar appears only when the top bar can't fit its links, and it shows scroll arrows only when its tabs overflow.
- **Respect reduced motion and reduced transparency.** Glass and spring motion both have fallbacks.
- **Absolutely positioned elements need a positioned ancestor inside their scroll area.** Hidden inputs and screen-reader labels count. Without one, they escape the scroll area and add empty page scroll.

## Writing copy

All UI text uses plain Australian English.

- Short sentences and contractions. No idioms or em dashes.
- Error messages follow "Couldn't save the strip. Try again."
- Standard buttons are Try again, Refresh, Dismiss and Cancel.
- Use Australian spelling in text (colour, favourite, customise), but keep routes and code as they are (`/customize`).
- One term per thing: project, template, frame designer, photo, old photo, guide, slot.
- Keep privacy and recovery caveats in event, kiosk and guest flows.
- Some tests match wording, so search `tests/` before changing an error message. Some event prompts are also copied into the database by a migration, so changing those needs a new migration.

## Commits and pull requests

- Write commit subjects in the imperative ("Add a strip date picker"), with a body that explains why when it isn't obvious.
- In the pull request, describe what changed, how you checked it, and any data, migration or feature-flag impact. For UI changes, add before and after screenshots.
- CI runs on every push and pull request. It needs to pass before a merge.

## Licence

By contributing, you agree that your contributions are licensed under the [MIT licence](LICENSE).
