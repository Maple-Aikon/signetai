---
title: "Recall Confidence Gate"
id: recall-confidence-gate
status: complete
informed_by: []
section: "Memory"
depends_on:
  - memory-pipeline-v2
success_criteria:
  - "hybridRecall preserves reranker-calibrated scores instead of synthesizing from rank position"
  - "userPromptSubmit injects only memories with top score >= hooks.userPromptSubmit.minScore (default 0.8)"
  - "daemon-rs mirrors gate via term-coverage proxy (matched_terms/total_terms) until full hybrid scoring lands"
scope_boundary: "Documents the shipped recall confidence bug fix and daemon-rs proxy behavior; not a broader retrieval redesign"
---

# Recall Confidence Gate

This shipped as a targeted bug fix in PR #396.

## Delivered behavior

- `hybridRecall` now preserves calibrated reranker scores instead of replacing
  them with rank-position placeholders.
- `hooks.userPromptSubmit.minScore` gates memory injection with a default of
  `0.8`.
- `daemon-rs` mirrors the gate with a temporary term-coverage proxy until full
  hybrid scoring parity lands.

## Why it mattered

The old behavior made downstream gating look more confident than the reranker
actually was. That polluted prompt injection decisions and weakened the meaning
of score thresholds.
