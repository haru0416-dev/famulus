# 003 Draft lifecycle and end-to-end health

Planned at `2ce2a2a`.

Depends on plans 002 and 009.

## Why

Draft review can refuse because the cycle has insufficient time (`src/agent/assistant.ts:919-943`), while cycle may mark the daily draft complete whenever the run did not time out (`src/cycle.ts:459-462`). Delivery success is currently a boolean embedded in a Memory event, not the workflow's terminal condition.

## Scope

In scope: durable draft lifecycle, revision/decision linkage, delivery integration, black-box probes for inbound reply and daily draft, health status.

Out of scope: publishing to Zenn, general Operation executor, research campaign state.

## Data model

`drafts`: id, local day, title, current revision, state, source dossier refs, delivery id, timestamps.

`draft_revisions`: immutable body, basis refs, content hash, review result, created_at; unique `(draft_id, revision)`.

State: `materialized -> review_pending -> revision_needed | delivery_pending -> delivered -> accepted | revise_requested | discarded`. Review failure remains `review_pending`; transport failure remains `delivery_pending`.

## Steps

1. Replace the daily meta flag with a unique draft day and explicit state.
2. Persist the body before invoking reviewer so a later cycle resumes the same revision.
3. Run review with AI SDK `Output.object` and persist only the validated complete result; never persist a partial structured stream as a decision.
4. Pass evidence references, not free-form basis only, to reviewer and stored revision.
5. Enqueue delivery through plan 002 and mark delivered only from its receipt.
6. Attach Discord reactions and thread replies to draft/revision IDs.
7. Add deterministic black-box probes using fake Discord and stub Runner for `poll -> inbox -> cycle -> delivery` and `due -> materialize -> review -> delivery -> reaction`.
8. Record probe success time and failed stage; expose both in `oz status`.

## Verification

```sh
git diff --stat 2ce2a2a..HEAD -- src/agent/assistant.ts src/cycle.ts src/services src/db src/cli.ts test oz-e2e-probe.ts
bun run gate
bun run test:e2e
```

## Done criteria

- Insufficient review time does not lose or complete the draft.
- Restart resumes the same persisted revision.
- Daily completion requires a delivered receipt.
- Revision and discard reactions update the intended draft exactly once.
- Both user-visible paths have repeatable black-box tests and health timestamps.
