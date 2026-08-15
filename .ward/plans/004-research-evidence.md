# 004 Research evidence, experiments, and dossiers

Planned at `2ce2a2a`.

Implemented after `f1eb68c`.

Depends on plans 001 and 009.

## Why

Memory stores provenance but general research results are free-form events (`src/services/Memory.ts:23-43`). Sandbox records execution output but not hypothesis, control, acceptance check, or verdict (`src/services/Sandbox.ts:1-65`). Draft basis is free text. This prevents claims from being traced to primary sources or verified experiments.

## Scope

In scope: research-only evidence model, source snapshots, claims/hypotheses, experiment records, immutable artifacts, dossier assembly, recall/rendering, CLI inspection.

Out of scope: external actions, connector credentials, campaign scheduling, automatic fan-out.

## Data model

`research_dossiers`: question, state (open, concluded, or inconclusive), conclusion claim, limitations, timestamps.

`research_claims`: dossier-scoped statement, kind (observation, hypothesis, or conclusion), state (open, supported, refuted, or inconclusive), timestamps.

`research_artifacts`: immutable source snapshot or Sandbox output, content/URI, SHA-256, media type, source ref, capture time, provenance, superseding edge.

`research_experiment_runs`: hypothesis, protocol/environment JSON, command and check commands, separate output artifacts/status/exit codes, verdict (verified, failed, or inconclusive).

`research_claim_evidence`: claim-to-artifact or claim-to-run edge with polarity (support, refute, or context), quote/location, timestamp.

Separate `sources`, parent `experiments`, and generic `dossier_items` tables are intentionally omitted. A source is an immutable snapshot artifact; runs group under a hypothesis claim; Plan 005/006 own future ordering and branching.

## Rules

- Belief remains owner-grounded personal truth; web claims never become belief.
- A conclusion requires at least one evidence edge and an explicit limitation.
- A numeric public claim must resolve to a source quote or verified experiment run.
- Sandbox completion is not experiment verification until the check command passes.
- Artifacts are immutable; corrections create a new artifact and superseding edge.

## Steps

1. Add schema and services with transactionally maintained state invariants.
2. Use AI SDK `Output.object` for researcher claims and quotes; accept only quotes present in successful fetched snapshots.
3. Persist each Web dossier in one transaction and keep external claims separate from Memory beliefs.
4. Run experiment command and check separately in Sandbox; only a completed zero-exit check yields `verified`.
5. Render dossier quotes, source refs, command/check verdicts, and artifact hashes through `oz dossier [id]`.
6. Require a terminal dossier ID for every draft and pass its exact rendering to the reviewer.
7. Keep two focused research tests: evidence/immutability boundaries and command-vs-check verdict behavior.

## Verification

```sh
git diff --stat 2ce2a2a..HEAD -- src/services/Memory.ts src/services/Sandbox.ts src/agent src/db src/cli.ts test
bun run gate
```

## Done criteria

- Every dossier conclusion is traceable to evidence.
- Experiments distinguish command success from verified claims.
- Draft review can inspect the exact evidence bundle.
- Personal belief and external research claims remain separate types and tables.
- `oz dossier` exposes the authoritative bundle without copying it into Memory FTS text.
