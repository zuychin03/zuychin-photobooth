# Capture feedback preferences

Booth settings, relay capture and legacy shared-room capture expose browser-local sound, flash and reduced-motion preferences. Countdown ticks and shutter sound are opt-in, and screen flash is off by default. The custom motion dropdown follows the device preference or explicitly reduces motion. Either reduced-motion source suppresses flash entirely and removes the animated countdown pulse.

Preferences use a versioned localStorage record with same-tab notifications and cross-tab storage updates. Blocked storage keeps the choice for the current visit and reports that it was not persisted. Playback checks the current setting immediately before creating audio. Changing a preference cannot replay an old flash; an in-flight animation is cancelled when flash becomes unavailable.

V2 room, challenge camera, event guest camera and kiosk capture already have no sound or flash effects. They retain that behaviour, including the kiosk's explicit silent/no-flash promise. These preferences do not alter photo pixels, camera permissions or project manifests.

Focused tests cover safe defaults, malformed saved data, device and explicit reduced motion, runtime sound opt-in, and blocked storage. TypeScript and scoped lint are checked separately. Native rendered checks of the settings, cross-tab changes, countdown and flash are still required; no audible-output claim is made from source tests.

Source review on 23/09/2026 kept the stored flash choice editable while reduced motion suppresses the effect. Relay capture now prevents duplicate starts, releases abandoned frame canvases and offers an error/retry state if capture fails. Relay pages reset their private state on account or route changes, with generation fences preventing late loads, completion callbacks and editor navigation from the previous lifetime.

One integrated `npm run check` completed successfully after these corrections: nonincremental TypeScript, whole-repository ESLint and all 1,075 tests passed (zero failures, cancellations or skips). This is source/local-test evidence only, not native camera, rendered, audible-output, hosted or release evidence.
