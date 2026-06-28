# Memory Sync Architecture — GBrain ↔ Mastra

## The Problem

We have two disconnected memory systems living in the same Supabase database (`nzglxpvezaggufgxdxvc`):

### System 1 — GBrain (semantic knowledge)
Used by: Claude Code, gstack skills, `/context-save`, `gbrain search`

| Table | What it holds |
|---|---|
| `sources` | Registered repos/directories (one per machine per repo) |
| `pages` | Documents — meeting notes, design docs, CLAUDE.md, TODOs, transcripts |
| `content_chunks` | Each page split into ~500-token chunks with vector embeddings |
| `tags` | Page classification |
| `links` | Cross-page references |
| `facts` | Extracted structured facts (unused so far) |
| `minion_jobs` | Async job queue for sync/embed tasks |

**Current state:** 111 pages, 817 chunks across 3 sources. Contains meeting decisions, design docs, daily briefs, learnings — all from Rahul's machine. Vishwa's local source (`gstack-code-ef19e4bc`) not yet pushed.

### System 2 — Mastra (agent conversation memory)
Used by: `planner-agent`, `developer-agent`, Mastra workflows

| Table | What it holds |
|---|---|
| `mastra_threads` | Conversation sessions per agent (4 threads, all planner-agent) |
| `mastra_messages` | Messages within threads (17 messages) |
| `mastra_resources` | Working memory per resource (structured markdown, 1 row) |
| `mastra_workflow_snapshot` | Workflow state (empty) |
| `mastra_observational_memory` | Long-term observations (empty) |
| `mastra_background_tasks` | Async tasks (empty) |

**Current state:** Only `planner-agent` writes to Supabase. Everything else (workflows, observability) goes to local `mastra.db` via `LibSQLStore`.

---

## The Gap

```
Claude Code session                    Mastra planner-agent
  discusses architecture                 answers planning questions
  decides to use Stedi over Bridge       BUT has no context on why
  captures it in gbrain                  working memory is empty
        ↓                                       ↑
        └─────────── NO BRIDGE ─────────────────┘

Team meeting                           gbrain
  decisions made, next steps agreed      has the meeting notes
  Mastra agents need this context        BUT Mastra can't read gbrain
        ↓                                       ↑
        └─────────── NO BRIDGE ─────────────────┘

Mastra planner-agent                   gbrain
  produces a great implementation plan   can't surface it to Claude Code
  stored in mastra_messages              never becomes a searchable page
        ↓                                       ↑
        └─────────── NO BRIDGE ─────────────────┘
```

Additionally, Mastra's default storage is **local** (`LibSQLStore` → `mastra.db`). Only `planner-agent` memory is in Supabase. The team cannot share workflow state, observability, or agent outputs.

---

## The Solutions

### Path A — Fix Mastra storage first (team state in Supabase)

**What:** Switch `mastra/index.ts` default store from `LibSQLStore` (local file) to `PostgresStore` (Supabase).

**Why:** Right now, if Rahul runs a workflow and you run one separately, you get two isolated local states. Moving default storage to Supabase means all workflows, agent outputs, and observability are shared and persistent across the team.

**Impact:**
- All `mastra_workflow_snapshot`, `mastra_background_tasks`, observability → Supabase
- Team can inspect each other's workflow runs
- No more "works on my machine" state

**Effort:** ~10 lines in `index.ts`. Low risk.

**Tradeoff:** Adds latency to every Mastra operation (network vs. local file). Acceptable for dev; may need connection pooling for prod.

---

### Path B — Seed gbrain knowledge into Mastra working memory

**What:** Write a script that reads key gbrain pages and writes them into `planner-agent`'s `workingMemory` in `mastra_resources`.

**Pages to seed:**
- `project_context` — what Gentleborn is, the domain, the stack
- `meeting-*` — decisions made, next steps, open questions
- `design-docs/*` — architecture decisions and rationale
- `learnings/*` — what worked, what didn't
- `todos` — current backlog

**Why:** The planner-agent's working memory is a structured markdown doc it reads before every response. Right now it's an empty template. Seeding it with gbrain content means the agent instantly has full project context — payer model, HIPAA constraints, Stedi decisions, provider types — without the user having to re-explain every session.

**Effort:** ~100-line script. Needs to run after every significant gbrain sync (manual or cron).

**Tradeoff:** Working memory has a size limit (~8k tokens typically). Need to summarize/prioritize rather than dump everything. Also goes stale — needs a refresh mechanism.

---

### Path C — Sync Mastra threads back into gbrain

**What:** After significant agent conversations, write the thread (`mastra_messages`) back as a gbrain page so Claude Code can search it.

**Example output slug:** `transcripts/mastra/planner-agent/2026-06-22-session`

**Why:** Decisions made during a Mastra planning session are currently invisible to Claude Code. If the planner-agent says "use PgBouncer in transaction mode", that decision should be searchable from Claude Code sessions too.

**Effort:** ~50-line script or Mastra hook on thread completion.

**Tradeoff:** Creates duplication if the same decision is captured in both a meeting note and a thread. Needs dedup logic or a naming convention.

---

### Path D — gbrain as a Mastra tool (real-time bridge)

**What:** Expose `gbrain search` as a Mastra tool that agents call during inference. Instead of seeding working memory upfront, the agent queries gbrain on demand.

**Why:** Eliminates the staleness problem of Path B. Agent gets fresh knowledge on every question. No batch jobs, no refresh crons.

**Example:**
```typescript
const gbrainSearchTool = createTool({
  id: 'gbrain-search',
  description: 'Search the team knowledge base for decisions, meeting notes, architecture rationale',
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) => {
    // query content_chunks via pgvector cosine similarity
    // return top-k chunk_text results
  }
});
```

**Effort:** ~80 lines. Requires the agent to be prompted to use it. Adds ~200-400ms per tool call.

**Tradeoff:** Agent must decide when to search. May miss context it doesn't know to look for. Path B (working memory) gives guaranteed context; Path D gives on-demand context. They complement each other.

---

## Recommended Path

| Priority | Path | Why first |
|---|---|---|
| 1 | **A** — Shared Mastra storage | Foundation. Without this, team state is fragmented. 10-minute fix. |
| 2 | **B** — gbrain → Mastra seed | Highest leverage. Gives agents full project context immediately. |
| 3 | **D** — gbrain as Mastra tool | Makes agents genuinely intelligent about the project at runtime. |
| 4 | **C** — Mastra → gbrain sync | Nice to have. Closes the loop but low urgency. |

---

## What Each Team Member Needs to Do

### Daily habit (takes 2 minutes)
```bash
# After any significant session or decision
/context-save              # saves checkpoint in gstack
gbrain sync                # pushes to Supabase
gbrain embed --stale       # vectorizes new content
```

### After meetings
1. Paste meeting notes as `meeting-YYYY-MM-DD-topic.md` in the repo or a notes dir
2. `gbrain sync` — it becomes a searchable page with decisions, entities, next steps

### Naming convention for personal vs. shared content
- Shared: `design-docs/`, `meeting-*`, `project_context`, `todos`
- Personal: `learnings/vishwa/`, `learnings/rahul/` (prefix with your name)

---

## Current State Summary

| Concern | Status |
|---|---|
| gbrain pointing to Supabase | ✅ Fixed this session |
| Mastra planner-agent memory in Supabase | ✅ Already was |
| Mastra default storage in Supabase | ❌ Still local LibSQLStore |
| gbrain has Vishwa's code indexed | ❌ Local source not yet pushed |
| gbrain → Mastra working memory seed | ❌ Not built |
| gbrain as Mastra tool | ❌ Not built |
| Mastra threads → gbrain pages | ❌ Not built |
| Team sync habit established | ❌ Not yet |
