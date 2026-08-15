# 002 Durable Discord outbound

## Goal

Persist every Discord outbound action before HTTP so a completed cycle or tool call does not depend on immediate network availability and an ambiguous send is never automatically repeated.

## Scope

Discord only. Keep inbound polling behavior and its existing metadata. Add `discord_outbound` and `discord_outbound_actions`; do not add migrations, schema versions, generic delivery abstractions, workers, retries, credential abstractions, or compatibility APIs.

## Contract

- `Discord.enqueue({ purpose, dedupeKey, text, taps?, to?, ping?, thread? })` resolves fixed channels, `discord:heard_in`, and the cached DM channel without network access.
- An uncached DM is represented by an ordered `open_dm` action before message actions.
- The complete ordered action list is canonical JSON with a hash. `(purpose, dedupe_key)` is unique. An identical enqueue returns the existing outbound; changed content or actions raise `Conflict`.
- Every message chunk has a stable nonce of at most 25 characters and sends `{ content, nonce, enforce_nonce: true }`.
- `Discord.flushQueued()` is the only Discord outbound HTTP path. It executes actions in ordinal order and persists each receipt before continuing.
- Explicit 4xx responses, including 429, end as `failed` before any success or `partial` after one. Network errors, timeouts, 5xx responses, interrupted `sending` actions, and missing required receipts end as `unknown`.
- `failed`, `partial`, `unknown`, and `sent` are terminal. There are no automatic retries.
- DM cache, thread cursors/list, and reaction lookup metadata update in the same SQLite transaction that records the corresponding successful action.
- Cycle replies/logs and assistant `tell`/`draft` enqueue with stable content-derived dedupe keys. User-visible tool results say queued, not sent.
- The poll cycle flushes queued outbound at the start of `pollInbound()`.

## Verification

```sh
bun run typecheck
bunx --bun vitest run test/discord.test.ts
```
