# P5 room entry and capture requests

Home creates `/room/new?v=2` and joins `/room/CODE?v=2`. Existing room URLs without `v=2` retain the copied legacy implementation. The new route waits for account hydration and keys entry/workspace state by the active device/account scope. Neither entry form requests camera or microphone access.

The entry checks `/api/rooms/capabilities` before creating, joining or resuming. Names and codes are validated before a request. Creation/join are explicit same-origin POSTs with a display name; capabilities and all results are private/no-store. Requests have ten-second abort signals and entry responses have a 64 KiB streamed byte ceiling. Failed or ambiguous POSTs are not retried automatically.

On success, the URL becomes `/room/CODE?v=2&id=PUBLIC_ROOM_UUID`. The ID is a lookup key, not authority. Access comes from the server-issued room-scoped HttpOnly cookie, never `host=1`, a code or a token query. A resume validates both the returned room ID and code. A denied resume offers an explicit new admission request.

A maximum of eight public code/ID hints are stored per device/account scope. They contain no names, tokens or membership roles. A code-only link with a remembered ID checks the server before offering to continue existing access. Requesting a different name explicitly warns that it replaces this browser's access, including host controls and other tabs. Stale denied hints are removed. Blocked local storage disables this convenience; it does not prevent server-validated ID links from resuming, and the join form still warns about replacing existing browser access.

Protocol v2 adds an empty `capture-request` control payload. A connected, admitted guest calls `RoomEngineV2.requestCapture()`. Only the authenticated host receives `onCaptureRequest(member)`; the sender cannot supply a capture plan, claimed role or time. Each sender and host peer throttles requests to one every three seconds. The callback should notify the host promptly, not await an open UI dialogue. Host preparation, all-member readiness and server commit remain separate operations. A request never invokes preparation or capture by itself.

Development-only lab controls dynamically load the transfer journal probe and native two/four-peer mesh probes. Their results label local synthetic execution; they do not establish cross-network, TURN or real-device acceptance.

Local tests cover legacy/v2 routing, URL injection, ignored authority flags, server code alphabet, display-name validation, bounded responses, late aborts, scoped hints, strict empty capture payloads, sender authentication and throttling. TypeScript, focused lint and the static entry design detector run separately. Root browser verification covers rendered keyboard, narrow viewport, unavailable and native-probe states; no such result is implied by these unit tests.
