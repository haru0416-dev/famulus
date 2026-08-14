# 011 Extension control boundaries

Planned at `dd7b4bf`.

Depends on plans 007, 009, and 010 for the complete boundary. Built-in Skill routing may begin after plan 009; plugin-sourced Skills require plan 010; observer-triggered effects require plan 007.

## Decision

Do not create a generic `Extension`, workflow DAG, executable plugin hook, or plugin-owned agent loop. Share a small turn/scope kernel while each durable domain keeps its own state machine.

```text
input / timer / committed event
  -> deterministic candidate resolver
  -> explicit/deterministic Skill selection
  -> policy compiler
  -> immutable TurnSpec + ExecutionScope
  -> one bounded AI SDK turn
  -> journaled Capability call
       |- permitted inline read/local action
       `- immutable Operation -> approval/policy -> non-LLM executor
```

The model reasons within a turn. The host chooses candidates and compiles authority. SQLite owns durable state. A domain service decides whether another turn is needed. The executor performs external effects.

## Responsibility table

| Mechanism | May decide | State owner | May grant authority | May execute effects |
|---|---|---|---|---|
| Skill | how to approach the current task | none; only a pinned reference on the run | no | no |
| Skill router (deferred) | `none` or one allowed built-in/admin-described `SkillRef` | route decision record | no | no |
| Agent profile | model/tool/effect ceilings and prompt layer | code-owned registry | only by intersecting existing grants | no |
| Policy compiler | immutable `TurnSpec` and effective scope | run/turn rows | cannot exceed parent/profile/grants | no |
| AI SDK loop | next model/tool step inside one turn | live turn; checkpoints in SQLite | no | only through bound Tool Gateway |
| Child turn | a separately scoped delegated task | separate run/turn | no; child scope is a strict subset | only through its subset bindings |
| Domain service | durable transitions and whether to schedule another turn | domain tables | no | only by requesting Capability/Operation |
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

interface SkillDefinition {
  readonly ref: SkillRef
  readonly source: "core" | "plugin"
  readonly summary: string
  readonly instructions: string
  readonly allowedProfiles: readonly ProfileId[]
  readonly requestedCapabilities: readonly CapabilityRef[] // hints only
}
```

Selection order:

1. Explicit `SkillRef` supplied by a trusted caller.
2. Skill pinned in a domain checkpoint.
3. Deterministic activation rule with one matching candidate.
4. Deferred: tool-less router chooses `none | SkillRef` from trusted routing descriptors.
5. Otherwise no Skill.

Rules:

- Exactly zero or one Skill is active in a turn.
- Plugin Skills are explicit-selection-only by default. Automatic routing uses built-in descriptors or short descriptors authored/approved by the owner, never package-supplied summaries or Skill text.
- The deferred router receives candidate IDs/trusted routing descriptors and task classification text, not Skill bodies, tools, credentials, or unrestricted memory.
- Router output is structured and must name an offered generation-pinned reference.
- A Skill cannot activate another Skill, switch itself mid-turn, start a loop, select a model, increase steps, or load its scripts.
- A second Skill requires a new child turn with a new compiled scope and explicit parent reference.
- Built-in and plugin Skills normalize to the same internal type and execution path.
- Prompt precedence is `SOUL/Governance > AgentProfile > owner/task contract > Skill > retrieved/untrusted data`.
- Prompt precedence is not a security boundary; Tool Gateway and scope enforce authority.

For generic publishing, one content-form Skill may guide `article | report | thread | newsletter | documentation`, while target-specific Zenn/Qiita/note formatting belongs to deterministic publication profiles/renderers. Evidence references, secret-leak checks, review requirements, allowed targets, and publication approval are enforced by typed artifact validators and Publisher Capability preconditions, not prompt precedence. A target renderer is not a second Skill and a publisher is a Capability.

## Turn and scope

```ts
interface ExecutionScope {
  readonly id: string
  readonly parentId?: string
  readonly profileId: ProfileId
  readonly capabilityGrants: readonly CapabilityGrantRef[]
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

interface TurnSpec {
  readonly id: string
  readonly runId: string
  readonly profileId: ProfileId
  readonly skill?: SkillRef
  readonly promptLayers: readonly PromptLayer[]
  readonly modelPolicy: ModelPolicy
  readonly tools: readonly ToolBinding[]
  readonly scopeId: string
  readonly stopPolicy: StopPolicy
  readonly formatVersion: number
  readonly hash: string
}
```

Effective authority is always an intersection:

```text
turn authority = profile ceiling
               intersect parent scope
               intersect active grants
               intersect live generation/revocation state
               intersect runtime deadline/budget constraints
```

- `prepareStep` may reduce tools, model budget, and remaining steps; it cannot add authority.
- Model switching revalidates provider-native/injected tools against the same scope.
- Child turns start with fresh messages and do not inherit Skill, credentials, network, workspace, delivery, or grants unless each item is explicitly included in the child scope.
- Child deadline, budget, and delegation depth must be lower than the parent's remaining values.
- Child creation atomically reserves model/tool/token budget from one root budget ledger. Sibling reservations plus parent consumption cannot exceed the root ceiling; unused reservation is returned on terminal child state.
- Models receive bound tool IDs, never credentials or bearer scope objects.
- The executor receives no SOUL, Skill, conversation, or model-controlled policy.

## Loop ownership

There are three distinct loops:

1. **Live turn loop**: AI SDK `ToolLoopAgent`; bounded steps; no durable scheduling ownership.
2. **Domain loop**: code-owned state machine such as a research campaign, delivery retry, or Operation verification; SQLite-backed and domain-specific.
3. **Scheduler loop**: cycle/poll claims due domain work; it does not interpret arbitrary plugin nodes or edges.

A Skill or Plugin owns none of these loops. A model may return a typed request such as `start research campaign`, but the domain service validates it and owns all later transitions. Research planner, branch worker, synthesizer, and verifier are separate turns controlled by the research campaign service.

Retry/recovery ownership:

| Failure | Sole owner | Other layers |
|---|---|---|
| SDK/adapter-controlled model retry or repair | AI SDK kernel; every call controlled by open-zero is governed/accounted | domain sees one terminal turn result |
| opaque provider-client transport retry | pinned provider adapter/CLI process | one bounded process attempt is recorded with retry visibility; no per-HTTP-attempt accounting claim |
| authorized inline invocation | Tool Gateway invocation journal | limited to host-owned replay-safe adapters within standing origin/method/data grants |
| operation-classified invocation | Operation executor/reconciler | invocation stores Operation ref; domain becomes `waiting_on_operation` and never retries the effect |
| delivery attempt | Delivery outbox | owner-share Delivery Capability enqueues under standing grant; third-party-share Operation stores/waits on delivery ref and never retries transport |
| research continuation | Research campaign service | it may schedule a new turn only after dependencies are terminal |

A Capability with `execution: "operation"` creates an Operation before I/O. The invocation is a projection/reference, not a second retry owner. `unknown` effect resolution belongs only to Operation reconciliation/manual resolution; a branch or observer cannot regenerate it. An `inline` Capability follows only its declared replay-safe Tool Gateway recovery rule. Delivery is a domain executor: the host-owned `share.owner` Delivery Capability idempotently enqueues under a standing grant, while third-party share requires an Operation that enqueues once and waits; only Delivery performs or retries the send.

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

Phase A is the only initially authorized implementation scope:

1. Define a code-owned AgentProfile registry and exhaustively inventory every `Runner.Role` value (including `scout`) plus direct agents such as parent, researcher, digger, keeper, reviewer, and dream: models, tools, native provider controls, effects, budgets, and data scopes. Adding a role must fail typechecking until it has a profile.
2. Add pure scope intersection and `TurnSpec` compilation with exhaustive tests; preserve current behavior through explicit profiles before adding routing.
3. Verify plan 009 removed model-ID-based provider Web-search injection and add a regression test proving profile/model switching cannot reintroduce provider external-I/O tools.
4. Add generation-pinned built-in Skill registry and explicit Skill selection. Start with one existing domain, such as publication form, not all prompts at once.
5. Add atomic root-budget reservation, then convert researcher/digger delegation into child turns with fresh messages, decreasing budget/depth, explicit SkillRef, and subset scope.
6. Make research campaign checkpoints pin profile, Skill generation, TurnSpec format, and relevant artifact references. Add the generation lease/reference writer here and prove an update cannot remove bytes referenced by a nonterminal turn or campaign checkpoint.
7. Import plugin Skills from plan 010 into the same registry, explicit-selection-only and restricted to delegated turns.
8. Add conformance fixtures for third-party Skills and prove they cannot expand tools, trigger hooks, create loops, or alter publisher/Operation authority.

Phase B is gated and not implemented speculatively:

9. Add the tool-less structured router only after explicit/deterministic selection has real ambiguous cases, owner-authored descriptors exist, and provider structured-output contracts pass.
10. Add a transactional runtime event outbox and observer request table only with the first concrete observer/core-handler pair. The source domain writes its mutation and event row in one transaction. Keep Memory evidence events separate.

## Verification

```sh
git diff --stat dd7b4bf..HEAD -- src/agent src/model src/services src/cycle.ts src/db test package.json bun.lock
bun run gate
bun run test:extension-boundaries-e2e
```

Phase A required cases: exhaustive Runner/direct-agent profile coverage including `scout`, explicit Skill, deterministic single match, generation update during a pinned turn/campaign checkpoint, Skill requesting an ungranted tool, provider-native external-I/O tool rejection, allowed no-I/O structured-output protocol primitive, journaled replay-safe public Search inline, credentialed/arbitrary read routed to Operation, raw MCP denied before grant/Operation creation, mid-turn activation attempt, child scope escalation, atomic sibling budget exhaustion, delegation depth exhaustion, child credential/network non-inheritance, plugin hook ignored, plugin loop request rejected, and operation-classified action routed to Operation. Prompt-conflict fixtures are quality evaluations, not proof of authority or publication safety.

When Phase B is justified, add router none/valid/unknown ref and malicious package summary exclusion; crash between domain mutation/event emission, observer atomic request/ack, duplicate delivery, self-recursive causation, revoked grant between event and handler, and observer crash.

## Done criteria

- Every turn has a persisted immutable profile, optional SkillRef, scope, stop policy, and effective tool binding set.
- A Skill can change reasoning instructions but cannot change authority, durable state ownership, or loop behavior.
- Delegation can only reduce authority, budget, deadline, and depth.
- One component owns each retry/resume decision: AI SDK for a live step loop, domain service for durable progress, Operation executor for effects.
- If Phase B is implemented, observers cannot directly execute effects or recursively schedule themselves without a core-declared path.
- Plugin installation or update cannot add executable hooks, schedulers, loops, handlers, or state machines.
- The boundary permits one content Skill plus a deterministic target renderer without granting either publication authority; concrete publication formats remain a separate implementation plan.

## Explicitly deferred

- multiple active Skills or Skill stacks
- mid-turn Skill switching
- Skill dependencies or recursive activation
- plugin-defined agents/subagents, loops, schedulers, domain handlers, or migrations
- executable plugin hooks and arbitrary event topics
- generic workflow DAG/node/edge definitions
- plugin-owned durable KV/state APIs
- automatic authority inferred from Skill text, `allowed-tools`, MCP annotations, or plugin extensions

## Reconsideration triggers

Reconsider multiple Skills only after paired evaluation shows a durable quality gain without increased routing error, prompt conflict, or authority ambiguity. Reconsider a shared durable loop only after at least two non-research domains share transitions and recovery semantics without exceptions. Reconsider executable plugin observers only after the package/trust/sandbox/revocation model exists independently of hook semantics.

## Stop conditions

Stop if routing requires giving the router tools, credentials, Skill bodies, or unrestricted memory. Stop if a child can receive anything outside the parent scope. Stop if an observer can cause I/O without current re-authorization and a domain/Operation owner. Stop if a proposed abstraction needs arbitrary node types, dynamic transition registration, plugin-owned retries, or shared state interpreted by more than one domain service.
