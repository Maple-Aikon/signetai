---
title: "Ontology Governance Workflow"
id: ontology-governance-workflow
status: planning
informed_by:
  - "docs/research/technical/RESEARCH-ONTOLOGY-EVOLUTION.md"
  - "docs/research/technical/RESEARCH-LCM-ACP.md"
section: "Knowledge Architecture"
depends_on:
  - "ontology-evolution-core"
  - "knowledge-architecture-schema"
success_criteria:
  - "Ontology-impacting schema changes follow a proposal and review workflow before merge"
  - "Each ontology change includes compatibility notes, migration plan, and rollback strategy"
  - "Spec/dependency/index consistency checks catch ontology contract drift in CI"
scope_boundary: "Defines process and quality gates for ontology evolution; does not define the underlying ontology schema fields themselves"
---

# Ontology Governance Workflow

Spec metadata:
- ID: `ontology-governance-workflow`
- Status: `planning`
- Hard depends on: `ontology-evolution-core`, `knowledge-architecture-schema`
- Registry: `docs/specs/INDEX.md`

Related docs:
- `docs/research/technical/RESEARCH-ONTOLOGY-EVOLUTION.md`
- `docs/specs/INDEX.md`
- `docs/specs/dependencies.yaml`

---

## 1) Problem

Ontology-impacting changes currently rely on ad-hoc coordination. This is
manageable at low volume, but fragile as schema complexity and retrieval
coupling increase.

Without a governance workflow:
- migration risk increases,
- cross-spec contracts drift silently,
- rollback and compatibility expectations are unclear.

## 2) Goals

1. Make ontology changes explicit and reviewable.
2. Require compatibility, migration, and rollback notes for risky changes.
3. Enforce dependency/index consistency in CI.
4. Keep workflow lightweight for local-first development.

## 3) Proposed workflow

### Stage 1: Proposal

Every ontology-impacting change starts with:
- linked planning/approved spec ID,
- declared contract impact,
- migration sketch (or explicit no-migration rationale),
- risk level (`low`, `medium`, `high`).

### Stage 2: Review

Required checks before merge:
- dependency graph consistency (`dependencies.yaml`),
- index registry consistency (`INDEX.md`),
- invariant compliance (agent scope, constraints surfacing, taxonomy),
- migration idempotency statement.

### Stage 3: Approval and rollout

For medium/high risk:
- staged rollout flag and fallback behavior,
- rollback path documented,
- observability hooks/metrics identified.

### Stage 4: Post-merge verification

- benchmark regression check for retrieval quality,
- graph health check (orphan rate, hub concentration),
- issue template for fast rollback if regression appears.

## 4) Deliverables

1. `docs/specs/sprints/ontology-governance-brief.md` (implementation brief).
2. CI guard extension for ontology contract drift.
3. PR template fragment for ontology-impacting changes.
4. Migration checklist in docs.

## 5) Integration contracts

### Governance Workflow <-> INDEX / dependencies

- New ontology specs must have synchronized entries in both files.
- Hard dependencies must be explicit before implementation starts.

### Governance Workflow <-> Invariants

Every ontology proposal must explicitly confirm:
- invariant 1 (agent scoping),
- invariant 3 (canonical entity taxonomy),
- invariant 5 (constraints always surface).

### Governance Workflow <-> Build sequence

Ontology governance gates run before moving planning specs to approved.
No governance bypass for schema-affecting PRs.

## 6) Non-goals

- No enterprise-style heavyweight approval board.
- No separate product for ontology reviews.
- No forced process for non-ontology code changes.

## 7) Validation

- CI fails on spec registry drift.
- CI fails when ontology-impacting PR lacks migration/rollback notes.
- Dry-run migration validation documented for new ontology migrations.

## 8) Success metrics

- Fewer post-merge ontology regressions.
- Faster incident resolution for ontology-related bugs.
- Reduced spec/index/dependency drift defects over time.

## 9) Open decisions

1. What threshold marks a change as ontology-impacting by policy?
2. Which checks are blocking vs advisory in CI?
3. Should governance metadata live only in docs or also in machine-readable config?
