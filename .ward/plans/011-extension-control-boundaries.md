# 011 Extension control boundaries

Planned at `dd7b4bf`.

Phase A depends on plan 009 and is required before plan 006. Gated plugin Skill import depends on plan 010; observer-triggered effects depend on plan 007.

## Decision

Do not create a generic `Extension`, workflow DAG, executable plugin hook, plugin-owned agent loop, or privileged permanent main loop. Share a small execution-root/loop/scope kernel while each durable domain keeps its own state machine.

```text
input / timer / committed event
  -> deterministic candidate resolver
  -> host-owned SkillPlan compiler
  -> policy compiler
  -> immutable ExecutionRoot + one or more LoopSpecs
  -> bounded AI SDK loop invocations (sequential or parallel)
  -> journaled Capability call
       |- permitted inline read/local action
       `- immutable Operation -> approval/policy -> non-LLM executor
```

Models reason inside independent loop invocations. The host chooses Skill slots and compiles authority. SQLite owns shared budget and durable state. A domain service creates fixed-purpose batches and decides whether more loops are needed. The executor performs external effects.

## Responsibility table

| Mechanism | May decide | State owner | May grant authority | May execute effects |
|---|---|---|---|---|
| Skill | one method or presentation instruction layer | none; only pinned references on LoopSpec | no | no |
| SkillPlan compiler | zero to two orthogonal slot bindings | immutable plan/hash | no; capability hints are ignored for authority | no |
| Skill router (deferred) | `none` or one allowed SkillRef for one offered slot | route decision record | no | no |
| Agent profile | model/tool/effect ceilings and prompt layer | code-owned registry | only by intersecting existing grants | no |
| Policy compiler | immutable `LoopSpec` and effective scope | root/loop rows | cannot exceed root/profile/grants | no |
| Execution root | root scope, budget, deadline, concurrency | root/budget rows | no | no |
| AI SDK loop invocation | next model/tool step inside one LoopSpec | independent checkpoint/invocation rows | no | only through bound Tool Gateway |
| Coordinator loop | propose bounded worker requests from offered templates | ordinary LoopSpec/result | no; tool-less and non-privileged | no |
| Worker/reviewer/synthesizer loop | perform one scoped role | separate LoopSpec/checkpoint | no; scope is a strict subset | only through its bindings |
| Domain service | durable transitions and whether to schedule another loop batch | domain tables | no | only by requesting Capability/Operation |
| Hook observer | request a core-owned handler after a committed event | offset/attempt only | no; request is re-authorized | no |
| Plugin | package Skills and MCP provider candidates | generation/install records | no | no |
| Capability | validate and classify a named action | grant and invocation journal | grant comes from owner/policy | inline only if policy permits |
| Operation executor | execute an exact approved spec | operation/attempt/receipt | no | yes, without an LLM |

## Skill model

```ts
interface SkillRef {
  readonly id: string
  readonly generation: string
  readonly digest: string
}

interface CompositionPolicyRef {
  readonly id: string
  readonly generation: string
  readonly digest: string
}

interface LoopTemplateRef {
  readonly id: string
  readonly generation: string
  readonly digest: string
}

interface SkillDefinition {
  readonly ref: SkillRef
  readonly source: "core" | "plugin"
  readonly slot: "method" | "presentation"
  readonly composition: "exclusive" | "orthogonal"
  readonly summary: string
  readonly instructions: string
  readonly allowedProfiles: readonly ProfileId[]
  readonly requestedTools: readonly string[] // routing/setup hints only
}

// Canonical shape is introduced by plan 009; this plan populates and validates its slots.
interface SkillPlan {
  readonly method?: SkillRef
  readonly presentation?: SkillRef
  readonly compositionPolicy: CompositionPolicyRef
  readonly hash: string
}
```

Selection order per slot:

1. Explicit `SkillRef` supplied by a trusted caller.
2. Skill pinned in a domain checkpoint.
3. Deterministic activation rule with one matching candidate.
4. Deferred: tool-less router chooses `none | SkillRef` from trusted descriptors for that slot.
5. Otherwise no Skill.

Rules:

- A LoopSpec has zero to two Skill bindings: at most one `method` and one `presentation`.
- Only host-classified `orthogonal` method/presentation pairs may share a loop. An `exclusive` Skill runs alone.
- Plugin Skills default to `exclusive`; package metadata cannot declare itself orthogonal. Owner/admin classification is generation-pinned and included in the SkillPlan hash.
- Plugin Skills are explicit-selection-only by default. Automatic routing uses built-in descriptors or short descriptors authored/approved by the owner, never package-supplied summaries or Skill text.
- The deferred router receives candidate IDs/trusted routing descriptors and task classification text, not Skill bodies, tools, credentials, or unrestricted memory.
- Router output is structured and must name an offered generation-pinned reference.
- A Skill cannot activate another Skill, alter its slot/order, switch itself mid-loop, start a loop, select a model, increase steps, or load its scripts.
- Non-orthogonal methods, competing strategies, and Skills requiring different data/tool scopes run in separate loop invocations and exchange only typed artifacts.
- Built-in and plugin Skills normalize to the same internal type and execution path.
- Prompt order is `SOUL/Governance > AgentProfile > owner/task contract > Skill(method) > Skill(presentation) > retrieved/untrusted data`.
- Prompt precedence is not a security boundary; Tool Gateway and scope enforce authority.
- Skill capability hints are never unioned into the effective toolset. Adding a Skill changes instructions only.

For generic publishing, a research/evidence `method` Skill and an article/report/thread `presentation` Skill may share a loop when host-classified orthogonal. Target-specific Zenn/Qiita/note formatting remains a deterministic renderer rather than a third Skill. Evidence references, secret-leak checks, review requirements, allowed targets, and publication approval are enforced by typed artifact validators and Publisher Capability preconditions, not prompt precedence.

## Execution root and scope

```ts
interface ExecutionRoot {
  readonly id: string
  readonly scopeId: string
  readonly rootBudgetId: string
  readonly deadlineAt: string
  readonly maxActiveLoops: number
  readonly coordinatorReserve: BudgetVector
}

interface ExecutionScope {
  readonly id: string
  readonly parentId?: string
  readonly profile: ProfileRef
  readonly corePolicies: readonly CoreToolPolicyRef[]
  readonly effectCeiling: readonly EffectAtom[]
  readonly origins: readonly string[]
  readonly credentialScopes: readonly string[]
  readonly workspaces: readonly string[]
  readonly dataScope: DataScope
  readonly budget: { readonly modelCalls: number; readonly toolCalls: number; readonly tokens?: number }
  readonly deadlineAt: string
  readonly maxDelegationDepth: number
  readonly rootBudgetId: string
}

interface LoopSpec {
  readonly id: string
  readonly rootId: string
  readonly stableSlotId: string
  readonly role: "interactive" | "autonomous" | "coordinator" | "worker" | "reviewer" | "synthesizer"
  readonly template: LoopTemplateRef
  readonly profile: ProfileRef
  readonly skillPlan: SkillPlan
  readonly taskInput: unknown // validated by the sealed template's input schema
  readonly taskInputHash: string
  readonly inputRefs: readonly ArtifactRef[]
  readonly inputHash: string
  readonly promptLayers: readonly PromptLayer[]
  readonly modelPolicy: ModelPolicy
  readonly tools: readonly ToolBinding[]
  readonly scopeId: string
  readonly resultContract: ResultContractRef
  readonly budgetReservationId: string
  readonly stopPolicy: StopPolicy
  readonly formatVersion: number
  readonly hash: string
}

interface TemplateExpansionRequest {
  readonly offeredTemplate: LoopTemplateRef
  readonly inputRefs: readonly ArtifactRef[]
  readonly taskInput: unknown
}

interface ChildDelegationRequest {
  readonly parentLoopId: string
  readonly parentScopeId: string
  readonly parentBudgetReservationId: string
  readonly offeredTemplate: LoopTemplateRef
  readonly inputRefs: readonly ArtifactRef[]
  readonly taskInput: unknown
}

interface ToolBinding {
  readonly toolId: string
  readonly policy: CoreToolPolicyRef
}
```

Effective authority is always an intersection:

```text
loop authority = root scope
               intersect profile ceiling
               intersect lane/template ceiling
               intersect active core policies
               intersect live generation/revocation state
               intersect runtime deadline/budget constraints
```

- `prepareStep` may reduce tools, model budget, and remaining steps; it cannot add authority.
- Model switching revalidates provider-native/injected tools against the same scope.
- Sibling/child loops start with fresh messages and do not inherit SkillPlan, credentials, network, workspace, delivery, or grants unless each item is explicitly compiled into their scope.
- Domain template expansion reserves from the root ledger within the template ceiling. Child delegation atomically sub-reserves from the parent reservation's unconsumed amount; parent consumption plus all descendant reservations cannot exceed the parent reservation.
- Batch creation atomically seals stable loop slot IDs, LoopSpecs, generation leases, and all model/tool/token reservations from one root budget ledger. Sibling reservations plus existing consumption cannot exceed the root ceiling; unused reservation is returned on terminal state.
- Loop identity is unique `(root_id, stable_slot_id)`. `taskInputHash` is the canonical serialization of every typed input that can change the result, including objective/query/transform/prediction/falsifier; `inputHash` is the canonical ordered list of artifact IDs plus content digests. Reapplying the same slot with the same task/input/LoopTemplateRef/Profile/SkillPlan/ResultContract hashes returns the existing LoopSpec; any changed hash is a Conflict rather than a second worker.
- Models receive bound tool IDs, never credentials or bearer scope objects.
- The executor receives no SOUL, Skill, conversation, or model-controlled policy.
- Phase A ToolBindings pin one code-owned CoreToolPolicyRef. Skill tool hints are ignored for authority.

After plan 007, the compiler adds a separate Capability binding variant containing one `CapabilityRef` and one live `CapabilityGrantRef`. Scope origin/method/workspace/data lists remain additional ceilings only; authorization never unions dimensions from different grants. One binding must satisfy the complete normalized resource request.

## Loop ownership

There are three distinct loop levels:

1. **Live loop invocation**: one AI SDK `ToolLoopAgent`; the smallest checkpoint/recovery unit.
2. **Domain orchestration loop**: code-owned state machine such as a research campaign, delivery retry, or Operation verification; it may create multiple sequential/parallel LoopSpecs.
3. **Scheduler loop**: cycle/poll claims due domain work; it does not interpret arbitrary plugin nodes or edges.

A root may have multiple active live loops up to `maxActiveLoops`; no loop is inherently the main loop. Coordinator, worker, reviewer, and synthesizer are ordinary role-scoped LoopSpecs. A coordinator is tool-less, sees only generation-pinned offered LoopTemplateRefs/descriptions and allowed artifact refs, and returns only a `TemplateExpansionRequest`. The offered template bytes are leased from presentation through batch terminal. The sealed code-owned template validates `taskInput` and supplies ProfileRef, SkillPlan, scope ceiling, ResultContractRef, stable-slot derivation, and budget ceiling; the model cannot choose them. The domain validates requests and atomically creates the batch. The coordinator does not remain alive while workers run.

Domain template expansion and child delegation use separate types/APIs. A domain may apply a `TemplateExpansionRequest` under the root scope even though the tool-less coordinator itself has no worker tools; authority comes from the code-owned domain template, not from the coordinator. A `ChildDelegationRequest` requires `parentLoopId/parentScopeId` and intersects the parent effective scope as well as root/template ceilings. Leaf workers cannot delegate, and request kind is persisted for audit/replay.

A Skill or Plugin owns none of these loop levels. A model may return a typed request such as `start research campaign`, but the domain service validates it and owns all later transitions. Research planner, parallel branch workers, synthesizer, and verifier are separate loop batches controlled by the research campaign service.

Initial parallel join policy is fixed `all-settled`. Terminal siblings are never regenerated because another sibling failed. Results are returned in stable slot order as typed artifact/status references. Parallel speculative workers may use only replay-safe inline reads/local actions; Operation, Delivery, and shared mutable workspace actions are emitted as typed intents and committed once by a domain-owned later stage.

Retry/recovery ownership:

| Failure | Sole owner | Other layers |
|---|---|---|
| SDK/adapter-controlled model retry or repair | AI SDK kernel; every call controlled by open-zero is governed/accounted | domain sees one terminal turn result |
| opaque provider-client transport retry | pinned provider adapter/CLI process | one bounded process attempt is recorded with retry visibility; no per-HTTP-attempt accounting claim |
| authorized inline invocation | Tool Gateway invocation journal | limited to host-owned replay-safe adapters within standing origin/method/data grants |
| operation-classified invocation | Operation executor/reconciler | invocation stores Operation ref; domain becomes `waiting_on_operation` and never retries the effect |
| delivery attempt | Delivery outbox | owner-share Delivery Capability enqueues under standing grant; third-party-share Operation stores/waits on delivery ref and never retries transport |
| research continuation | Research campaign service | it may schedule a new turn only after dependencies are terminal |

A Capability with `execution: "operation"` creates an Operation before I/O. The invocation is a projection/reference, not a second retry owner. `unknown` effect resolution belongs only to Operation reconciliation/manual resolution; a loop, coordinator, sibling, or observer cannot regenerate it. An `inline` Capability follows only its declared replay-safe Tool Gateway recovery rule. Delivery is a domain executor: the host-owned `share.owner` Delivery Capability idempotently enqueues under a standing grant, while third-party share requires one domain-selected commit artifact and an Operation that enqueues once and waits; only Delivery performs or retries the send.

Do not add a generic Job/DAG schema until at least two non-research domains demonstrate the same claim/wait/recovery contract without domain exceptions. If a small job envelope is later justified, it contains only a core-owned handler ID and lifecycle; handlers remain code-owned and no plugin registers transitions.

## Events and hooks

Do not expose arbitrary `beforeX/afterX` callbacks. Safety checks, approval checks, and attempt-before-I/O remain direct core code, not hooks.

```ts
interface RuntimeEvent<P> {
  readonly id: string
  readonly topic: EventTopic // closed core-owned union
  readonly subject: { readonly kind: string; readonly id: string }
  readonly payload: P
  readonly correlationId: string
  readonly causationId?: string
  readonly at: string
}
```

Observer rules:

- The authoritative domain mutation and an event-outbox row are written in the same SQLite transaction. Dispatch happens only after commit; there is no state-commit/event-persist gap.
- Delivery is durable and at-least-once. Observer acknowledgement and creation of a typed handler request occur in one transaction with `UNIQUE(observer_id, event_id, handler_id, input_hash)`.
- An observer cannot call a model, tool, Capability, or executor directly.
- It may request only a closed, core-owned handler with typed input.
- The request carries correlation/causation, not bearer authority, and is re-authorized against current grants and revocation state.
- Handler requests retain root causation ID, parent causation ID, and depth. Observers cannot subscribe to events caused by themselves unless the core handler explicitly allows it; uniqueness on the causal edge plus depth limits stop recursion.
- Observer failure cannot roll back the event's source transaction.
- Agent Plugins v1 hooks, commands, agents, and client extensions are not loaded as observers.

Plugin-provided executable observers remain out of scope until a separate host-code trust model, sandbox, signature/provenance policy, update/revocation behavior, and two concrete interoperable consumers exist.

## Implementation phases

Phase A is the initially authorized implementation scope:

1. Extend plan 009's code-owned Profile registry with composition/coordination roles and exhaustively map every `Runner.Role` value (including `scout`) plus direct agents such as interactive parent, autonomous parent, researcher, digger, keeper, reviewer, and dream. Adding a production role or direct model path must fail typechecking until it has a ProfileRef. Research planner maps to `coordinator`; verifier maps to `reviewer`.
2. Add pure scope intersection and `LoopSpec` compilation with exhaustive tests; preserve current behavior through explicit profiles before adding routing.
3. Verify plan 009 removed model-ID-based provider Web-search injection and add a regression test proving profile/model switching cannot reintroduce provider external-I/O tools.
4. Add generation-pinned built-in Skill registry and host-owned `method/presentation` SkillPlan compiler. Start with explicit single-Skill plans, then one measured orthogonal pair such as research method plus publication form.
5. Use plan 009 ExecutionRoot/LoopSpec and budget primitives. Keep the current interactive parent as an ordinary effect-bound `interactive` profile. Add a separate tool-less coordinator profile only for domains that need bounded fan-out; neither profile is privileged or permanently alive.
6. Convert researcher/digger delegation into stable-slot loop requests with fresh messages, decreasing scope/depth, explicit SkillPlan, typed result contract, and all-or-none sibling budget reservation. Start at concurrency 1, then enable bounded parallel `all-settled` execution.
7. Add generic generation lease/reference APIs and live-loop writers for the transitive closure of ProfileRef, each SkillRef, CompositionPolicyRef, LoopTemplateRef, every CoreToolPolicyRef, ResultContractRef, and LoopSpec format/hash. Lease an offered template before coordinator execution and persist canonical SkillPlan/template bytes/hash. Prove an update cannot replace/remove a template between offer, batch creation, and terminal loop. Plan 006 adds the campaign-checkpoint writer and its retention test.
Phase B is gated, depends on plans 007 and 010 where noted, and is not implemented speculatively:

8. After plan 010, import plugin Skills into the same registry, explicit-selection-only, `exclusive` by default, and initially restricted to leaf worker loops.
9. Add conformance fixtures for third-party Skills and prove they cannot expand tools, trigger hooks, create loops, alter SkillPlan slots, or change publisher/Operation authority.
10. Add the tool-less structured router only after explicit/deterministic per-slot selection has real ambiguous cases, owner-authored descriptors exist, and provider structured-output contracts pass. A router chooses one offered slot per call, not an arbitrary stack.
11. After plan 007, add a transactional runtime event outbox and observer request table only with the first concrete observer/core-handler pair. The source domain writes its mutation and event row in one transaction. Keep Memory evidence events separate.

## Verification

```sh
git diff --stat dd7b4bf..HEAD -- src/agent src/model src/services src/cycle.ts src/db test package.json bun.lock
bun run gate
bun run test:extension-boundaries-e2e
```

Phase A required cases: exhaustive production ProfileRef coverage including `scout`, autonomous parent, and direct agents; zero/one Skill and allowed method+presentation pair; same-slot/exclusive conflict rejection; profile/composition/Skill/template/CoreToolPolicy/ResultContract generation update during pinned offers/sibling loops; Skill tool-hint non-union; provider-native external-I/O tool rejection; allowed no-I/O structured-output primitive; journaled replay-safe public Search through a core policy binding; stable-slot same-hash reuse and changed task input/artifact/template/policy conflict; TemplateExpansionRequest cannot choose authority; ChildDelegationRequest requires/intersects parent scope and sub-reserves parent remaining budget; parent consumption plus descendants cannot exceed parent reservation; atomic sibling budget exhaustion; coordinator reserve preservation; bounded concurrency; one sibling crash with terminal sibling retained; all-settled stable result order; child scope/depth/credential/network non-inheritance; and parallel effect intent without direct execution. Prompt-conflict fixtures are quality evaluations, not proof of authority or publication safety.

When Phase B is justified, add cross-grant origin/credential laundering denial, credentialed/arbitrary read routed to Operation, raw MCP denied before grant/Operation creation, plugin leaf re-delegation rejection, plugin hook/loop request rejection, one domain-selected idempotent operation-classified commit action, router none/valid/unknown ref and malicious package summary exclusion; crash between domain mutation/event emission, observer atomic request/ack, duplicate delivery, self-recursive causation, revoked grant between event and handler, and observer crash.

## Done criteria

- Every live loop has a persisted immutable root, profile, SkillPlan, scope, stop policy, stable slot, budget reservation, result contract, and effective tool binding set.
- A SkillPlan can compose only host-approved orthogonal slots; adding Skills cannot change authority, toolset, topology, budget, retry/effect semantics, or durable state ownership.
- Delegation can only reduce authority, budget, deadline, and depth.
- A root may run multiple bounded sibling loops without any loop becoming a privileged scheduler or retry owner.
- One component owns each retry/resume decision: AI SDK for a live step loop, domain service for durable progress, Operation executor for effects.
- If Phase B is implemented, observers cannot directly execute effects or recursively schedule themselves without a core-declared path.
- Plugin installation or update cannot add executable hooks, schedulers, loops, handlers, or state machines.
- The boundary permits a method+presentation Skill pair plus deterministic target renderer without granting any of them publication authority; concrete publication formats remain a separate implementation plan.

## Explicitly deferred

- more than one Skill in the same slot, more than two initial slots, or arbitrary ordered Skill stacks
- mid-turn Skill switching
- Skill dependencies or recursive activation
- plugin-defined agents/subagents, loops, schedulers, domain handlers, or migrations
- executable plugin hooks and arbitrary event topics
- generic workflow DAG/node/edge definitions
- plugin-owned durable KV/state APIs
- automatic authority inferred from Skill text, `allowed-tools`, MCP annotations, or plugin extensions

## Reconsideration triggers

Add a third Skill slot only after two concrete compositions cannot be represented as method/presentation or separate loops and paired evaluation shows a durable gain without increased conflict or authority ambiguity. Reconsider a shared durable orchestration engine only after at least two non-research domains share transitions and recovery semantics without exceptions. Reconsider executable plugin observers only after the package/trust/sandbox/revocation model exists independently of hook semantics.

## Stop conditions

Stop if routing requires giving the router tools, credentials, Skill bodies, or unrestricted memory. Stop if Skill composition requires authority union, package-defined ordering/dependencies, or model conflict resolution. Stop if a sibling can receive anything outside root/template scope, reserve budget outside the root ledger, or create further workers when marked leaf. Stop if a coordinator remains alive as scheduler, directly writes worker rows, or can retry effects. Stop if an observer can cause I/O without current re-authorization and a domain/Operation owner. Stop if a proposed abstraction needs arbitrary node types, dynamic transition registration, plugin-owned retries, or shared state interpreted by more than one domain service.
