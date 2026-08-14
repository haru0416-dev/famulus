# 009 AI SDK v7 execution kernel

Planned at `2ce2a2a`.

Depends on plan 001 and is cross-cutting for plans 003 through 007, 010, and 011.

## Why

The repository already adapts Claude CLI and Codex Responses to AI SDK `LanguageModelV4`, applies governance as middleware, validates Valibot tool inputs, and runs the loop through `Experimental_Agent` (`src/agent/assistant.ts:20,1031-1108`, `src/model/governed.ts`, `src/model/schema.ts`). Installed `ai@7.0.62` exposes stable `ToolLoopAgent`, `prepareStep`, `Output.*`, `toolApproval`, lifecycle telemetry, and message/tool-result representations. These remove local orchestration code without replacing durable SQLite state. The custom Claude adapter currently selects its own tool protocol schema whenever tools exist (`src/model/language-model.ts:178-204`), so `Output.*` plus tools is not assumed compatible until a contract test proves and implements response-format composition.

## Responsibility boundary

AI SDK owns:

- one live turn's model/tool loop
- tool input schema validation and tool-call protocol
- bounded stop conditions
- per-step model, instruction, and active-tool selection
- complete structured-output validation
- approval request/response message representation
- stream and lifecycle events
- provider adaptation and response messages

SQLite owns:

- run/turn/step source of truth and format version
- checkpoints and crash recovery
- tool invocation journal and unknown/interrupted invocation state
- approval authentication, expiry, policy, and audit
- operation/delivery leases, idempotency, retries, and outbox
- quota/usage accounting source of truth
- MCP session IDs and provider response IDs

Telemetry is observability, not audit. Partial structured streams are display-only, never committed decisions.

## Steps

1. Pin `ai` to the exact version whose public types and behavior are tested; dependency upgrades are explicit changes, not semver-range drift.
2. Add provider contract tests for plain text, tools, `Output.object` without tools, `Output.object` with tools, invalid output repair, and approval pause/replay. Implement response-format/tool-protocol composition in each custom `LanguageModelV4` adapter before adopting combined output modes.
3. Replace the compatibility alias `Experimental_Agent` with stable `ToolLoopAgent`; replace compatibility stop helper names with current stable APIs after confirming installed declarations.
4. Define a shared agent factory that always wraps models with governance middleware and requires explicit stop conditions, zero SDK retries by default, run ID, deadline, telemetry metadata, and an effect-classified effective toolset. Governed runs reject provider-native/injected tools that perform external I/O, including web reads, because local journaling cannot precede provider I/O. No-I/O protocol controls such as Claude structured response formatting and tool-call serialization remain allowed and are covered by provider contract tests. Replace the current model-ID-based Codex web-search injection (`src/model/codex-responses.ts:362-378`) with the existing local Search tool binding; plan 007 later places that same binding behind Capability authorization.
5. Introduce `prepareStep` for dynamic model routing, `activeTools` restriction, budget/deadline enforcement, and research-mode-specific instructions. Revalidate the effective toolset after model switching. Do not mutate durable state from `prepareStep`.
6. Move new structured results to `Output.object`, `Output.array`, and `Output.choice` only on provider paths proven by the contract suite; preserve the Valibot runtime-validation bridge.
7. Add a tool invocation journal keyed by run/turn/tool-call ID and canonical input hash. Record `prepared/started/succeeded/failed/unknown` before and after execution and persist a reusable result or durable Operation/delivery reference. SDK tool execution starts only after the `started` record commits.
8. Persist versioned `ModelMessage`-compatible messages plus tool call/result IDs at durable checkpoints. Validate before replay. A succeeded invocation reuses its stored result; an interrupted inline replay-safe invocation follows its declared recovery rule; an operation-classified, arbitrary-command, or otherwise non-replay-safe `started` invocation becomes `unknown` and makes the turn non-resumable until reconciled/manual resolution. Never merely discard an unmatched call and regenerate the turn.
9. Register lifecycle telemetry with inputs/outputs disabled by default. Emit run/step/model/tool durations and provider metadata while retaining Ledger and audit rows in SQLite.
10. Do not use AI SDK approval replay for effect execution. An SDK approval message can represent a paused model turn or Operation UI projection, while plan 007 owns the sole approval and out-of-band executor.
11. Use provider response IDs or MCP session IDs only as optional acceleration metadata; local state remains sufficient to explain and recover a run.
12. Remove or expose open-zero's Claude adapter resubmission (`src/model/language-model.ts:191-209`) as a separately governed and accounted model call; one SDK call cannot hide multiple adapter-controlled calls.
13. Inspect and pin the installed Claude CLI's transport-retry behavior. Disable internal retries when supported. If retries are opaque and cannot be disabled, treat one CLI process invocation as the adapter's bounded transport-attempt unit, record `transportRetryVisibility: "opaque"`, enforce the process deadline once, and do not claim per-HTTP-attempt accounting.
14. Add contract tests against the installed package types and AI SDK test utilities so upgrades fail visibly when APIs or message shapes change.

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

Targeted tests must cover step limit, deadline-based active-tool reduction, model switching, provider-native/injected external-I/O tool rejection before I/O, local Search binding replacement, allowed no-I/O structured response protocol, revalidation after routing, plain/tool/structured/combined provider modes, invalid structured output, invalid tool input repair, governance and accounting on every adapter-controlled model call including repair/resubmission, pinned CLI retry visibility/deadline behavior, rejection of unclassified effective tools, telemetry with redacted payloads, successful result replay, crash before/after tool I/O, unknown non-resumable invocation, approval pause without effectful replay, and SDK upgrade type drift.

## Done criteria

- No new agent loop reimplements AI SDK step execution.
- Every model call still passes Governance and Ledger accounting.
- Structured decisions are validated through `Output.*` plus domain checks.
- Durable resume works from SQLite without provider-held conversation state.
- Durable resume never repeats an effect whose outcome is unknown.
- Telemetry failure cannot lose or change an audit fact.
- No AI SDK approval or MCP facility can bypass Operation policy.

## Stop conditions

Stop if stable AI SDK APIs differ from installed `7.0.62` declarations. Pin behavior to installed types and update this plan before changing dependencies. Stop if replay requires serializing provider-private objects rather than public `ModelMessage`/tool representations.
