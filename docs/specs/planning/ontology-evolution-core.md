---
title: "Ontology Evolution Core"
id: ontology-evolution-core
status: planning
informed_by:
  - "docs/research/technical/RESEARCH-ONTOLOGY-EVOLUTION.md"
  - "docs/research/technical/RESEARCH-COMPETITIVE-SYSTEMS.md"
  - "docs/research/technical/RESEARCH-GITNEXUS-PATTERNS.md"
section: "Knowledge Architecture"
depends_on:
  - "knowledge-architecture-schema"
  - "desire-paths-epic"
success_criteria:
  - "Dependency edges include confidence and provenance signals that retrieval uses by default"
  - "Co-occurrence and normalized association signals improve traversal path quality without hub inflation"
  - "Relationship taxonomy is explicit and validated, replacing free-form dependency typing"
  - "Temporal lineage fields allow current-truth retrieval while preserving history"
scope_boundary: "Defines ontology schema and retrieval semantics for confidence, temporal lineage, and relationship typing; does not define UX governance workflow for reviewing ontology changes"
---

# Ontology Evolution Core

Spec metadata:
- ID: `ontology-evolution-core`
- Status: `planning`
- Hard depends on: `knowledge-architecture-schema`, `desire-paths-epic`
- Registry: `docs/specs/INDEX.md`

Related docs:
- `docs/research/technical/RESEARCH-ONTOLOGY-EVOLUTION.md`
- `docs/specs/approved/desire-paths-epic.md`
- `docs/specs/planning/retroactive-supersession.md`
- `docs/KNOWLEDGE-ARCHITECTURE.md`

---

## 1) Problem

Signet's ontology already has strong structure (entity, aspect, attribute,
dependency), but retrieval quality and graph health are constrained by
three schema-level limitations:

1. Edge trust is under-specified (`strength` without enough epistemic detail).
2. Relationship semantics are too loose for consistent traversal behavior.
3. Temporal evolution of facts is only partially represented.

The result is avoidable graph noise, weaker path scoring, and limited support
for time-aware truth queries.

## 2) Goals

1. Make edge quality measurable and queryable.
2. Make relationship semantics explicit and stable.
3. Preserve historical truth while improving current-truth retrieval.
4. Keep SQLite-first and agent-scoped architecture intact.

## 3) Proposed capability set

### A) Confidence and provenance on dependency edges

Extend `entity_dependencies` with:
- `confidence` (0.0-1.0)
- `reason` (constrained provenance class)
- optional `evidence_count`

Traversal ranking uses a bounded composite signal, defaulting to:
`score = strength * confidence * association_weight`

### B) Dynamic association signal

Add co-occurrence signal to dependencies:
- co-mention and co-retrieval increments
- normalized association (NPMI-style)
- hub homeostasis caps to avoid high-degree domination

### C) Relationship taxonomy

Introduce constrained dependency types (initial proposal):
- `uses`, `depends_on`, `blocks`, `supersedes`, `relates_to`, `derives_from`

Migration strategy:
- phase 1: dual-write with `legacy_type`
- phase 2: strict validation and backfill complete

### D) Temporal lineage and current-truth filtering

Extend memory lineage for ontology-aware retrieval:
- `parent_id`, `root_id`, `relation_type`, `is_latest`
- retrieval defaults prefer latest truth while preserving expansion path

Compatibility with supersession:
- attribute supersession and memory lineage stay linked
- constraints never auto-superseded

## 4) Non-goals

- No separate graph database migration.
- No product UI governance workflow in this spec.
- No model architecture changes to predictor internals.

## 5) Integration contracts

### Ontology Evolution Core <-> Desire Paths

- DP traversal ranking consumes confidence/provenance/association fields.
- Bounded traversal remains mandatory.
- Constraint surfacing invariant remains hard override.

### Ontology Evolution Core <-> Retroactive Supersession

- Supersession updates lineage fields when applicable.
- Current-truth retrieval respects `is_latest=1` by default.

### Ontology Evolution Core <-> Predictive Scorer

- New structural features available for scoring:
  confidence aggregates, association weights, lineage depth.

## 6) Rollout phases

### Phase 1 (safe defaults)
- Add new columns with defaults.
- Backfill confidence/reason minimally.
- Enable read-path use behind config flags.

### Phase 2 (behavioral adoption)
- Turn on ranking usage for confidence/association.
- Add relationship taxonomy validation.
- Add lineage-aware query mode.

### Phase 3 (strict mode)
- Enforce typed relationship constraints.
- Deprecate legacy relationship mapping paths.

## 7) Validation and tests

- Migration idempotency for all new fields.
- Traversal tests proving low-confidence edges are deprioritized.
- Co-occurrence normalization tests (hub cap behavior).
- Lineage tests for latest-truth and history expansion.
- Agent scope isolation across all new queries.

## 8) Success metrics

- Lower false-positive traversal paths in benchmark suite.
- Higher MRR/Precision@K without recall collapse.
- Lower stale-fact incidence in current-truth retrieval.
- Reduced orphan/hub-skew graph health metrics.

## 9) Open decisions

1. Final minimal relationship taxonomy for v1 strict mode.
2. Default weights for confidence vs association vs strength.
3. Whether lineage lives only on memories or partially on attributes too.
