# 009 AI SDK v7 execution kernel

Planned at `2ce2a2a`.

Depends on plan 001 and is cross-cutting for plans 003 through 007, 010, and 011.

## Why

The repository already adapts Claude CLI and Codex Responses to AI SDK `LanguageModelV4`, applies governance as middleware, validates Valibot tool inputs, and runs the loop through `Experimental_Agent` (`src/agent/assistant.ts:20,1031-1108`, `src/model/governed.ts`, `src/model/schema.ts`). Installed `ai@7.0.62` exposes stable `ToolLoopAgent`, `prepareStep`, `Output.*`, `toolApproval`, lifecycle telemetry, and message/tool-result representations. These remove local orchestration code without replacing durable SQLite state. The custom Claude adapter currently selects its own tool protocol schema whenever tools exist (`src/model/language-model.ts:178-204`), so `Output.*` plus tools is not assumed compatible until a contract test proves and implements response-format composition.

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
- shared root budget, stable loop slots, reservations, deadline, and concurrency ceiling
- checkpoints and crash recovery
- tool invocation journal and unknown/interrupted invocation state
- approval authentication, expiry, policy, and audit
- operation/delivery leases, idempotency, retries, and outbox
- quota/usage accounting source of truth
- MCP session IDs and provider response IDs

The kernel also owns the closed `EffectAtom` vocabulary, generation-pinned `ProfileRef`, `CoreToolPolicyRef`, `ResultContractRef`, and the canonical `SkillPlan` shape with empty slots allowed. These bootstrap types let every production model call use a profile and zero-Skill plan before plan 011 adds Skill composition. Effect classification is shared; external authorization remains plan 007's responsibility.

Telemetry is observability, not audit. Partial structured streams are display-only, never committed decisions.

## Steps

1. Pin `ai` to the exact version whose public types and behavior are tested; dependency upgrades are explicit changes, not semver-range drift.
2. Add provider contract tests for plain text, tools, `Output.object` without tools, `Output.object` with tools, invalid output repair, and approval pause/replay. Implement response-format/tool-protocol composition in each custom `LanguageModelV4` adapter before adopting combined output modes.
3. Replace the compatibility alias `Experimental_Agent` with stable `ToolLoopAgent`; replace compatibility stop helper names with current stable APIs after confirming installed declarations.
4. Define generation-pinned Profile/CoreToolPolicy/ResultContract registries, canonical zero-SkillPlan, immutable `ExecutionRoot`, and `LoopSpec` records. A root owns scope, shared budget account, deadline, coordinator reserve, and concurrency ceiling; it may contain multiple sequential/parallel loops. Each LoopSpec has a stable slot, role, ProfileRef, canonical typed task input/hash, ordered artifact refs/digests, SkillPlan hash, ResultContractRef, scope, stop policy, and budget reservation. No loop type is inherently `main`.
5. Define a shared loop runner that requires ProfileRef rather than an arbitrary production model ID, always wraps models with governance middleware, and requires explicit stop conditions, zero SDK retries by default, root/loop IDs, deadline, telemetry metadata, and an effect-classified effective toolset. Make arbitrary model-ID calls test-only. Governed runs reject provider-native/injected tools that perform external I/O, including web reads, because local journaling cannot precede provider I/O. No-I/O protocol controls such as Claude structured response formatting and tool-call serialization remain allowed and are covered by provider contract tests. Replace the current model-ID-based Codex web-search injection (`src/model/codex-responses.ts:362-378`) with the existing local Search tool binding; plan 007 later places that same binding behind Capability authorization.
6. Add a root budget ledger with persistent reservation state (`held -> consuming -> consumed | released | unknown`), atomic all-or-none reservations, coordinator reserve owned by a fixed root slot, maximum active loops, stable-slot dedupe, cancellation propagation, and release of unused terminal reservations. `unknown` reservations are not released automatically. Start with one root/one loop and concurrency 1.
7. Introduce `prepareStep` for dynamic model routing, `activeTools` restriction, budget/deadline enforcement, and research-mode-specific instructions. Revalidate the effective toolset after model switching. Do not mutate durable state from `prepareStep`.
8. Move new structured results to `Output.object`, `Output.array`, and `Output.choice` only on provider paths proven by the contract suite; preserve the Valibot runtime-validation bridge.
9. Add a tool invocation journal keyed by root/loop/tool-call ID and canonical input hash. Record `prepared/started/succeeded/failed/unknown` before and after execution and persist a reusable result or durable Operation/delivery reference. SDK tool execution starts only after the `started` record commits.
10. Persist versioned `ModelMessage`-compatible messages plus tool call/result IDs at durable checkpoints. Validate before replay. A succeeded invocation reuses its stored result; an interrupted inline replay-safe invocation follows its declared recovery rule; an operation-classified, arbitrary-command, or otherwise non-replay-safe `started` invocation becomes `unknown` and makes the loop non-resumable until reconciled/manual resolution. Never merely discard an unmatched call and regenerate the loop.
11. Register lifecycle telemetry with inputs/outputs disabled by default. Emit root/loop/step/model/tool durations and provider metadata while retaining Ledger and audit rows in SQLite.
12. Do not use AI SDK approval replay for effect execution. An SDK approval message can represent a paused model loop or Operation UI projection, while plan 007 owns the sole approval and out-of-band executor.
13. Use provider response IDs or MCP session IDs only as optional acceleration metadata; local state remains sufficient to explain and recover a root/loop.
14. Remove or expose open-zero's Claude adapter resubmission (`src/model/language-model.ts:191-209`) as a separately governed and accounted model call; one SDK call cannot hide multiple adapter-controlled calls.
15. Inspect and pin the installed Claude CLI's transport-retry behavior. Disable internal retries when supported. If retries are opaque and cannot be disabled, define the hard call-budget unit as one bounded adapter process invocation, record `transportRetryVisibility: "opaque"`, enforce the process deadline once, reserve the configured maximum output allowance conservatively, and do not claim per-HTTP-attempt or unreported-token hard accounting.
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

Targeted tests must cover exhaustive production ProfileRef coverage, arbitrary model-ID production call rejection, zero-SkillPlan, one root with one/multiple LoopSpecs, no privileged main role, canonical typed-input/artifact hashing, ResultContract/CoreToolPolicy generation pinning, atomic sibling reservations, persistent reservation transitions, coordinator reserve isolation, unknown reservation non-release, stable-slot same-hash reuse and changed-hash conflict, concurrency ceiling, cancellation propagation, step limit, deadline-based active-tool reduction, model switching, provider-native/injected external-I/O tool rejection before I/O, local Search binding replacement, allowed no-I/O structured response protocol, revalidation after routing, plain/tool/structured/combined provider modes, invalid structured output, invalid tool input repair, governance and accounting on every adapter-controlled model call including repair/resubmission, pinned CLI retry visibility/deadline behavior, rejection of unclassified effective tools, telemetry with redacted payloads, successful result replay, crash before/after tool I/O, unknown non-resumable invocation, approval pause without effectful replay, and SDK upgrade type drift.

## Done criteria

- No new agent loop reimplements AI SDK step execution.
- Every model call still passes Governance and Ledger accounting.
- Structured decisions are validated through `Output.*` plus domain checks.
- Multiple live loops can run under one root without exceeding declared adapter-process/tool budget units or concurrency, and without relying on a privileged main loop. Unobservable provider-internal attempts/tokens are explicitly outside the hard accounting claim.
- Durable resume works from SQLite without provider-held conversation state.
- Durable resume never repeats an effect whose outcome is unknown.
- Telemetry failure cannot lose or change an audit fact.
- No AI SDK approval or MCP facility can bypass Operation policy.

## Stop conditions

Stop if stable AI SDK APIs differ from installed `7.0.62` declarations. Pin behavior to installed types and update this plan before changing dependencies. Stop if replay requires serializing provider-private objects rather than public `ModelMessage`/tool representations.
