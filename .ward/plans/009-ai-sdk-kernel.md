# 009 AI SDK execution boundary

Planned at `2ce2a2a`. Implemented in the `c2d5233` through current commit series.

Depends on plan 001. Plans 002 and 007 own durable external effects.

## Why

Use the installed stable AI SDK agent loop without recreating its step protocol. Keep provider access behind one GPT adapter, apply Governance and Ledger accounting to every model call, and prevent provider-side tools from bypassing local policy.

## Boundary

AI SDK owns:

- live model/tool step orchestration
- tool input validation and bounded stop conditions
- structured output handling
- public `ModelMessage` and lifecycle representations

open-zero owns:

- model allowlist and routing
- quota gates and Ledger accounting
- locally executed tools and their policy
- optional durable model attempts for jobs that already have a stable owner

Durable model attempts are not a general conversation-resume mechanism. The main assistant history is process-local, so recording every provider call without a resumable checkpoint would add rows without preventing duplicate effects. Durable tool execution, delivery, and outbox recovery belong to the plans that own those effects.

## Implemented

1. Pin `ai` to the tested version and use stable `ToolLoopAgent` with explicit stop conditions and `maxRetries: 0`.
2. Limit production models to `gpt-5.6-sol` and `gpt-5.6-luna`.
3. Use the Codex Responses adapter directly with ChatGPT OAuth. API keys are not accepted.
4. Perform one provider request per adapter invocation. A 401 is returned as a failure; the adapter does not refresh and retry invisibly.
5. Apply Governance and Ledger accounting in both AI SDK middleware and `Runner` paths.
6. Remove provider-native `web_search`. Research uses the local `search` and `fetch` tools, so policy and observations remain on the host side.
7. Validate structured Runner results with the existing runtime schema bridge.
8. Keep ExecutionKernel model attempts available for stable owner-bound work such as keeper jobs. Calls without a meaningful durable owner use Governance and Ledger only.
9. Create the current SQLite schema once. No schema version or migration chain is maintained.

## Deferred

- Durable Discord delivery and outbox: plan 002.
- Tool invocation journal and capability authorization: plan 007.
- Multiple durable loops and SkillPlan composition: plan 011.
- General assistant checkpoint/resume: only add when a persisted `ModelMessage` checkpoint can actually resume the loop.

## Verification

```sh
bun run gate
bun run oz status
bun run oz doctor
```

## Done Criteria

- Production accepts only sol/luna GPT model IDs.
- No provider-native external-I/O tool is injected.
- AI SDK and Runner calls pass Governance and Ledger accounting.
- SDK and transport retries are explicit and disabled by default.
- Structured Runner output is runtime-validated.
- Owner-bound durable model attempts commit before provider I/O.
- Fresh databases are created from the current schema in one shot.
