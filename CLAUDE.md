# GRIDHAND Workers — Claude Config

See master config at `~/Desktop/workspace/CLAUDE.md` for full context.

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
