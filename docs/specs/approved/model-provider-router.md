---
title: "Model Provider Router"
id: model-provider-router
status: approved
informed_by:
  - docs/research/technical/RESEARCH-INFERENCE-CONTROL-PLANE.md
  - docs/research/technical/RESEARCH-COMPETITIVE-SYSTEMS.md
section: "Runtime"
depends_on:
  - signet-runtime
success_criteria:
  - "Signet exposes a shared inference routing layer that can select among session-backed, API-backed, and local model targets from agent.yaml policy"
  - "The daemon exposes both a Signet-native inference API and an OpenAI-compatible gateway surface backed by the same router"
  - "Daemon-managed workloads such as extraction and synthesis can route through the same policy engine instead of a separate provider selector"
  - "Operators can inspect routing decisions, health, and fallback state from the CLI and daemon status surfaces"
scope_boundary: "Defines Signet's inference control plane, routing schema, and daemon/CLI surfaces; does not require every harness to immediately drop its internal executor implementation"
---

# Model Provider Router

## Problem

Today inference routing is fragmented. Harnesses and daemon workloads each own
separate model/provider selection paths. That prevents Signet from enforcing a
single privacy policy, fallback strategy, or observability surface.

## Goals

1. Make Signet the inference control plane.
2. Support per-agent rosters of session-backed, API-backed, and local targets.
3. Route by policy and task class, not only by one static provider.
4. Expose both a compatibility gateway and a native RPC.
5. Bring extraction and synthesis under the same routing surface.

## Non-goals

- Replacing every harness runtime implementation in one PR.
- Defining cloud orchestration or distributed scheduling.
- Shipping a separate long-lived router sidecar in v1.

## Architecture

The daemon owns four responsibilities:

1. provider/account/session registry
2. policy evaluation and route explanation
3. execution and fallback orchestration where Signet owns the call
4. compatibility and native API surfaces

Harnesses integrate in one of two ways:

- OpenAI-compatible gateway for broad compatibility
- Signet-native inference RPC for richer routing hints and subtask metadata

## Config contract

`agent.yaml` gains a top-level `routing:` block with:

- `accounts`
- `targets`
- `policies`
- `taskClasses`
- `agents`
- `workloads`

Legacy extraction/synthesis config remains valid and is compiled into an
implicit routing profile so existing installs keep working.

## Required behavior

### Routing modes

- `strict`: explicit ordered chain
- `automatic`: score eligible candidates
- `hybrid`: automatic within a constrained allowlist

### Hard gates

The router must block a target when:

- privacy tier is insufficient
- required capability is missing
- context window is too small
- account/session state is missing or expired
- the route is administratively unavailable

### Execution and fallback

The selected target executes first. If it fails, the router may try later
allowed targets from the resolved fallback chain and must record the attempt
sequence in the route trace.

### Workloads

Daemon-managed workloads use the same router:

- `memory_extraction`
- `session_synthesis`
- `interactive`

When a workload call site does not provide an `agent_id`, the router uses the
workspace default agent context.

## API surface

### Native inference API

The daemon exposes endpoints for:

- listing routing config and runtime state
- explaining a route decision without execution
- executing a routed prompt
- inspecting route health and recent fallback state

### Compatibility gateway

The daemon exposes an OpenAI-compatible gateway for:

- `GET /v1/models`
- `POST /v1/chat/completions`

The gateway may accept Signet-specific metadata headers so compatible harnesses
can pass agent, task-class, privacy-tier, and policy hints.

## CLI surface

The CLI exposes:

- `signet route list`
- `signet route status`
- `signet route explain`
- `signet route test`
- `signet route pin`
- `signet route unpin`

## Integration contracts

### Signet Runtime

This spec extends `signet-runtime`: harnesses remain thin adapters over daemon
contracts, but inference routing becomes a first-class daemon-owned contract.

### OpenClaw and Hermes

OpenClaw and Hermes should prefer Signet-owned routing where they can point at
Signet as a provider or call the native inference API. This spec does not block
incremental harness adoption.

## Validation

- Routing decisions are reproducible from config + runtime snapshot.
- CLI explain matches daemon explain.
- Privacy-denied tasks never route to remote targets.
- Gateway and native RPC are backed by the same decision engine.
- Legacy extraction/synthesis behavior remains available through implicit
  routing when explicit routing is absent.

## Implementation progress

This section is an implementation ledger for the approved contract above.
It is intentionally operational, not normative. Update it as work lands so
the spec stays useful as both contract and progress tracker.

### Done

- Shared router core exists in `@signet/core` with:
  - `routing:` config parsing
  - legacy extraction/synthesis -> implicit routing compilation
  - strict / automatic / hybrid policy resolution
  - privacy, capability, context, and basic runtime-availability gates
  - route traces and fallback target ordering
- The daemon owns a new inference router service with:
  - config loading from `agent.yaml`
  - runtime snapshot generation
  - routed execution with ordered fallback attempts
  - workload-provider shims for extraction and session synthesis
- Native inference API exists:
  - `GET /api/inference/status`
  - `POST /api/inference/explain`
  - `POST /api/inference/execute`
- OpenAI-compatible gateway exists:
  - `GET /v1/models`
  - `POST /v1/chat/completions`
- Daemon-managed workloads can route through the shared router:
  - `interactive`
  - `memory_extraction`
  - `session_synthesis`
- Signet-owned OS surfaces now try the router first and fall back cleanly:
  - `os-chat`
  - `os-agent`
- CLI route tooling exists:
  - `signet route list`
  - `signet route status`
  - `signet route doctor`
  - `signet route explain`
  - `signet route test`
  - `signet route pin`
  - `signet route unpin`
- Docs and tests landed for the initial control-plane wave.

### Partially done

- Config model is present, but simplified:
  - `accounts`, `targets`, `policies`, `taskClasses`, `agents`, and
    `workloads` exist
  - a separate canonical top-level `models:` map does not yet exist
- Provider abstraction is richer at the router layer, but execution still
  largely relies on the existing `LlmProvider` plumbing underneath
- Subscription/session-backed accounts are modeled in schema, but not yet
  implemented as first-class persisted session/quota entities with refresh
  lifecycle
- Routing decisions use task class, policy, privacy, capability, and basic
  heuristics, but the request contract is not yet as rich as the target
  end state for harness/runtime metadata and subtask semantics
- Observability exists per call through route traces and execution attempts,
  but does not yet persist route history, quota state, or fallback analytics
- CLI support is functional, but still lacks the full override surface
  described in the original plan, especially richer request-shaping flags

### Not done

- First-class session/account registry behavior:
  - explicit persisted account health records
  - quota tracking
  - expiry / invalidation state transitions
  - refresh or revalidation flows where supported
- Policy-engine hardening:
  - retry classification taxonomy
  - circuit breaking
  - cooldown / recovery logic
  - durable degraded-state tracking
- Streaming and cancellation:
  - gateway streaming
  - native streaming session lifecycle
  - cancellation surface
  - mid-stream degradation / restart policy
- Dedicated security and abuse controls for inference routes:
  - route-specific rate limiting
  - stricter request/body/header ceilings
  - hardened permission/scope coverage for route and gateway entry points
- Persisted telemetry for routing decisions, fallback hops, costs, and
  session/quota state
- Harness adoption outside Signet-owned daemon routes:
  - OpenClaw
  - Hermes
  - OpenCode
  - Pi
- Full chaos/integration coverage for:
  - session expiry
  - 429 / quota exhaustion
  - local backend loss
  - mid-stream provider failure
  - strict fallback chains under real failure
