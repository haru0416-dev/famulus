# 006 Durable research campaigns and signposts

Planned at `2ce2a2a`.

Depends on plans 004, 005, 009, and plan 011 Phase A.

## Why

Watch and workspace preserve a subject, previous result, and files, but not completed branches, empty searches, checkpoints, budgets, or termination conditions (`src/services/Attention.ts:24-47`). Campaign state is justified only after plan 005 shows useful branches that exceed one cycle.

## Scope

In scope: research-specific campaign state, branch scheduling, checkpoints, budgets, synthesis/citation stages, signpost-backed watch integration.

Out of scope: generic DAG/workflow engine, external write operations, self-deployment.

## Data model

`research_campaigns`: canonical campaign_intent_key, intent_spec_hash, dossier_id, mode, state, budget, deadline, terminal reason, unique non-null execution root/owner binding, timestamps; `UNIQUE(campaign_intent_key)`.

The intent key is derived from the stable owner/request identity, not a newly allocated campaign ID. Insert-or-return with the same key and spec hash returns the existing campaign/root; the same key with a changed spec hash is a Conflict.

`research_branches`: campaign, transform/query, state, prediction, falsifier, attempt, next_at, artifact/dossier refs, error; unique dedupe key.

`research_checkpoints`: branch, sequence, cursor/state JSON, workspace ref, artifact refs, next action, created_at.

`signposts`: claim/dossier, indicator, source/query, expected direction, threshold, cadence, watermark, state.

Campaign state: `planned -> running -> waiting -> running | synthesizing -> verifying -> completed | inconclusive | failed | cancelled`. `waiting -> running` occurs only when at least one dependency/branch becomes claimable or a terminal branch result permits the next stage.

Branch state: `ready -> running -> waiting | completed | empty | failed | cancelled | unknown`. `waiting -- next_at due --> ready`. A crashed running branch becomes `unknown`; handler-specific reconciliation transitions it to `ready`, `failed`, or `cancelled`, never directly back to `running`.

Wake/reconciliation atomically updates the branch/campaign state and its budget reservation. A wait retains only the declared continuation reservation; reconciliation must resolve an `unknown` reservation before making the branch claimable. Cycle claims only committed `ready` branches.

## Steps

1. Add campaign/branch/checkpoint services with lease and optimistic version checks, due-wait wakeup, and handler-specific unknown reconciliation. Create the canonical intent key/spec hash, campaign row, unique owner-bound ExecutionRoot, coordinator reserve, and initial branch reservation in one transaction; duplicate same-spec intent creation returns the same campaign/root and changed-spec reuse conflicts.
2. Promote only useful over-budget branches from plan 005 into campaigns.
3. Make cycle claim bounded ready branches and dispatch research handlers.
4. Bind all planner/worker/synthesizer/verifier loops to one campaign execution root and root budget account; no loop is a privileged main loop.
5. Seal bounded branch workers as stable-slot batches with all-or-none budget reservations and fixed `all-settled` join. Preserve terminal siblings when another branch fails.
6. Persist AI SDK `ModelMessage`-compatible messages, tool calls, tool results, ProfileRef, canonical SkillPlan/CompositionPolicy, LoopTemplateRef, all CoreToolPolicyRefs and CoreToolImplementationRefs, ResultContractRef, LoopSpec format/hash, stable slot, typed task input/hash, artifact refs/hash, and budget reference at branch checkpoints. Add the campaign generation-lease writer here and retain the transitive referenced bytes until the campaign/branch is terminal.
7. Persist checkpoint before returning control; resume the same stable slot, not a regenerated worker plan.
8. Separate synthesis and citation verification into later loop batches that consume typed branch artifacts.
9. Create signposts from concluded/inconclusive dossiers and map them to watch triggers.
10. Store `changed / unchanged / failed` plus watermark for every signpost observation.
11. Add cancellation propagation, budget exhaustion, deadline, and partial-result rendering.

## Verification

```sh
git diff --stat 2ce2a2a..HEAD -- src/services/Attention.ts src/cycle.ts src/agent src/db src/cli.ts test
bun run gate
bun run test:campaign-e2e
```

Fault cases: concurrent duplicate canonical campaign intent creation, same intent key with changed spec conflict, crash between campaign/root/initial-reservation writes, orphan root/reservation prevention, crash after checkpoint, duplicate stable-slot application, changed input hash conflict, generation update while checkpoint is nonterminal, duplicate claim, expired lease, one sibling crash with terminal siblings retained, empty branch, rate-limit wait becoming claimable after `next_at`, atomic wakeup/reservation update, unknown reservation retained until reconciliation, unknown reconciliation to each allowed terminal/ready state followed by exactly one reclaim, atomic sibling budget exhaustion, cancellation propagation, synthesis failure, citation failure, signpost no-change, and source failure.

## Done criteria

- A campaign survives process restart and resumes an existing branch.
- Due waiting branches and reconciled unknown branches become claimable without regenerating their stable slot or leaking/reserving budget twice.
- Completed and empty branches are not regenerated.
- Budgets and terminal reasons are explicit.
- Final synthesis links only verified dossier evidence.
- Signpost watches report differences rather than repeating full free-form research.
