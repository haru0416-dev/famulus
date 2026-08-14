# open-zero implementation plans

Planned at `2ce2a2a` on `main`.

## Architecture decision

Do not build one generic workflow engine for research, delivery, external actions, and self-deployment.
The repository previously removed unused `outbox` and `execution_attempts` tables because no code owned their lifecycle (`docs/adr/0007-drop-unused-tables.md`). New state is added only with its first reader, writer, and end-to-end check.

The design has three domain tracks:

1. **Delivery**: reliable inbound/outbound transport and draft delivery.
2. **Research**: evidence, experiments, explore modes, campaigns, and signposts.
3. **Operation**: future MCP/plugins/connectors and approved external writes.

Self-deployment is separate from normal Operation because it changes the executor and its safety policy.

Agent Plugins 1.0.0 is the preferred external package format, not a fourth execution model. Its portable `plugin.json`, `skills/`, and `mcp.json` components feed the internal registry. Installation trust, permission grants, credentials, approval, sandboxing, updates, and audit remain open-zero responsibilities because the specification does not define them.

Extension authority is split by responsibility:

- **Skill** supplies instructions for one turn; it owns no state, tools, model, budget, schedule, or authority.
- **Router** chooses at most one allowed Skill before a turn; it cannot call tools or change state.
- **Agent profile / policy compiler** creates the immutable turn specification and effective scope.
- **AI SDK loop** runs one live bounded turn; it does not own durable repetition.
- **Domain service** owns durable repetition and transitions, such as research campaigns or delivery.
- **Hook observer** reacts only to committed typed events by requesting a core-owned handler; it cannot execute effects directly.
- **Plugin** packages generation-pinned Skills and MCP candidates; it does not register loops, hooks, schedulers, or state machines.
- **Capability / Operation** is the only path to external effects.

Authority only decreases across routing and delegation. Skill text, plugin metadata, model choice, and events never carry grants.

Shared invariants, not a shared state machine:

- immutable typed spec before approval or execution
- canonical serialization and content hash
- durable attempt before external I/O
- explicit `success / failed / partial / unknown`
- no blind retry from `unknown`
- external receipt and reconciliation when available
- append-only audit facts separated from current-state projections
- capability-specific verification defines completion
- every effective model-visible tool, including provider-injected/native tools, has a local effect classification; unclassified tools are unavailable
- network egress, user notification, and arbitrary command execution are effects even when sandboxed or first-party
- provider-executed external-I/O tools are unavailable in governed runs, including read/search tools, because local policy cannot journal before their I/O; no-I/O protocol features such as structured response formatting remain allowed

## AI SDK boundary

The installed `ai@7.0.62` is the in-process model execution kernel:

- `ToolLoopAgent` for a single live turn's tool loop
- `stopWhen` and `prepareStep` for bounded per-step model/tool selection
- `Output.*` for validated structured model results
- `toolApproval` for approval request/response protocol, not approval storage
- lifecycle telemetry for traces, not the audit source of truth
- `ModelMessage`, response messages, tool calls, and tool results as persistence formats
- `@ai-sdk/mcp` later for MCP protocol conversion behind Capability policy

SQLite remains authoritative for runs, checkpoints, the single Operation approval record, provider generations, grants, sessions, leases, outbox, attempts, retries, and crash recovery. AI SDK approval messages may project an Operation decision but never execute an effectful tool on replay. Provider-executed write tools are not allowed because they bypass the local executor and approval boundary.

## Order

| Plan | Stage | Depends on | Outcome |
|---|---|---|---|
| [001](001-runtime-safety.md) | P0 | - | validated config, stable paths, migrations, backup, cycle lease |
| [009](009-ai-sdk-kernel.md) | Cross-cutting | 001 | stable AI SDK agent, structured output, step policy, traces, persisted messages |
| [002](002-reliable-discord.md) | P0 | 001 | paged inbound and durable outbound delivery |
| [003](003-draft-lifecycle-e2e.md) | P0 | 002, 009 | resumable draft lifecycle and black-box health checks |
| [004](004-research-evidence.md) | P1 | 001, 009 | evidence, claims, experiments, artifacts, dossiers |
| [005](005-explore-modes.md) | P1 | 004, 009 | measured `wide / deep / explore` and fixed fan-out |
| [006](006-research-campaigns.md) | P2 | 004, 005, 009 | durable campaigns, branches, checkpoints, signposts |
| [007](007-capability-operations.md) | Future foundation | 001, 002, 009 | typed capabilities, approval-safe operations, MCP boundary |
| [010](010-agent-plugin-packages.md) | Future foundation | 001, 007, 009 | Agent Plugins 1.0.0 loader, pinned installs, grants, updates |
| [011](011-extension-control-boundaries.md) | Future foundation | 007, 009, 010 | native Skill routing, turn scopes, typed observers, delegation rules |
| [008](008-self-deploy.md) | Future foundation | 001, 003, 007 | staged self-update with health check and rollback |

P0 through P2 means plans 001 through 006 plus cross-cutting plan 009. Plans 007, 008, 010, and 011 fix the future shape without pretending connectors, plugin installation, extension routing, or autonomous deployment already exist.

## Global stop conditions

- Stop if `git diff --stat 2ce2a2a..HEAD -- <scope>` shows unreviewed drift in a plan's scope.
- Stop if a schema change would discard existing production data.
- Stop after the same verification failure occurs twice; re-derive the approach.
- Stop if an implementation needs credentials inside Sandbox or model-controlled code.
- Stop if a new table has no production reader, writer, and targeted test in the same change.
