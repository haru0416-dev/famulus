# 002 Reliable Discord transport

Planned at `2ce2a2a`.

Depends on plan 001.

## Why

Inbound reads only the newest 50 messages and collapses transport failure into an empty result (`src/services/Discord.ts:334-355`). Outbound chunks are posted directly; an intermediate failure can be overwritten by a later success, and only the last message ID is returned (`src/services/Discord.ts:271-299`). `cycle` sends before recording completion, so a DB failure can cause a repeated reply (`src/cycle.ts:429-471`).

## Scope

In scope: Discord transport, inbox ingestion, delivery tables/service, cycle reply and draft posting paths, poll, status, fault-injection tests.

Out of scope: additional channels, generic connectors, research campaign state.

## Data model

`deliveries`: immutable canonical delivery spec/hash covering destination, the complete ordered remote action list, purpose, dedupe key, CoreDeliveryBindingRef, retry policy, and optional future authorization projection; state, next_at, monotonic worker/process generation fence, current attempt and exact worker process incarnation (host/boot/PID/start identity), created/updated timestamps; unique `(purpose, dedupe_key)`. Duplicate enqueue returns the existing row only when the complete delivery spec hash matches; any changed destination/action/binding/retry/authorization projection is a Conflict.

`CoreDeliveryBindingRef` is owned by this plan and pins the code-owned Discord transport implementation digest, bot/application principal ID, immutable local credential-config generation/ref, and destination scope. Secret bytes are resolved by the transport service, never models or ambient process lookup. Plan 007 later adds a separate `OperationDeliveryAuthorizationRef` projection containing its grant/approval/credential-lease/CapabilityImplementation tuple plus parent Operation resolution epoch/owner; 002 does not define or depend on that authority schema.

`delivery_actions`: ordinal, kind (`dm_open | message_part | thread_create | reaction`), canonical payload/hash (including recipient, body, reply ref, thread name, or emoji), stable remote nonce/idempotency key where supported, declared request cost and recovery rule, state, attempt count, remote receipt/channel/message/thread ID, error, timestamps; unique `(delivery_id, ordinal)`. Every Discord HTTP side effect is an action; there is no incidental destination-resolution, thread, or reaction call.

`delivery_attempts`: append-only start/result records with fence token, exact worker process incarnation, deadline/request reservation, and `success / failed / unknown`.

Delivery state: `pending -> sending -> sent`; failures become `retryable`, `partial`, or `unknown`. `unknown` requires reconciliation or user decision and is not blindly retried.

## Steps

1. Return typed Discord fetch errors, rate-limit metadata, and pages instead of `undefined`.
2. Page backwards from newest until the stored cursor is reached; never advance past an unfetched gap.
3. Make inbox event insertion and cursor/tap commit one transaction using existing origin dedupe.
4. Add Delivery service with idempotent enqueue that returns the existing row only for duplicate `(purpose, dedupe_key)` plus identical canonical delivery spec hash; mismatched payload/binding/policy conflicts.
5. Execute each remote action in order, reserve one request unit before each HTTP call, persist every receipt, stop on first non-success, and resume from the first unresolved action. For a user destination, enqueue a `dm_open` action before message actions; its channel receipt is the sole input to later sends and ping checks, so destination resolution never performs hidden HTTP I/O. Enqueue rejects a retry/request budget smaller than the initial action count.
6. Model Discord DM channel creation, reactions, and thread creation as first-class canonical delivery actions with their own idempotency/reconciliation rules, not incidental side effects.
7. Inventory every `Discord.post()` caller and make Delivery worker the only caller allowed to perform transport I/O. Convert cycle replies plus model-visible `tell` and `draft` paths in `src/agent/assistant.ts` to enqueue canonical Delivery specs rather than send directly. For replies/drafts derived from consumed input, enqueue and cycle cursor completion occur in one SQLite transaction using a stable input/artifact-derived dedupe key; interactive tool results return the durable Delivery reference/state, not a fabricated send success.
8. Show pending/partial/unknown deliveries and last successful inbound poll in `oz status`.

Worker claim atomically increments a monotonic process-generation fence, stores the exact worker process incarnation, and creates the attempt-before-I/O row. Before each action, it atomically reserves one request/cost unit from the immutable policy and checks attempts/deadline/backoff; all initial actions and every retry/reconciliation request count against that ceiling. Message actions use the persisted stable Discord nonce and `enforce_nonce` (or another contract-tested remote idempotency primitive). Thread/reaction actions must declare an endpoint-specific idempotency or reconciliation rule; if an endpoint cannot suppress/reconcile duplicates, ambiguous loss stays `unknown` and automated retry is disabled. The worker resolves only the pinned CoreDeliveryBindingRef and immediately before each action verifies fence, process incarnation, deadline, remaining reserved unit, local credential-config generation/principal, destination scope, and transport implementation digest. When plan 007 supplies an OperationDeliveryAuthorizationRef, claim and every action additionally CAS/check the exact current parent Operation resolution epoch/owner and revocation/approval tuple; a changed/unowned parent epoch blocks I/O. Operation-authorized Delivery keeps that parent ownership through retryable/partial/unknown states until terminal release. Lease loss after an action starts becomes `unknown`; expiry does not permit another worker to send. Reconciliation/retry and issuance of a new fence require the action's declared remote rule plus supervisor proof that the exact old process incarnation was killed and joined or is dead after process restart; uncertain liveness or PID reuse without matching start identity refuses reassignment. A DB fence check alone never authorizes reassignment. Core policy and any later Operation-approved RetryPolicy are intersected at enqueue, never expanded by the worker.

Delivery is the sole owner of transport I/O, retry, reconciliation, and remote receipts. Plan 007 exposes owner replies, owner notifications, and review drafts through a host-owned replay-safe Delivery Capability under a narrow standing `share.owner` grant. Future third-party publication is authorized by an Operation, which atomically enqueues an immutable delivery bound to the approved spec hash; the Operation waits for the Delivery receipt and never sends or retries transport itself.

## Verification

```sh
git diff --stat 2ce2a2a..HEAD -- src/services/Discord.ts src/agent/assistant.ts src/inbox.ts src/poll.ts src/cycle.ts src/cli.ts src/db test
bun run gate
```

Fault cases must cover 51+ inbound messages, HTTP 429/500/timeout, bounded retry attempts/deadline/request budget and backoff, enqueue with action count above request budget rejection, failure on outbound action 2 of 3, recipient/thread name/reply/reaction emoji mutation conflict, every DM-open/message/thread/reaction request debited, DM-open receipt reused without a second destination-resolution/ping HTTP call, ambiguous DM-open outcome reconciled or left unknown, cycle/tell/draft enqueue without direct HTTP I/O, repository-level assertion that only Delivery transport code performs Discord outbound HTTP, crash before/after atomic reply enqueue plus cursor completion, duplicate enqueue same spec returning the same delivery, same dedupe key with changed action/destination/binding/retry/Operation spec conflict, concurrent worker fence CAS, stale worker paused after fence check, lease expiry without kill-and-join remaining unknown, exact old-incarnation death then new fence, PID reuse/start-identity mismatch refusing reassignment, stable nonce duplicate suppression, thread/reaction ambiguous outcome using declared reconciliation or staying unknown, endpoint without enforceable nonce/reconciliation rejection, credential/principal/grant/revocation/implementation change before retry, ambient token substitution rejection, crash after send start becoming unknown rather than reclaimable, crash after remote success before local commit, restart/resume, duplicate poll, and reaction replay.

## Done criteria

- No inbound message is skipped when more than 50 arrive.
- Transport failure is visible and never treated as no messages.
- A delivery is either fully represented by receipts or explicitly partial/unknown.
- Repeated worker execution does not create a second known-successful delivery.
- Retry count, deadline, request budget, and backoff are immutable at enqueue and no worker can expand them.
- Every send uses the exact pinned DeliveryBindingRef; revocation or binding drift stops before I/O.
- Cycle cursor completion is independent from immediate network availability.
- No model, cycle, poll, or domain path calls Discord transport directly; all outbound side effects are represented by Delivery actions before I/O.

## Stop conditions

Stop if the chosen Discord endpoint cannot reconcile an unknown send. Preserve `unknown` and require manual resolution rather than inventing exactly-once guarantees.
