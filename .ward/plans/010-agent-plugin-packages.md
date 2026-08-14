# 010 Agent Plugins 1.0.0 package boundary

Planned at `2ce2a2a`.

Depends on plans 001, 007, 009, and plan 011 Phase A. The no-exec package validator may be developed after plan 001, but importing Skills requires the Phase A registry/composition boundary, and MCP activation/effectful capabilities stay disabled until plan 007 is complete.

## Decision

Adopt [Agent Plugins Specification 1.0.0](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md) as an external package compatibility format only.

Portable inputs:

- root `plugin.json`
- `skills/*/SKILL.md`
- root `mcp.json`
- fixed component discovery and component-level failure isolation
- `PLUGIN_ROOT` and persistent per-instance `PLUGIN_DATA`
- filesystem-resolved package containment

The specification does not define trust, permissions, sandboxing, signatures, secrets, registry/install/update behavior, revocation, or audit. Those remain open-zero policy. The package manifest is never the internal Capability, approval, or execution contract.

```text
acquire -> inspect/no-exec install -> AgentPluginLoader
        -> Skills / MCP provider candidates -> Capability registry
        -> immutable Operation -> policy/approval -> non-LLM executor
```

MCP remains the connection and wire protocol. Agent Plugins describes how an MCP server configuration is packaged. AI SDK adapts an accepted MCP connection to model tools. Only open-zero Capability and Operation layers decide whether and how an effect may execute.

## Trust model

- `name`, `version`, author, repository, descriptions, Skill text, MCP descriptions, and annotations are untrusted claims.
- A plugin instance is identified by open-zero instance ID plus acquisition source and package content digest, not manifest name/version.
- Skill instructions are subordinate to SOUL, Governance, agent profile, and tool grants.
- Skill scripts/assets are untrusted code and do not run during install.
- `allowed-tools` or client extensions are hints, never grants.
- stdio MCP startup is code execution; path containment is not a subprocess sandbox. It remains disabled in the first implementation.
- MCP resources, prompts, tool results, and errors use the existing untrusted-data boundary.
- Hooks, commands, agents/subagents, rules, and LSP are not portable v1 components and are not auto-loaded.

## Install record

Persist only with the first production reader, writer, CLI, and tests:

- instance ID and enabled generation
- source kind/URL/ref and acquisition receipt
- package SHA-256 and per-file inventory
- supported schema version
- immutable install root and separate data root
- discovered components, quarantined probe results, and diagnostics
- grants bound to component/server/tool, immutable CapabilityImplementationRef/code digest, input/output-schema hashes, Capability/adapter version, credential scope, and package digest
- revoked/disabled state and timestamps
- generation leases from active consumers: this plan owns Operations/live sessions, plan 011 Phase A owns live-loop refs, plan 006 owns campaign checkpoints, and plan 011's gated observer phase owns handler requests

Manifest `version` is display/update-candidate metadata only. Existing approved Operations remain pinned to the exact old generation until terminal.

## Steps

1. Vendor the recognized 1.0.0 schema documents and record their source/digests. Never fetch schemas while loading a package.
2. Build a no-exec validator for JSON shape, supported `$schema`, resolved path containment, symlink/archive traversal, device files, case collisions, file count, and total size.
3. Implement fixed discovery for `skills/*/SKILL.md` and `mcp.json`, preserving the specification's narrow failure boundaries and diagnostics.
4. Install into a staged immutable generation, atomically activate it disabled-by-default, and keep `PLUGIN_DATA` outside the package generation.
5. Import valid Skills as generation-pinned instruction candidates with package provenance. Plan 011 owns selection and turn composition. Loading a Skill never expands tools, budget, network, credentials, or approval scope.
6. Import MCP entries as disabled provider candidates. Remote origins, redirects, and credential scopes require local configuration; package header/env values are not a secret mechanism.
7. Use plan 007's quarantined non-LLM probe to connect/initialize/list capabilities. A probe cannot call tools, and failure never enables a candidate.
8. Bind enabled components to local grants and immutable CapabilityImplementationRefs. Any package digest, executable, MCP config, host adapter code digest, input/output tool schema, adapter, credential scope, or effect classification change invalidates the affected grant.
9. Route only host-owned, replay-safe read adapters with enforceable origin/method/data constraints inline through restricted profiles. Raw remote MCP tools stay `unknown` and disabled even when described as reads; they cannot receive a grant or create an Operation until a host-owned effect-specific adapter defines effects, resources, schemas, execution, and recovery. Known write/share/money/deploy adapters route through Operations; a missing adapter leaves the candidate discovered but disabled.
10. Implement generation-based update, capability/implementation diff, rollback, disable, and revocation. Keep package and host-adapter implementation generations while any consumer-owned reference exists: Operations/sessions here, live loops in plan 011 Phase A, campaign checkpoints in plan 006, and handler requests in the gated observer phase. Recheck revocation when claiming work and immediately before external I/O; close sessions, kill processes/containers, revoke credential leases, and block egress on revocation. Revocation forbids new I/O but may retain read-only package bytes required by a pinned non-effectful consumer.
11. Add marketplace/source acquisition only after local-directory and pinned-repository installs pass the same inspection and rollback tests. Do not invent a registry protocol before the standard defines one or a concrete source requires it.

## Runtime isolation

- package root and executable/runtime dependency closure are generation-pinned and read-only
- `PLUGIN_DATA` is writable data only; loading executable code or dependencies from it is forbidden in the initial implementation
- no ambient environment, home directory, SSH agent, database, or host credentials
- credentials are injected by an effect-specific adapter with explicit scope
- remote MCP uses HTTPS, origin allowlists, SSRF/DNS re-resolution checks, and strips sensitive headers on cross-origin redirects
- stdio is disabled initially; enabling it later requires a digest-pinned runtime closure, dedicated process/container profile, session kill, credential revocation, and egress cutoff tests
- update never replaces bytes beneath an executing or approved Operation

## Verification

```sh
git diff --stat 2ce2a2a..HEAD -- src/plugins src/services src/db src/cli.ts test package.json bun.lock
bun run gate
bun run test:plugins-e2e
```

Fixtures must cover a minimal plugin, Skills plus MCP, unknown top-level manifest fields, fatal field errors, unsupported schema, missing optional component locations, symlink escape, archive traversal, component-level failure isolation, disabled-by-default install, no install-time execution, Skill grant non-escalation, forbidden code load from `PLUGIN_DATA`, quarantined probe, probe tool-call denial, raw MCP grant/Operation denial, MCP schema drift, same-schema remote misbehavior remaining a trust risk, update commit crash, startup reconciliation, package and host-adapter implementation generations retained by a nonterminal Operation/session, same version with changed code digest invalidation, update diff, rollback, revocation with live session, read-only package retention after revocation, `PLUGIN_DATA` preservation, and an effectful MCP tool blocked before Operation creation.

## Done criteria

- A conforming 1.0.0 package can be inspected and installed without executing its contents.
- Package identity and grants are pinned to content and local policy, not self-reported metadata.
- Skills and MCP provider candidates cannot silently expand permissions.
- Plugin packages cannot register hooks, loops, schedulers, domain handlers, or durable state machines.
- MCP write tools cannot execute outside plan 007.
- Updates preserve data, keep in-flight generations, show capability diffs, and invalidate changed grants.
- Revoked generations cannot start new external I/O.

## Stop conditions

Stop if implementation requires changing the portable schema or assigning security semantics to client extensions. Stop if an Operation cannot pin package digest, immutable host-adapter implementation digest, adapter version, MCP configuration, input/output tool schemas, and credential scope. Stop if stdio startup can reach host/network/secrets before its sandbox profile is proven. Stop if marketplace work starts defining a private registry protocol without a concrete interoperable consumer.
