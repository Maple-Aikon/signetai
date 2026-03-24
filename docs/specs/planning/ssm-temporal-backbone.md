---
title: "SSM Temporal Backbone"
id: ssm-temporal-backbone
status: planning
informed_by:
  - "docs/research/technical/RESEARCH-SSM-INTEGRATION.md"
  - "docs/research/technical/SSM-CONTINUAL-LEARNING-DEEP-DIVE.md"
  - "docs/research/technical/SSM-NOVEL-APPLICATIONS.md"
section: "Predictive Scorer"
depends_on:
  - "ssm-foundation-evaluation"
  - "ontology-evolution-core"
  - "session-continuity-protocol"
success_criteria:
  - "Temporal state model improves relevance ranking on long-gap and supersession-sensitive queries"
  - "Learned decay outperforms fixed decay heuristics on canary suite"
  - "Shadow-mode sidecar serves scores without breaking existing retrieval guarantees"
scope_boundary: "Defines SSM temporal state model integration in shadow mode; does not change graph traversal semantics or enforce production routing"
---

# SSM Temporal Backbone

## Purpose

Integrate an SSM sidecar as a temporal reasoning module that scores memory
candidates using session history, recency gaps, and supersession signals.

## Deliverables

1. Shadow-mode temporal scorer endpoint.
2. Feature pipeline binding continuity, behavioral, and ontology signals.
3. Learned decay/recurrence behavior with fallback to current scorer.
4. Diagnostics for drift, latency, and calibration.

## Non-goals

- No hard cutover from current predictive scorer.
- No direct graph traversal path mutation in this phase.

## Acceptance gates

- Shadow output quality consistently beats or matches baseline on defined
  benchmark slices.
- Latency and failure modes stay within configured bounds.
- Constraint surfacing invariant remains untouched.
