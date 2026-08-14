# 007 Capability, MCP, connector, and operation boundary

Planned at `2ce2a2a`.

Depends on plans 001, 002, and 009. This fixes the future shape; do not add empty production tables without the dummy/reference capability and end-to-end tests in the same change.

## Why

Proposals intentionally stop at approved and store a payload hash, but the displayed card does not show the canonical payload (`src/services/Proposals.ts:8-19`, `src/cli.ts:147-165`). Generic MCP exposure would also erase the current structural separation between research-only tools and state-changing tools.

## Boundary

Before adding external capabilities, inventory every model-visible built-in tool and classify its effect. Existing `shell(net: true)` is network egress plus arbitrary code execution, and `tell`/draft delivery is `share`; neither is implicitly safe because it is first-party or sandboxed. Agent profiles are deny-by-default: an unclassified tool is unavailable, and plugin-provided instructions run without ambient network shell or direct delivery tools.

```ts
interface Capability<I, O> {
  id: string
  version: string
  effect: "read" | "write" | "share" | "money" | "deploy"
  inputSchema: Schema<I>
  outputSchema: Schema<O>
  normalize(input: I): I
  preview(input: I): ApprovalView
  idempotencyKey(input: I): string
  execute(ctx: ExecutionContext<I>): Effect<O, ConnectorError>
  verify(ctx: VerificationContext<I, O>): Effect<Verification>
  reconcile?(ctx: ReconcileContext<I, O>): Effect<ReconcileResult>
}
```

MCP discovery may produce capability candidates but never bypass this interface. Agent Plugins package loading belongs to plan 010 and is only one source of MCP configuration and Skills. `@ai-sdk/mcp` converts protocol tools into AI SDK tools only after registry validation. Raw MCP tools are `unknown` and disabled by default; descriptions and annotations cannot establish read-only behavior. Direct model execution is allowed only for an audited local adapter or an explicitly granted remote origin where the user accepts that read-only behavior cannot be technically enforced. Write/share/money/deploy capabilities produce an immutable operation spec and require policy/approval.

## Data model

`provider_instances` / `provider_generations`: source-neutral connector/MCP identity, immutable configuration/artifact binding, state (`staged/probing/inspected/enabled/disabled/revoked`), active generation, timestamps.

`capability_grants`: provider generation, capability/adapter version, input/output schema hashes, effect, credential scope, grant state, timestamps.

`provider_sessions`: generation, transport/process reference, credential lease, state, opened/closed timestamps.

`operations`: proposal ref, capability grant, normalized spec, spec hash, idempotency key, risk, state, lease, external ref, timestamps.

`operation_approvals`: the only authoritative approval, bound to operation ID and exact spec hash, actor, decision, expiry, timestamps.

`operation_attempts`: append-only attempt, started/finished, outcome (`success/failed/partial/unknown`), receipt, error.

State: `prepared -> awaiting_approval -> approved -> executing -> verifying -> succeeded`; alternatives are `denied`, `expired`, `retry_wait`, `failed`, `unknown`, `cancelled`.

Rules:

- Approval displays the exact normalized spec and hash that execution uses.
- Approval checks expiry in the same transaction as the decision.
- Timeout/disconnect after external I/O becomes `unknown`, never automatic retry.
- Retry requires capability-declared safety or successful reconciliation proving non-application.
- Existing legacy proposals are never retrospectively executable.
- Credentials are resolved by connector code outside model and Sandbox contexts.
- Effectful model tools only prepare an Operation and stop. They never hold an AI SDK `execute` function that performs the effect.
- AI SDK `toolApproval` may carry a UI/message projection of an Operation decision, but replay never triggers an effectful SDK tool. SQLite `operation_approvals` is the sole authority.
- Provider-executed write tools are prohibited because local `toolApproval`, operation attempts, and outbox cannot intercept their side effects.
- Revocation closes sessions, kills local processes/containers, expires credential leases, and blocks egress before new external I/O.

## Steps

1. Inventory all built-in and provider-injected/native model tools and assign effect, allowed agent profiles, egress, credential, and approval policy. Remove ambient access to unclassified tools; model-controlled network shell and direct delivery cannot be inherited by plugin Skills. Provider adapters may not append tools after the effective toolset is validated.
2. Fix proposal expiry-at-decision and canonical payload preview, then make new approvals reference Operations rather than executable proposal payloads.
3. Add static Capability registry and a no-side-effect reference capability.
4. Add source-neutral provider generation, grant, session, operation, approval, and attempt schema with one reader, writer, CLI, and E2E test.
5. Define provider generation commit/recovery: stage filesystem/config, persist inspected generation, atomically select it in SQLite, and reconcile orphan staging/active records at startup.
6. Implement prepare, approve, claim, execute, verify, reconcile, revoke, and manual resolve APIs.
7. Add a separate executor unit that never invokes an LLM.
8. Add `@ai-sdk/mcp` only here; persist MCP session metadata in SQLite, use HTTP transport for production, and keep stdio disabled until plan 010 proves a runtime closure and sandbox profile.
9. Add a non-LLM quarantined probe lifecycle: connect/initialize/list capabilities with tool calls forbidden, temporary scoped credentials, isolation, attempt/audit record, timeout, and teardown.
10. Add MCP adapter: inspected candidates to capability descriptors with runtime input/output decoders and schema hashes, local effect classification, explicit grants, and write conversion to operations. Do not trust tool descriptions or annotations as permission evidence, and never pass unvalidated MCP output to model, verify, or reconcile code.
11. Add the first real connector only after fault injection passes.
12. Extract connector abstraction only when at least two independently implemented connectors prove the shared contract. The standards-compatible package loader is separate in plan 010.

## Verification

```sh
git diff --stat 2ce2a2a..HEAD -- src/services/Proposals.ts src/cli.ts src/db src/runtime.ts test
bun run gate
bun run test:operations-e2e
```

Required faults: approval expiry race, payload mutation, SDK approval replay, duplicate executor, remote success then local crash, partial result, invalid connector output, unknown reconciliation, probe crash, active-generation commit crash, MCP input/output schema drift, untrusted effect annotation, same-schema malicious remote behavior, denied credential scope, revocation with live session, and executor restart.

## Done criteria

- No model-controlled path can execute a write capability directly.
- Executed bytes equal approved normalized spec bytes.
- Every external attempt has an audit row created before I/O.
- `unknown` cannot transition to retry without reconciliation/manual decision.
- MCP registration cannot expand permissions silently.
- Every model-visible tool is effect-classified, and plugin instructions cannot inherit ambient effectful tools.
- There is one approval authority: an exact Operation spec hash in SQLite.
- Provider update/revocation semantics apply equally to built-in connectors, direct MCP configurations, and Agent Plugin packages.
