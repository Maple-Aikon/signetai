# Forge Hook System Expansion

**Status**: complete
**Informed by**: `references/claude-code/` (hook lifecycle architecture)

## Summary

Ports Claude Code's hook lifecycle architecture to Forge in Rust, adapted
for Signet-native operation where the daemon remains the source of truth
for configuration and LLM-backed hook execution.

## What shipped

### New crate: `forge-hooks`

Engine for hook matching, dispatch, and execution. Located at
`packages/forge/crates/forge-hooks/`.

- **Matcher**: exact, pipe-separated, regex (via regex-lite), wildcard
- **Registry**: built-in (daemon HTTP) + user (agent.yaml) hook merging,
  deduplication, hot reload via `SharedRegistry` (`Arc<RwLock<HookRegistry>>`)
- **Dispatch**: parallel execution via `futures::join_all`, aggregation
  (any Block = Block, all Error = Error, otherwise Allow)
- **Executors**: Command (subprocess), HTTP (generalized POST),
  Daemon (prompt/agent eval via `/api/hooks/prompt-eval` and `/api/hooks/agent-eval`)

### Core types in `forge-core/src/hook.rs`

`HookEvent` (14 variants), `HookDecision` (Allow/Block/Error),
`HookOutput`, `HookInput` (with constructors for all 12 wired events),
`Matcher`, `HookType`, `HookEntry`, `HookConfig`, `AggregatedResult`.

### 14 events across 3 tiers

**Tier 1 (8 events, all wired):**
- `SessionStart`, `SessionEnd` (app.rs)
- `UserPromptSubmit` (agent_loop.rs, blocking)
- `PreCompact`, `PostCompact` (context.rs)
- `PreToolUse` (agent_loop.rs, blocking)
- `PostToolUse` (agent_loop.rs, observe-only)
- `Stop` (agent_loop.rs, on turn complete)

**Tier 2 (4 events, all wired):**
- `PostToolUseFailure` (agent_loop.rs, on tool error)
- `PermissionRequest` (agent_loop.rs, blocking, auto-deny)
- `PermissionDenied` (agent_loop.rs, audit trail)
- `Notification` (agent_loop.rs, on errors and compaction failures)

**Tier 3 (2 events, pending feature work):**
- `SubagentStart`, `CwdChanged`

### 4 hook types

1. **Command**: shell subprocess, exit 0=Allow, exit 2=Block, other=Error
2. **HTTP**: generalized POST with header interpolation
3. **Prompt**: single-shot LLM eval via daemon `/api/hooks/prompt-eval`
4. **Agent**: multi-turn eval via daemon `/api/hooks/agent-eval` (delegates to prompt-eval for now)

### Configuration

Hooks configured in `~/.agents/agent.yaml` under a `hooks` key:

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash|Shell"
      type: command
      command: "~/.agents/hooks/validate-bash.sh"
      timeout: 5
  PostToolUse:
    - matcher: "Write|Edit"
      type: command
      command: "~/.agents/hooks/auto-commit.sh"
      async: true
```

### Daemon endpoints

- `POST /api/hooks/prompt-eval`: LLM evaluation using synthesis provider
- `POST /api/hooks/agent-eval`: same (multi-turn deferred)

Both return `{ok, reason, inject}` and fail open (allow) when no
synthesis provider is configured.

### Hot reload

`ConfigWatcher` fires `ConfigEvent::Reloaded` on agent.yaml changes.
The TUI acquires `write()` on the `SharedRegistry` and calls `reload()`.
Agent loop dispatch continues using read locks, so reload is non-blocking
for in-flight hook execution.

### Backward compatibility

Existing 4 daemon hooks (session-start, user-prompt-submit, pre-compaction,
session-end) are registered as built-in HTTP hooks. No user config needed
for existing behavior. User HTTP hooks to the same daemon URL suppress the
built-in (deduplication).

## Test coverage

158 tests across 8 test binaries:
- Unit: matcher (22), registry (10), config (4)
- Integration: command_executor (17), http_executor (14), daemon_executor (18),
  dispatch (18), integration (20), config (23)

## Files

### Created
- `packages/forge/crates/forge-hooks/` (entire crate)
- `packages/forge/crates/forge-core/src/hook.rs`
- `packages/daemon/src/daemon.ts` (prompt-eval, agent-eval endpoints)

### Modified
- `packages/forge/Cargo.toml` (workspace member)
- `packages/forge/crates/forge-core/src/lib.rs` (pub mod hook)
- `packages/forge/crates/forge-agent/src/agent_loop.rs` (SharedRegistry, 12 dispatch points)
- `packages/forge/crates/forge-agent/src/context.rs` (SharedRegistry, PreCompact/PostCompact)
- `packages/forge/crates/forge-tui/src/app.rs` (SharedRegistry, SessionStart/SessionEnd, hot reload)
- `packages/forge/crates/forge-cli/src/main.rs` (registry construction)
- `packages/forge/crates/forge-signet/src/config.rs` (hooks field on AgentConfig)
