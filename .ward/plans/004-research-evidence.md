# 004 Research evidence, experiments, and dossiers

Planned at `2ce2a2a`.

Depends on plans 001 and 009.

## Why

Memory stores provenance but general research results are free-form events (`src/services/Memory.ts:23-43`). Sandbox records execution output but not hypothesis, control, acceptance check, or verdict (`src/services/Sandbox.ts:1-65`). Draft basis is free text. This prevents claims from being traced to primary sources or verified experiments.

## Scope

In scope: research-only evidence model, source snapshots, claims/hypotheses, experiment records, immutable artifacts, dossier assembly, recall/rendering, CLI inspection.

Out of scope: external actions, connector credentials, campaign scheduling, automatic fan-out.

## Data model

`artifacts`: immutable kind, content or workspace URI, sha256, media type, created_at, provenance.

`sources`: canonical URL/ref, fetched_at, title, artifact_id, taint, freshness metadata.

`claims`: statement, kind (`observation/hypothesis/conclusion`), state (`open/supported/refuted/inconclusive`), created_at, concluded_at.

`claim_evidence`: claim, source/artifact/event, polarity (`support/refute/context`), quote/location, added_at.

`experiments`: hypothesis claim, environment artifact, protocol artifact, state, started/finished timestamps.

`experiment_runs`: input/control/variant, command, raw artifact, check command, result, verdict (`verified/failed/inconclusive/unknown`).

`dossiers`: question, state (`open/collecting/evaluating/concluded/inconclusive/cancelled`), conclusion claim, limits artifact.

`dossier_items`: ordered links to claims, sources, experiments, artifacts, and events.

## Rules

- Belief remains owner-grounded personal truth; web claims never become belief.
- A conclusion requires at least one evidence edge and an explicit limitation.
- A numeric public claim must resolve to a source quote or verified experiment run.
- Sandbox completion is not experiment verification until the check command passes.
- Artifacts are immutable; corrections create a new artifact and superseding edge.

## Steps

1. Add schema and services with transactionally maintained state invariants.
2. Define researcher, claim, experiment, and dossier results with AI SDK `Output.object` / `Output.array` using the existing Valibot-to-JSON-Schema bridge.
3. Add researcher outputs that create source snapshots and evidence edges.
4. Add experiment planning and run recording around Sandbox.
5. Add dossier CLI views and Memory references without flattening evidence into FTS text.
6. Change draft inputs to dossier IDs and evidence bundles.
7. Add tests for unsupported conclusions, refutation, stale source, artifact hash mismatch, failed checks, and redaction boundaries.

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
