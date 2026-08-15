# 003 Draft lifecycle and end-to-end health

Planned at `2ce2a2a`.

Implemented after `ffcdcb0`.

Depends on plans 002 and 009.

## Why

Draft review can refuse because the cycle has insufficient time (`src/agent/assistant.ts:919-943`), while cycle may mark the daily draft complete whenever the run did not time out (`src/cycle.ts:459-462`). Delivery success is currently a boolean embedded in a Memory event, not the workflow's terminal condition.

## Scope

In scope: durable draft lifecycle, revision/decision linkage, delivery integration, and focused end-to-end checks.

Out of scope: publishing to Zenn, general Operation executor, research campaign state.

## Data model

`drafts`: one row per local day with title, body, terminal research dossier ID, content hash, state, review feedback, delivery id, decision origin, and timestamps. The hash includes the dossier ID.

State: `review_pending -> revision_needed | delivery_pending -> delivered -> accepted | revise_requested | discarded`. `delivery_failed` is terminal for the automatic path. Review failure remains `review_pending`. Discord marks `delivered` only from a sent receipt; ambiguous and rejected delivery stays explicit and is not retried automatically.

## Steps

1. Replace the daily meta flag with a unique draft day and explicit state.
2. Persist the body before invoking reviewer so a later cycle resumes the same revision.
3. Pass the immutable dossier rendering to the reviewer in a separate fenced block and persist reviewer feedback when revision is required.
4. Enqueue delivery through plan 002 and mark delivered only from its receipt.
5. Attach Discord reactions to draft IDs and apply each origin once.
6. Record inbound poll success/failure and draft delivery success/failure in `schema_meta`; expose both through `oz status`.
7. Cover saved-body resume and `delivery -> reaction -> inbox -> draft decision` in the existing focused tests.

## Verification

```sh
git diff --stat 2ce2a2a..HEAD -- src/agent/assistant.ts src/cycle.ts src/services src/db src/cli.ts test oz-e2e-probe.ts
bun run gate
bunx --bun vitest run test/attention.test.ts test/discord.test.ts test/drafting.test.ts test/prompt-tools.test.ts
```

## Done criteria

- Insufficient review time does not lose or complete the draft.
- Restart resumes the same persisted revision.
- Delivery success requires a sent receipt; delivery failure remains explicit and is not retried automatically.
- Revision and discard reactions update the intended draft exactly once.
- Saved-body resume and Discord delivery/reaction paths have repeatable focused tests.
- `oz status` shows the last inbound success/failure and draft delivery success/failure.
