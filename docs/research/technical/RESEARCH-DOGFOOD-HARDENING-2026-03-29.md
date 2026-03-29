---
title: "Dogfood Hardening Findings, March 29 2026"
question: "Which concrete runtime and MCP regressions surfaced during the March 29, 2026 Signet dogfood run, and what guardrails should harden them?"
date: "2026-03-29"
status: "complete"
---

# Dogfood hardening findings, March 29 2026

## What this research answers

This note captures the incident class exposed by the March 29, 2026
dogfood run so the follow-on planning stub can point to a concrete
source of truth instead of relying on ephemeral chat context.

## Findings

The dogfood run surfaced eight issues with clear clustering:

1. Vector runtime fragility in shadow decisions. The daemon kept trying
   vec-backed decision queries even when `vec0` was not usable, causing
   recurring log spam and degraded dedup behavior.
2. Named knowledge expansion was ambiguous. Expanding `"Signet"` could
   resolve the wrong entity when a more prominent pinned or highly-linked
   entity was nearby in the graph.
3. Session expansion was too brittle. Temporal drill-down depended on a
   narrow memory-mention join and could return zero summaries even when
   summary text and project path clearly matched the requested entity.
4. Session visibility diverged between REST and MCP surfaces. Cross-agent
   presence could show a live session while `/api/sessions` and bypass
   routes behaved as if no session existed.
5. Feedback acceptance semantics were opaque. `recorded` and `accepted`
   reflected different stages, but the API did not explain the contract
   clearly enough for operators to debug zero-acceptance cases.
6. Constructed entity cards were noisy. Temporal bookkeeping fragments and
   low-signal attributes could dominate supplementary constructed results.
7. MCP policy defaults exposed epoch timestamps, which confused state
   inspection even though the behavior itself still worked.

## Guardrail direction

- Gate vec-backed decision retrieval on confirmed runtime usability.
- Resolve named entity expansion with exact-match priority before broader
  token traversal logic.
- Let session expansion fall back to summary text and project matching
  when explicit mention links are absent.
- Normalize session keys across REST and MCP-facing paths, including
  `session:<uuid>` forms.
- Make feedback acceptance semantics explicit in API responses and docs.
- Filter temporal bookkeeping noise from constructed context blocks and
  keep those blocks on a tighter character budget.
