# GRIDHAND Workers — Claude Config

See master config at `~/.claude/CLAUDE.md` for full context.

## This Project
Node.js + Express. SMS AI worker backend. Deployed on Railway.
Each worker is a JS file in `workers/` that extends `base.js`.

## Architecture
- `server.js` — Express entry point, Twilio webhook handler
- `workers/` — one file per worker type
- `clients/` — one config JSON per client (business info, assigned workers, memory)
- `subagents/` — intelligence, compliance, business-intelligence, integrations
- `lib/ai-client.js` — all Claude API calls go here
- `lib/twilio-client.js` — all Twilio calls go here
- `memory/` — per-client conversation memory

## Worker Pattern
Every worker must:
1. Extend `base.js`
2. Define a `systemPrompt` using client context
3. Implement `handle(message, context)` → returns reply string
4. Use `subagents/store.js` for memory reads/writes
5. Never call Claude or Twilio directly — always use lib wrappers

## Rules
- Never send real SMS without MJ's approval
- Never modify client billing or Stripe charges
- Test with `memory/test-client` before touching real client configs
- Do NOT push to GitHub without MJ saying so

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
