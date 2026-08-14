# 008 Staged self-update and rollback

Planned at `2ce2a2a`.

Depends on plans 001, 003, and 007.

## Why

Selfdev correctly stops at a clone because a gate in the clone proves only that clone (`src/core/selfdev.ts:9-13`). Deployment modifies the code that enforces approval, governance, and execution, so it must not be a normal connector operation.

## Scope

In scope: patch artifacts, approval display, staging checkout, repeatable gate, activation, health check, rollback, audit, protected-path policy.

Out of scope: model-held production credentials, direct edits to the live checkout, unattended standing permission, force-push, schema downgrade.

## Data model

`deployments`: base commit, patch artifact/hash, proposed target, state, approval ref, staged commit, previous release, timestamps.

`deployment_attempts`: append-only stage/gate/activate/health/rollback facts and artifacts.

State: `prepared -> awaiting_approval -> approved -> staged -> tested -> activating -> healthy`; failure paths are `rejected`, `test_failed`, `activation_failed`, `unhealthy -> rolling_back -> rolled_back | rollback_failed`, and `unknown`.

## Safety rules

- The model may create a patch artifact but cannot approve or activate it.
- Approval shows base commit, complete diff, changed protected paths, gate command, migration impact, and patch hash.
- Executor applies the approved patch to a fresh checkout, never the model workspace.
- Gate reruns after approval against the exact staged commit.
- Activation uses release directories/symlink or an equivalent atomic switch, not in-place mutation.
- Health requires process start plus P0 black-box probes.
- Previous release remains bootable until health passes.
- Changes to approval, capability registry, executor, deployment policy, secrets handling, or rollback require an additional explicit owner confirmation.

## Steps

1. Store selfdev diff, base commit, gate output, and file list as immutable artifacts.
2. Add protected-path classification and approval rendering.
3. Add a deployment-specific executor and state machine separate from Capability executor.
4. Create fresh staging checkout, apply exact patch, install frozen dependencies, run gate and migration dry-run.
5. Activate atomically, restart units, run health probes, and commit healthy state.
6. Automatically rollback on failed health; preserve artifacts and logs.
7. Add manual `oz deploy resolve` for `unknown`/rollback failure.
8. Consider standing grants only after repeated approved deployments show a narrow, stable class; never include protected paths.

## Verification

```sh
git diff --stat 2ce2a2a..HEAD -- src/core/selfdev.ts src/services src/db src/cli.ts test systemd
bun run gate
bun run test:deploy-e2e
```

Fault cases: base drift, patch mismatch, dependency failure, gate failure, migration dry-run failure, crash before switch, crash after switch, service start failure, black-box probe failure, rollback failure, and protected-path change.

## Done criteria

- Live source is never edited in place by the model or Sandbox.
- Activated code is byte-for-byte the approved patch on the approved base.
- Failed health returns the previous release to service automatically when possible.
- Governance/executor changes cannot approve themselves.
- Every stage and rollback is auditable with immutable artifacts.
