# 007 Capability, MCP, connector, and operation boundary

Planned at `2ce2a2a`.

Depends on plans 001, 002, and 009. This fixes the future shape; do not add empty production tables without the dummy/reference capability and end-to-end tests in the same change.

## Why

Proposals intentionally stop at approved and store a payload hash, but the displayed card does not show the canonical payload (`src/services/Proposals.ts:8-19`, `src/cli.ts:147-165`). Generic MCP exposure would also erase the current structural separation between research-only tools and state-changing tools.

## Boundary

Before adding external capabilities, inventory every model-visible built-in tool and classify its effect. Existing `shell(net: true)` is network egress plus arbitrary code execution, and `tell`/draft delivery is `share`; neither is implicitly safe because it is first-party or sandboxed. Agent profiles are deny-by-default: an unclassified tool is unavailable, and plugin-provided instructions run without ambient network shell or direct delivery tools.

```ts
type EffectAtom =
  | "local.read"
  | "local.append"
  | "workspace.write"
  | "network.egress"
  | "code.exec"
  | "share.owner"
  | "share.third-party"
  | "external.write"
  | "money"
  | "deploy"

interface Capability<I, O> {
  id: string
  version: string
  effects: readonly EffectAtom[]
  execution: "inline" | "operation"
  recoverability: "replay-safe" | "reconcile" | "manual"
  inputSchema: Schema<I>
  outputSchema: Schema<O>
  normalize(input: I): I
  resources(input: I): ResourceRequest
  preview(input: I): ApprovalView
  idempotencyKey(input: I): string
  execute(ctx: ExecutionContext<I>): Effect<O, ConnectorError>
  verify(ctx: VerificationContext<I, O>): Effect<Verification>
  reconcile?(ctx: ReconcileContext<I, O>): Effect<ReconcileResult>
}
```

MCP discovery may produce capability candidates but never bypass this interface. Agent Plugins package loading belongs to plan 010 and is only one source of MCP configuration and Skills. `@ai-sdk/mcp` converts protocol tools into AI SDK tools only after registry validation. Raw MCP tools are `unknown` and disabled by default; descriptions and annotations cannot establish read-only behavior. Direct model execution is allowed only for an audited local adapter whose normalized input resources are checked against grant constraints. Provider-executed external-I/O tools are forbidden even for reads because local code cannot commit an invocation before their I/O. A provider may implement no-I/O protocol primitives such as structured response formatting as an internal tool; classify and allow those only when contract tests prove they cannot independently perform external I/O or expose model authority.

An effect is not automatically an approval boundary. `inline` execution is allowed only for a host-owned adapter with a committed invocation journal, active standing grant, resource/data-scope authorization, bounded origin/method, and declared replay-safe recovery. Initial inline cases are public-data Search restricted to configured origins/read methods and a Delivery Capability that idempotently enqueues owner replies/notifications/review drafts under a narrow `share.owner` grant. Third-party publication, credentialed reads, arbitrary egress, code execution, external write, money, and deploy use `operation`; policy may auto-approve a narrowly granted Operation but cannot omit it. Unknown remote behavior, including raw MCP tools, is disabled rather than guessed or wrapped in an Operation.

## Data model

`provider_instances` / `provider_generations`: source-neutral connector/MCP identity, immutable configuration/artifact binding, state (`staged/probing/inspected/enabled/disabled/revoked`), active generation, timestamps.

`capability_grants`: provider generation, capability/adapter version, input/output schema hashes, effect/execution ceiling, origin/method/workspace/target/input/data constraints, credential scope, grant state, timestamps.

`provider_sessions`: generation, transport/process reference, credential lease, state, opened/closed timestamps.

`operations`: proposal ref, capability grant, normalized spec, spec hash, idempotency key, risk, state, lease, external ref, timestamps.

`operation_approvals`: the only authoritative approval, bound to operation ID and exact spec hash, actor, decision, expiry, timestamps.

`operation_attempts`: append-only attempt, started/finished, outcome (`success/failed/partial/unknown`), receipt, error.

State: `prepared -> awaiting_approval -> approved -> executing -> waiting_delivery | verifying -> succeeded`; alternatives are `denied`, `expired`, `retry_wait`, `failed`, `unknown`, `cancelled`.

Rules:

- Approval displays the exact normalized spec and hash that execution uses.
- Approval checks expiry in the same transaction as the decision.
- Timeout/disconnect after external I/O becomes `unknown`, never automatic retry.
- Retry requires capability-declared safety or successful reconciliation proving non-application.
- Existing legacy proposals are never retrospectively executable.
- Credentials are resolved by connector code outside model and Sandbox contexts.
- Model tools bound to `execution: "operation"` only prepare an Operation and stop. They never hold an AI SDK `execute` function that performs the effect.
- AI SDK `toolApproval` may carry a UI/message projection of an Operation decision, but replay never triggers an operation-classified SDK tool. SQLite `operation_approvals` is the sole authority.
- Provider-executed write tools are prohibited because local `toolApproval`, operation attempts, and outbox cannot intercept their side effects.
- Provider-executed external read/search tools are also prohibited because local invocation journal and resource authorization cannot precede their I/O.
- Revocation closes sessions, kills local processes/containers, expires credential leases, and blocks egress before new external I/O.
- An Operation classified as third-party share atomically enqueues a Delivery bound to its spec hash and enters `waiting_delivery`. Delivery owns send attempts, retry, reconciliation, and receipt; Operation only projects the terminal receipt into verification.

## Steps

1. Inventory all built-in and provider-injected/native model tools and assign effects, resources, allowed agent profiles, egress, credential, and approval policy. Remove ambient access to unclassified tools; model-controlled network shell and direct delivery cannot be inherited by plugin Skills. Provider adapters may not append or execute external-I/O tools after the effective toolset is validated. Plan 009 first routes web search through the existing local Search tool binding; this plan later registers it in the Capability model without creating a second runtime path.
2. Fix proposal expiry-at-decision and canonical payload preview, then make new approvals reference Operations rather than executable proposal payloads.
3. Add static Capability registry with the existing local Search binding and plan 002 owner Delivery enqueue as the first host-owned inline capabilities.
4. Add source-neutral provider generation, grant, session, operation, approval, and attempt schema with one reader, writer, CLI, and E2E test.
5. Define provider generation commit/recovery: stage filesystem/config, persist inspected generation, atomically select it in SQLite, and reconcile orphan staging/active records at startup.
6. Implement prepare, resource/data-scope authorization, approve, claim, execute, verify, reconcile, revoke, and manual resolve APIs. Authorization compares normalized-input resources and outbound data classification with grant constraints before creating an invocation or Operation.
7. Add a separate executor unit that never invokes an LLM.
8. Add `@ai-sdk/mcp` only here; persist MCP session metadata in SQLite, use HTTP transport for production, and keep stdio disabled until plan 010 proves a runtime closure and sandbox profile.
9. Add a non-LLM quarantined probe lifecycle: connect/initialize/list capabilities with tool calls forbidden, temporary scoped credentials, isolation, attempt/audit record, timeout, and teardown.
10. Add MCP adapter: inspected candidates stay disabled until a host-owned effect-specific adapter supplies runtime input/output decoders, schema hashes, effects, resources, execution mode, recovery, and grant constraints. The adapter may convert a known non-inline action to an Operation. Never infer these fields from MCP descriptions/annotations or pass unvalidated MCP output to model, verify, or reconcile code.
11. Add the first real connector only after fault injection passes.
12. Extract connector abstraction only when at least two independently implemented connectors prove the shared contract. The standards-compatible package loader is separate in plan 010.

## Verification

```sh
git diff --stat 2ce2a2a..HEAD -- src/services/Proposals.ts src/cli.ts src/db src/runtime.ts test
bun run gate
bun run test:operations-e2e
```

Required faults: approval expiry race, payload mutation, SDK approval replay, duplicate executor, Operation/delivery enqueue crash, duplicate delivery receipt, remote success then local crash, partial result, invalid connector output, unknown reconciliation, denied inline origin/method/data scope, non-replay-safe capability marked inline, probe crash, active-generation commit crash, MCP input/output schema drift, untrusted effect annotation, same-schema malicious remote behavior, denied credential scope, revocation with live session, and executor restart.

## Done criteria

- No model-controlled path can execute a write capability directly.
- The executor receives the exact approved canonical spec bytes; connector-added protocol/authentication fields are separate typed transport data and are audited separately.
- Every external attempt has an audit row created before I/O.
- `unknown` cannot transition to retry without reconciliation/manual decision.
- MCP registration cannot expand permissions silently; an unknown raw tool remains disabled and cannot create an Operation.
- Every model-visible tool is effect-classified, and plugin instructions cannot inherit ambient effectful tools.
- There is one approval authority: an exact Operation spec hash in SQLite.
- Provider update/revocation semantics apply equally to built-in connectors, direct MCP configurations, and Agent Plugin packages.
