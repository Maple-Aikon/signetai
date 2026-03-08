Roadmap
===

This is the public roadmap for Signet, updated manually as priorities
shift. It captures what we're actively building, what's committed next,
and what we're still thinking through. For a detailed history of what
has shipped, see CHANGELOG.md.

Status markers: `[done]` shipped, `[wip]` in progress, `[next]` planned,
`[idea]` exploring.


Current Focus (0.42.x)
---

- [wip] Procedural memory P2–P5 — usage tracking, implicit relation
  computation, suggestion endpoints, dashboard visualization
- [wip] Predictive memory scorer — QA phase (three critical bugs under
  fix before enabling by default: feature vector mismatch, cold-start
  exit condition, stale traversal cache)
- [wip] Dashboard settings refactor — unified settings/config page
  replacing tab layout; resizable identity panel, per-section advanced
  collapsibles
- [wip] Knowledge graph constellation — entity-centric force simulation
  (hexagon nodes sized by mention density), four known visualization
  bugs being fixed
- [wip] Multi-agent support — agent_id scoping across all data tables,
  agent registry, per-agent skill graph nodes and usage stats
- [wip] Daemon refactor — spec in planning; extract 7000+ LOC daemon.ts
  into Hono sub-routers


Planned
---

- [next] Signet Runtime — autonomous tool execution layer, pre-generation
  research phase, built-in tool registry, HTTP channel
- [next] Federated predictor training — community base model ships with
  new installs, local fine-tuning on user interaction patterns; cold
  start eliminated
- [next] Wallet auth (EIP-8004) — blockchain-based agent identity
  verification for open-ended agent economies
- [next] Encrypted sync — end-to-end encrypted agent state
  synchronization using existing wallet keypairs
- [next] Agent branching — version-control-like identity branching
  and merging (one agent across multiple concurrent sessions converges
  back to a single history)
- [next] Daemon Rust rewrite — systems language migration; test suite
  and specs in docs/specs/ define the rewrite contract


Exploring
---

- [idea] Agent marketplace — discover, hire, and compose other Signet
  agents; enabled by standardized identity and EIP-8004
- [idea] Collaborative memory — shared memory pools across agent teams
  with scoped access control
- [idea] Plugin system — extend daemon with custom pipeline stages
  without forking
- [idea] Mobile companion — lightweight agent presence on iOS/Android
- [idea] Compass connector — platform adapter for Compass IDE


Recently Shipped
---

- [done] 0.42.x — OpenClaw recall query pollution fix; hybrid recall
  for prompt-submit; guard legacy hook path from envelope contamination
- [done] 0.41.0 — Native Rust vector ops with SIMD acceleration
  (`@signet/native` napi-rs crate)
- [done] 0.40.0 — Codex harness connector with transcript normalization
  and timeout reporting
- [done] 0.39.0 — Session-activity-based MEMORY.md synthesis on schedule;
  daemon-driven synthesis provider
- [done] 0.38.x — Entity evolution timeline view; doc drift detection
  script and agent prompt; constellation none-mode polish
- [done] KA-6 — Entity pinning and behavioral feedback loop (FTS overlap
  → aspect weight, per-entity predictor win rates, superseded propagation)
- [done] KA-5 — Session continuity integration into knowledge graph
  dashboard; continuity scoring over time
- [done] KA-4 — Predictive scorer coupling; structural features
  (entity_slot, aspect_slot, is_constraint, structural_density) in
  scorer payload
- [done] KA-3 — Traversal retrieval path wired into session-start and
  recall; constraint surfacing invariant enforced
- [done] KA-1 + KA-2 — Knowledge architecture schema (entity_aspects,
  entity_attributes, entity_dependencies, task_meta); structural
  assignment stage in extraction pipeline
- [done] Predictive memory scorer — all four build sprints complete;
  Rust crate with autograd, training pipeline, daemon integration,
  observability dashboard (in QA)
- [done] Session continuity protocol — session_checkpoints table,
  checkpoint digests, recovery injection, continuity scoring
- [done] Auth module — token-based middleware, policy rules, rate
  limiting for daemon API routes
- [done] Scheduler — cron-based task worker with SSE output streaming
  and run history
- [done] Server-side UMAP — dimensionality reduction moved from browser
  to daemon with pre-computed projections and cache
- [done] 1Password WASM integration — lazy-loaded secret resolution
  without native binaries
- [done] OpenClaw connector — full integration strategy, importance
  scoring, recall, plugin runtime path
- [done] Dashboard redesign — shadcn-svelte component system, hash
  navigation, Svelte 5 rune stores, skills marketplace UI
