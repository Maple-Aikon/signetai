Roadmap
===

This is the public roadmap for Signet, updated manually as priorities
shift. It captures what we're actively building, what's committed next,
and what we're still shaping. For implementation sequencing, dependency
contracts, and status truth, see `docs/specs/INDEX.md`.

Status markers: `[done]` shipped, `[wip]` in progress, `[next]` planned,
`[stub]` intentionally tracked but not fully planned, `[idea]` exploring.


Current Focus (0.76.x)
---

- [wip] Desire Paths Phase 4-5 continuation
  - path scoring evolution, temporal reinforcement, explorer-bee and
    reconsolidation tracks
- [wip] Procedural Memory P2-P5
  - usage tracking, relation computation, retrieval/suggestion quality,
    and visualization polish
- [wip] Multi-agent + runtime hardening
  - scoped memory policies, runtime adapter stability, connector reliability
- [wip] Ontology hardening
  - confidence/provenance semantics, relationship typing, temporal lineage
- [wip] SSM translation track
  - benchmark harness and shadow-mode rollout specs now in the index


Planned Next
---

- [next] Ontology governance workflow
  - proposal/review gates, compatibility notes, rollback requirements
- [next] SSM temporal backbone (shadow mode)
  - deterministic fallback, canary validation, latency/drift guardrails
- [next] SSM-assisted traversal ranking (shadow mode)
  - multi-hop quality lift while preserving traversal bounds + constraints
- [next] Rust daemon parity + primary runtime cutover
  - parity first, cutover second
- [next] Deep memory search (optional escalation)
  - multi-agent LLM memory search when primary retrieval confidence is low


Strategic Stub Backlog (tracked, planning incomplete)
---

- [stub] Distributed harness and multi-remote orchestration
- [stub] First-party Signet harness (while continuing connector support)
  - reference direction: Hermes Agent
- [stub] Remember/Recall skill parity refresh with current schema
- [stub] MCP CLI bridge + usage analytics in dashboard
  - reference direction: MC Porter
- [stub] Git-based marketplace monorepo for skills + MCP servers
  - GitHub-authenticated PR publishing/reviews, JSON review artifacts
- [stub] Adaptive skill lifecycle (passive/continuous maintenance)
- [stub] Cryptographic identity roadmap
- [stub] Connectors: Py Agent, Hermes Agent
- [stub] Plugin API + app ecosystem integrations (dashboard/CLI)
- [stub] Unified realtime constellation/embedding/entity viewer
  - replace slow current 3D path; visualize new dependency types by default
- [stub] Dashboard IA refactor
  - settings as standalone page, breadcrumb-first navigation model
- [stub] Post-install behavior migration audit
  - ensure daemon/CLI own critical install flows


Recently Shipped
---

- [done] Index and dependency control plane expanded and synchronized
  - ontology track, SSM track, and strategic stub backlog fully registered
- [done] Desire Paths Phase 1-3 baseline
  - traversal-primary retrieval, constructed memories, prospective indexing,
    scoped vector restore, reranking and dampening groundwork
- [done] Knowledge Architecture KA-1 through KA-6
  - entity/aspect/attribute schema, traversal retrieval, continuity coupling,
    entity pinning, behavioral feedback
- [done] Multi-agent support phases 1-8
  - roster/scoping/runtime routing foundation complete; polish phases deferred


Notes
---

- Explicitly dropped: client-side LLM reranking (superseded by better path).
- This roadmap is directional. `docs/specs/INDEX.md` remains the execution
  contract and dependency source of truth.
