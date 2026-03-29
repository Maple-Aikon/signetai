---
title: "Dogfood Hardening, March 29 2026"
id: dogfood-hardening-2026-03-29
status: planning
informed_by:
  - docs/research/technical/RESEARCH-DOGFOOD-HARDENING-2026-03-29.md
section: "Runtime"
depends_on:
  - "memory-pipeline-v2"
  - "signet-runtime"
  - "knowledge-architecture-schema"
success_criteria:
  - "Shadow decisions stop issuing vec-backed queries when the vector runtime is unavailable and continue without recurring vec0 failures"
  - "Named entity expansion resolves exact requested entities before graph prominence or pinned-state heuristics"
  - "Temporal session expansion returns matching summaries when mention links or summary/project text indicate the requested entity"
  - "REST session listing and bypass routes accept normalized session keys and stay aligned with live presence visibility"
  - "Memory feedback responses explain recorded versus accepted ratings clearly enough to debug zero-acceptance cases"
  - "Constructed entity cards omit temporal bookkeeping noise and stay within a tighter supplementary content budget"
scope_boundary: "Incident hardening for runtime, MCP, and knowledge-retrieval surfaces only; does not redesign the memory model, traversal architecture, or session system"
draft_quality: "incident-driven planning stub"
---

# Dogfood Hardening, March 29 2026

## Problem

The March 29, 2026 dogfood run on `v0.86.1` exposed a cluster of small but
real operator-facing regressions across the daemon, MCP tools, and
knowledge-retrieval surfaces. None of them required a new product design,
but together they made the system feel less trustworthy than it should.

The failures fell into five buckets:

1. Vec-backed shadow decisions kept trying to run after vector runtime
   failure.
2. Named knowledge expansion could resolve the wrong root entity.
3. Temporal session expansion was too dependent on one brittle linkage path.
4. Session state differed between cross-agent presence and REST/bypass APIs.
5. Feedback and constructed-result surfaces were technically working but not
   operator-clear.

## Goals

1. Fail cleanly when vec-backed decision retrieval is unavailable.
2. Make named entity expansion deterministic and exact-match first.
3. Make session expansion resilient to missing mention-link coverage.
4. Normalize session identity across REST and MCP-facing surfaces.
5. Reduce low-signal output on feedback and constructed supplementary cards.

## Proposed hardening

### 1) Vector runtime gating

Shadow decisions should only attempt vec-backed candidate retrieval when the
runtime has positively confirmed vec usability. A found extension path is not
enough. Startup probing and runtime status should distinguish:

- extension discovered
- extension loaded
- vec table creation usable

If vec is unavailable, shadow decisions should degrade to BM25-only without
per-tick repeated failures.

### 2) Deterministic named entity resolution

Direct named expansion should use an exact-match-first resolver shared by
`knowledge_expand` and `knowledge_expand_session`. Pinned state and graph
prominence are useful for traversal, but they should not override an exact
named lookup.

### 3) Temporal expansion fallback path

Session expansion should still use memory-mention linkage when it exists, but
it should also fall back to summary text and project/source matching when the
canonical summary clearly refers to the requested entity.

### 4) Session identity normalization

REST session routes should accept both raw keys and `session:<uuid>` forms.
Session listing should reflect live presence, not only tracker claims, so the
operator-facing surface matches what MCP peer tooling already sees.

### 5) Output hygiene

Feedback responses should explicitly state the acceptance contract, and
constructed cards should drop temporal bookkeeping fragments and stay on a
shorter supplementary budget.

## Validation

- Regression tests cover vec-unavailable shadow decisions, exact named
  expansion, temporal session expansion fallback, prefixed session-key
  bypass, and constructed-card cleanup.
- API/MCP docs explain the clarified behavior for sessions and feedback.
