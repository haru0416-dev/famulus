# 001 Runtime safety foundation

Planned at `2ce2a2a`.

## Why

Configuration is read after imports in entrypoints while `DEFAULT_DB_PATH` is computed at module evaluation (`src/services/Db.ts:35`, `src/cycle.ts:20-41`). Numeric settings are parsed with unchecked `Number()`. The DB uses WAL but has no automated backup or restore rehearsal. Concurrent cycle execution is prevented only by systemd convention, not by a DB claim.

## Scope

In scope: `src/core/env.ts`, new typed config module, entrypoints, `src/services/Db.ts`, `src/db/*`, `src/services/Attention.ts`, `src/cycle.ts`, CLI status/maintenance, tests, deployment docs.

Out of scope: Discord delivery semantics, research schema, external connectors.

## Design

- Load and validate config before service modules consume values.
- Resolve data, workspace, and cache paths from repository/config root, never caller cwd.
- Create fresh databases from one current schema snapshot. Upgrade only recognized existing shapes through
  checksummed additive `schema_migrations`, then retain full schema shape verification.
- Add a `cycle_lease` row with owner process incarnation (host/boot ID, PID, process start identity), monotonic fence token, acquired_at, heartbeat_at, expires_at.
- Add SQLite online backup, integrity checks, restore-to-temp verification, and retention. Bun 1.3 has no
  online-backup binding, so use SQLite's transaction-consistent `VACUUM INTO` as the canonical supported
  alternative; never copy the live main/WAL files directly.
- Surface last successful backup, restore verification, lease holder, and config errors in `oz status`.

Lease state: `free -> held -> released`; expiry alone never authorizes steal. Recovery first proves the exact old process incarnation is dead (or supervisor kill-and-join succeeds), then transactionally increments the monotonic fence and claims it. If liveness is uncertain or the old process is still alive/paused, recovery refuses to steal. One process owns a lease token and only that owner+fence may renew, commit cycle plan transitions, hand work to an effect gateway, or release it; stale fences fail compare-and-swap.

## Steps

1. Introduce a schema-validated `Config` value and remove module-level environment reads.
2. Make every entrypoint call `loadEnv()` then construct `Config` before runtime layers.
3. Add a migration runner that adopts the exact v4 shape as the baseline, migrates it without rebuilding data,
   and rejects unknown or checksum-mismatched histories without modification.
4. Implement cycle lease claim, heartbeat, release, process-incarnation liveness checks, kill-and-join recovery where supported, monotonic fencing, and expired-lease recovery that refuses uncertain/live owners. Check the current fence before every durable plan transition and before handing work to model/tool/Delivery gateways; later plans add their own per-attempt fences rather than weakening this root fence.
5. Implement `oz backup`, `oz restore --verify`, and `oz doctor` using SQLite backup APIs and integrity checks.
6. Add tests for invalid numbers, cwd independence, migration idempotency, two-process lease contention, paused live owner past expiry refusing steal, dead process incarnation recovery, PID reuse/start-identity mismatch, stale owner commit/effect-handoff fence rejection, and restore verification.

## Verification

Run:

```sh
git diff --stat 2ce2a2a..HEAD -- src/core src/db src/services/Db.ts src/services/Attention.ts src/cycle.ts src/cli.ts test
bun run gate
bun run oz doctor
```

Expected: gate passes; invalid config exits before opening a DB; two concurrent cycle probes produce one lease owner; an expired but live owner cannot be replaced; a dead owner can be replaced with a higher fence and its stale writes are rejected; a restored temporary DB passes `integrity_check`, `foreign_key_check`, and schema verification.

## Done criteria

- No service reads process environment at module evaluation.
- Starting from another cwd opens the configured DB, not a new relative DB.
- Existing production data survives migration.
- Concurrent cycle invocations cannot process the same plan.
- Lease expiry cannot create split-brain: takeover requires proven old-incarnation death and stale fences cannot commit or hand off effects.
- Backup restoration is automatically tested, not merely written.

## Stop conditions

Stop if Bun's SQLite API cannot perform a WAL-safe online backup; select and document a canonical SQLite-supported alternative before continuing.
