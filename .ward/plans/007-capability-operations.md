# 007 Capability, MCP, connector, and operation boundary

Planned at `2ce2a2a`.

Depends on plans 001, 002, and 009. This fixes the future shape; do not add empty production tables without the dummy/reference capability and end-to-end tests in the same change.

## Why

Proposals intentionally stop at approved and store a payload hash, but the displayed card does not show the canonical payload (`src/services/Proposals.ts:8-19`, `src/cli.ts:147-165`). Generic MCP exposure would also erase the current structural separation between research-only tools and state-changing tools.

## Boundary

Before adding external capabilities, inventory every model-visible built-in tool and classify its effect. Existing `shell(net: true)` is network egress plus arbitrary code execution, and `tell`/draft delivery is `share`; neither is implicitly safe because it is first-party or sandboxed. Agent profiles are deny-by-default: an unclassified tool is unavailable, and plugin-provided instructions run without ambient network shell or direct delivery tools.

```ts
interface CapabilityImplementationRef {
  readonly id: string
  readonly generation: string
  readonly digest: string
  readonly inputSchemaDigest: string
  readonly outputSchemaDigest: string
}

interface EffectIdentity {
  readonly providerInstanceId: string
  readonly principalId: string // stable non-secret external account/tenant identity
}

interface IdempotencyContractRef {
  readonly id: string
  readonly generation: string
  readonly digest: string
}

interface RetryPolicyRef {
  readonly id: string
  readonly generation: string
  readonly digest: string
  readonly maxAttempts: number
  readonly deadlineAt: string
  readonly requestBudget: number
  readonly costBudget?: number
  readonly backoffScheduleMs: readonly number[]
}

interface EffectIntentRef {
  readonly ownerKind: string
  readonly ownerId: string
  readonly actionSlot: string
}

interface Capability<I, O> {
  id: string
  version: string
  implementation: CapabilityImplementationRef
  idempotency: IdempotencyContractRef
  effects: readonly EffectAtom[]
  execution: "inline" | "operation"
  recoverability: "replay-safe" | "reconcile" | "manual"
  inputSchema: Schema<I>
  outputSchema: Schema<O>
  resources(input: I): ResourceRequest
  preview(input: I): ApprovalView
  execute(ctx: ExecutionContext<I>): Effect<O, ConnectorError>
  verify(ctx: VerificationContext<I, O>): Effect<Verification>
  reconcile?(ctx: ReconcileContext<I, O>): Effect<ObservedReconcileResult>
}
```

`reconcile` may observe remote state and classify already-applied sub-effects, but it cannot perform a compensating/completing write. Any additional external effect is a separate canonical Operation linked to the original as `completion` or `compensation`, with its own resource authorization, spec hash, idempotency key, approval decision, and attempt-before-I/O record.

The host-owned IdempotencyContract registry, not Capability implementation code, validates and canonicalizes raw input, produces the immutable normalized spec bytes/hash, and derives namespace/key from those bytes plus EffectIdentity and EffectIntentRef. Capability methods receive only that canonical value. A retry/replay carries the same EffectIntentRef; an intentional repeat uses a new owner-issued intent/slot even when the payload is identical. A compatible implementation update must retain the same contract ref and derivation. Changing the contract requires a new Capability identity or an explicit migration that first reconciles/blocks every nonterminal Operation under the old contract.

`EffectAtom` is the closed classification vocabulary introduced by plan 009; this plan adds resource/grant/Operation semantics without defining a second effect taxonomy.

MCP discovery may produce capability candidates but never bypass this interface. Agent Plugins package loading belongs to plan 010 and is only one source of MCP configuration and Skills. `@ai-sdk/mcp` converts protocol tools into AI SDK tools only after registry validation. Raw MCP tools are `unknown` and disabled by default; descriptions and annotations cannot establish read-only behavior. Direct model execution is allowed only for an audited local adapter whose normalized input resources are checked against grant constraints. Provider-executed external-I/O tools are forbidden even for reads because local code cannot commit an invocation before their I/O. A provider may implement no-I/O protocol primitives such as structured response formatting as an internal tool; classify and allow those only when contract tests prove they cannot independently perform external I/O or expose model authority.

An effect is not automatically an approval boundary. `inline` execution is allowed only for a host-owned adapter with a committed invocation journal, active standing grant, resource/data-scope authorization, bounded origin/method, and declared replay-safe recovery. Initial inline cases are public-data Search restricted to configured origins/read methods and a Delivery Capability that idempotently enqueues owner replies/notifications/review drafts under a narrow `share.owner` grant. Third-party publication, credentialed reads, arbitrary egress, code execution, external write, money, and deploy use `operation`; policy may auto-approve a narrowly granted Operation but cannot omit it. Unknown remote behavior, including raw MCP tools, is disabled rather than guessed or wrapped in an Operation.

## Data model

`provider_instances` / `provider_generations`: source-neutral connector/MCP identity, immutable configuration/artifact binding, state (`staged/probing/inspected/enabled/disabled/revoked`), active generation, timestamps.

`capability_grants`: provider generation, immutable CapabilityImplementationRef and IdempotencyContractRef, stable provider instance/principal identity, capability/adapter version, input/output schema hashes, effect/execution ceiling, origin/method/workspace/target/input/data constraints, credential scope, grant state, timestamps.

`provider_sessions`: generation, transport/process reference, credential lease, state, opened/closed timestamps.

`operations`: stable EffectIntentRef, optional parent Operation and relation (`completion | compensation`) plus parent quiescence/reconciliation snapshot refs and claimed parent resolution epoch, stable EffectIdentity, immutable CredentialLeaseRef, capability grant, CapabilityImplementationRef, IdempotencyContractRef, and RetryPolicyRef, normalized spec, spec hash, approval epoch, resolution epoch/optional exclusive resolution owner, stable idempotency namespace/key, risk, state, monotonic execution fence/current attempt and executor process incarnation, next_at, consumed request/cost budget, external ref, timestamps; unique `(idempotency_namespace, idempotency_key)` and globally unique `(effect_intent_owner_kind, effect_intent_owner_id, action_slot)`. The namespace includes provider instance and external principal/account identity plus the effect/action domain, and survives credential/grant/provider/implementation-generation rotation for that same principal. Reusing an EffectIntentRef with a different EffectIdentity or canonical spec is a Conflict, never a second Operation.

`operation_approvals`: the only authoritative approval, bound to operation ID, exact spec hash, grant ref, CapabilityImplementationRef, IdempotencyContractRef, CredentialLeaseRef, RetryPolicyRef, approval epoch, actor, decision, expiry, timestamps.

`operation_attempts`: append-only attempt, monotonic fence token, exact executor process incarnation (host/boot/PID/start identity), started/finished/deadline, reserved/consumed request and cost units, outcome (`success/failed/partial/unknown`), typed receipt with confirmed sub-effect IDs/digests, error.

`operation_io_requests`: append-only per-external-request rows bound to Operation attempt/fence, canonical request hash, reserved/consumed request and cost units, started/finished, remote idempotency key/receipt, outcome. Connector code has no raw network transport; every external request, including execute, verify, and reconcile traffic, passes through this gateway and commits its row/budget debit before I/O.

State: `prepared -> awaiting_approval -> approved -> executing -> waiting_delivery | verifying -> succeeded`; alternatives are `denied`, `expired`, `retry_wait`, `partial`, `failed`, `unknown`, `cancelled`.

Rules:

- Approval displays the exact normalized spec/hash, grant, implementation/idempotency generations, credential identity/lease expiry, RetryPolicy limits/deadline/backoff/cost ceiling, and EffectIntentRef that execution uses.
- Approval decisions carry the displayed approval epoch and compare-and-swap operation ID + spec hash + grant ref + CapabilityImplementationRef + IdempotencyContractRef + CredentialLeaseRef + RetryPolicyRef + epoch + expected `awaiting_approval` state while checking expiry in one transaction. A stale screen/request is rejected.
- Timeout/disconnect after external I/O becomes `unknown`, never automatic retry.
- Retry requires capability-declared safety or successful reconciliation proving non-application.
- Retry also requires remaining approved attempts, deadline, request/cost budget, and the due `next_at`. RetryPolicy is immutable after approval; exhaustion becomes terminal/manual rather than extending the policy silently.
- `partial` means the typed receipt confirms an explicit subset of externally visible sub-effects. It never retries automatically. Read-only reconciliation/manual resolution may mark already-observed completion or terminate it; any new completion/compensation effect requires a separately authorized linked Operation.
- A linked completion/compensation may be drafted while the parent is unresolved, but it cannot enter approval/claim until a durable parent-quiescence proof records that every parent executor/process/session is dead, kill-and-joined, or externally fenced with egress cut off, and a read-only reconciliation snapshot identifies the exact confirmed/missing sub-effects. Linked claim atomically CASes the parent's current resolution epoch from unowned to an exclusive owner `(linked_operation_id, linked_attempt_id)` and stores that epoch on the child. While owned, parent retry/reconcile/manual terminalization and any sibling linked claim are forbidden. Every child external request rechecks the parent epoch/owner immediately before I/O. Child terminal resolution atomically releases or advances the parent's resolution state; stale snapshots/children cannot act. Parent manual terminalization/cancellation has the same quiescence and exclusive-epoch prerequisite. If quiescence is uncertain, both parent resolution and linked effect execution remain blocked.
- Existing legacy proposals are never retrospectively executable.
- Credentials are resolved by connector code outside model and Sandbox contexts.
- Model tools bound to `execution: "operation"` only prepare an Operation and stop. They never hold an AI SDK `execute` function that performs the effect.
- AI SDK `toolApproval` may carry a UI/message projection of an Operation decision, but replay never triggers an operation-classified SDK tool. SQLite `operation_approvals` is the sole authority.
- Provider-executed write tools are prohibited because local `toolApproval`, operation attempts, and outbox cannot intercept their side effects.
- Provider-executed external read/search tools are also prohibited because local invocation journal and resource authorization cannot precede their I/O.
- Revocation closes sessions, kills local processes/containers, expires credential leases, and blocks egress before new external I/O.
- One active grant must authorize the entire normalized resource request, including origin, method, credential, workspace/target, input, and outbound data constraints. Authorization never unions dimensions from multiple grants.
- Credential resolution must produce a stable non-secret principal ID and immutable CredentialLeaseRef before Operation prepare. Different provider instances or principals cannot share an idempotency namespace or rebind an existing Operation. Before approval, same-principal credential rotation is a full binding rebind: atomically replace the lease, increment approval epoch, and issue a new approval view. After approval, the lease is immutable; expiry/mismatch before the first I/O expires the Operation, while expiry/mismatch after an attempt requires reconciliation/manual resolution. Claim and immediately-before-each-I/O checks resolve the pinned lease, verify it is active and still maps to the stored EffectIdentity, and stop before I/O on mismatch/expiry; substituting ambient/current credentials is forbidden. A later credential requires a new EffectIntentRef/new Operation unless reconciliation proves a defined safe continuation contract.
- For a third-party share Capability, the host-owned canonicalization contract deterministically derives the complete ordered Delivery action list (message parts, reply refs, thread creation, reactions), destination, binding projection, and retry ceiling from the exact approved Operation spec. Approval displays and hashes that delivery projection. Enqueue recomputes it and requires byte/hash equality; it cannot append an unapproved action. In one transaction, the Operation advances its resolution epoch, assigns exclusive resolution owner `(delivery, delivery_id)`, enqueues the Delivery with an `OperationDeliveryAuthorizationRef` containing that parent epoch/owner plus Operation ID/spec/approval epoch, CapabilityImplementationRef, EffectIdentity, CredentialLeaseRef, grant/revocation generation, and intersected RetryPolicyRef, then enters `waiting_delivery`. Delivery owns send attempts, retry, reconciliation, and receipt only while that parent epoch/owner remains current. Delivery terminalization atomically releases/advances the parent resolution epoch, and Operation accepts only a receipt whose delivery spec hash and epoch match the approved projection. A linked Operation cannot acquire the parent while any Delivery owns it; manual release requires the Delivery terminal plus exact worker-incarnation quiescence.
- Preparing an Operation is insert-or-return: the same stable namespace/key plus same spec hash returns the existing row across grant generations; a different spec hash is a Conflict. An existing `unknown` or `succeeded` Operation blocks replacement after update. Operation creation, invocation reference, and the domain transition to `waiting_on_operation` occur in one SQLite transaction.
- Binding rotation never silently changes an approved effect. A matching `prepared` or `awaiting_approval` Operation may be atomically rebound to a new compatible grant/implementation/credential lease only after full resource/policy authorization, the same EffectIdentity, and the same IdempotencyContractRef. Rebind increments the approval epoch, invalidates all outstanding approval requests/decisions, and emits a new approval view before any decision can be accepted. `approved`, `executing`, `waiting_delivery`, `verifying`, `retry_wait`, `partial`, `unknown`, and `succeeded` stay pinned to the original binding tuple; revocation/expiry blocks execution or requires reconciliation/manual resolution according to state.
- Capability implementation, IdempotencyContract, and credential-lease references are retained by every nonterminal Operation/attempt. Claim, execute, verify, and reconcile resolve the exact pinned references; a missing/digest-mismatched implementation or identity-mismatched credential stops execution and cannot fall forward to current code or ambient credentials, even when a human-readable adapter version is unchanged.
- Claim atomically increments a monotonic execution fence, creates the Operation attempt-before-I/O row, and binds the exact executor process incarnation. A linked claim also acquires the parent's exclusive resolution epoch in that transaction. Each external request then atomically reserves/debits its own approved request/cost unit and creates an `operation_io_requests` row before I/O; the transport gateway rejects raw/unbudgeted second requests. Lease/worker loss after any request starts transitions to `unknown`; expiry alone never makes the Operation reclaimable. Reconciliation/manual resolution may move an unowned Operation to `retry_wait`, but a new claim/fence is forbidden while its resolution epoch is owned and until the supervisor proves the old process incarnation is dead or kill-and-join succeeds; uncertain or paused-live owners remain blocked. The gateway verifies the current fence, attempt/incarnation, credential lease, deadline, remaining budget, and for linked Operations the unchanged parent resolution epoch/owner immediately before every I/O with no intervening await. Where a remote API accepts an idempotency/fencing key, the connector must send the Operation/request key/fence; otherwise any ambiguous loss remains `unknown` and still requires old-incarnation death before a duplicate-safe/reconciled retry.

Binding rotation/reprepare by state:

| State | Rebind | Same namespace/key prepare |
|---|---|---|
| `prepared`, `awaiting_approval` | same EffectIdentity/IdempotencyContract only; increment approval epoch and issue a new approval request | return/rebind existing row |
| `approved` | forbidden | return existing; revoked/expired binding before first I/O expires it and requires a new EffectIntentRef |
| `executing`, `waiting_delivery`, `verifying`, `partial`, `unknown` | forbidden | return existing; executor/reconciler remains sole owner |
| `retry_wait` | forbidden until reconciliation/policy confirms retry under pinned grant; revoked grant requires manual resolution | return existing |
| `succeeded` | forbidden | return receipt; never create replacement |
| `failed`, `denied`, `expired`, `cancelled` | forbidden | return terminal row; a genuinely new EffectIntentRef/action slot derives a new idempotency key |

## Steps

1. Inventory all built-in and provider-injected/native model tools and assign effects, resources, allowed agent profiles, egress, credential, and approval policy. Remove ambient access to unclassified tools; model-controlled network shell and direct delivery cannot be inherited by plugin Skills. Provider adapters may not append or execute external-I/O tools after the effective toolset is validated. Plan 009 first routes web search through the existing local Search tool binding; this plan later registers it in the Capability model without creating a second runtime path.
2. Fix proposal expiry-at-decision and canonical payload preview, then make new approvals reference Operations rather than executable proposal payloads.
3. Add static Capability registry with the existing local Search binding and plan 002 owner Delivery enqueue as the first host-owned inline capabilities.
4. Add source-neutral provider generation, immutable CapabilityImplementation/IdempotencyContract/CredentialLease/RetryPolicy generations and leases, grant, session, operation, approval, and fenced attempt schema with one reader, writer, CLI, and E2E test.
5. Define provider generation commit/recovery: stage filesystem/config, persist inspected generation, atomically select it in SQLite, and reconcile orphan staging/active records at startup.
6. Implement host-owned canonicalization/idempotency and RetryPolicy contracts plus idempotent prepare, resource/data-scope authorization, approve, fenced claim, execute, verify, read-only reconcile, revoke, parent-quiescence proof, and manual resolve APIs. Authorization compares canonical-input resources and outbound data classification with grant constraints before atomically creating/reusing an Operation and binding its EffectIntentRef. Completion/compensation APIs always prepare a separately linked Operation with a new action slot rather than executing I/O inside reconciliation, and approval/claim verifies the current parent quiescence proof and reconciliation snapshot.
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

Required faults: approval expiry race, payload mutation, SDK approval replay, duplicate prepare returning the same Operation, same intent/payload across implementation updates returning the same Operation, same EffectIntentRef with changed canonical spec or EffectIdentity conflict, identical payload with a new EffectIntentRef producing a distinct Operation, same input under different provider instances/principals requiring distinct EffectIntentRefs and producing distinct Operations, pre-approval credential rotation incrementing epoch, post-approval credential rotation rejection, credential swapped to another principal after approval, expired/missing lease immediately before first I/O expiring the Operation, expiry after attempt requiring reconciliation, ambient credential substitution rejection, cross-principal rebind rejection, implementation update retaining the same host canonicalization/idempotency derivation, idempotency-contract change with nonterminal Operation rejection, retry-policy mutation after approval rejection, max-attempt/deadline/request/cost exhaustion, multi-request connector debiting every request, second request above budget rejected before I/O, raw connector transport unavailable, backoff due-time enforcement, repeated 503 reconciliation bounded by the approved policy, grant rotation rebind incrementing approval epoch, stale pre-rebind approval decision rejection, concurrent rebind/decision CAS, grant/provider/CapabilityImplementation update in every Operation state including `retry_wait`, same adapter version with changed implementation digest, missing pinned implementation on resume, terminal same-intent reprepare returning the terminal row, crash around atomic Operation/domain binding, stale executor after lease expiry, paused executor after final fence check blocking reassignment, uncertain old-incarnation liveness refusing new fence, kill-and-join then retry, PID reuse/start-identity mismatch, concurrent claim fence CAS, fence change immediately before I/O, executor crash after started becoming unknown rather than reclaimable, approved Delivery projection exact match, added thread/reaction after approval conflict, changed Delivery action order/hash conflict, atomic parent-epoch/Delivery enqueue, Delivery retry retaining parent resolution ownership, linked claim blocked by waiting/retryable/unknown Delivery, parent epoch changed before Delivery claim/I/O rejection, Delivery terminal receipt and parent epoch release atomicity, manual Delivery release requiring terminal state and worker quiescence, duplicate delivery receipt, mismatched delivery receipt/epoch rejection, remote success then local crash, partial result with typed confirmed sub-effects, reconciliation attempting write rejection, linked completion/compensation requiring independent authorization/approval/idempotency/attempt, linked approval/claim blocked while parent executor or session is live/uncertain, stale parent quiescence snapshot rejection, two linked children racing for one parent epoch, parent retry racing linked claim, parent retry blocked for the lifetime of linked I/O, parent epoch changed before child I/O rejection, kill-and-join plus reconciliation before linked effect, parent manual terminalization blocked without quiescence/exclusive epoch, invalid connector output, unknown reconciliation, denied inline origin/method/data scope, cross-grant origin/credential/data laundering denial, non-replay-safe capability marked inline, probe crash, active-generation commit crash, MCP input/output schema drift, untrusted effect annotation, same-schema malicious remote behavior, denied credential scope, revocation with live session, and executor restart.

## Done criteria

- No model-controlled path can execute a write capability directly.
- The executor receives the exact approved canonical spec bytes; connector-added protocol/authentication fields are separate typed transport data and are audited separately.
- Every external attempt has an audit row created before I/O.
- `unknown` cannot transition to retry without reconciliation/manual decision.
- MCP registration cannot expand permissions silently; an unknown raw tool remains disabled and cannot create an Operation.
- Every model-visible tool is effect-classified, and plugin instructions cannot inherit ambient effectful tools.
- There is one approval authority: the exact Operation/spec/grant/implementation/approval-epoch tuple in SQLite.
- Provider update/revocation semantics are source-neutral and proven here for built-in connectors and direct MCP configurations. Plan 010 must prove that Agent Plugin package generations bind to this same contract rather than making package loading a prerequisite for plan 007 completion.
