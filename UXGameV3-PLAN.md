# UXGameV3 — Specific Implementation Plan

> **Design Vision:** "Destiny 2 character menu meets Vercel dashboard"
> Clean dark base + warm RPG soul.
> Warm accent glows: gold (#f59e0b), teal (#14b8a6), purple (#a855f7)
> 5-tier rarity system on skill cards
> HUD corner brackets on panels
> RPG vocabulary throughout
> Hexagonal avatar + XP bar in sidebar

---

## 0. Design Tokens (app.css)

### New RPG CSS variables — add after `--sig-grain-opacity` in `:root`

```css
/* === UXGameV3 RPG tokens === */

/* Warm accent palette */
--rpg-gold:     #f59e0b;
--rpg-gold-dim: rgba(245, 158, 11, 0.18);
--rpg-gold-glow: 0 0 12px rgba(245,158,11,0.45), 0 0 24px rgba(245,158,11,0.2);

--rpg-teal:     #14b8a6;
--rpg-teal-dim: rgba(20, 184, 166, 0.15);
--rpg-teal-glow: 0 0 12px rgba(20,184,166,0.4), 0 0 24px rgba(20,184,166,0.15);

--rpg-purple:   #a855f7;
--rpg-purple-dim: rgba(168, 85, 247, 0.15);
--rpg-purple-glow: 0 0 12px rgba(168,85,247,0.4), 0 0 24px rgba(168,85,247,0.15);

/* 5-tier rarity system */
--rarity-common:    #6b6b76;   /* grey    */
--rarity-uncommon:  #22c55e;   /* green   */
--rarity-rare:      #3b82f6;   /* blue    */
--rarity-epic:      #a855f7;   /* purple  */
--rarity-legendary: #f59e0b;   /* gold    */

--rarity-common-glow:    0 0 8px rgba(107,107,118,0.4);
--rarity-uncommon-glow:  0 0 8px rgba(34,197,94,0.5);
--rarity-rare-glow:      0 0 8px rgba(59,130,246,0.5);
--rarity-epic-glow:      0 0 8px rgba(168,85,247,0.5);
--rarity-legendary-glow: 0 0 12px rgba(245,158,11,0.6);

/* HUD bracket sizing */
--hud-bracket-size: 10px;
--hud-bracket-weight: 1.5px;

/* XP bar */
--xp-bar-height: 3px;
--xp-bar-bg: rgba(245, 158, 11, 0.15);
--xp-bar-fill: #f59e0b;

/* Hexagon avatar */
--hex-avatar-size: 48px;
```

### Changed token values in `:root`

```css
/* BEFORE */
--sig-accent: #8a8a96;
--sig-accent-hover: #c0c0c8;
--sig-warning: (undefined — referenced but not declared)

/* AFTER */
--sig-accent: #f59e0b;        /* warm gold replaces cold grey */
--sig-accent-hover: #fbbf24;  /* brighter gold on hover */
--sig-warning: #f59e0b;       /* explicit declaration */
--sig-error: #ef4444;         /* explicit declaration */
```

### New utility classes — add at end of `app.css`

```css
/* === UXGameV3 Utilities === */

/* HUD corner bracket overlay (use on relative-positioned parent) */
.hud-panel {
  position: relative;
}
.hud-panel::before,
.hud-panel::after,
.hud-panel .hud-corner-bl,
.hud-panel .hud-corner-tr {
  content: '';
  position: absolute;
  width: var(--hud-bracket-size);
  height: var(--hud-bracket-size);
  pointer-events: none;
  z-index: 1;
}
.hud-panel::before {
  top: -1px; left: -1px;
  border-top: var(--hud-bracket-weight) solid var(--rpg-gold);
  border-left: var(--hud-bracket-weight) solid var(--rpg-gold);
}
.hud-panel::after {
  bottom: -1px; right: -1px;
  border-bottom: var(--hud-bracket-weight) solid var(--rpg-gold);
  border-right: var(--hud-bracket-weight) solid var(--rpg-gold);
}

/* Gold text glow */
.rpg-text-gold {
  color: var(--rpg-gold);
  text-shadow: 0 0 10px rgba(245,158,11,0.5);
}
.rpg-text-teal  { color: var(--rpg-teal); }
.rpg-text-purple { color: var(--rpg-purple); }

/* Rarity border helpers */
.rarity-common    { border-color: var(--rarity-common)!important; }
.rarity-uncommon  { border-color: var(--rarity-uncommon)!important; }
.rarity-rare      { border-color: var(--rarity-rare)!important; }
.rarity-epic      { border-color: var(--rarity-epic)!important; }
.rarity-legendary {
  border-color: var(--rarity-legendary)!important;
  box-shadow: var(--rarity-legendary-glow);
}

/* Scanline overlay (subtle, optional on hero panels) */
.rpg-scanlines::after {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0,0,0,0.04) 2px,
    rgba(0,0,0,0.04) 4px
  );
  pointer-events: none;
  z-index: 2;
}
```

### `@keyframes` additions

```css
@keyframes rpg-pulse-gold {
  0%, 100% { box-shadow: 0 0 6px rgba(245,158,11,0.3); }
  50%       { box-shadow: 0 0 16px rgba(245,158,11,0.7); }
}
@keyframes rpg-slide-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes xp-fill {
  from { width: 0%; }
  to   { width: var(--xp-pct, 60%); }
}
```

---

## 1. Sidebar (app-sidebar.svelte)

### 1a. navItems label renames

```ts
// BEFORE:
const navItems: NavItem[] = [
  { id: "config",        label: "Config",      icon: Pencil },
  { id: "memory-group", label: "Memory",      icon: Brain,  group: "memory" },
  { id: "secrets",       label: "Secrets",     icon: ShieldCheck },
  { id: "skills",        label: "Marketplace", icon: Store },
  { id: "tasks",         label: "Tasks",       icon: ListChecks },
  { id: "engine-group",  label: "Engine",      icon: Cog,    group: "engine" },
];

// AFTER:
const navItems: NavItem[] = [
  { id: "config",        label: "Character Sheet", icon: Pencil },
  { id: "memory-group", label: "Memory",           icon: Brain,  group: "memory" },
  { id: "secrets",       label: "The Vault",        icon: ShieldCheck },
  { id: "skills",        label: "The Armory",       icon: Store },
  { id: "tasks",         label: "Quest Board",      icon: ListChecks },
  { id: "engine-group",  label: "Engine",           icon: Cog,    group: "engine" },
];
```

### 1b. Import additions (top of `<script>`)

```ts
// ADD after existing imports:
import Sword from "@lucide/svelte/icons/sword";
import Shield from "@lucide/svelte/icons/shield";
import Scroll from "@lucide/svelte/icons/scroll";
import Zap from "@lucide/svelte/icons/zap";
```

Use `Sword` for config, `Shield` for secrets, `Scroll` for memory-group, `Zap` for skills, `ListChecks` stays for tasks.

### 1c. Hex Avatar + XP bar — replace the Sidebar.Header block

```svelte
<!-- REPLACE the entire <Sidebar.Header> block -->
<Sidebar.Header>
  <Sidebar.Menu>
    <Sidebar.MenuItem>
      <Sidebar.MenuButton class="h-auto py-2 font-[family-name:var(--font-display)]">
        {#snippet child({ props })}
          <div {...props} class="flex items-center gap-3">
            <!-- Hexagonal avatar -->
            <div class="hex-avatar shrink-0" aria-hidden="true">
              <div class="hex-inner">
                {identity?.name?.slice(0,2)?.toUpperCase() ?? 'SG'}
              </div>
            </div>
            <!-- Identity text -->
            <div class="flex flex-col gap-0.5 leading-none overflow-hidden
              transition-[opacity,width] duration-200 ease-out
              group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:w-0">
              <span class="text-[11px] font-bold tracking-[0.12em] uppercase
                text-[var(--sig-text-bright)]">
                SIGNET
              </span>
              <span class="text-[10px] tracking-[0.04em] text-[var(--sig-text-muted)]
                font-[family-name:var(--font-mono)]">
                {identity?.name ?? "Agent"}
              </span>
              <!-- XP bar -->
              <div class="mt-1 h-[var(--xp-bar-height)] w-full
                bg-[var(--xp-bar-bg)] rounded-full overflow-hidden">
                <div class="h-full bg-[var(--xp-bar-fill)] rounded-full
                  transition-[width] duration-700 ease-out"
                  style="width: {xpPercent}%"></div>
              </div>
            </div>
          </div>
        {/snippet}
      </Sidebar.MenuButton>
    </Sidebar.MenuItem>
  </Sidebar.Menu>
</Sidebar.Header>
```

### 1d. New reactive variable (add to `<script>`)

```ts
// Derive XP percentage from memCount (capped at 100)
// Add after existing prop destructuring:
let xpPercent = $derived(Math.min(100, Math.round((memCount / 500) * 100)));
```

### 1e. Hex avatar CSS (add to `<style>` or as Tailwind in `app.css`)

```css
/* Add to app.css under UXGameV3 Utilities */
.hex-avatar {
  width: var(--hex-avatar-size, 40px);
  height: calc(var(--hex-avatar-size, 40px) * 1.15);
  position: relative;
  clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
  background: linear-gradient(135deg,
    color-mix(in srgb, var(--rpg-gold) 30%, var(--sig-surface-raised)),
    var(--sig-surface-raised)
  );
  border: none; /* clip-path handles shape */
  animation: rpg-pulse-gold 4s ease-in-out infinite;
  flex-shrink: 0;
}
.hex-inner {
  position: absolute;
  inset: 2px;
  clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
  background: var(--sig-surface);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  color: var(--rpg-gold);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
```

### 1f. Daemon status indicator — change to RPG vocabulary

```svelte
<!-- BEFORE -->
<span>...</span>
{daemonStatus ? "ONLINE" : "OFFLINE"}

<!-- AFTER -->
<span
  class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
  class:bg-[var(--rpg-teal)]={!!daemonStatus}
  class:animate-pulse={!!daemonStatus}
  class:border={!daemonStatus}
  class:border-[var(--sig-text-muted)]={!daemonStatus}
></span>
<span class="...existing classes...">
  {daemonStatus ? "DAEMON ACTIVE" : "DAEMON OFFLINE"}
</span>
```

---

## 2. CHARACTER SHEET (ConfigTab.svelte)

### 2a. Page header in `+page.svelte` → `PAGE_HEADERS`

File: `src/lib/components/layout/page-headers.ts` (or wherever PAGE_HEADERS is defined)

```ts
// BEFORE (in page-headers.ts):
config: { title: "Config", eyebrow: "agent configuration" }

// AFTER:
config: { title: "Character Sheet", eyebrow: "agent identity & lore files" }
```

### 2b. ConfigTab.svelte — `file-header` HUD bracket styling

In `<style>`:
```css
/* ADD after existing .file-header */
.file-header {
  /* existing */
  position: relative;
}
/* Add HUD corner brackets to .file-header */
.file-header::before {
  content: '';
  position: absolute;
  top: 4px; left: 4px;
  width: 8px; height: 8px;
  border-top: 1.5px solid var(--rpg-gold);
  border-left: 1.5px solid var(--rpg-gold);
  pointer-events: none;
}
.file-header::after {
  content: '';
  position: absolute;
  bottom: 4px; right: 4px;
  width: 8px; height: 8px;
  border-bottom: 1.5px solid var(--rpg-gold);
  border-right: 1.5px solid var(--rpg-gold);
  pointer-events: none;
}
```

### 2c. ConfigTab.svelte — dirty-badge color → gold

```css
/* BEFORE */
.dirty-badge {
  color: var(--sig-warning, #d4a017);
  background: color-mix(in srgb, var(--sig-warning, #d4a017) 15%, transparent);
  border: 1px solid var(--sig-warning, #d4a017);
}

/* AFTER */
.dirty-badge {
  color: var(--rpg-gold);
  background: var(--rpg-gold-dim);
  border: 1px solid var(--rpg-gold);
  box-shadow: 0 0 6px rgba(245,158,11,0.25);
  animation: rpg-pulse-gold 2s ease-in-out infinite;
}
```

### 2d. ConfigTab.svelte — `nav-btn` hover → gold accent

```css
/* BEFORE */
.nav-btn:hover:not(:disabled) {
  color: var(--sig-text);
  border-color: var(--sig-border-strong);
}

/* AFTER */
.nav-btn:hover:not(:disabled) {
  color: var(--rpg-gold);
  border-color: var(--rpg-gold);
  box-shadow: 0 0 6px rgba(245,158,11,0.3);
}
```

### 2e. ConfigTab.svelte — file-selector active indicator

```css
/* BEFORE */
.file-selector:hover { border-color: var(--sig-accent); }

/* AFTER */
.file-selector:hover { border-color: var(--rpg-gold); }
.file-selector:hover .file-name { color: var(--rpg-gold); }
```

### 2f. ConfigTab.svelte — empty state text

```svelte
<!-- BEFORE -->
<div class="config-empty">No markdown files found</div>

<!-- AFTER -->
<div class="config-empty">
  <span class="rpg-text-gold sig-eyebrow">⚠ No lore files found</span>
  <span class="sig-label mt-1">Character sheet is empty</span>
</div>
```

---

## 3. ADVENTURE LOG (MemoryTab.svelte)

### 3a. Page header

```ts
// page-headers.ts BEFORE:
memory: { title: "Memory", eyebrow: "..." }
// AFTER:
memory: { title: "Adventure Log", eyebrow: "persistent memory index" }
```

### 3b. MemoryTab.svelte — search bar icon → RPG sigil

```svelte
<!-- BEFORE -->
{:else}
  <span class="text-[var(--sig-accent)] sig-label">◇</span>

<!-- AFTER -->
{:else}
  <span class="sig-label" style="color: var(--rpg-gold)">⬡</span>
```

### 3c. MemoryTab.svelte — memory card `article` → add rarity glow based on importance

Change the `article` element opening tag:

```svelte
<!-- BEFORE -->
<article
  class="doc-card relative flex flex-col
  gap-1.5 p-3 border border-[var(--sig-border-strong)]
  border-t-2 border-t-[var(--sig-text-muted)]
  bg-[var(--sig-surface)] ...">

<!-- AFTER -->
<article
  class="doc-card relative flex flex-col
  gap-1.5 p-3 border border-[var(--sig-border-strong)]
  border-t-2
  bg-[var(--sig-surface)] ...
  {getMemoryRarityClass(memory.importance)}"
>
```

Add new helper function in `<script>`:

```ts
// ADD after formatDate():
function getMemoryRarityClass(importance: number | undefined): string {
  const imp = importance ?? 0;
  if (imp >= 0.9) return 'rarity-legendary';
  if (imp >= 0.75) return 'rarity-epic';
  if (imp >= 0.5) return 'rarity-rare';
  if (imp >= 0.25) return 'rarity-uncommon';
  return 'rarity-common';
}
```

### 3d. MemoryTab.svelte — count bar label

```svelte
<!-- BEFORE -->
{totalCount} {totalCount === 1 ? 'memory' : 'memories'}

<!-- AFTER -->
{totalCount} {totalCount === 1 ? 'memory scroll' : 'memory scrolls'}
```

### 3e. MemoryTab.svelte — empty state

```svelte
<!-- BEFORE -->
'No memories available yet.'

<!-- AFTER -->
'The Adventure Log is empty. Begin your journey to record memories.'
```

### 3f. MemoryTab.svelte — "similar" button → "⟳ echoes"

```svelte
<!-- BEFORE in footer buttons -->
>similar</Button>

<!-- AFTER -->
>⟳ Echoes</Button>
```

### 3g. MemoryTab.svelte — type filter pill labels (capitalise)

```svelte
<!-- BEFORE -->
{#each ['fact', 'decision', 'preference', 'issue', 'learning'] as t}

<!-- AFTER — wrap in RPG vocabulary -->
{#each [
  { id: 'fact',       label: 'Lore'       },
  { id: 'decision',   label: 'Decree'     },
  { id: 'preference', label: 'Preference' },
  { id: 'issue',      label: 'Curse'      },
  { id: 'learning',   label: 'Insight'    },
] as t}
  <button
    class={mem.filterType === t.id ? pillActive : pillInactive}
    onclick={() => mem.filterType = mem.filterType === t.id ? '' : t.id}
  >{t.label}</button>
{/each}
```

---

## 4. CHRONICLES (TimelineTab.svelte)

### 4a. Page header

```ts
// BEFORE: timeline: { title: "Timeline", eyebrow: "..." }
// AFTER:  timeline: { title: "Chronicles", eyebrow: "memory evolution timeline" }
```

### 4b. TimelineTab.svelte — hero title text

```svelte
<!-- BEFORE -->
<h2 class="timeline-hero-title">
  Signet Evolution Timeline
</h2>

<!-- AFTER -->
<h2 class="timeline-hero-title rpg-text-gold">
  The Chronicles
</h2>
```

### 4c. TimelineTab.svelte — hero subtitle

```svelte
<!-- BEFORE -->
<p class="timeline-hero-subtitle">
  Track added, evolved, and pinned memories across recap eras.
</p>

<!-- AFTER -->
<p class="timeline-hero-subtitle">
  Witness the unfolding saga. Each era holds the memories that shaped your agent's soul.
</p>
```

### 4d. TimelineTab.svelte — era navigation labels

```svelte
<!-- BEFORE getRangeChipLabel -->
function getRangeChipLabel(bucket: MemoryTimelineBucket): string {
  if (bucket.rangeKey === "last_week") return "Week";
  if (bucket.rangeKey === "one_month") return "Month";
  return "Today";
}

<!-- AFTER -->
function getRangeChipLabel(bucket: MemoryTimelineBucket): string {
  if (bucket.rangeKey === "last_week") return "The Week";
  if (bucket.rangeKey === "one_month") return "The Month";
  return "This Era";
}
```

### 4e. TimelineTab.svelte — metric labels

```svelte
<!-- BEFORE -->
<span class="timeline-hero-metric-label">Agent skills used</span>
<!-- AFTER -->
<span class="timeline-hero-metric-label">Skills Equipped</span>

<!-- BEFORE -->
<span class="timeline-hero-metric-label">MCP servers used</span>
<!-- AFTER -->
<span class="timeline-hero-metric-label">Relays Active</span>

<!-- BEFORE -->
<span class="timeline-hero-metric-label">Average importance</span>
<!-- AFTER -->
<span class="timeline-hero-metric-label">Avg. Power Level</span>

<!-- BEFORE -->
<span class="timeline-hero-metric-label">Pinned</span>
<!-- AFTER -->
<span class="timeline-hero-metric-label">Pinned Scrolls</span>
```

### 4f. TimelineTab.svelte — timeline-hero HUD brackets

```css
/* ADD to <style>: */
.timeline-hero {
  /* existing styles */
  position: relative;
}
.timeline-hero::before {
  content: '';
  position: absolute;
  top: 6px; left: 6px;
  width: 12px; height: 12px;
  border-top: 2px solid var(--rpg-gold);
  border-left: 2px solid var(--rpg-gold);
  pointer-events: none;
}
.timeline-hero::after {
  content: '';
  position: absolute;
  bottom: 6px; right: 6px;
  width: 12px; height: 12px;
  border-bottom: 2px solid var(--rpg-gold);
  border-right: 2px solid var(--rpg-gold);
  pointer-events: none;
}
```

### 4g. TimelineTab.svelte — summary metric labels

```svelte
<!-- BEFORE -->
<span class="timeline-summary-copy">- Added</span>
<!-- AFTER -->
<span class="timeline-summary-copy">— Forged</span>

<!-- BEFORE -->
<span class="timeline-summary-copy">- Tracked events captured</span>
<!-- AFTER -->
<span class="timeline-summary-copy">— Events Witnessed</span>

<!-- BEFORE -->
<span class="timeline-summary-copy">- Evolved</span>
<!-- AFTER -->
<span class="timeline-summary-copy">— Evolved</span>

<!-- BEFORE -->
<span class="timeline-summary-copy">- Strengthened</span>
<!-- AFTER -->
<span class="timeline-summary-copy">— Strengthened</span>
```

### 4h. TimelineTab.svelte — "Top Three Memories" panel

```svelte
<!-- BEFORE -->
<p class="sig-label">Top Three Memories</p>

<!-- AFTER -->
<p class="sig-label rpg-text-gold">⚔ Most Powerful Memories</p>
```

---

## 5. MEMORY MAP (EmbeddingsTab.svelte)

### 5a. Page header

```ts
// BEFORE: embeddings: { title: "Constellation", eyebrow: "..." }
// AFTER:  embeddings: { title: "Memory Map", eyebrow: "UMAP constellation" }
```

### 5b. EmbeddingsTab.svelte — health report dot colors → RPG palette

```ts
// BEFORE
function healthDotColor(status: "healthy" | "degraded" | "unhealthy"): string {
  if (status === "healthy") return "#4a7a5e";
  if (status === "degraded") return "#c4a24a";
  return "#8a4a48";
}

// AFTER
function healthDotColor(status: "healthy" | "degraded" | "unhealthy"): string {
  if (status === "healthy") return "#14b8a6";   // rpg-teal
  if (status === "degraded") return "#f59e0b";  // rpg-gold
  return "#ef4444";
}
```

### 5c. EmbeddingsTab.svelte — "Constellation Health" label

```svelte
<!-- BEFORE -->
<span class="...">Constellation Health</span>

<!-- AFTER -->
<span class="...">Memory Map Health</span>
```

### 5d. EmbeddingsTab.svelte — unlock preview button RPG style

```svelte
<!-- BEFORE -->
<button type="button" class="pointer-events-auto px-2 py-[2px] ...">
  {ActionLabels.Unlock} preview
</button>

<!-- AFTER -->
<button type="button" class="pointer-events-auto px-2 py-[2px]
  font-[family-name:var(--font-mono)] text-[10px] uppercase
  border border-[var(--rpg-gold)] text-[var(--rpg-gold)]
  bg-[rgba(5,5,5,0.8)] hover:bg-[var(--rpg-gold)] hover:text-black
  transition-colors">
  ⟳ Unlock Vision
</button>
```

---

## 6. THE VAULT (SecretsTab.svelte)

### 6a. Page header

```ts
// BEFORE: secrets: { title: "Secrets", eyebrow: "..." }
// AFTER:  secrets: { title: "The Vault", eyebrow: "encrypted secret storage" }
```

### 6b. SecretsTab.svelte — section header label → RPG

In the template, locate:
```svelte
<!-- BEFORE (approx line in 1Password section): -->
<div class="sig-label uppercase tracking-[0.08em]">
  1Password
</div>

<!-- AFTER: -->
<div class="sig-label uppercase tracking-[0.08em] rpg-text-teal">
  ⚿ 1Password Relay
</div>
```

### 6c. SecretsTab.svelte — secrets list row → HUD bracket wrapper

Wrap each secret row with hud-panel class:

```svelte
<!-- BEFORE -->
<div class="flex items-center gap-3 border border-[var(--sig-border-strong)]
  bg-[var(--sig-surface-raised)] px-[var(--space-md)] py-3 rounded-lg">

<!-- AFTER -->
<div class="hud-panel flex items-center gap-3 border border-[var(--sig-border-strong)]
  bg-[var(--sig-surface-raised)] px-[var(--space-md)] py-3">
```

### 6d. SecretsTab.svelte — empty state

```svelte
<!-- BEFORE -->
<div class="p-8 text-center text-[var(--sig-text-muted)]">
  No secrets stored. Add one above.
</div>

<!-- AFTER -->
<div class="p-8 text-center text-[var(--sig-text-muted)]">
  <div class="rpg-text-teal sig-heading mb-1">⚿ The Vault Is Empty</div>
  <div class="sig-label">Add a secret key to begin</div>
</div>
```

### 6e. SecretsTab.svelte — Add button styling

```svelte
<!-- BEFORE -->
<Button class="rounded-lg bg-[var(--sig-text-bright)] text-[var(--sig-bg)] ...">
  {secretAdding ? "Adding..." : ActionLabels.Add}
</Button>

<!-- AFTER -->
<Button class="bg-[var(--rpg-gold)] text-black hover:bg-[#fbbf24]
  text-[11px] font-bold tracking-[0.06em] uppercase font-[family-name:var(--font-mono)]
  border-none transition-all">
  {secretAdding ? "Forging..." : "⚿ Store Secret"}
</Button>
```

### 6f. SecretsTab.svelte — bullet point (••••••••) → arcane symbol

```svelte
<!-- BEFORE -->
<span class="font-[family-name:var(--font-mono)] text-[12px] text-[var(--sig-text-muted)]">
  ••••••••
</span>

<!-- AFTER -->
<span class="font-[family-name:var(--font-mono)] text-[12px]" style="color:var(--rpg-gold);opacity:0.4;letter-spacing:0.15em">
  ∗∗∗∗∗∗∗∗
</span>
```

---

## 7. THE ARMORY (MarketplaceTab.svelte + SkillsTab.svelte)

### 7a. Page headers

```ts
// BEFORE: skills: { title: "Marketplace", eyebrow: "..." }
// AFTER:  skills: { title: "The Armory", eyebrow: "skill packs & MCP tool servers" }
```

### 7b. MarketplaceTab.svelte — hero h2 texts

```svelte
<!-- BEFORE (section === "skills") -->
"Discover skill packs that level up your agent workflow"
<!-- AFTER -->
"Equip your agent with legendary skill packs"

<!-- BEFORE (section === "mcp") -->
"Browse MCP servers and route production tools with confidence"
<!-- AFTER -->
"Connect relay servers and wield production tools"
```

### 7c. MarketplaceTab.svelte — hero p texts

```svelte
<!-- BEFORE (section === "skills") -->
"Install trusted skills, compare options, and rate what actually delivers results."
<!-- AFTER -->
"Install trusted abilities, compare loadouts, and forge your optimal build."

<!-- BEFORE (section === "mcp") -->
"Connect tool servers, monitor routed tools, and leave Signet Reviews for your stack."
<!-- AFTER -->
"Bind relay servers, monitor active channels, and rate your arsenal."
```

### 7d. MarketplaceTab.svelte — section toggle button labels

```svelte
<!-- BEFORE -->
<Button>Agent Skills</Button>
<Button>MCP Servers</Button>

<!-- AFTER -->
<Button>⚔ Skill Packs</Button>
<Button>⟳ Relay Servers</Button>
```

### 7e. MarketplaceTab.svelte — hero-metric labels

```svelte
<!-- BEFORE: "Active section" -->
<span>Active section</span>
<!-- AFTER -->
<span>Arsenal Section</span>

<!-- BEFORE: "Catalog size" -->
<span>Catalog size</span>
<!-- AFTER -->
<span>Items in Catalog</span>

<!-- BEFORE: "Signet Reviews" -->
<span>Signet Reviews</span>
<!-- AFTER -->
<span>Battle Reviews</span>
```

### 7f. SkillCard.svelte — add `rarity` prop + rarity border

Add new prop `rarity?: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'` to Props type:

```ts
// BEFORE (in Props type):
type Props = {
  item: Skill | SkillSearchResult;
  mode: "installed" | "browse";
  featured?: boolean;
  selected?: boolean;
  ...
};

// AFTER:
type Props = {
  item: Skill | SkillSearchResult;
  mode: "installed" | "browse";
  featured?: boolean;
  selected?: boolean;
  rarity?: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  compareSelected?: boolean;
  ...
};

// ADD destructuring:
let {
  item, mode, featured = false, selected = false,
  rarity = 'common', compareSelected = false, ...
}: Props = $props();
```

Derive rarity from install count for browse mode:

```ts
// ADD after monogramBg $derived:
let derivedRarity = $derived((): 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' => {
  if (rarity !== 'common') return rarity; // use explicit prop first
  if (!isSearchResult(item)) return 'uncommon'; // installed = at least uncommon
  const installs = item.installs ?? 0;
  if (installs >= 100000) return 'legendary';
  if (installs >= 10000)  return 'epic';
  if (installs >= 1000)   return 'rare';
  if (installs >= 100)    return 'uncommon';
  return 'common';
});
```

### 7g. SkillCard.svelte — apply rarity to `.card` CSS class

```svelte
<!-- BEFORE -->
<div class="card-wrap" class:selected class:featured>
  <button type="button" class="card" onclick={() => onclick?.()}>

<!-- AFTER -->
<div class="card-wrap" class:selected class:featured>
  <button type="button"
    class="card rarity-{derivedRarity()}"
    onclick={() => onclick?.()}>
```

Add to `<style>`:

```css
/* Rarity borders override */
.card.rarity-legendary {
  border-color: var(--rarity-legendary);
  box-shadow: var(--rarity-legendary-glow);
}
.card.rarity-epic {
  border-color: var(--rarity-epic);
  box-shadow: var(--rarity-epic-glow);
}
.card.rarity-rare {
  border-color: var(--rarity-rare);
  box-shadow: var(--rarity-rare-glow);
}
.card.rarity-uncommon {
  border-color: var(--rarity-uncommon);
  box-shadow: var(--rarity-uncommon-glow);
}
/* common = default border */
```

### 7h. SkillCard.svelte — add RarityBadge in card header

```svelte
<!-- BEFORE (in .badge-row div): -->
<div class="badge-row">
  {#if mode === "browse" && isSearchResult(item)}
    <span class="compare-toggle" ...>

<!-- AFTER: -->
<div class="badge-row">
  <!-- Rarity badge -->
  <span class="rarity-badge-sm rarity-badge-{derivedRarity()}" aria-label="Rarity: {derivedRarity()}">
    {derivedRarity().toUpperCase().slice(0,3)}
  </span>
  {#if mode === "browse" && isSearchResult(item)}
    <span class="compare-toggle" ...>
```

Add CSS:

```css
.rarity-badge-sm {
  font-family: var(--font-mono);
  font-size: 8px;
  padding: 1px 4px;
  border: 1px solid currentColor;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  border-radius: 2px;
}
.rarity-badge-legendary { color: var(--rarity-legendary); }
.rarity-badge-epic       { color: var(--rarity-epic);      }
.rarity-badge-rare       { color: var(--rarity-rare);      }
.rarity-badge-uncommon   { color: var(--rarity-uncommon);  }
.rarity-badge-common     { color: var(--rarity-common);    }
```

### 7i. SkillsTab.svelte — Install/Remove button labels

```svelte
<!-- BEFORE -->
{installing ? "..." : "INSTALL"}
<!-- AFTER -->
{installing ? "Equipping..." : "⚔ EQUIP"}

<!-- BEFORE -->
{uninstalling ? "..." : "REMOVE"}
<!-- AFTER -->
{uninstalling ? "Removing..." : "✕ UNEQUIP"}
```

### 7j. SkillsTab.svelte — Browse/Installed tab labels

```svelte
<!-- BEFORE -->
Browse{sk.catalogTotal ? ` (${sk.catalogTotal.toLocaleString()})` : ""}
<!-- AFTER -->
⚔ Armory{sk.catalogTotal ? ` (${sk.catalogTotal.toLocaleString()})` : ""}

<!-- BEFORE -->
Installed ({sk.installed.length})
<!-- AFTER -->
Equipped ({sk.installed.length})
```

---

## 8. SERVER MAP (McpServersTab.svelte)

### 8a. Page header (no dedicated page, it's a sub-tab within The Armory — update McpServersTab labels)

### 8b. McpServersTab.svelte — view tabs

```svelte
<!-- BEFORE: "Browse" / "Installed" (showViewTabs branch) -->
<!-- AFTER: "Discover" / "Connected" -->
```

In McpServersTab, find `Tabs.Trigger` for "browse" and "installed":

```svelte
<!-- BEFORE -->
Browse{mcpMarket.catalogTotal ? ...}
Installed ({mcpMarket.installed.length})

<!-- AFTER -->
⟳ Discover{mcpMarket.catalogTotal ? ...}
⚡ Connected ({mcpMarket.installed.length})
```

### 8c. McpServersTab.svelte — install/remove button text

Find the install button in the catalog card rendering:

```svelte
<!-- BEFORE -->
Install
<!-- AFTER -->
⚡ Bind

<!-- BEFORE -->
Remove
<!-- AFTER -->
✕ Unbind
```

---

## 9. QUEST BOARD (TasksTab.svelte + TaskBoard.svelte + TaskCard.svelte)

### 9a. Page header

```ts
// BEFORE: tasks: { title: "Tasks", eyebrow: "..." }
// AFTER:  tasks: { title: "Quest Board", eyebrow: "scheduled agent quests" }
```

### 9b. TasksTab.svelte — "New Task" button

```svelte
<!-- BEFORE -->
<Button onclick={() => openForm()}>
  <Plus class="size-3.5" />
  New Task
</Button>

<!-- AFTER -->
<Button onclick={() => openForm()}
  class="bg-[var(--rpg-gold)] text-black hover:bg-[#fbbf24] border-none
    font-bold text-[11px] uppercase tracking-[0.06em]">
  <Plus class="size-3.5" />
  ⚔ New Quest
</Button>
```

### 9c. TaskBoard.svelte — column labels (RPG vocabulary)

```ts
// BEFORE:
const columns = [
  { key: "scheduled", label: "Scheduled", color: "var(--sig-accent)" },
  { key: "running",   label: "Running",   color: "var(--sig-warning, #f59e0b)" },
  { key: "completed", label: "Completed", color: "var(--sig-success)" },
  { key: "failed",    label: "Failed",    color: "var(--sig-error, #ef4444)" },
] as const;

// AFTER:
const columns = [
  { key: "scheduled", label: "Active Quests", color: "var(--rpg-gold)" },
  { key: "running",   label: "In Progress",   color: "var(--rpg-teal)" },
  { key: "completed", label: "Completed",     color: "#22c55e" },
  { key: "failed",    label: "Failed",        color: "#ef4444" },
] as const;
```

### 9d. TaskBoard.svelte — "Disabled" section label

```svelte
<!-- BEFORE -->
"Disabled"
<!-- AFTER -->
"⊘ Dormant Quests"
```

### 9e. TaskBoard.svelte — empty state

```svelte
<!-- BEFORE -->
<span class="text-[13px]">No scheduled tasks yet</span>
<span class="text-[11px]">Create one to start automating agent workflows</span>

<!-- AFTER -->
<div class="rpg-text-gold sig-heading mb-1">⚔ Quest Board Empty</div>
<span class="text-[11px] text-[var(--sig-text-muted)]">
  Issue your first quest to begin the agent's journey
</span>
```

### 9f. TaskCard.svelte — card styling: add RPG border on running/failed

In the `Card.Root class` binding:

```svelte
<!-- BEFORE -->
<Card.Root class="bg-[var(--sig-surface-raised)] border-[var(--sig-border)] ...">

<!-- AFTER -->
<Card.Root class="
  bg-[var(--sig-surface-raised)]
  {columnKey === 'running' ? 'border-[var(--rpg-teal)]' : ''}
  {columnKey === 'failed'  ? 'border-[#ef4444]' : ''}
  {columnKey === 'scheduled' ? 'border-[var(--sig-border)]' : ''}
  {columnKey === 'completed' ? 'border-[#22c55e]/40' : ''}
  hover:border-[var(--rpg-gold)] transition-colors
  {!task.enabled ? 'opacity-50' : ''}">
```

### 9g. TaskCard.svelte — harness badge → RPG label

```svelte
<!-- BEFORE -->
let harnessLabel = $derived(
  task.harness === "claude-code" ? "claude" : task.harness === "codex" ? "codex" : "opencode",
);

<!-- AFTER -->
let harnessLabel = $derived(
  task.harness === "claude-code" ? "⚡ claude" :
  task.harness === "codex"       ? "⚡ codex" :
  "⚡ opencode"
);
```

### 9h. TaskCard.svelte — running status text

```svelte
<!-- BEFORE -->
<span class="text-[var(--sig-warning, #f59e0b)]">running...</span>

<!-- AFTER -->
<span style="color: var(--rpg-teal)" class="animate-pulse">⟳ On Quest...</span>
```

---

## 10. THE FORGE (PipelineTab.svelte + PipelineNode.svelte + PipelineEdge.svelte)

### 10a. Page header

```ts
// BEFORE: pipeline: { title: "Pipeline", eyebrow: "..." }
// AFTER:  pipeline: { title: "The Forge", eyebrow: "memory processing pipeline" }
```

### 10b. PipelineTab.svelte — toolbar LIVE/DISCONNECTED → RPG

```svelte
<!-- BEFORE -->
{pipeline.connected ? "LIVE" : "DISCONNECTED"}

<!-- AFTER -->
{pipeline.connected ? "⚡ FORGE ACTIVE" : "⊘ FORGE OFFLINE"}
```

### 10c. PipelineTab.svelte — Live Feed header

```svelte
<!-- BEFORE -->
<span class="sig-heading text-[10px]">Live Feed</span>

<!-- AFTER -->
<span class="sig-heading text-[10px] rpg-text-gold">⚔ Forge Events</span>
```

### 10d. PipelineTab.svelte — waiting for events

```svelte
<!-- BEFORE -->
"Waiting for events..."

<!-- AFTER -->
"⟳ The forge awaits..."
```

### 10e. PipelineNode.svelte — selected node border → gold

```svelte
<!-- BEFORE (in <rect class="node-rect" ...> stroke binding): -->
stroke={active ? groupColor : strokeColor}
stroke-width={selected ? 2.5 : active ? 1.5 : 1}

<!-- AFTER: -->
stroke={selected ? '#f59e0b' : active ? groupColor : strokeColor}
stroke-width={selected ? 2.5 : active ? 1.5 : 1}
```

Also update the selected drop-shadow in `<style>`:

```css
/* BEFORE */
.pipeline-node--selected .node-rect { filter: brightness(1.3); }

/* AFTER */
.pipeline-node--selected .node-rect {
  filter: brightness(1.3) drop-shadow(0 0 6px rgba(245,158,11,0.6));
}
```

### 10f. PipelineTab.svelte — pipeline mode badge

Locate `modeColors` record:

```ts
// BEFORE
const modeColors: Record<string, string> = {
  "controlled-write": "border-[#4ade80] text-[#4ade80]",
  shadow:    "border-[#fbbf24] text-[#fbbf24]",
  frozen:    "border-[#94a3b8] text-[#94a3b8]",
  disabled:  "border-[#f87171] text-[#f87171]",
  unknown:   "border-[var(--sig-border)] text-[var(--sig-text-muted)]",
};

// AFTER (add RPG labels via data attributes - keep colors same but use variables)
const modeColors: Record<string, string> = {
  "controlled-write": "border-[var(--rpg-teal)] text-[var(--rpg-teal)]",
  shadow:    "border-[var(--rpg-gold)] text-[var(--rpg-gold)]",
  frozen:    "border-[#94a3b8] text-[#94a3b8]",
  disabled:  "border-[#ef4444] text-[#ef4444]",
  unknown:   "border-[var(--sig-border)] text-[var(--sig-text-muted)]",
};
```

---

## 11. RELAYS (ConnectorsTab.svelte)

### 11a. Page header

```ts
// BEFORE: connectors: { title: "Connectors", eyebrow: "..." }
// AFTER:  connectors: { title: "Relays", eyebrow: "platform harnesses & data sources" }
```

### 11b. ConnectorsTab.svelte — section heading labels

```svelte
<!-- BEFORE -->
<h3 class="sig-label uppercase tracking-[0.1em]">Platform Harnesses</h3>

<!-- AFTER -->
<h3 class="sig-label uppercase tracking-[0.1em] rpg-text-gold">⚡ Combat Harnesses</h3>

<!-- BEFORE -->
<h3 class="sig-label uppercase tracking-[0.1em]">Document Connectors</h3>

<!-- AFTER -->
<h3 class="sig-label uppercase tracking-[0.1em] rpg-text-teal">⟳ Data Relays</h3>
```

### 11c. ConnectorsTab.svelte — status indicators → RPG colours

```svelte
<!-- BEFORE -->
class:bg-[var(--sig-success)]={h.exists}

<!-- AFTER -->
class:bg-[var(--rpg-teal)]={h.exists}
class:animate-pulse={h.exists}
```

### 11d. ConnectorsTab.svelte — Resync buttons → RPG

```svelte
<!-- BEFORE -->
{harnessResyncing ? "Re-syncing..." : "Re-sync Harnesses"}

<!-- AFTER -->
{harnessResyncing ? "⟳ Syncing..." : "⟳ Re-forge Harnesses"}

<!-- BEFORE -->
{connectorsResyncing ? "Re-syncing..." : "Re-sync Connectors"}

<!-- AFTER -->
{connectorsResyncing ? "⟳ Syncing..." : "⟳ Re-bind Relays"}
```

### 11e. ConnectorsTab.svelte — empty connectors

```svelte
<!-- BEFORE -->
"No document connectors configured"

<!-- AFTER -->
<span class="rpg-text-teal sig-heading">⟳ No Relays Bound</span>
```

### 11f. ConnectorsTab.svelte — harness row → hud-panel

```svelte
<!-- BEFORE -->
<div class="flex items-center gap-3 px-3 py-2.5
  border border-[var(--sig-border)]
  bg-[var(--sig-surface-raised)]">

<!-- AFTER -->
<div class="hud-panel flex items-center gap-3 px-3 py-2.5
  border border-[var(--sig-border)]
  bg-[var(--sig-surface-raised)]
  hover:border-[var(--rpg-gold)] transition-colors">
```

---

## 12. ACTIVITY FEED (LogsTab.svelte)

### 12a. Page header

```ts
// BEFORE: logs: { title: "Logs", eyebrow: "..." }
// AFTER:  logs: { title: "Activity Feed", eyebrow: "daemon event stream" }
```

### 12b. LogsTab.svelte — streaming status

```svelte
<!-- BEFORE -->
{#if logsStreaming}
  ● Live
{:else if logsReconnecting}
  ↺ Reconnecting
{:else if logsConnecting}
  ◌ Connecting
{:else}
  ● Offline
{/if}

<!-- AFTER -->
{#if logsStreaming}
  ⚡ Live Feed
{:else if logsReconnecting}
  ⟳ Restoring Link...
{:else if logsConnecting}
  ◌ Connecting...
{:else}
  ⊘ Feed Offline
{/if}
```

### 12c. LogsTab.svelte — log detail window gradient

```css
/* BEFORE */
.log-details-window {
  background:
    radial-gradient(circle at 86% -18%, color-mix(in srgb, var(--sig-accent) 16%, ...), transparent 46%),
    ...
}

/* AFTER */
.log-details-window {
  background:
    radial-gradient(circle at 86% -18%, color-mix(in srgb, var(--rpg-gold) 12%, transparent), transparent 46%),
    linear-gradient(145deg,
      color-mix(in srgb, var(--sig-surface-raised) 90%, var(--sig-bg)) 0%,
      var(--sig-surface-raised) 72%
    );
}
```

### 12d. LogsTab.svelte — "No logs found" → RPG

```svelte
<!-- BEFORE -->
<div class="...">No logs found</div>

<!-- AFTER -->
<div class="... rpg-text-gold">⊘ The Feed Is Silent</div>
```

### 12e. LogsTab.svelte — level colors → use RPG tokens

```ts
// BEFORE
function getLogLevelClass(level: LogEntry["level"]): string {
  switch (level) {
    case "error": return "log-level--error";
    case "warn":  return "log-level--warn";
    ...
  }
}
// (no change to function, change the CSS vars instead)
```

```css
/* AFTER — update CSS custom property values: */
.log-row.log-level--info   { --log-level-color: var(--rpg-teal); }
.log-row.log-level--warn   { --log-level-color: var(--rpg-gold); }
.log-row.log-level--error  { --log-level-color: #ef4444; }
.log-level--info  { color: var(--rpg-teal); }
.log-level--warn  { color: var(--rpg-gold); }
```

---

## 13. SETTINGS (SettingsTab.svelte + sub-sections)

### 13a. Page header

```ts
// BEFORE: settings: { title: "Settings", eyebrow: "..." }
// AFTER:  settings: { title: "The Sanctum", eyebrow: "agent configuration matrix" }
```

### 13b. SettingsTab.svelte — section title renames

```ts
// BEFORE sectionDefs:
{ id: "agent",      title: "Agent" }
{ id: "harnesses",  title: "Harnesses" }
{ id: "embeddings", title: "Embeddings" }
{ id: "search",     title: "Search" }
{ id: "memory",     title: "Memory" }
{ id: "paths",      title: "Paths" }
{ id: "pipeline",   title: "Pipeline" }
{ id: "trust",      title: "Trust" }
{ id: "auth",       title: "Auth" }

// AFTER:
{ id: "agent",      title: "Agent Identity" }
{ id: "harnesses",  title: "Harnesses" }       // keep, sub-label in template
{ id: "embeddings", title: "Embeddings" }
{ id: "search",     title: "Search" }
{ id: "memory",     title: "Memory Matrix" }
{ id: "paths",      title: "Paths" }
{ id: "pipeline",   title: "The Forge Setup" }
{ id: "trust",      title: "Trust Protocol" }
{ id: "auth",       title: "Auth Sigils" }
```

### 13c. SettingsTab.svelte — save bar styling → RPG

```css
/* BEFORE */
.save-btn {
  color: var(--sig-bg);
  background: var(--sig-text-bright);
  border: none;
  ...
}

/* AFTER */
.save-btn {
  color: black;
  background: var(--rpg-gold);
  border: none;
  font-weight: 700;
  letter-spacing: 0.08em;
  transition: all 0.15s ease;
}
.save-btn:not(:disabled):hover {
  background: #fbbf24;
  box-shadow: var(--rpg-gold-glow);
}
```

### 13d. SettingsTab.svelte — "Unsaved changes" → RPG

```css
/* BEFORE */
.save-state.dirty { color: var(--sig-warning, #d4a017); }

/* AFTER */
.save-state.dirty {
  color: var(--rpg-gold);
  text-shadow: 0 0 8px rgba(245,158,11,0.4);
}
```

### 13e. AgentSection.svelte — FormSection description

```svelte
<!-- BEFORE -->
description="Core identity metadata. Created by signet setup, synced to all harnesses on change."

<!-- AFTER -->
description="Core identity metadata — the soul of your agent. Synced to all harnesses on change."
```

### 13f. HarnessesSection.svelte — FormSection description

```svelte
<!-- BEFORE -->
description="AI platforms to integrate with. The daemon syncs identity files and installs hooks for each active harness."

<!-- AFTER -->
description="Combat platforms your agent inhabits. The daemon forges identity files and installs hooks for each bound harness."
```

### 13g. TrustSection.svelte — verification select items → keep values, add RPG descriptions

In FormField description:

```svelte
<!-- BEFORE -->
description="none = local only. erc8128 = wallet-based..."

<!-- AFTER -->
description="Identity sigil verification. none = local oath. erc8128 = wallet-bound (recommended). gpg/did = alternative seals."
```

### 13h. AuthSection.svelte — mode descriptions

```svelte
<!-- BEFORE -->
description="local = no auth required (localhost only). team = tokens required..."

<!-- AFTER -->
description="local = no seal required (trusted realm). team = sigils required for all requests. hybrid = trusted realm skips, remote requires sigil."
```

---

## 14. New Shared Components

### 14a. `src/lib/components/ui/rpg/HudPanel.svelte`

Full Svelte component:

```svelte
<!-- HudPanel.svelte — wraps any content with HUD corner brackets -->
<script lang="ts">
  interface Props {
    class?: string;
    color?: string;  // CSS color for brackets, default rpg-gold
    size?: number;   // bracket size in px, default 10
    weight?: number; // border weight in px, default 1.5
    children?: any;
  }
  let {
    class: extraClass = '',
    color = 'var(--rpg-gold)',
    size = 10,
    weight = 1.5,
    children,
  }: Props = $props();
</script>

<div
  class="hud-panel-wrap {extraClass}"
  style="
    --hud-color: {color};
    --hud-size: {size}px;
    --hud-weight: {weight}px;
  "
>
  {@render children?.()}
</div>

<style>
  .hud-panel-wrap {
    position: relative;
  }
  .hud-panel-wrap::before,
  .hud-panel-wrap::after {
    content: '';
    position: absolute;
    width: var(--hud-size);
    height: var(--hud-size);
    pointer-events: none;
    z-index: 10;
  }
  .hud-panel-wrap::before {
    top: 0; left: 0;
    border-top: var(--hud-weight) solid var(--hud-color);
    border-left: var(--hud-weight) solid var(--hud-color);
  }
  .hud-panel-wrap::after {
    bottom: 0; right: 0;
    border-bottom: var(--hud-weight) solid var(--hud-color);
    border-right: var(--hud-weight) solid var(--hud-color);
  }
</style>
```

**Usage:**

```svelte
<HudPanel class="border border-[var(--sig-border)] p-4">
  <p>Content goes here</p>
</HudPanel>
```

---

### 14b. `src/lib/components/ui/rpg/RarityBadge.svelte`

```svelte
<!-- RarityBadge.svelte -->
<script lang="ts">
  type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  interface Props {
    rarity: Rarity;
    size?: 'sm' | 'md';
  }
  let { rarity, size = 'sm' }: Props = $props();

  const LABELS: Record<Rarity, string> = {
    common:    'Common',
    uncommon:  'Uncommon',
    rare:      'Rare',
    epic:      'Epic',
    legendary: 'Legendary',
  };

  const COLORS: Record<Rarity, string> = {
    common:    'var(--rarity-common)',
    uncommon:  'var(--rarity-uncommon)',
    rare:      'var(--rarity-rare)',
    epic:      'var(--rarity-epic)',
    legendary: 'var(--rarity-legendary)',
  };

  const GLOWS: Record<Rarity, string> = {
    common:    'none',
    uncommon:  'var(--rarity-uncommon-glow)',
    rare:      'var(--rarity-rare-glow)',
    epic:      'var(--rarity-epic-glow)',
    legendary: 'var(--rarity-legendary-glow)',
  };

  let color = $derived(COLORS[rarity]);
  let glow  = $derived(GLOWS[rarity]);
  let label = $derived(LABELS[rarity]);
</script>

<span
  class="rarity-badge rarity-badge--{size}"
  style="color: {color}; border-color: {color}; box-shadow: {glow};"
  aria-label="Rarity: {label}"
>
  {label}
</span>

<style>
  .rarity-badge {
    display: inline-block;
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border: 1px solid currentColor;
    border-radius: 2px;
    white-space: nowrap;
  }
  .rarity-badge--sm {
    font-size: 8px;
    padding: 1px 4px;
  }
  .rarity-badge--md {
    font-size: 10px;
    padding: 2px 6px;
  }
</style>
```

---

### 14c. `src/lib/components/ui/rpg/XpBar.svelte`

```svelte
<!-- XpBar.svelte -->
<script lang="ts">
  interface Props {
    value: number;     // 0-100 percentage
    label?: string;    // e.g. "2,341 XP"
    color?: string;    // default rpg-gold
    height?: number;   // px, default 3
    animated?: boolean;
  }
  let {
    value,
    label = '',
    color = 'var(--rpg-gold)',
    height = 3,
    animated = true,
  }: Props = $props();

  let clampedValue = $derived(Math.min(100, Math.max(0, value)));
</script>

<div class="xp-bar-wrap">
  {#if label}
    <div class="xp-bar-label">
      <span class="sig-eyebrow" style="color: {color}">{label}</span>
    </div>
  {/if}
  <div
    class="xp-bar-track"
    style="height: {height}px; background: color-mix(in srgb, {color} 15%, transparent);"
    role="progressbar"
    aria-valuenow={clampedValue}
    aria-valuemin={0}
    aria-valuemax={100}
  >
    <div
      class="xp-bar-fill {animated ? 'xp-bar-animated' : ''}"
      style="width: {clampedValue}%; background: {color};"
    ></div>
  </div>
</div>

<style>
  .xp-bar-wrap { width: 100%; }
  .xp-bar-label {
    display: flex;
    justify-content: space-between;
    margin-bottom: 2px;
  }
  .xp-bar-track {
    width: 100%;
    border-radius: 9999px;
    overflow: hidden;
  }
  .xp-bar-fill {
    height: 100%;
    border-radius: 9999px;
    transition: width 0.7s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .xp-bar-animated {
    animation: xp-fill 1s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes xp-fill {
    from { width: 0%; }
  }
</style>
```

---

### 14d. `src/lib/components/ui/rpg/StatBlock.svelte`

```svelte
<!-- StatBlock.svelte — RPG stat display (e.g. "247 Memories | 12 Skills Equipped") -->
<script lang="ts">
  interface Stat {
    label: string;
    value: string | number;
    color?: string;
    icon?: string; // unicode char or short emoji-free icon
  }
  interface Props {
    stats: Stat[];
    columns?: number;
  }
  let { stats, columns = 2 }: Props = $props();
</script>

<div
  class="stat-block"
  style="grid-template-columns: repeat({columns}, minmax(0,1fr))"
>
  {#each stats as stat (stat.label)}
    <div class="stat-item">
      <span class="stat-value" style={stat.color ? `color:${stat.color}` : ''}>
        {#if stat.icon}<span class="stat-icon" aria-hidden="true">{stat.icon}</span>{/if}
        {stat.value}
      </span>
      <span class="stat-label">{stat.label}</span>
    </div>
  {/each}
</div>

<style>
  .stat-block {
    display: grid;
    gap: 6px;
  }
  .stat-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    border: 1px solid var(--sig-border-strong);
    background: color-mix(in srgb, var(--sig-surface-raised) 55%, transparent);
    border-radius: 3px;
  }
  .stat-value {
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 700;
    color: var(--sig-text-bright);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .stat-icon { font-style: normal; }
  .stat-label {
    font-family: var(--font-mono);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--sig-text-muted);
  }
</style>
```

---

## 15. Onboarding Flow (NEW)

Three new components in: `src/lib/components/onboarding/`

### 15a. `AgentForge.svelte` — wrapper/orchestrator

```svelte
<!-- AgentForge.svelte -->
<script lang="ts">
  import ArchetypeSelect from './ArchetypeSelect.svelte';
  import StartingLoadout from './StartingLoadout.svelte';

  let step = $state<'archetype' | 'loadout' | 'done'>('archetype');
  let chosenArchetype = $state<string>('');

  // Props
  interface Props {
    onComplete: (result: { archetype: string; skills: string[] }) => void;
  }
  let { onComplete }: Props = $props();

  function handleArchetypeChosen(archetype: string) {
    chosenArchetype = archetype;
    step = 'loadout';
  }

  function handleLoadoutComplete(skills: string[]) {
    step = 'done';
    onComplete({ archetype: chosenArchetype, skills });
  }
</script>

<div class="agent-forge-shell">
  <div class="forge-header">
    <div class="forge-title rpg-text-gold">⚒ Agent Forge</div>
    <div class="forge-subtitle sig-eyebrow">Craft your agent's identity</div>
    <!-- Step indicator -->
    <div class="forge-steps">
      <span class="forge-step" class:active={step === 'archetype'}>1 · Archetype</span>
      <span class="forge-divider">——</span>
      <span class="forge-step" class:active={step === 'loadout'}>2 · Loadout</span>
      <span class="forge-divider">——</span>
      <span class="forge-step" class:active={step === 'done'}>3 · Complete</span>
    </div>
  </div>

  <div class="forge-body">
    {#if step === 'archetype'}
      <ArchetypeSelect onSelect={handleArchetypeChosen} />
    {:else if step === 'loadout'}
      <StartingLoadout archetype={chosenArchetype} onComplete={handleLoadoutComplete} />
    {:else}
      <div class="forge-complete">
        <div class="rpg-text-gold sig-heading mb-2">⚔ Agent Forged!</div>
        <div class="sig-label">Your agent is ready to begin the journey.</div>
      </div>
    {/if}
  </div>
</div>

<style>
  .agent-forge-shell {
    display: flex;
    flex-direction: column;
    gap: 24px;
    padding: 32px;
    max-width: 640px;
    margin: 0 auto;
    position: relative;
  }
  .forge-header { text-align: center; }
  .forge-title {
    font-family: var(--font-display);
    font-size: 28px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .forge-steps {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: 12px;
  }
  .forge-step {
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--sig-text-muted);
    transition: color 0.2s;
  }
  .forge-step.active {
    color: var(--rpg-gold);
    text-shadow: 0 0 8px rgba(245,158,11,0.5);
  }
  .forge-divider {
    color: var(--sig-border-strong);
    font-family: var(--font-mono);
    font-size: 9px;
  }
  .forge-complete { text-align: center; padding: 40px 0; }
  .forge-body { animation: rpg-slide-in 0.3s ease both; }
</style>
```

### 15b. `ArchetypeSelect.svelte`

```svelte
<!-- ArchetypeSelect.svelte -->
<script lang="ts">
  interface Archetype {
    id: string;
    name: string;
    description: string;
    icon: string;
    color: string;
    rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
    bonuses: string[];
  }

  const ARCHETYPES: Archetype[] = [
    {
      id: 'coder',
      name: 'The Artificer',
      description: 'Master of code and systems. +25% pipeline throughput.',
      icon: '⚙',
      color: 'var(--rpg-teal)',
      rarity: 'rare',
      bonuses: ['+25% pipeline speed', '+10% memory retention', 'Embedded coding skills'],
    },
    {
      id: 'analyst',
      name: 'The Scholar',
      description: 'Seeker of truth. Memory capacity doubled.',
      icon: '📜',
      color: 'var(--rpg-purple)',
      rarity: 'epic',
      bonuses: ['2× memory capacity', '+15% search accuracy', 'Enhanced timeline view'],
    },
    {
      id: 'operator',
      name: 'The Commander',
      description: 'Deploys quests with precision. Task automation unlocked.',
      icon: '⚔',
      color: 'var(--rpg-gold)',
      rarity: 'legendary',
      bonuses: ['Advanced Quest Board', '+20% task success rate', 'Multi-harness sync'],
    },
    {
      id: 'generalist',
      name: 'The Wanderer',
      description: 'Balanced across all disciplines. No specialisation, no limits.',
      icon: '🗺',
      color: 'var(--sig-text-muted)',
      rarity: 'uncommon',
      bonuses: ['Balanced stats', 'All tabs unlocked', 'Freedom of choice'],
    },
  ];

  interface Props {
    onSelect: (id: string) => void;
  }
  let { onSelect }: Props = $props();
  let hovered = $state<string | null>(null);
</script>

<div class="archetype-grid">
  <h3 class="archetype-heading sig-heading">Choose Your Archetype</h3>
  <div class="archetype-cards">
    {#each ARCHETYPES as arch (arch.id)}
      <button
        type="button"
        class="archetype-card rarity-{arch.rarity}"
        class:hovered={hovered === arch.id}
        onmouseenter={() => hovered = arch.id}
        onmouseleave={() => hovered = null}
        onclick={() => onSelect(arch.id)}
      >
        <div class="arch-icon" style="color:{arch.color}">{arch.icon}</div>
        <div class="arch-name" style="color:{arch.color}">{arch.name}</div>
        <div class="arch-rarity sig-eyebrow" style="color:{arch.color}">
          {arch.rarity.toUpperCase()}
        </div>
        <p class="arch-desc">{arch.description}</p>
        <ul class="arch-bonuses">
          {#each arch.bonuses as bonus (bonus)}
            <li class="arch-bonus">
              <span style="color:{arch.color}">▸</span> {bonus}
            </li>
          {/each}
        </ul>
        <div class="arch-select-btn" style="border-color:{arch.color};color:{arch.color}">
          SELECT
        </div>
      </button>
    {/each}
  </div>
</div>

<style>
  .archetype-heading {
    text-align: center;
    margin-bottom: 20px;
    color: var(--sig-text-bright);
  }
  .archetype-cards {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }
  .archetype-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
    background: var(--sig-surface-raised);
    border: 1px solid var(--sig-border-strong);
    cursor: pointer;
    text-align: left;
    transition: all 0.2s ease;
    position: relative;
  }
  .archetype-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  }
  .arch-icon {
    font-size: 28px;
    line-height: 1;
    margin-bottom: 4px;
  }
  .arch-name {
    font-family: var(--font-display);
    font-size: 14px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .arch-rarity {
    letter-spacing: 0.1em;
    margin-bottom: 4px;
  }
  .arch-desc {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--sig-text-muted);
    line-height: 1.5;
    margin: 0;
  }
  .arch-bonuses {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .arch-bonus {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--sig-text);
  }
  .arch-select-btn {
    margin-top: auto;
    padding: 6px 12px;
    border: 1px solid;
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    text-align: center;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .archetype-card:hover .arch-select-btn { opacity: 1; }
  @media (max-width: 560px) {
    .archetype-cards { grid-template-columns: 1fr; }
  }
</style>
```

### 15c. `StartingLoadout.svelte`

```svelte
<!-- StartingLoadout.svelte -->
<script lang="ts">
  interface Props {
    archetype: string;
    onComplete: (skills: string[]) => void;
  }
  let { archetype, onComplete }: Props = $props();

  // Suggested starter skill packs per archetype
  const LOADOUT_OPTIONS: Record<string, string[]> = {
    coder:     ['git-tools', 'code-review', 'deploy-agent', 'debug-assistant'],
    analyst:   ['data-analyst', 'report-writer', 'web-researcher', 'chart-builder'],
    operator:  ['task-runner', 'cron-manager', 'alert-system', 'multi-agent'],
    generalist:['web-search', 'note-taker', 'email-helper', 'file-organiser'],
  };

  let options = $derived(LOADOUT_OPTIONS[archetype] ?? LOADOUT_OPTIONS.generalist);
  let selected = $state<Set<string>>(new Set());

  function toggle(skill: string) {
    const next = new Set(selected);
    if (next.has(skill)) { next.delete(skill); } else { next.add(skill); }
    selected = next;
  }
</script>

<div class="loadout-wrap">
  <h3 class="sig-heading text-center mb-4">Choose Starting Loadout</h3>
  <p class="sig-eyebrow text-center mb-6" style="color:var(--sig-text-muted)">
    Select up to 4 skill packs to equip at creation
  </p>

  <div class="loadout-grid">
    {#each options as skill (skill)}
      <button
        type="button"
        class="loadout-item"
        class:loadout-selected={selected.has(skill)}
        onclick={() => toggle(skill)}
      >
        <span class="loadout-check">{selected.has(skill) ? '✓' : '○'}</span>
        <span class="loadout-name">{skill}</span>
      </button>
    {/each}
  </div>

  <button
    type="button"
    class="loadout-confirm"
    onclick={() => onComplete([...selected])}
  >
    ⚔ Begin Journey ({selected.size} selected)
  </button>
</div>

<style>
  .loadout-wrap { display: flex; flex-direction: column; gap: 16px; }
  .loadout-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }
  .loadout-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid var(--sig-border-strong);
    background: var(--sig-surface-raised);
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
  }
  .loadout-item:hover {
    border-color: var(--rpg-gold);
    color: var(--rpg-gold);
  }
  .loadout-selected {
    border-color: var(--rpg-gold) !important;
    background: var(--rpg-gold-dim) !important;
    color: var(--rpg-gold) !important;
  }
  .loadout-check {
    font-size: 12px;
    flex-shrink: 0;
    width: 16px;
  }
  .loadout-name {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .loadout-confirm {
    padding: 12px 24px;
    background: var(--rpg-gold);
    color: black;
    border: none;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    cursor: pointer;
    transition: all 0.15s;
    align-self: center;
    min-width: 200px;
  }
  .loadout-confirm:hover {
    background: #fbbf24;
    box-shadow: var(--rpg-gold-glow);
  }
</style>
```

---

## 16. +page.svelte — Sub-tab label renames

### 16a. Memory group sub-tabs

```svelte
<!-- BEFORE -->
<button class={...} onclick={() => setTab("memory")}>Index</button>
<button class={...} onclick={() => setTab("timeline")}>Timeline</button>
<button class={...} onclick={() => setTab("embeddings")}>Constellation</button>

<!-- AFTER -->
<button class={...} onclick={() => setTab("memory")}>Adventure Log</button>
<button class={...} onclick={() => setTab("timeline")}>Chronicles</button>
<button class={...} onclick={() => setTab("embeddings")}>Memory Map</button>
```

### 16b. Engine group sub-tabs

```svelte
<!-- BEFORE -->
<button>Settings</button>
<button>Pipeline</button>
<button>Connectors</button>
<button>Logs</button>

<!-- AFTER -->
<button>The Sanctum</button>
<button>The Forge</button>
<button>Relays</button>
<button>Activity Feed</button>
```

### 16c. Status bar labels

```svelte
<!-- BEFORE (bottom status bar) -->
{:else if activeTab === "memory"}
  <span>{displayMemories.length} memory documents</span>
  ...
{:else if activeTab === "timeline"}
  <span>timeline eras</span>
  ...
{:else if activeTab === "pipeline"}
  <span>Pipeline</span>
  <span>memory loop v2</span>
{:else if activeTab === "embeddings"}
  <span>Constellation</span>
  <span>UMAP</span>
{:else if activeTab === "secrets"}
  <span>Secrets</span>
  <span>libsodium</span>
{:else if activeTab === "tasks"}
  <span>{ts.tasks.length} scheduled tasks</span>
  <span>cron scheduler</span>
{:else if activeTab === "connectors"}
  <span>platform harnesses + data sources</span>
  <span>connector health</span>
{/if}

<!-- AFTER -->
{:else if activeTab === "memory"}
  <span>{displayMemories.length} memory scrolls</span>
  ...
{:else if activeTab === "timeline"}
  <span>chronicle eras</span>
  ...
{:else if activeTab === "pipeline"}
  <span>The Forge</span>
  <span>memory loop v2</span>
{:else if activeTab === "embeddings"}
  <span>Memory Map</span>
  <span>UMAP constellation</span>
{:else if activeTab === "secrets"}
  <span>The Vault</span>
  <span>libsodium encrypted</span>
{:else if activeTab === "tasks"}
  <span>{ts.tasks.length} active quests</span>
  <span>cron scheduler</span>
{:else if activeTab === "connectors"}
  <span>combat harnesses + data relays</span>
  <span>relay health</span>
{/if}
```

### 16d. Header action bar — tasks "New Task" button

```svelte
<!-- BEFORE -->
<Button onclick={() => openForm()}>
  <Plus class="size-3.5" />
  New Task
</Button>

<!-- AFTER -->
<Button onclick={() => openForm()}
  class="bg-[var(--rpg-gold)] text-black hover:bg-[#fbbf24] border-none
    font-bold uppercase text-[11px] tracking-[0.06em] h-7 gap-1.5">
  <Plus class="size-3.5" />
  ⚔ New Quest
</Button>
```

### 16e. Header timelineGeneratedFor label

```svelte
<!-- BEFORE -->
<span class="sig-label">Era timeline</span>

<!-- AFTER -->
<span class="sig-label rpg-text-gold">⌛ Chronicle Eras</span>
```

---

## 17. MemoryForm.svelte (Adventure Log entry edit)

### 17a. Sheet title labels

```svelte
<!-- BEFORE -->
{mode === "delete" ? "Delete Memory" : "Edit Memory"}
<!-- AFTER -->
{mode === "delete" ? "⚠ Erase Memory Scroll" : "✏ Edit Memory Scroll"}

<!-- BEFORE description -->
{mode === "delete"
  ? "This will soft-delete the memory. It can be recovered later."
  : "Update this memory's content or metadata."}
<!-- AFTER -->
{mode === "delete"
  ? "This scroll will be soft-erased. Recovery is possible from the archives."
  : "Alter the content and metadata of this memory scroll."}
```

### 17b. MemoryForm.svelte — Submit button

```svelte
<!-- BEFORE -->
{mode === "delete" ? "Delete Memory" : "Save Changes"}
<!-- AFTER -->
{mode === "delete" ? "⚠ Erase Scroll" : "⚔ Inscribe Changes"}
```

---

## Implementation Order + Estimated Time

| Priority | Section | Est. Time | Notes |
|----------|---------|-----------|-------|
| 1 | `app.css` — design tokens | 30 min | Foundation for everything else |
| 2 | New shared components (HudPanel, RarityBadge, XpBar, StatBlock) | 45 min | Used by all sections |
| 3 | Sidebar — hex avatar, XP bar, nav labels | 30 min | First visible change |
| 4 | SkillCard — rarity system | 45 min | Complex, high visual impact |
| 5 | +page.svelte — sub-tab labels, status bar, task button | 20 min | Small but ties navigation together |
| 6 | PAGE_HEADERS — all title/eyebrow renames | 15 min | Touches all tabs |
| 7 | MarketplaceTab / SkillsTab — hero text, button labels | 30 min | THE ARMORY section |
| 8 | TaskBoard / TaskCard — Quest Board RPG vocabulary | 30 min | QUEST BOARD section |
| 9 | TimelineTab — Chronicles labels + hero HUD brackets | 20 min | CHRONICLES section |
| 10 | MemoryTab — rarity on cards, label renames | 25 min | ADVENTURE LOG |
| 11 | SecretsTab — THE VAULT styling | 20 min | THE VAULT |
| 12 | PipelineTab + PipelineNode — THE FORGE | 25 min | THE FORGE |
| 13 | ConnectorsTab — RELAYS | 20 min | RELAYS |
| 14 | LogsTab — ACTIVITY FEED | 20 min | ACTIVITY FEED |
| 15 | SettingsTab + sub-sections — THE SANCTUM | 25 min | SETTINGS |
| 16 | EmbeddingsTab — MEMORY MAP health colours | 15 min | MEMORY MAP |
| 17 | Onboarding flow (AgentForge, ArchetypeSelect, StartingLoadout) | 90 min | New feature — do last |
| **Total** | | **~8 hours** | |

### Rollout strategy
1. Ship design tokens first — no visual regressions, just variable additions
2. Ship shared components (they're purely additive, not yet used)
3. Apply sidebar changes — most immediately visible to users
4. Apply tab-by-tab in priority order above
5. Onboarding flow as final bonus feature once core RPG skin is validated

### Testing checklist per section
- [ ] Light theme still readable (all new RPG colours have sufficient contrast)  
- [ ] Collapsed sidebar hides text (existing `group-data-[collapsible=icon]:opacity-0` respected)  
- [ ] Rarity classes don't break default card layout  
- [ ] HUD bracket CSS doesn't overflow scrollable containers  
- [ ] Hex avatar `clip-path` works in all modern browsers (no Safari fallback needed)  
- [ ] XP bar animation respects `prefers-reduced-motion`  
- [ ] All RPG text strings remain accessible (no meaning lost for screen readers)

---

*Plan generated for UXGameV3 branch — "Destiny 2 × Vercel dashboard" aesthetic.*
