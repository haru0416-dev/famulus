# 006 Durable research campaigns and signposts

Planned at `2ce2a2a`.

Depends on plans 004, 005, and 009.

## Why

Watch and workspace preserve a subject, previous result, and files, but not completed branches, empty searches, checkpoints, budgets, or termination conditions (`src/services/Attention.ts:24-47`). Campaign state is justified only after plan 005 shows useful branches that exceed one cycle.

## Scope

In scope: research-specific campaign state, branch scheduling, checkpoints, budgets, synthesis/citation stages, signpost-backed watch integration.

Out of scope: generic DAG/workflow engine, external write operations, self-deployment.

## Data model

`research_campaigns`: dossier_id, mode, state, budget, deadline, terminal reason, timestamps.

`research_branches`: campaign, transform/query, state, prediction, falsifier, attempt, next_at, artifact/dossier refs, error; unique dedupe key.

`research_checkpoints`: branch, sequence, cursor/state JSON, workspace ref, artifact refs, next action, created_at.

`signposts`: claim/dossier, indicator, source/query, expected direction, threshold, cadence, watermark, state.

Campaign state: `planned -> running -> waiting -> synthesizing -> verifying -> completed | inconclusive | failed | cancelled`.

Branch state: `ready -> running -> waiting | completed | empty | failed | cancelled`. A crashed running branch becomes `unknown` and requires handler-specific reconciliation before retry.

## Steps

1. Add campaign/branch/checkpoint services with lease and optimistic version checks.
2. Promote only useful over-budget branches from plan 005 into campaigns.
3. Make cycle claim bounded ready branches and dispatch research handlers.
4. Persist AI SDK `ModelMessage`-compatible messages, tool calls, and tool results with a format version at branch checkpoints.
5. Persist checkpoint before returning control; resume from checkpoint, not a regenerated plan.
6. Separate synthesis and citation verification stages.
7. Create signposts from concluded/inconclusive dossiers and map them to watch triggers.
8. Store `changed / unchanged / failed` plus watermark for every signpost observation.
9. Add cancellation, budget exhaustion, deadline, and partial-result rendering.

## Verification

```sh
git diff --stat 2ce2a2a..HEAD -- src/services/Attention.ts src/cycle.ts src/agent src/db src/cli.ts test
bun run gate
bun run test:campaign-e2e
```

Fault cases: crash after checkpoint, duplicate claim, expired lease, empty branch, rate-limit wait, budget exhaustion, cancellation, synthesis failure, citation failure, signpost no-change, and source failure.

## Done criteria

- A campaign survives process restart and resumes an existing branch.
- Completed and empty branches are not regenerated.
- Budgets and terminal reasons are explicit.
- Final synthesis links only verified dossier evidence.
- Signpost watches report differences rather than repeating full free-form research.
