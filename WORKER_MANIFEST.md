# GRIDHAND WORKER MANIFEST
Last updated: 2026-04-21

This document is the authoritative reference for the full GRIDHAND agent fleet — every tier, every agent, every model assignment, and every routing decision.

---

## TIER STRUCTURE

| Tier | Name | Count | Description | Owner Context |
|---|---|---|---|---|
| 0 | Commander | 1 | Master orchestrator, runs every 15 min, routes to Directors | `gridhand` only |
| 1 | Directors | 5 | Division orchestrators — Acquisition, Revenue, Experience, Brand, Intelligence | `gridhand` only |
| 2 | MY_ARSENAL | 12 | MJ's personal strategic tools — internal ops, never touch client data by default | `gridhand` default, client-switchable for hybrids |
| 2 | Hybrid Agents | 6 | Subset of MY_ARSENAL that can serve both MJ and clients via `owner` param | `gridhand` or `<client_id>` |
| 3 | Client Workers | 16 | Deployed for paying clients — SMS, voice, lead, reputation, billing | Per-client `owner` |
| 3 | Business Mgmt | 5 | New internal ops layer — compliance, finances, growth, ops health | `gridhand` only |
| 4 | SMS Workers | 15+ active, 60+ bench | Per-client inbound/outbound SMS handlers | Per-client |

---

## MY_ARSENAL — 12 Internal Strategic Agents

These agents serve MJ directly. They are invoked via the Executive Assistant (EA) or the Commander. They do not process client data unless a `clientSlug` or `owner` is explicitly passed.

| Codename | File | Role |
|---|---|---|
| FORGE | `agents/specialists/forge.js` | Code builder — translates build requests into implementation specs for grid agents |
| ORACLE | `agents/specialists/oracle.js` | Strategic intelligence — architecture decisions, business strategy, research synthesis |
| ARES | `agents/specialists/cold-outreach.js` | Cold outreach — re-engagement campaigns for cold leads |
| CHAIN | `agents/specialists/churn-predictor.js` | Churn prediction — weekly risk scoring, flags clients at 7+/10 |
| PULSE | `agents/specialists/pipeline-reporter.js` | Pipeline reporting — stage counts, stall detection, acquisition health |
| LAUNCHPAD | `agents/specialists/onboarding-conductor.js` | Onboarding conductor — D1/D3/D7/D14/D30 welcome sequence |
| AEGIS | _(security audit specialist)_ | Security monitoring — RLS gaps, auth failures, anomaly detection |
| XRAY | _(code analysis specialist)_ | Code analysis — reads the codebase and produces architectural reviews |
| ECHO | _(communication specialist)_ | Communication drafting — replies, announcements, updates |
| PATHFINDER | _(route planning specialist)_ | Route optimization and logistics planning |
| APEX | _(performance specialist)_ | Performance benchmarking and optimization recommendations |
| NOVA | `agents/specialists/` | _(capability expansion specialist)_ |

---

## HYBRID AGENTS — Serve Both Contexts

These 6 agents are part of MY_ARSENAL but have been upgraded with an `owner` parameter. Pass `owner: 'gridhand'` (default) for internal ops. Pass `owner: '<client_id>'` to run them in a client-serving context.

| Codename | File | Internal Use | Client Use |
|---|---|---|---|
| FORGE | `agents/specialists/forge.js` | Build specs for GRIDHAND platform | Build proposals/specs for a client's configuration |
| ORACLE | `agents/specialists/oracle.js` | GRIDHAND architecture + business strategy | Pre-call prospect intel for client outreach |
| CHAIN | `agents/specialists/churn-predictor.js` | GRIDHAND client portfolio churn monitoring | Client-side churn risk monitoring for their own customer base |
| ARES | `agents/specialists/cold-outreach.js` | GRIDHAND prospect re-engagement | Client-side cold outreach to their own cold leads |
| PULSE | `agents/specialists/pipeline-reporter.js` | Acquisition director portfolio reports | Monthly pipeline reports for a specific client account |
| LAUNCHPAD | `agents/specialists/onboarding-conductor.js` | GRIDHAND client onboarding (D1-D30) | Onboarding new sub-clients for a client's own service |

### owner parameter — how it works

```javascript
// Internal mode (default — current behavior, no change)
await forge.run({ task: 'build the new billing API', outputType: 'spec' })
// owner defaults to 'gridhand' → internal GRIDHAND context

// Client context mode
await forge.run({ task: 'build proposal for client X', outputType: 'spec', owner: 'client_abc123' })
// owner = 'client_abc123' → isClientContext = true → system prompt switches scope
```

The `isClientContext` flag (derived from `owner !== 'gridhand'`) controls:
- System prompt `<owner_context>` block — scope, tone, and reference frame
- Any AI-generated output that mentions platform internals or GRIDHAND admin routes
- Message framing in agents that send SMS (cold-outreach, onboarding-conductor)

---

## CLIENT WORKERS — 16 Active

Deployed per paying client. Each worker handles a specific function autonomously. Configured via `registry.json` — no redeploy needed for new clients.

| Codename | Role |
|---|---|
| AVI | Appointment scheduler and reminder engine |
| NOVA | New lead capture and qualification |
| REX | Review request and reputation management |
| FORM | Form submission intake and routing |
| ECHO | Client communication drafting and replies |
| STELLA | Star rating recovery and review responses |
| CASH | Payment reminders and invoice follow-up |
| SAGE | FAQ and knowledge base answering |
| DUSK | After-hours response and lead capture |
| QUEUE | Waitlist and queue management |
| REVIVE | Win-back campaigns for lapsed customers |
| RIPPLE | Referral activation and tracking |
| GATE | Intake screening and disqualification |
| BRAND | Brand voice monitoring and consistency |
| CALM | Complaint de-escalation and resolution |
| STATUS | Service status updates and notifications |

---

## NEW BUSINESS MANAGEMENT AGENTS — 5

New internal ops layer. These agents monitor, measure, and grow GRIDHAND itself. All use Groq. None send SMS directly. Internal division only.

| Codename | File | Role | Modes |
|---|---|---|---|
| NEXUS | `agents/specialists/ops-analyst.js` | Operations Analyst — monitors fleet health, flags failures | `audit`, `optimize`, `report` |
| SHIELD | `agents/specialists/compliance-monitor.js` | Compliance Monitor — TCPA tracking, quiet hours, opt-out enforcement | `check`, `report` |
| LEDGER | `agents/specialists/financial-watchdog.js` | Financial Watchdog — MRR, churn rate, LTV, AI cost vs revenue | `mrr`, `spend`, `forecast` |
| SPARK | `agents/specialists/growth-catalyst.js` | Growth Catalyst — upsell identification, outreach target surfacing | `upsell`, `outreach`, `pipeline` |
| BRIDGE | `agents/specialists/client-success-director.js` | Client Success Director — NPS, health scores, QBR agendas, escalations | `health`, `qbr`, `escalate` |

### Output schemas

All 5 agents return structured JSON. Never return null — always return a stub on error.

```
NEXUS:  { issues: [], recommendations: [], summary: string }
SHIELD: { violations: [], warnings: [], compliant: boolean }
LEDGER: { metrics: {}, insights: [], alerts: [] }
SPARK:  { opportunities: [], targets: [], summary: string }
BRIDGE: { healthScores: [], escalations: [], agenda?: string }
```

---

## DIRECTORS — 5

Directors orchestrate specialists across their division. They run on-demand, called by the Commander. Each Director always returns a report object — never null, never silent failure.

| Director | File | Division | Specialists It Runs |
|---|---|---|---|
| Acquisition Director | `agents/acquisition-director.js` | acquisition | cold-outreach, pipeline-reporter, lead-qualifier, prospect-nurturer, campaign-conductor |
| Revenue Director | `agents/revenue-director.js` | revenue | invoice-recovery, contract-renewal, subscription-guard, pricing-optimizer, revenue-forecaster |
| Experience Director | `agents/experience-director.js` | experience | churn-predictor, onboarding-conductor, client-success, loyalty-coordinator, feedback-collector |
| Brand Director | `agents/brand-director.js` | brand | brand-sentinel, reputation-defender, review-orchestrator, social-manager, content-scheduler |
| Intelligence Director | `agents/intelligence-director.js` | intelligence | competitor-monitor, market-pulse, performance-benchmarker, industry-learnings |

### Director stub report (error case)

```javascript
// Every director MUST return this shape on any failure
{
  agentId:      'acquisition-director',
  division:     'acquisition',
  actionsCount: 0,
  escalations:  [],
  outcomes:     [{ status: 'error', message: err.message }],
}
```

---

## COMMANDER — Routing Logic

File: `agents/gridhand-commander.js`
Model: `claude-opus-4-7` (strategic routing requires the best model)
Runs: every 15 minutes via cron (Railway scheduler)

### What the Commander does each cycle

1. Pulls all active clients from Supabase
2. Checks each client's state, plan, and last activity
3. Routes client batches to the appropriate Director based on division priority
4. Collects Director reports
5. Logs outcomes to `activity_log` and `agent_state`
6. Surfaces escalations to EA (Executive Assistant) → MJ via Telegram

### Routing priority order

1. Revenue (billing failures, overdue invoices) — highest priority
2. Experience (churn risk, onboarding gaps) — second priority
3. Acquisition (pipeline stalls, cold leads) — third
4. Brand (reputation signals, review gaps)
5. Intelligence (market research, competitor signals)

---

## MODEL ROUTING TABLE

| Agent / Tier | Model | Reason |
|---|---|---|
| Commander | `claude-opus-4-7` | Strategic routing across 5 divisions — requires judgment |
| All 5 Directors | `claude-opus-4-7` | Division orchestration — complex multi-specialist coordination |
| FORGE | `groq/llama-3.3-70b-versatile` | Code spec generation — Groq speed sufficient, high volume |
| ORACLE | `groq/llama-3.3-70b-versatile` | Strategic analysis — Groq used; Opus available for escalation |
| All 16 Client Workers | `groq/llama-3.3-70b-versatile` | Client-action execution — speed + cost efficiency |
| All 32+ Specialist agents | `groq/llama-3.3-70b-versatile` | Same — fast, cheap, sufficient for structured tasks |
| NEXUS, SHIELD, LEDGER, SPARK, BRIDGE | `groq/llama-3.3-70b-versatile` | Internal ops — monitoring + analysis, no creative judgment needed |
| Executive Assistant (EA) | `claude-sonnet-4-6` | MJ's direct interface — quality matters, not just speed |
| Grid agents: backend, qa | `claude-opus-4-7` (via Claude Code) | Code + security decisions — correctness-critical |
| Grid agents: frontend, devops, integrations, analytics, growth, mobile | `claude-sonnet-4-6` (via Claude Code) | Build work — quality + speed balance |
| Scout pre-reads | `groq/llama-3.3-70b-versatile` | Context extraction — Groq burn is free, prepares Opus briefs |
| SMS workers | `ollama` → `groq` fallback | Local-first for cost; Groq fallback for quality gate |
| Ollama (local) | Analysis + read-only tasks only | NEVER used for code generation or SMS content |

### Hard rule: Ollama never writes code or SMS

Ollama is allowed to: read files, summarize content, extract signals, do research.
Ollama is never allowed to: write code, generate SMS content, produce any output that gets committed or sent.

---

## owner: 'gridhand' vs owner: client_id

### owner: 'gridhand' (default)

- Agent is serving GRIDHAND's internal operations
- System prompt references the GRIDHAND platform, MJ's admin context, internal architecture
- Output may include internal file paths, API routes, admin tooling
- No client-specific scope — works across the full portfolio or for GRIDHAND itself

### owner: client_id (e.g. 'client_abc123')

- Agent is serving a specific paying client's business
- System prompt switches to `isClientContext = true`
- Output is scoped to that client's business, vertical, and configuration
- Internal GRIDHAND references are suppressed unless directly relevant
- For SMS-sending agents (cold-outreach, onboarding-conductor): messages are written from the client's brand voice, not GRIDHAND's

### How to pass it

```javascript
// From a Director or Commander that wants to run a hybrid agent in client mode:
const { run } = require('./specialists/forge')

const result = await run({
  task:       'build a follow-up workflow for new leads',
  outputType: 'spec',
  owner:      client.id,   // triggers client context
})
```

```javascript
// From churn-predictor / pipeline-reporter / onboarding-conductor:
const churnPredictor = require('./specialists/churn-predictor')

// Internal mode (GRIDHAND monitoring its own clients):
await churnPredictor.run(clients)           // owner defaults to 'gridhand'

// Client mode (monitoring a client's own customer churn):
await churnPredictor.run(clients, client.id) // isClientContext = true
```

---

## TCPA + SMS SAFETY

All SMS sending — without exception — goes through `lib/twilio-client.js sendSMS()`.

- TCPA quiet hours (8 AM–9 PM recipient local time) are enforced at send time in `twilio-client.js`
- Opt-out keywords (STOP, UNSUBSCRIBE, CANCEL, END, QUIT) are checked before every send
- All Groq-generated client-facing SMS runs through `lib/message-gate.js validateSMS()` before sending
- SHIELD (`compliance-monitor.js`) audits the log after the fact for pattern violations

No agent may call the Twilio SDK directly. Any new agent that sends SMS must `require('../../lib/twilio-client')`.

---

## FILE MAP

```
agents/
  gridhand-commander.js          — Commander (Opus 4.7)
  acquisition-director.js        — Acquisition Director (Opus 4.7)
  revenue-director.js            — Revenue Director (Opus 4.7)
  experience-director.js         — Experience Director (Opus 4.7)
  brand-director.js              — Brand Director (Opus 4.7)
  intelligence-director.js       — Intelligence Director (Opus 4.7)
  executive-assistant.js         — EA — MJ's Telegram interface (Sonnet 4.6)
  specialists/
    forge.js                     — FORGE (hybrid) — code builder
    oracle.js                    — ORACLE (hybrid) — strategic intelligence
    churn-predictor.js           — CHAIN (hybrid) — churn risk scoring
    cold-outreach.js             — ARES (hybrid) — cold lead re-engagement
    pipeline-reporter.js         — PULSE (hybrid) — pipeline health
    onboarding-conductor.js      — LAUNCHPAD (hybrid) — D1-D30 sequence
    ops-analyst.js               — NEXUS — fleet operations monitoring
    compliance-monitor.js        — SHIELD — TCPA + compliance auditing
    financial-watchdog.js        — LEDGER — MRR, spend, forecast
    growth-catalyst.js           — SPARK — upsell + outreach targets
    client-success-director.js   — BRIDGE — health scores, QBR, escalations
    [30+ additional specialists]
workers/
  [15 active SMS workers, 60+ on bench]
lib/
  ai-client.js                   — Universal AI client (Groq, Anthropic, Ollama)
  twilio-client.js               — TCPA-guarded SMS sending (always use this)
  message-gate.js                — Groq output quality validator
  memory-client.js               — Interaction logging to Supabase
  memory-vault.js                — Cross-agent shared state store
  scout.js                       — Scout pattern: Groq pre-reads for Opus
  token-tracker.js               — Token spend tracking per call
```
