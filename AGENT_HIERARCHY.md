# GRIDHAND — Agent Hierarchy

Three tiers. Don't mix them up.

---

## TIER 1 — THE BRAIN
*MJ's internal intelligence. Never client-facing. Runs on cron every 15 min.*

### Commander
- **File:** `agents/gridhand-commander.js`
- **Model:** Claude Opus 4.7
- **Role:** Routes every cron cycle. Reads all client signals. Dispatches directors. Synthesizes outcomes.

### Directors (5)
| Name | File | Role |
|---|---|---|
| Acquisition Director | `agents/acquisition-director.js` | Pipeline, cold outreach, lead scoring |
| Revenue Director | `agents/revenue-director.js` | MRR, billing health, upsell signals |
| Experience Director | `agents/experience-director.js` | Churn risk, onboarding, client success |
| Brand Director | `agents/brand-director.js` | Reputation, content scheduling, social |
| Intelligence Director | `agents/intelligence-director.js` | Market intel, competitor scans, benchmarks |

*All Directors: Claude Opus 4.7*

### Internal Support (12)
| Name | File |
|---|---|
| Daily Digest | `agents/daily-digest.js` |
| Executive Assistant | `agents/executive-assistant.js` |
| Worker Guardian | `agents/worker-guardian.js` |
| Scenario Warden | `agents/scenario-warden.js` |
| Credential Monitor | `agents/credential-monitor.js` |
| Industry Scenario Builder | `agents/industry-scenario-builder.js` |
| n8n Scenario Engine | `agents/n8n-scenario-engine.js` |
| Project Orchestrator | `agents/project-orchestrator.js` |
| Reputation Agent | `agents/reputation-agent.js` |
| Retention Agent | `agents/retention-agent.js` |
| Lead Nurture Agent | `agents/lead-nurture-agent.js` |

*All Internal Support: Groq (llama-3.3-70b)*

---

## TIER 2 — THE SPECIALISTS
*Client workforce. 37 agents across 5 divisions. Deployed for every paying client.*
*All Specialists: Groq (llama-3.3-70b)*

### Acquisition Division (7)
| Agent | File | What It Does |
|---|---|---|
| Lead Qualifier | `specialists/lead-qualifier.js` | Scores inbound leads by fit + urgency |
| Cold Outreach | `specialists/cold-outreach.js` | Personalized first-touch sequences |
| Prospect Nurturer | `specialists/prospect-nurturer.js` | Warms prospects until they book |
| Referral Activator | `specialists/referral-activator.js` | Triggers referral asks at the right moment |
| Appointment Setter | `specialists/appointment-setter.js` | Books discovery calls from warm leads |
| Win-Back Outreach | `specialists/win-back-outreach.js` | Re-engages churned or lost prospects |
| Pipeline Reporter | `specialists/pipeline-reporter.js` | Weekly pipeline summary + next actions |

### Revenue Division (7)
| Agent | File | What It Does |
|---|---|---|
| Invoice Recovery | `specialists/invoice-recovery.js` | Chases unpaid invoices automatically |
| Subscription Guard | `specialists/subscription-guard.js` | Flags at-risk subscriptions before churn |
| Upsell Timer | `specialists/upsell-timer.js` | Identifies upgrade moments from usage |
| Pricing Optimizer | `specialists/pricing-optimizer.js` | Benchmarks pricing against market |
| Payment Dunner | `specialists/payment-dunner.js` | Failed payment recovery sequence |
| Contract Renewal | `specialists/contract-renewal.js` | Starts renewal conversations 60 days out |
| Revenue Forecaster | `specialists/revenue-forecaster.js` | Projects MRR trend from current signals |

### Experience Division (7)
| Agent | File | What It Does |
|---|---|---|
| Client Success | `specialists/client-success.js` | Proactive check-ins + QBR preparation |
| Churn Predictor | `specialists/churn-predictor.js` | Detects disengagement before cancel |
| Loyalty Coordinator | `specialists/loyalty-coordinator.js` | Milestone recognition + loyalty rewards |
| Onboarding Conductor | `specialists/onboarding-conductor.js` | Guides new clients through first 30 days |
| Feedback Collector | `specialists/feedback-collector.js` | Structured NPS + issue capture |
| Milestone Celebrator | `specialists/milestone-celebrator.js` | Celebrates client wins automatically |
| Support Escalator | `specialists/support-escalator.js` | Routes urgent issues before they explode |

### Brand Division (5)
| Agent | File | What It Does |
|---|---|---|
| Brand Sentinel | `specialists/brand-sentinel.js` | Monitors brand mentions + sentiment |
| Campaign Conductor | `specialists/campaign-conductor.js` | Orchestrates multi-channel campaigns |
| Social Manager | `specialists/social-manager.js` | Schedules + publishes social content |
| Content Scheduler | `specialists/content-scheduler.js` | Plans content calendar from strategy |
| Reputation Defender | `specialists/reputation-defender.js` | Responds to negative reviews within 1h |

### Intelligence Division (11)
| Agent | File | What It Does |
|---|---|---|
| Competitor Monitor | `specialists/competitor-monitor.js` | Tracks competitor moves weekly |
| Market Pulse | `specialists/market-pulse.js` | Industry trend digests for clients |
| Performance Benchmarker | `specialists/performance-benchmarker.js` | Compares client KPIs vs market avg |
| Ops Analyst | `specialists/ops-analyst.js` | Operational efficiency scoring |
| Compliance Monitor | `specialists/compliance-monitor.js` | Flags regulatory + TCPA exposure |
| Financial Watchdog | `specialists/financial-watchdog.js` | Cash flow anomaly detection |
| Growth Catalyst | `specialists/growth-catalyst.js` | Identifies growth levers per client |
| Client Success Director | `specialists/client-success-director.js` | Division-level success reporting |
| Oracle | `specialists/oracle.js` | Deep strategic analysis on demand |
| Forge | `specialists/forge.js` | Builds custom automations per client |
| Review Orchestrator | `specialists/review-orchestrator.js` | Coordinates all review activity |

---

## TIER 3 — THE WORKERS
*Execution layer. Triggered by events. ~25 workers.*
*All Workers: Ollama (local) → Groq (fallback)*

### Communication
| Worker | File | Trigger |
|---|---|---|
| Receptionist | `workers/receptionist.js` | Inbound call / SMS |
| Reminder | `workers/reminder.js` | Scheduled before appointment |
| After Hours | `workers/after-hours.js` | Outside business hours |
| FAQ | `workers/faq.js` | Common questions |
| Twilio Sender | `workers/twilio-sender.js` | All outbound SMS |

### Revenue
| Worker | File | Trigger |
|---|---|---|
| Invoice Chaser | `workers/invoice-chaser.js` | Overdue invoice |
| Upsell | `workers/upsell.js` | Usage threshold hit |
| Booking | `workers/booking.js` | Appointment events |
| Quote | `workers/quote.js` | Quote request |
| Reactivation | `workers/reactivation.js` | 30+ days inactive |

### Relationships
| Worker | File | Trigger |
|---|---|---|
| Lead Follow-up | `workers/lead-followup.js` | New lead |
| Referral | `workers/referral.js` | Post-service |
| Review Requester | `workers/review-requester.js` | Service complete |
| Onboarding | `workers/onboarding.js` | New client signup |
| Waitlist | `workers/waitlist.js` | Slot opens up |

### Operations
| Worker | File | Trigger |
|---|---|---|
| Intake | `workers/intake.js` | New inquiry |
| Status Updater | `workers/status-updater.js` | Status change |
| Weekly Report | `workers/weekly-report.js` | Every Monday |
| Integration Dispatch | `workers/integration-dispatcher.js` | External event |
| Memory | `workers/memory.js` | Context recall |

### Industry Workers (Vertical)
| Worker | Directory | Industry |
|---|---|---|
| Bay Boss | `workers/bay-boss/` | Auto repair |
| Transaction Tracker | `workers/transaction-tracker/` | Real estate |
| Rent Collector | `workers/rent-collector/` | Property management |
| Lead Incubator | `workers/lead-incubator/` | Long-cycle sales |

---

## Quick Reference

| Question | Answer |
|---|---|
| Who runs every 15 min? | Commander → dispatches Directors |
| Who works for clients? | The 37 Specialists (Tier 2) |
| Who sends the SMS? | Workers (Tier 3) — specifically twilio-sender.js |
| Who decides what SMS to send? | Specialists trigger Workers |
| What model runs the brain? | Opus 4.7 (Commander + Directors) |
| What model runs specialists? | Groq llama-3.3-70b |
| What model runs workers? | Ollama locally → Groq fallback |
| Can local models edit code? | NO. Ollama/Groq read only. Sonnet/Opus write code. |
