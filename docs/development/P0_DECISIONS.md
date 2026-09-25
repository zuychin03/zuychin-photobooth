# P0 boundaries and workload decisions

Recorded 23/09/2026. This consolidates decisions within the [approved V2 plan](../../V2_PLAN.md) and the explicitly authorised phone-testing deferral recorded below. Constants below belong to isolated feasibility code unless explicitly described as a plan requirement. They are not deployed quotas or device-performance promises.

## Evidence categories

| Category | Meaning in this record |
| --- | --- |
| Approved plan boundary | An architectural requirement or explicitly proposed beta profile already contained in the approved plan. Approval of the plan does not turn illustrative provider capacity into a measured fact. |
| Conservative implementation decision | A routine bounded choice made for the P0 experiment. Keep it explicit and revise it when implementation or target-device evidence justifies a change. |
| Measured desktop fact | An observation recorded by the local desktop browser or executable fixture. Its environment and limits remain attached. |
| Provisional phone performance | A proposed capture profile or limit without corresponding phone evidence. It remains unverified until a real-device probe records results. |
| Later activation measurement | Hosted database, storage, deployment, egress or transport evidence needed before enabling the relevant cloud feature. It is not supplied by a local model. |

Source evidence: [access spike](P0_ACCESS_SPIKE.md), [media spike](P0_MEDIA_SPIKE.md), [browser observations](P0_BROWSER_EVIDENCE.md), and [project/schema resource bounds](P0_RESOURCE_BOUNDS.md). Resource-limit definitions and their validation belong to the resource-bounds record; this document intentionally does not duplicate their values. P0 memory observations belong in the browser/media evidence. Until recorded, a recording's compressed byte size must not be presented as a memory measurement.

## Data and permission boundaries

The approved plan keeps device-only projects available without an account. Personal/friend projects and events use separate private scope/storage contracts; event guests do not gain couple-vault or source-project access. Existing couple rows and Gallery's legacy strip-reader contract remain intact. Originals remain local by default for the proposed event profile.

The P0 capability model implements separate contribution, personal-receipt, gallery and wall roles. A receipt binds one accepted reservation/session, including when a guest creates multiple sessions. Each included contributor must independently consent to event submission and each publication destination. Moderation does not override missing consent. Removal, revocation and expiry deny future model reads; the model does not revoke an already-downloaded file or a real signed URL.

Tokens use 32 cryptographically random bytes and stored SHA-256 hashes as a conservative implementation decision. Scope, resource, subject, role, expiry and revocation are checked on every operation. Production credential issuance, host/moderator authentication, cookie exchange and storage policies are later work. Test-specific token/room lifetimes are fixtures, not chosen production lifetimes.

## Signalling workload

Continue the plan's capability-checked server signalling direction. The working local prototype uses a loopback HTTP test adapter and in-memory records; it establishes two-room request isolation without establishing a DB-backed transport. Media remains outside this signalling model.

| Limit | Origin and rationale | Current evidence |
| --- | --- | --- |
| Four members per room | Approved plan ceiling; avoids silently expanding the transport programme | Room creation rejects a larger roster |
| SDP 32,768 bytes; ICE 4,096 bytes | Conservative UTF-8 payload bounds for the spike | Oversized payloads are rejected |
| 64 queued messages per room | Conservative retained-data bound | The next send is rejected until expired records are pruned |
| One-minute message TTL | Short-lived setup/reconnect data in the experiment | Expired messages disappear on access |
| 16 messages per poll page | Bounded retrieval with monotonic cursors | Cursor pagination and invalid-cursor rejection tested |
| 40,000 request-body bytes | Test HTTP adapter's finite input boundary | Oversized and malformed bodies rejected |

Worst-case retained payload is 2,097,152 bytes per full room inbox, excluding object/JSON/runtime overhead. One full poll page holds at most 524,288 payload bytes, also excluding serialization overhead. These are calculations from enforced bounds, not observed process memory. The body bound can reject heavily escaped JSON before the per-payload ceiling is reached, which is acceptable for this conservative experiment.

There is no implemented polling cadence, per-member fairness budget, per-IP rate limit, request-cost target or measured connection-setup latency yet. A participant can occupy the bounded shared queue. P5 must choose and test those controls before using this transport, then measure its DB/request cost. Do not infer a polling request rate or provider allowance from the queue constants. Private Realtime remains an alternative only after its scoped credential flow is proven; an opaque guest cookie is not a Realtime JWT.

## Event commitment budget

The approved plan proposes a private-beta profile of 25 guests, at most 100 final image contributions, a 2 MB published-image limit and 250 MB committed bytes, with a seven-day contribution window and 30-day retention. These remain a proposed operational envelope. The P0 model exercises count and bytes; it does not implement guest admission counts or the full dated event lifecycle.

The image fixture uses decimal bytes:

| Component | Reserved bytes per accepted upload | Decision |
| --- | --- | --- |
| Staging authorisation | 2,000,000 | Reserve the maximum permitted write, independent of a guest's claimed or actual smaller size |
| Delivery and thumbnail headroom | 2,100,000 | Conservative allowance: 2 MB delivery plus the plan's illustrative 100 KB thumbnail |
| Combined commitment | 4,100,000 | Charge both while staging remains writable or awaits confirmed cleanup |

The deterministic fixture admits 60 simultaneous reservations at 246,000,000 bytes and rejects the 61st. One hundred such outstanding commitments would require 410,000,000 bytes. After authorised staging has expired and cleanup is confirmed, 100 retained delivery/thumbnail allowances would total 210,000,000 bytes, subject to every other event commitment. This does not guarantee 100 contributions or any amount of provider capacity.

Logical reservation expiry is ten minutes, as required by the plan. Ordinary closure stops new acceptance and permits already accepted work until the earlier of its expiry or ten minutes after closure. The spike retains staging for the plan's two-hour upload authorisation plus a conservative five-minute cleanup margin, and then requires explicit deletion confirmation before releasing bytes. Late writes, removal and revocation never imply immediate staging reclamation. Ready delivery objects remain charged after logical removal until delivery deletion is confirmed. Production worker crashes and partially created derivatives require durable accounting in P1/P7.

Model tests measure ledger commitment, not physical object storage or database races. The proposed deployment example of five four-camera rooms, a 25-guest event and ten concurrent still uploads remains a later workload test to refine and run at 1x/2x/5x, rather than a P0 capacity claim. TURN, wall delivery and egress require separate measurements.

## Media decisions and fallbacks

The bounded probe requests two seconds at 12 fps and 1280 x 720, matching the plan's initial motion profile. Its ten-megabyte encoded-output limit is a conservative experiment limit. The current desktop record shows actual MP4 and WebM encode/decode with changing pixels, not merely API detection: 47,084 and 17,628 encoded bytes, respectively, in the recorded run. Source draw count and track-reported rate do not establish encoded frame rate. Neither file size nor success on Chromium establishes phone memory or codec performance.

An unsupported or failed recording retains the PNG/still route; a format is never relabelled to claim MP4. Later implementation must offer motion only after actual encode/decode checks on that device. Local-only preview and final still composition remain the approved low-power alternative to shared live segmentation. Keep local originals for interrupted transfers, host loss or rejected event submissions, with an honest export/rejoin path. These are approved fallback requirements; P0 does not ship all of those product flows.

The print probe establishes geometry calculations only. PDF generation and actual-size physical output remain P4 delivery/acceptance work. Resource bounds and forthcoming memory observations must state which figures are deterministic estimates, JavaScript-heap observations or whole-process/native measurements; none substitutes for the others.

## Remaining gates and their owners

| Owner | Remaining evidence or implementation | Effect |
| --- | --- | --- |
| P0 | Schema/resource bounds, encoder-memory prototype observations, consolidated workload decisions, named real-browser/device results and unresolved codec/preview constraints | Complete local work now; mobile feasibility evidence remains explicitly deferred, not passed |
| P1 | Fail-closed maintenance, lifecycle migration, actual quota concurrency, archive/delete failure recovery and legacy-reader compatibility | Separate secure-storage implementation and acceptance; local capability tests do not pass it |
| P2/P3 | Integrated durable projects, import/undo/recovery, recipe validation and asset delivery/visual coverage | P0 bounds and fixtures are inputs, not completion evidence |
| P4 | Export implementation, GIF/video device decoding, PDF measurement, physical sample print and sustained memory behaviour | Physical printer/device evidence is required here; geometry arithmetic alone cannot pass it |
| P5 | DB-backed signalling, protocol sequencing/recovery, rate/fairness budgets, measured setup/cost, shared preview and two/four-device cross-network/TURN testing | Local two-room HTTP isolation is preliminary evidence only |
| P7/P8 | Event storage/RLS, real upload/finalisation races, consent/publication integration, late writes, kiosk turnover and rehearsal | No guest cloud activation from the in-memory model |
| P9/activation | Full supported-device matrix, release regression, deployment workload/provider measurements, exact-commit remote CI and authorised release | No provider capacity, hosted policy or release claim until measured and authorised |

## Authorised phone-testing deferral

On 23/09/2026 Danny asked: “Can that be done later? I have Android but don't really have time for that right now”. This authorises deferring phone testing and continuing local development. Finish the local P0 deliverables, then proceed to P1 with mobile acceptance explicitly outstanding.

This is an explicit sequencing change to the original delivery table, which lists P0 as a dependency of P1 and includes mobile encode/print feasibility plus named real-browser/device results in P0. It does not convert desktop emulation into mobile evidence or declare full device acceptance passed. Record real Android results when Danny has time; Safari/iPhone evidence remains required for that supported target before release. Phone codec, memory, preview and performance claims remain provisional until their relevant device checks pass. Physical printing, production policies, concurrency, provider capacity and release activation retain their own gates. The approved data/authentication boundaries and no-hosted-write restrictions are unchanged.
