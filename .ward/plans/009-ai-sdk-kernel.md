# 009 AI SDK v7 execution kernel

Planned at `2ce2a2a`.

Depends on plan 001 and is cross-cutting for plans 003 through 007, 010, and 011.

## Why

The repository adapts Codex Responses to AI SDK `LanguageModelV4`, applies governance as middleware, validates Valibot tool inputs, and runs the loop through `ToolLoopAgent` (`src/agent/assistant.ts`, `src/model/governed.ts`, `src/model/schema.ts`). Installed `ai@7.0.62` exposes stable `ToolLoopAgent`, `prepareStep`, `Output.*`, `toolApproval`, lifecycle telemetry, and message/tool-result representations. These remove local orchestration code without replacing durable SQLite state. Production inference is GPT-only; Claude model IDs and the Claude CLI adapter are not supported paths.

## Responsibility boundary

AI SDK owns:

- each live loop invocation's model/tool steps
- tool input schema validation and tool-call protocol
- bounded stop conditions
- per-step model, instruction, and active-tool selection
- complete structured-output validation
- approval request/response message representation
- stream and lifecycle events
- provider adaptation and response messages

SQLite owns:

- execution root, loop specification/attempt/step source of truth and format version
- exact loop-attempt process incarnation (host/boot/PID/start identity), monotonic fence, and takeover proof
- shared root budget, stable loop slots, reservations, deadline, and concurrency ceiling
- checkpoints and crash recovery
- tool invocation journal and unknown/interrupted invocation state
- approval authentication, expiry, policy, and audit
- operation/delivery leases, idempotency, retries, and outbox
- quota/usage accounting source of truth
- MCP session IDs and provider response IDs

The kernel also owns the closed `EffectAtom` vocabulary, generation-pinned `ProfileRef`, `CoreToolPolicyRef`, `CoreToolImplementationRef`, `ResultContractRef`, and the canonical `SkillPlan` shape with empty slots allowed. `CoreToolImplementationRef` identifies the exact host adapter/code generation plus input/output schema digests; policy and implementation are separate pinned references. These bootstrap types let every production model call use a profile and zero-Skill plan before plan 011 adds Skill composition. Effect classification is shared; external authorization remains plan 007's responsibility.

Telemetry is observability, not audit. Partial structured streams are display-only, never committed decisions.

## Steps

1. Pin `ai` to the exact version whose public types and behavior are tested; dependency upgrades are explicit changes, not semver-range drift.
2. Add Codex provider contract tests for plain text, tools, `Output.object` without tools, `Output.object` with tools, invalid output repair, and approval pause/replay before adopting combined output modes.
3. Replace the compatibility alias `Experimental_Agent` with stable `ToolLoopAgent`; replace compatibility stop helper names with current stable APIs after confirming installed declarations.
4. Define generation-pinned Profile/CoreToolPolicy/CoreToolImplementation/ResultContract registries, canonical zero-SkillPlan, immutable `ExecutionRoot`, and `LoopSpec` records. Each root has one immutable `ExecutionOwnerRef { kind, id }` with a unique constraint so a domain intent/session cannot acquire two roots. Root creation, owner-domain binding, and initial reservation occur in one SQLite transaction. A root owns scope, shared budget account, deadline, coordinator reserve, and concurrency ceiling; it may contain multiple sequential/parallel loops. Each LoopSpec has a stable slot, role, ProfileRef, canonical typed task input/hash, ordered artifact refs/digests, SkillPlan hash, ResultContractRef, exact policy+implementation ToolBindings, scope, stop policy, and budget reservation. No loop type is inherently `main`.
5. Define a shared loop runner that requires ProfileRef rather than an arbitrary production model ID, always wraps models with governance middleware, and requires explicit stop conditions, zero SDK retries by default, root/loop IDs, deadline, telemetry metadata, and an effect-classified effective toolset. Make arbitrary model-ID calls test-only. Governed runs reject provider-native/injected tools that perform external I/O, including web reads, because local journaling cannot precede provider I/O. No-I/O protocol controls such as Claude structured response formatting and tool-call serialization remain allowed and are covered by provider contract tests. Replace the current model-ID-based Codex web-search injection (`src/model/codex-responses.ts:362-378`) with the existing local Search tool binding; plan 007 later places that same binding behind Capability authorization. Every live loop attempt stores the exact owner process incarnation and monotonic fence. A new process may advance the fence only after proving the old incarnation dead or supervisor kill-and-join; paused/uncertain owners and PID reuse without matching start identity block takeover. Before every adapter process/provider invocation, atomically create a durable model-attempt row keyed by root/loop/step/attempt ordinal, CAS the current loop-attempt incarnation/fence, and consume/reserve the declared model-call, conservative token allowance, and conservative model-cost ceiling for the selected route. Dynamic model switching must fit the loop's remaining cost reservation before the call. Only after `started` commits may provider I/O begin. A crash/disconnect before a complete persisted response marks the attempt `unknown`; its call/token/cost reservation is not released or reused. Reattempting the step requires an explicit kernel retry decision, a new attempt ordinal, and fresh remaining budget in every vector, never replay under the old reservation.
6. Add a root budget ledger with model-call, tool-call, token, and cost vectors; persistent reservation state (`held -> consuming -> consumed | released | unknown`); atomic all-or-none reservations; coordinator reserve owned by a fixed root slot; maximum active loops; stable-slot dedupe; cancellation propagation; and release of unused terminal reservations. `unknown` reservations are not released automatically. Start with one root/one loop and concurrency 1.
7. Introduce `prepareStep` for dynamic model routing, `activeTools` restriction, budget/deadline enforcement, and research-mode-specific instructions. Revalidate the effective toolset after model switching. Do not mutate durable state from `prepareStep`.
8. Move new structured results to `Output.object`, `Output.array`, and `Output.choice` only on provider paths proven by the contract suite; preserve the Valibot runtime-validation bridge.
9. Add a tool invocation journal with a host-assigned occurrence identity `UNIQUE(root_id, loop_id, step_ordinal, call_ordinal)` and append-only per-occurrence tool attempts; provider tool-call ID is immutable metadata, not the dedupe authority. Before any tool I/O, one transaction durably seals the complete ordered model response/tool-call batch, canonical input bytes/hashes, exact policy/implementation ToolBinding hashes, checkpoint/step ordinal, loop-attempt ID/incarnation/fence, and atomically reserves/debits one tool-call unit plus declared per-tool cost for every initial occurrence. If the whole batch exceeds remaining tool/cost budget, reject it all as budget-exhausted and execute zero calls; partial batch admission is forbidden. Replay of an existing occurrence with any changed provider ID, tool ID, input, policy, or implementation is a Conflict rather than another invocation. In the same transaction, only the current loop-attempt incarnation/fence may CAS the sealed batch to dispatchable; stale attempts cannot claim an occurrence. Immediately before I/O, each executor rechecks the persisted incarnation/fence/lease and its reserved unit. Record `succeeded/failed/unknown` after execution and persist a reusable result or durable Operation/delivery reference; unknown units remain consumed. A declared replay-safe recovery creates a new tool-attempt ordinal under the same immutable occurrence and atomically reserves/debits fresh tool-call and cost units; it never reuses the initial unit. Cross-process recovery also requires proof that the old loop/tool executor incarnation is dead or kill-and-join succeeded. If budget is exhausted, recovery stops explicitly. If the installed AI SDK cannot expose a pre-dispatch interception point that seals and reserves the complete tool-call batch before `execute`, stop and add a local adapter boundary rather than relying on `onStepFinish`.
10. Persist versioned `ModelMessage`-compatible model responses and the complete ordered tool-call batch before dispatch, then persist tool results at durable checkpoints. Recovery resumes from the sealed response and never regenerates a step whose tool batch may have started. A succeeded model attempt reuses its stored response; an unknown model attempt remains a consumed accounting fact and can only be followed by an explicitly budgeted new attempt. A succeeded tool invocation reuses its stored result; an interrupted inline replay-safe invocation follows its declared recovery rule through a fresh budgeted tool attempt; an operation-classified, arbitrary-command, or otherwise non-replay-safe `started` invocation becomes `unknown` and makes the loop non-resumable until reconciled/manual resolution. Never discard an unmatched call, rerun the model to obtain a new provider call ID under the old attempt, reuse a consumed tool-attempt reservation, or allow a stale loop process incarnation to execute.
11. Register lifecycle telemetry with inputs/outputs disabled by default. Emit root/loop/step/model/tool durations and provider metadata while retaining Ledger and audit rows in SQLite.
12. Do not use AI SDK approval replay for effect execution. An SDK approval message can represent a paused model loop or Operation UI projection, while plan 007 owns the sole approval and out-of-band executor.
13. Use provider response IDs or MCP session IDs only as optional acceleration metadata; local state remains sufficient to explain and recover a root/loop.
14. Keep the GPT-only Codex transport retry behavior explicit and zero-retry at the kernel boundary; one governed adapter call cannot hide another provider call.
16. Add contract tests against the installed package types and AI SDK test utilities so upgrades fail visibly when APIs or message shapes change.

## MCP policy

- Add `@ai-sdk/mcp` in plan 007, not this plan.
- Production uses HTTP/streamable HTTP transport.
- MCP read tools are filtered through agent-specific allowlists.
- MCP write tools become typed Operations; they are never passed through as directly executable dynamic tools.
- `dynamicTool` input/output is `unknown` and must be validated by grant-pinned Capability input and output schemas.
- Provider-executed external-I/O tools are forbidden for governed runs. All read/write/search tools are locally bound, authorized, and journaled. Provider response-format and serialization controls are allowed because they do not independently perform external effects.

## Verification

```sh
git diff --stat 2ce2a2a..HEAD -- src/agent src/model src/services/Governance.ts src/services/Ledger.ts test package.json bun.lock
bun run gate
```

Targeted tests must cover exhaustive production ProfileRef coverage, arbitrary model-ID production call rejection, zero-SkillPlan, one immutable owner-to-root binding, crash around atomic owner/root/initial-reservation creation, duplicate owner creation returning/conflicting with the existing root, one root with one/multiple LoopSpecs, no privileged main role, canonical typed-input/artifact hashing, ResultContract/CoreToolPolicy/CoreToolImplementation generation pinning, implementation/schema update during a checkpointed loop, atomic sibling reservations across model/tool/token/cost vectors, persistent reservation transitions, coordinator reserve isolation, unknown reservation non-release, stable-slot same-hash reuse and changed-hash conflict, concurrency ceiling, cancellation propagation, step limit, deadline-based active-tool reduction, model switching within cost ceiling and expensive route rejection, provider-native/injected external-I/O tool rejection before I/O, local Search binding replacement, allowed no-I/O structured response protocol, revalidation after routing, plain/tool/structured/combined provider modes, invalid structured output, invalid tool input repair, model attempt-before-provider-I/O, crash before model attempt commit causing no call, provider acceptance then crash producing unknown consumed call/token/cost budget, same model attempt replay rejection, explicit new model attempt requiring fresh budget in every vector, concurrent model attempt fence CAS, paused interactive loop past lease refusing takeover, exact old loop-incarnation death then higher fence, PID reuse/start-identity mismatch, governance and accounting on every adapter-controlled model call including repair/resubmission, pinned CLI retry visibility/deadline behavior, rejection of unclassified effective tools, telemetry with redacted payloads, successful result replay, duplicate occurrence same binding/input result reuse, same occurrence/provider call ID with mutated payload/tool/policy/implementation conflict, replay-safe recovery using a new tool-attempt ordinal and fresh tool/cost units, exhausted recovery budget stopping without I/O, cross-process tool recovery requiring old-incarnation death, multi-call batch exactly fitting budget, multi-call batch exceeding remaining calls/cost executing zero tools, atomic batch reservation crash, unknown tool occurrence retaining its unit, crash before sealing with no I/O, crash after sealing/before start, crash after started/before result checkpoint without model regeneration, provider returning a new time-based call ID on attempted replay, two concurrent resume attempts with only the current incarnation/fence reaching I/O, stale executor fence rejection immediately before I/O, unknown non-resumable invocation, approval pause without effectful replay, and SDK upgrade type drift.

## Done criteria

- No new agent loop reimplements AI SDK step execution.
- Every model call still passes Governance and Ledger accounting.
- Structured decisions are validated through `Output.*` plus domain checks.
- Multiple live loops can run under one root without exceeding declared adapter-process/tool budget units or concurrency, and without relying on a privileged main loop. Unobservable provider-internal attempts/tokens are explicitly outside the hard accounting claim.
- Every adapter process invocation has a committed attempt and consumed reservation before provider I/O; an unknown attempt cannot reuse that reservation.
- Durable resume works from SQLite without provider-held conversation state.
- Durable resume never repeats an effect whose outcome is unknown.
- A tool-call batch is durably sealed before dispatch, and only one fenced loop attempt can transition an occurrence to I/O.
- Telemetry failure cannot lose or change an audit fact.
- No AI SDK approval or MCP facility can bypass Operation policy.

## Stop conditions

Stop if stable AI SDK APIs differ from installed `7.0.62` declarations. Pin behavior to installed types and update this plan before changing dependencies. Stop if replay requires serializing provider-private objects rather than public `ModelMessage`/tool representations.
