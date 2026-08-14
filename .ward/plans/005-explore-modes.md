# 005 Measured wide, deep, and explore modes

Planned at `2ce2a2a`.

Depends on plans 004 and 009.

## Why

The current researcher retrieves accurately but direction generation remains with the parent. The assessment explicitly requires comparison before adding campaign state (`docs/assessment-2026-08-14.md:231-282`). A fan-out that only increases calls is not a successful exploration feature.

## Scope

In scope: explicit research modes, deterministic branch briefs, isolated fan-out, evaluation fixtures and metrics, result dedupe, dossier integration.

Out of scope: durable multi-cycle campaigns, recursive unlimited search, external actions.

## Modes

- `wide`: enumerate items satisfying a fixed criterion; requires target count and structured rows.
- `deep`: verify one target through primary sources and optional experiment.
- `explore`: generate directions outside the seed framing.

Initial explore transforms: `direct`, `structural`, `distant`, `invert`, `variable`, `falsify`, `human`. Each branch receives only the seed and its transform, never sibling results.

## Evaluation contract

Before running either path, save seed vocabulary, parent predictions, expected exclusions, and the classification rubric. Compare current path and candidate path on:

- new domain names
- new concept names
- structurally different explanations
- primary-source confirmations
- prediction-breaking results
- explicit empty directions
- duplicates
- model calls, outbound fetches, and elapsed time

## Steps

1. Define typed mode inputs/outputs and schemas.
2. Implement `wide` and `deep` without changing current parent behavior.
3. Implement each branch as a `ToolLoopAgent` call with isolated messages and bounded `stopWhen`.
4. Use `prepareStep` to narrow `activeTools`, select the worker model, and stop expensive tools when the branch budget/deadline is low.
5. Implement `explore` fan-out in code with bounded concurrency and budget.
6. Store each branch as dossier evidence, including empty results and prediction mismatch.
7. Build a stable fixture set from real prior questions without using outcomes to define labels.
8. Run paired comparisons and document the raw artifacts.
9. Enable only transforms that add accepted evidence under the predeclared rubric.

## Verification

```sh
git diff --stat 2ce2a2a..HEAD -- src/agent src/services/Search.ts src/services/Web.ts src/model src/db test docs
bun run gate
bun run evaluate:explore
```

## Done criteria

- The same seed can run in all three modes with typed outputs.
- Branch contexts are isolated and bounded.
- Empty and duplicate branches are visible.
- The acceptance decision is based on predeclared metrics and raw artifacts.
- If no transform improves accepted evidence, explore remains opt-in rather than permanent overhead.
