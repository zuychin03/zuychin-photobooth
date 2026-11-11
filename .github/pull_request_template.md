## What changed

<!-- What this pull request does and why. Link the issue if there is one. -->

## How I checked it

- [ ] `npm run check`
- [ ] `npm run test:rehearsal` and `npm run build`, if the change could affect them
- [ ] The matching `database/tests` suite, if SQL changed
- [ ] Checked in a browser at phone and desktop widths, in light and dark themes, if the UI changed

<!-- Add before and after screenshots for UI changes. -->

## Data and deployment

- [ ] No change to saved data, migrations or feature flags
- [ ] Saved formats change: new fields are gated on a version and covered by tests for old and new data
- [ ] Adds a migration: forward-only, and the server refuses the feature until the migration reports its capability
- [ ] Adds a hosted feature: behind a `PB_*` switch that defaults to `false`
