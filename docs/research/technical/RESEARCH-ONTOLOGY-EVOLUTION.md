---
title: "Research: Ontology Evolution and Governance for Signet"
description: "Research synthesis for evolving Signet's ontology from static graph schema to governed, temporal, confidence-aware knowledge model."
section: "Research"
order: 96
question: "How should Signet evolve its ontology model and governance so graph quality, temporal correctness, and retrieval reliability improve without sacrificing local-first simplicity?"
informs:
  - "knowledge-architecture-schema"
  - "desire-paths-epic"
  - "retroactive-supersession"
  - "predictive-memory-scorer"
---

# Research: Ontology Evolution and Governance for Signet

*Research synthesis. March 24, 2026.*

## Why this document exists

Signet's current ontology foundation (entity -> aspect -> attribute + dependencies) is structurally strong, but several roadmap items and observed issues point to the same need: ontology quality and ontology operations now matter as much as raw extraction throughput.

This document proposes an ontology evolution path that is:
- compatible with current SQLite-first architecture,
- aligned with `docs/specs/INDEX.md` invariants,
- directly mappable to future specs and dependency tracking.

## Current strengths

From existing specs and implementation direction:
- Canonical entity taxonomy and structural density framing exist.
- Agent scoping is a hard invariant.
- Constraint surfacing is explicit and non-negotiable.
- Retroactive supersession exists at attribute level.
- Desire Paths and scorer architecture already expect graph-aware retrieval.

## Current gaps (high signal)

1. **Epistemic uncertainty is under-modeled**
   - Edge strength exists, but edge confidence/provenance handling is incomplete.
2. **Temporal truth is partial**
   - Supersession exists, but world-state queries over time remain limited.
3. **Static relationships dominate**
   - Co-occurrence and feedback-driven structural adaptation are not yet first-class.
4. **Governance loop is weak**
   - No formal ontology proposal/review workflow for high-impact schema evolution.
5. **Consolidation layer is missing**
   - Raw attribute volume can outgrow retrieval clarity without synthesis/provenance summaries.

## External and internal patterns worth adopting

### 1) Semantic model vs action model separation

Keep ontology structure separate from mutation semantics.

- **Semantic layer:** entity types, relation types, aspect/attribute schema, value constraints.
- **Action layer:** supersede, merge, pin, forget, consolidate, rename, confidence override.

This mirrors a proven model from ontology-centric systems and reduces accidental coupling between data shape and workflow behavior.

### 2) Strong type and value constraints

Promote constrained relation/value definitions:
- relation taxonomy as constrained union,
- value constraints (enum/range/regex/date bounds),
- required fields for specific entity/aspect classes.

### 3) Confidence + provenance on dependencies

Formalize edge trust as first-class retrieval signal:
- `confidence` (certainty),
- `reason` (extraction source/provenance class),
- optional `evidence_count` and last validation time.

### 4) Temporal ontology support

Add explicit temporal semantics for facts and relation states:
- validity windows (`valid_from`, `valid_until`) where applicable,
- memory lineage (`parent_id`, `root_id`, `is_latest`) for change tracking,
- query support for "what was true at T?"

### 5) Dynamic relationship learning

Use feedback and co-occurrence safely:
- co-mention and co-retrieval counters,
- normalized association (NPMI-style),
- homeostasis caps to prevent hub inflation.

### 6) Observation/consolidation tier

Add synthesis objects above raw attributes:
- provenance-backed observations per entity/aspect,
- constraints excluded from merges,
- stale observation invalidation on supersession.

### 7) Ontology governance lifecycle

Adopt lightweight change control for schema-level changes:
- proposal -> review -> approved -> shipped,
- diff visibility and migration impact notes,
- rollback and compatibility expectations.

## Proposed ontology capability stack (v1 -> v3)

### V1 (near-term, low risk)
- Edge confidence + reason fields enforced in traversal and ranking.
- Bounded traversal defaults exposed as config.
- Co-occurrence counters on dependencies with guardrails.
- Ontology health metrics: orphan rate, hub concentration, cohesion.

### V2 (mid-term, moderate risk)
- Typed relationship taxonomy migration.
- Observation layer with proof/provenance tracking.
- Temporal retrieval channel integration with current fusion pipeline.
- Structured ontology change proposal workflow.

### V3 (long-term, higher complexity)
- Temporal world-state query semantics at ontology level.
- Workflow/process entities for ordered causal chains.
- Full ontology versioning compatibility policy across migrations.

## Mapping candidates to existing spec graph

| Candidate capability | Best target spec(s) | Status impact |
|---|---|---|
| Edge confidence + reason + bounded traversal | desire-paths-epic (DP-6/DP-9 adjacent) | enrich existing approved spec |
| Co-occurrence + normalization/homeostasis | desire-paths-epic | enrich existing approved spec |
| Observation/consolidation layer | DP-20 trajectory (from competitive systems research) | likely new approved child spec |
| Temporal forgetting + version chains | retroactive-supersession (or new lifecycle spec) | planning -> approved path needed |
| Relationship taxonomy | knowledge-architecture follow-on spec | new planning spec recommended |
| Ontology governance workflow | cross-cutting (index + dependencies discipline) | new planning spec recommended |

## Recommended spec packaging approach

To keep scope manageable, split into two planning specs after this research:

1. **`ontology-evolution-core`**
   - schema and retrieval semantics:
   confidence/provenance, relationship taxonomy, co-occurrence, temporal fields.

2. **`ontology-governance-workflow`**
   - process and safeguards:
   proposal lifecycle, compatibility checks, migration quality gates, rollback policy.

## Suggested measurable outcomes

- Reduced graph noise: orphan/single-mention entity share drops month-over-month.
- Better retrieval precision: MRR/Precision@K improve without recall collapse.
- Fewer unsafe edges: low-confidence edge utilization decreases in top paths.
- Temporal correctness: superseded or expired facts stop appearing as current truth.
- Governance reliability: schema changes ship with explicit impact and rollback paths.

## Open questions

1. Should relation taxonomy be strict from day one or staged with compatibility aliases?
2. Should temporal validity live on attributes, memories, or both?
3. What minimum evidence threshold should upgrade an inferred edge to trusted?
4. How much of ontology proposal workflow should be productized vs internal docs/tooling?
5. Which metrics should block merges vs only warn?

## References

- `docs/specs/INDEX.md`
- `docs/specs/dependencies.yaml`
- `docs/research/technical/RESEARCH-COMPETITIVE-SYSTEMS.md`
- `docs/research/technical/RESEARCH-GITNEXUS-PATTERNS.md`
- `docs/research/technical/RESEARCH-REFERENCE-REPOS.md`
- `docs/research/technical/MSAM-COMPARISON.md`
- `docs/research/technical/RESEARCH-LCM-ACP.md`
- Palantir Foundry Ontology docs (overview/core concepts/models/change workflows)
