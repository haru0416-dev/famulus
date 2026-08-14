# 002 Reliable Discord transport

Planned at `2ce2a2a`.

Depends on plan 001.

## Why

Inbound reads only the newest 50 messages and collapses transport failure into an empty result (`src/services/Discord.ts:334-355`). Outbound chunks are posted directly; an intermediate failure can be overwritten by a later success, and only the last message ID is returned (`src/services/Discord.ts:271-299`). `cycle` sends before recording completion, so a DB failure can cause a repeated reply (`src/cycle.ts:429-471`).

## Scope

In scope: Discord transport, inbox ingestion, delivery tables/service, cycle reply and draft posting paths, poll, status, fault-injection tests.

Out of scope: additional channels, generic connectors, research campaign state.

## Data model

`deliveries`: immutable destination, body hash, purpose, dedupe key, optional Operation/spec-hash reference, state, created/updated timestamps; unique `(purpose, dedupe_key)`.

`delivery_parts`: ordinal, body, state, attempt count, remote message ID, error, timestamps; unique `(delivery_id, ordinal)`.

`delivery_attempts`: append-only start/result records with `success / failed / unknown`.

Delivery state: `pending -> sending -> sent`; failures become `retryable`, `partial`, or `unknown`. `unknown` requires reconciliation or user decision and is not blindly retried.

## Steps

1. Return typed Discord fetch errors, rate-limit metadata, and pages instead of `undefined`.
2. Page backwards from newest until the stored cursor is reached; never advance past an unfetched gap.
3. Make inbox event insertion and cursor/tap commit one transaction using existing origin dedupe.
4. Add Delivery service with idempotent enqueue that returns the existing row on a duplicate `(purpose, dedupe_key)`.
5. Send each part in order, persist every remote ID, stop on first non-success, and resume from the first unsent part.
6. Record Discord reactions/thread creation as delivery receipts, not incidental side effects.
7. Add a delivery worker command and let cycle enqueue rather than call `Discord.post()` directly. For replies/drafts derived from consumed input, enqueue and cycle cursor completion occur in one SQLite transaction using a stable input/artifact-derived dedupe key.
8. Show pending/partial/unknown deliveries and last successful inbound poll in `oz status`.

Delivery is the sole owner of transport I/O, retry, reconciliation, and remote receipts. Plan 007 exposes owner replies, owner notifications, and review drafts through a host-owned replay-safe Delivery Capability under a narrow standing `share.owner` grant. Future third-party publication is authorized by an Operation, which atomically enqueues an immutable delivery bound to the approved spec hash; the Operation waits for the Delivery receipt and never sends or retries transport itself.

## Verification

```sh
git diff --stat 2ce2a2a..HEAD -- src/services/Discord.ts src/inbox.ts src/poll.ts src/cycle.ts src/cli.ts src/db test
bun run gate
```

Fault cases must cover 51+ inbound messages, HTTP 429/500/timeout, failure on outbound part 2 of 3, crash before/after atomic reply enqueue plus cursor completion, duplicate enqueue returning the same delivery, crash after remote success before local commit, restart/resume, duplicate poll, and reaction replay.

## Done criteria

- No inbound message is skipped when more than 50 arrive.
- Transport failure is visible and never treated as no messages.
- A delivery is either fully represented by receipts or explicitly partial/unknown.
- Repeated worker execution does not create a second known-successful delivery.
- Cycle cursor completion is independent from immediate network availability.

## Stop conditions

Stop if the chosen Discord endpoint cannot reconcile an unknown send. Preserve `unknown` and require manual resolution rather than inventing exactly-once guarantees.
