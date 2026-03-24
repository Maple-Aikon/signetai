---
title: "SSM Foundation and Evaluation Harness"
id: ssm-foundation-evaluation
status: planning
informed_by:
  - "docs/research/technical/RESEARCH-SSM-INTEGRATION.md"
  - "docs/research/technical/SSM-LITERATURE-REVIEW.md"
  - "docs/research/technical/SYNTHETIC-DATA-GENERATION.md"
  - "docs/research/technical/ssm-implementations-survey.md"
section: "Predictive Scorer"
depends_on:
  - "predictive-memory-scorer"
  - "desire-paths-epic"
success_criteria:
  - "SSM candidate baseline can be trained and evaluated on reproducible benchmark suites"
  - "Canary tests prove temporal pattern learning beyond static score heuristics"
  - "Ablations compare SSM vs current scorer on MRR, NDCG@10, and temporal precision"
scope_boundary: "Defines SSM data pipeline, benchmark harness, and acceptance gates; does not replace production retrieval or scorer paths"
---

# SSM Foundation and Evaluation Harness

## Purpose

Create a controlled evaluation lane for SSM models before any production
routing changes. This spec turns research into measurable experiments with
stable datasets, canaries, and acceptance thresholds.

## Deliverables

1. Benchmark harness for retrieval and temporal tasks.
2. Synthetic + real mixed training corpus construction process.
3. Reproducible ablation matrix against current predictive scorer.
4. Acceptance thresholds for promotion to runtime shadow mode.

## Non-goals

- No production replacement of current scorer.
- No schema migration for graph topology in this phase.

## Acceptance gates

- Benchmark reproducibility across reruns.
- Temporal canary tests pass (supersession, recurrence, gap sensitivity).
- Quality gains hold without unacceptable latency regression.
