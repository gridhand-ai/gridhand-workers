// tier: standard
/**
 * n8n-scenario-engine.js
 *
 * ── LK GRIDHAND AGENTS (Low Key) ──────────────────────────────────────────────
 * These are INTERNAL agents — they work to improve and build GRIDHAND's system.
 * They don't serve clients directly. They think, generate scenarios, and build
 * automation blueprints that get deployed into n8n.
 *
 * OG GRIDHAND AGENTS (Original) = lead-nurture, reputation, retention, etc.
 * Those serve clients directly. These (LK) serve GRIDHAND internally.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 35 LK domain agents that think about automation scenarios for small service
 * businesses and generate importable n8n workflow JSON.
 *
 * Each domain agent:
 *   1. Takes seed scenario templates
 *   2. Calls Groq (llama-3.3-70b) to expand/personalize them for real clients
 *   3. Generates valid n8n workflow JSON for each scenario
 *   4. Saves to /scenarios/{domain-id}/{timestamp}-{slug}.json
 *   5. Updates /scenarios/index.json with metadata
 *   6. Optionally pushes to live n8n instance via REST API (requires N8N_API_KEY)
 *
 * Schedule: runs daily at 2am via setInterval in server.js
 *
 * Usage:
 *   node agents/n8n-scenario-engine.js           -- run all 15 agents now
 *   node agents/n8n-scenario-engine.js --domain lead-capture  -- run one agent
 *   node agents/n8n-scenario-engine.js --dry-run -- generate JSON, skip n8n push
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const N8N_BASE_URL  = process.env.N8N_BASE_URL  || 'https://gridhand-n8n-production.up.railway.app';
const N8N_API_KEY   = process.env.N8N_API_KEY   || '';
const GROQ_API_KEY  = process.env.GROQ_API_KEY  || '';
const GROQ_MODEL    = 'llama-3.3-70b-versatile';
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

const SCENARIOS_DIR = path.join(__dirname, '..', 'scenarios');
const INDEX_FILE    = path.join(SCENARIOS_DIR, 'index.json');

// How many expanded scenarios to generate per domain per run
const SCENARIOS_PER_DOMAIN = 3;

// ─── 15 Domain Agents ────────────────────────────────────────────────────────

const SCENARIO_DOMAINS = [
    {
        id: 'lead-capture',
        name: 'Lead Capture Agent',
        description: 'Facebook/Google/Typeform leads → CRM automation',
        seeds: [
            'Facebook Lead Ad → HubSpot contact → Twilio SMS welcome',
            'Google Form submit → Airtable row → email follow-up',
            'Typeform complete → Pipedrive deal → assign to sales rep',
            'Website contact form → qualify with AI → route to calendar',
            'LinkedIn lead → enrich with Clearbit → add to sequence',
        ],
    },
    {
        id: 'review-reputation',
        name: 'Review Reputation Agent',
        description: 'Google/Yelp review monitoring and auto-response',
        seeds: [
            'New Google Review → AI draft response → post reply',
            'Negative review alert → notify owner → track resolution',
            'Review score drops below 4.0 → alert + action plan',
            'Monthly review report → email to client',
            'After service → SMS request for Google review',
        ],
    },
    {
        id: 'sms-campaigns',
        name: 'SMS Campaign Agent',
        description: 'Twilio-based SMS automation flows',
        seeds: [
            'Trigger: new contact → welcome SMS series (day 1, 3, 7)',
            'Trigger: unpaid invoice 7 days → escalating SMS reminders',
            'Trigger: appointment tomorrow → reminder SMS + confirm link',
            'Trigger: no visit in 30 days → win-back SMS offer',
            'Trigger: birthday → personalized SMS with offer',
        ],
    },
    {
        id: 'appointment-flow',
        name: 'Appointment Flow Agent',
        description: 'Booking to follow-up automation',
        seeds: [
            'Calendly booked → add to CRM → confirmation SMS → 24hr reminder → 2hr reminder',
            'No-show detected → reschedule SMS → offer discount',
            'Appointment complete → review request after 1hr',
            'Waitlist opened → notify waiting customers',
            'Recurring appointment due → proactive rebooking SMS',
        ],
    },
    {
        id: 'payment-chaser',
        name: 'Payment Chaser Agent',
        description: 'Invoice and payment automation',
        seeds: [
            'Invoice created → due in 3 days → reminder SMS',
            'Invoice overdue 1 day → polite SMS reminder',
            'Invoice overdue 7 days → firm SMS + email',
            'Payment received → thank you SMS + receipt',
            'Monthly statement due → auto-generate and send',
        ],
    },
    {
        id: 'social-publishing',
        name: 'Social Publishing Agent',
        description: 'Multi-platform content distribution',
        seeds: [
            'New blog post → rewrite for Twitter + LinkedIn + Facebook → schedule',
            'Weekly content calendar → auto-post Monday–Friday',
            'Customer testimonial → format for each platform → publish',
            'Product/service update → announce on all platforms simultaneously',
            'Seasonal promotion → create platform-specific versions → schedule',
        ],
    },
    {
        id: 'crm-sync',
        name: 'CRM Sync Agent',
        description: 'Keep all contact and deal data in sync',
        seeds: [
            'New contact in HubSpot → sync to Airtable + Mailchimp',
            'Deal stage change → update all connected systems',
            'Email reply detected → update CRM last contact date',
            'Duplicate contact found → merge and notify',
            'Contact gone cold 60 days → flag for re-engagement',
        ],
    },
    {
        id: 'win-back',
        name: 'Win-Back Agent',
        description: 'Re-engage lapsed customers',
        seeds: [
            'No purchase/visit in 30 days → personalized win-back SMS',
            'No purchase/visit in 60 days → special discount offer',
            'No purchase/visit in 90 days → final attempt + survey',
            'Cancelled appointment never rebooked → follow-up after 2 weeks',
            'Churned customer → quarterly check-in campaign',
        ],
    },
    {
        id: 'onboarding',
        name: 'Onboarding Agent',
        description: 'New client welcome and setup sequences',
        seeds: [
            'New client signup → welcome email + SMS + checklist',
            'Day 1 → intro call scheduled automatically',
            'Day 3 → check-in SMS asking about experience',
            'Day 7 → first result report + what to expect next',
            'Day 30 → monthly review scheduled + feedback request',
        ],
    },
    {
        id: 'reporting',
        name: 'Reporting Agent',
        description: 'Automated data collection and reporting',
        seeds: [
            'Weekly: pull tasks from Airtable → generate summary → email client',
            'Monthly: review count + rating average → send performance report',
            'Daily: new leads count + conversion rate → Slack notification',
            'Weekly: revenue vs last week → email to owner',
            'Monthly: top performing workers → client success report',
        ],
    },
    {
        id: 'ecommerce',
        name: 'E-commerce Agent',
        description: 'Online store automation flows',
        seeds: [
            'Abandoned cart → email reminder after 1hr → SMS after 24hr',
            'Order placed → confirmation → shipping update → delivery confirmation',
            'Post-purchase day 7 → review request',
            'Low stock alert → notify owner + pause ads',
            'Repeat customer 3x → VIP tag + special offer',
        ],
    },
    {
        id: 'internal-ops',
        name: 'Internal Ops Agent',
        description: 'Internal business automation',
        seeds: [
            'New employee → create accounts in all systems → send welcome',
            'Weekly team report → compile from all tools → send to owner',
            'License/certification expiring → 30 day warning → assign renewal task',
            'Inventory low → auto-create purchase order → notify manager',
            'Daily standup → pull yesterday tasks → generate summary',
        ],
    },
    {
        id: 'seasonal-campaigns',
        name: 'Seasonal Campaign Agent',
        description: 'Holiday and seasonal automation',
        seeds: [
            'Black Friday: 2 weeks before → tease → launch → follow-up sequence',
            'New Year: Jan 1 → goal-setting offer → check-in Jan 15',
            'Summer: May 1 → seasonal promotion for relevant services',
            'Back to school → targeted campaign for relevant businesses',
            'Holiday: Dec 1 → gift card campaign → last chance Dec 20',
        ],
    },
    {
        id: 'industry-specialist',
        name: 'Industry Specialist Agent',
        description: 'Industry-specific scenario generation',
        seeds: [
            'Auto repair: vehicle due for oil change (6 months) → proactive SMS',
            'Restaurant: table booked → pre-order menu → upsell drinks',
            'Gym: member not visited in 2 weeks → check-in SMS',
            'Salon: haircut 6 weeks ago → rebooking reminder',
            'Real estate: listing price drop → alert saved search customers',
        ],
    },
    {
        id: 'competitor-monitor',
        name: 'Competitor Monitor Agent',
        description: 'Watch competitor activity and alert',
        seeds: [
            'Competitor gets negative review → alert owner with opportunity',
            'Competitor drops price → notify + suggest response',
            'Competitor gains 10+ reviews this month → benchmark alert',
            'Competitor posts new service → analyze and report',
            'Monthly: competitor comparison report → email to client',
        ],
    },

    // ── 20 MORE AGENTS ──────────────────────────────────────────────────────

    {
        id: 'follow-up-sequences',
        name: 'Follow-Up Sequence Agent',
        description: 'Multi-touch follow-up for every trigger type',
        seeds: [
            'Quote sent → day 1 call reminder → day 3 SMS → day 7 final push',
            'Lead went cold → 5-touch reactivation sequence over 2 weeks',
            'Proposal sent → open detected → auto-schedule follow-up call',
            'Free trial started → onboarding emails day 1/3/7/14/30',
            'Event attended → thank you → recap → upsell sequence',
            'Demo completed → same-day recap → 2-day follow-up → 5-day close attempt',
        ],
    },
    {
        id: 'referral-program',
        name: 'Referral Program Agent',
        description: 'Referral tracking, rewards, and viral growth automation',
        seeds: [
            'Customer makes referral → thank you + reward trigger',
            'Referral converts → notify referrer → bonus reward',
            'New customer asks "how did you hear about us" → track source',
            'Top referrer this month → VIP upgrade + personal thank you',
            'Referral link clicked but not converted → follow-up to both parties',
            'Anniversary of referral → thank customer + ask for another',
        ],
    },
    {
        id: 'survey-feedback',
        name: 'Survey & Feedback Agent',
        description: 'NPS, post-service surveys, and feedback collection',
        seeds: [
            'Service complete → NPS survey SMS 2 hours later',
            'NPS score 0-6 → immediate owner alert + recovery call',
            'NPS score 9-10 → request Google review + referral ask',
            'Monthly check-in survey → compile results → email report',
            'Cancellation detected → exit survey → flag if saveable',
            'Product/service change → gather customer feedback first',
        ],
    },
    {
        id: 'loyalty-program',
        name: 'Loyalty Program Agent',
        description: 'Points, rewards, VIP tiers, and retention automation',
        seeds: [
            'Customer visits → award points → update tier status',
            'Points threshold reached → send reward notification',
            'VIP tier achieved → welcome message + exclusive offer',
            'Points expiring in 30 days → reminder SMS',
            'Birthday month → double points notification',
            '10th visit milestone → surprise upgrade or free service',
        ],
    },
    {
        id: 'email-drip',
        name: 'Email Drip Campaign Agent',
        description: 'Multi-step automated email sequences for every funnel stage',
        seeds: [
            'New subscriber → 7-email welcome series over 2 weeks',
            'Downloaded lead magnet → nurture sequence → soft pitch day 10',
            'Webinar registered → 3 pre-event emails → 2 post-event follow-ups',
            'Abandoned checkout → 3-email recovery sequence over 72 hours',
            'Inactive email 90 days → re-engagement campaign → unsubscribe if no open',
            'New product launch → pre-launch teaser → launch day → recap',
        ],
    },
    {
        id: 'data-enrichment',
        name: 'Data Enrichment Agent',
        description: 'Enrich contacts with company, social, and demographic data',
        seeds: [
            'New lead → Clearbit enrich → add company/title/LinkedIn to CRM',
            'Email address only → find phone number via enrichment API',
            'New business client → pull company size/revenue/industry data',
            'Stale contact record 6+ months → re-enrich to update data',
            'LinkedIn URL added → auto-pull profile data → update CRM',
            'New contact → score lead based on enriched data → route accordingly',
        ],
    },
    {
        id: 'document-contracts',
        name: 'Document & Contract Agent',
        description: 'DocuSign, proposals, contracts, and e-signature automation',
        seeds: [
            'Deal reaches proposal stage → auto-generate proposal from template',
            'Contract sent → unsigned after 3 days → reminder SMS',
            'Contract signed → trigger onboarding workflow automatically',
            'Service agreement expiring → renewal notice 30/14/7 days out',
            'Invoice approved → auto-generate and send contract',
            'New client → auto-populate all forms from CRM data',
        ],
    },
    {
        id: 'alerts-monitoring',
        name: 'Alerts & Monitoring Agent',
        description: 'Business monitoring, anomaly detection, and instant alerts',
        seeds: [
            'Revenue drops 20% week-over-week → alert owner immediately',
            'No new leads in 48 hours → alert + trigger lead gen check',
            'Worker task failure detected → SMS alert to admin',
            'Website goes down → immediate SMS notification',
            'Negative keyword detected in messages → escalate to owner',
            'Unusual hours login to business system → security alert',
        ],
    },
    {
        id: 'chat-messenger',
        name: 'Chat & Messenger Agent',
        description: 'Website chat, WhatsApp, Messenger, and Instagram DM automation',
        seeds: [
            'WhatsApp message received → AI respond → escalate if complex',
            'Instagram DM received → auto-reply with info → book appointment',
            'Facebook Messenger inquiry → qualify → route to right person',
            'Website chat offline → capture message → SMS response within 5 min',
            'After-hours message → acknowledge + set expectations + morning follow-up',
            'Chat lead → extract intent → create CRM record + trigger sequence',
        ],
    },
    {
        id: 'voice-phone',
        name: 'Voice & Phone Agent',
        description: 'Call tracking, voicemail drop, and VoIP automation',
        seeds: [
            'Missed call → voicemail transcribed → SMS follow-up within 60 sec',
            'Call completed → log summary to CRM → trigger follow-up',
            'Voicemail drop campaign → batch send to cold leads',
            'Call duration under 30 sec → flag as likely not answered → retry',
            'Inbound call from unknown number → lookup → greet by name if known',
            'Monthly call analytics → top call times → staff scheduling recommendation',
        ],
    },
    {
        id: 'upsell-crosssell',
        name: 'Upsell & Cross-sell Agent',
        description: 'Revenue expansion through smart timing and personalization',
        seeds: [
            'Service purchased → 30 days later → complementary service offer',
            'Basic plan customer 90 days → upgrade pitch with ROI breakdown',
            'High engagement customer → invite to premium tier',
            'Seasonal upsell: winter approaching → relevant service bundle offer',
            'After positive review → perfect time to pitch add-on service',
            'Customer ROI milestone → share win + upgrade conversation',
        ],
    },
    {
        id: 'churn-prevention',
        name: 'Churn Prevention Agent',
        description: 'Early warning and intervention for at-risk clients',
        seeds: [
            'Engagement drops 50% → proactive check-in call triggered',
            'Support tickets spike → assign success manager → personal outreach',
            'Login frequency drops → "is everything OK?" SMS + offer help',
            'Subscription renewal approaching + low usage → intervention sequence',
            'Complaint filed → escalate + resolution tracking + follow-up',
            'Contract ending in 60 days → renewal campaign starts immediately',
        ],
    },
    {
        id: 'vip-client',
        name: 'VIP Client Agent',
        description: 'Premium treatment automation for high-value customers',
        seeds: [
            'Client reaches $5k spend → VIP flag + personal thank you from owner',
            'VIP anniversary → gift or exclusive offer',
            'VIP submits support ticket → priority routing + faster SLA',
            'VIP birthday → personal video message + special offer',
            'VIP refers someone → double reward + extra recognition',
            'VIP no contact in 30 days → owner personal outreach',
        ],
    },
    {
        id: 'lead-scoring',
        name: 'Lead Scoring Agent',
        description: 'Automatic lead qualification, scoring, and routing',
        seeds: [
            'New lead → AI score based on company size + industry + behavior',
            'High-score lead → immediate sales alert + fast-track sequence',
            'Low-score lead → nurture sequence only, no sales time wasted',
            'Lead score increases from cold to warm → notify sales rep',
            'Lead visits pricing page 3x → hot signal → immediate outreach',
            'Lead score decays after 30 days no activity → re-engagement or archive',
        ],
    },
    {
        id: 'multi-location',
        name: 'Multi-Location Agent',
        description: 'Automation for businesses with multiple branches or locations',
        seeds: [
            'Review at any location → route to that location manager + owner',
            'One location underperforms → alert HQ + trigger review',
            'New location opening → launch sequence across all channels',
            'Staff at location goes offline → route to nearest available',
            'Cross-location customer → notify preferred location of visit history',
            'Monthly: location performance comparison → send to owner',
        ],
    },
    {
        id: 'content-generation',
        name: 'Content Generation Agent',
        description: 'AI-powered content creation for marketing and communication',
        seeds: [
            'Weekly: generate 5 social posts from business updates → stage for approval',
            'New service added → AI writes blog post + social variants + SMS',
            'Positive customer story → AI turns it into case study + social proof',
            'Seasonal event → AI generates campaign assets for all channels',
            'Competitor weakness found → AI writes positioning content',
            'FAQ update → AI rewrites for clarity + formats for all channels',
        ],
    },
    {
        id: 'marketplace-listings',
        name: 'Marketplace & Listings Agent',
        description: 'Google Business Profile, Yelp, directory listing automation',
        seeds: [
            'New service added → update Google Business Profile automatically',
            'Holiday hours → auto-update all listings 1 week before',
            'Photo added to business → sync to all directories',
            'New promotion → post to Google Business + Yelp simultaneously',
            'Business info changes → propagate to all 50+ directory listings',
            'Google Business Q&A new question → AI draft answer → post after approval',
        ],
    },
    {
        id: 'compliance-privacy',
        name: 'Compliance & Privacy Agent',
        description: 'GDPR, TCPA, opt-out, and consent management automation',
        seeds: [
            'Opt-out received → remove from ALL communication lists immediately',
            'Consent collected → log with timestamp → attach to contact record',
            'Data deletion request → purge from all systems + confirm',
            'TCPA: only contact between 8am-9pm local time enforcement',
            'New contact → send consent confirmation before any marketing',
            'Annual: review and purge contacts with no consent on file',
        ],
    },
    {
        id: 'finance-reconciliation',
        name: 'Finance & Reconciliation Agent',
        description: 'Automated bookkeeping, reconciliation, and financial alerts',
        seeds: [
            'Payment received → log to QuickBooks → update invoice status → notify',
            'End of month → reconcile Stripe vs QuickBooks → flag discrepancies',
            'Recurring revenue drops → alert owner + generate report',
            'Refund issued → update all systems + customer notification',
            'Tax season: Q1 ends → compile income/expense report automatically',
            'Cash flow projection every Monday → email to owner',
        ],
    },
    {
        id: 'partnership-b2b',
        name: 'Partnership & B2B Agent',
        description: 'Partner onboarding, co-marketing, and B2B relationship automation',
        seeds: [
            'New partner signed → onboarding sequence + resource kit',
            'Partner referral received → fast-track + notify partner of status',
            'Partner inactive 60 days → re-engagement + check-in',
            'Co-marketing campaign → sync assets + coordinate launch',
            'Partner milestone → congratulations + upsell conversation',
            'Monthly partner performance → send report + suggest improvements',
        ],
    },
];

// ─── Utilities ────────────────────────────────────────────────────────────────

function generateId() {
    return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

function slugify(str) {
    return str
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 60);
}

function loadIndex() {
    try {
        return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    } catch {
        return { generated: [], lastRun: null };
    }
}

function saveIndex(index) {
    fs.mkdirSync(SCENARIOS_DIR, { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

// ─── Groq AI Call ─────────────────────────────────────────────────────────────

async function callGroq(systemPrompt, userMessage, maxTokens = 800) {
    if (!GROQ_API_KEY) {
        throw new Error('GROQ_API_KEY not set — cannot generate scenarios');
    }

    const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
            model: GROQ_MODEL,
            max_tokens: maxTokens,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userMessage  },
            ],
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Groq API error (${response.status}): ${err.slice(0, 200)}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
}

// ─── N8N Workflow JSON Generator ─────────────────────────────────────────────

/**
 * Generate a valid n8n workflow JSON for a given domain + scenario description.
 * Produces a webhook trigger → code node structure that can be imported directly
 * into n8n and extended with real credentials/nodes.
 */
function generateWorkflowJson(domain, scenarioTitle, scenarioDescription) {
    const triggerId = generateId();
    const logicId   = generateId();
    const notifyId  = generateId();

    const webhookPath = `gridhand-${domain.id}-${Date.now()}`;
    const safeTitle   = scenarioTitle.replace(/'/g, "\\'");
    const safeDesc    = scenarioDescription.replace(/'/g, "\\'").replace(/\n/g, ' ');

    return {
        name: `[GRIDHAND] ${domain.name} - ${scenarioTitle.slice(0, 60)}`,
        nodes: [
            // ── Trigger node: webhook so any external system can fire it ──
            {
                id: triggerId,
                name: 'Trigger',
                type: 'n8n-nodes-base.webhook',
                typeVersion: 1,
                position: [240, 300],
                parameters: {
                    path: webhookPath,
                    responseMode: 'onReceived',
                    options: {},
                },
                webhookId: generateId(),
            },
            // ── Logic node: core scenario processing ──
            {
                id: logicId,
                name: 'Scenario Logic',
                type: 'n8n-nodes-base.code',
                typeVersion: 2,
                position: [480, 300],
                parameters: {
                    jsCode: [
                        `// GRIDHAND Auto-Generated Scenario`,
                        `// Domain:   ${domain.name}`,
                        `// Scenario: ${safeTitle}`,
                        `// Desc:     ${safeDesc}`,
                        `// Created:  ${new Date().toISOString()}`,
                        `//`,
                        `// HOW TO USE:`,
                        `// 1. Replace this Code node with real n8n nodes for your stack`,
                        `// 2. Configure credentials in n8n Settings → Credentials`,
                        `// 3. Test with the "Execute Workflow" button`,
                        ``,
                        `const input = $input.first().json;`,
                        ``,
                        `// ── Validate required fields ──`,
                        `if (!input) {`,
                        `  throw new Error('No input data received');`,
                        `}`,
                        ``,
                        `// ── Core scenario logic ──`,
                        `// Scenario: ${safeTitle}`,
                        `const output = {`,
                        `  ...input,`,
                        `  processed: true,`,
                        `  processedAt: new Date().toISOString(),`,
                        `  domain: '${domain.id}',`,
                        `  scenario: '${safeTitle}',`,
                        `  gridhandVersion: '1.0',`,
                        `};`,
                        ``,
                        `return [{ json: output }];`,
                    ].join('\n'),
                },
            },
            // ── Notify node: log completion (replace with Slack/SMS/email) ──
            {
                id: notifyId,
                name: 'Log Completion',
                type: 'n8n-nodes-base.code',
                typeVersion: 2,
                position: [720, 300],
                parameters: {
                    jsCode: [
                        `// Replace this node with your notification channel:`,
                        `// - Twilio SMS: use n8n-nodes-base.twilio`,
                        `// - Slack:      use n8n-nodes-base.slack`,
                        `// - Email:      use n8n-nodes-base.emailSend`,
                        `// - HubSpot:    use n8n-nodes-base.hubspot`,
                        ``,
                        `const result = $input.first().json;`,
                        `console.log('[GRIDHAND] Scenario completed:', result.scenario);`,
                        `return [{ json: { success: true, ...result } }];`,
                    ].join('\n'),
                },
            },
        ],
        connections: {
            'Trigger': {
                main: [[{ node: 'Scenario Logic', type: 'main', index: 0 }]],
            },
            'Scenario Logic': {
                main: [[{ node: 'Log Completion', type: 'main', index: 0 }]],
            },
        },
        settings: {
            executionOrder: 'v1',
            saveManualExecutions: true,
            callerPolicy: 'workflowsFromSameOwner',
            errorWorkflow: '',
        },
        tags: ['gridhand', domain.id, 'auto-generated'],
        meta: {
            gridhand: {
                domainId:    domain.id,
                domainName:  domain.name,
                scenario:    scenarioTitle,
                description: scenarioDescription,
                generatedAt: new Date().toISOString(),
            },
        },
    };
}

// ─── N8N API: push workflow to live instance ─────────────────────────────────

async function pushToN8n(workflowJson) {
    if (!N8N_API_KEY) {
        return { skipped: true, reason: 'N8N_API_KEY not set — saved to disk only' };
    }

    const response = await fetch(`${N8N_BASE_URL}/api/v1/workflows`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-N8N-API-KEY': N8N_API_KEY,
        },
        body: JSON.stringify(workflowJson),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`n8n API error (${response.status}): ${err.slice(0, 200)}`);
    }

    const data = await response.json();
    return { pushed: true, n8nId: data.id, n8nName: data.name };
}

// ─── Domain Agent Runner ─────────────────────────────────────────────────────

/**
 * Run a single domain agent:
 *  1. Use Groq to expand seed scenarios into rich, personalized descriptions
 *  2. Generate n8n workflow JSON for each
 *  3. Save to disk
 *  4. Push to n8n if API key available
 *  5. Return list of generated scenario metadata
 */
async function runDomainAgent(domain, existingIndex, options = {}) {
    const { dryRun = false } = options;
    const generated = [];

    console.log(`\n[SCENARIO ENGINE] Running: ${domain.name}...`);

    // Build the set of already-generated scenario slugs for this domain
    const existingSlugs = new Set(
        existingIndex.generated
            .filter(s => s.domainId === domain.id)
            .map(s => s.slug)
    );

    // ── Step 1: Ask Groq to expand seeds into real scenario descriptions ──
    const systemPrompt = [
        '<role>You are a GRIDHAND automation specialist. GRIDHAND serves small service businesses: auto repair shops, barbershops, restaurants, gyms, real estate agents, and retail stores.</role>',
        '<task>Expand the provided automation seed into a concrete, actionable scenario description for a real small business. Write 2-3 sentences describing exactly what triggers the workflow, what it does step-by-step, and what outcome it delivers for the business owner. Be specific about apps, timing, and business impact. Do NOT use bullet points — write as flowing prose.</task>',
        '<rules>Only return the description text. No headers, no JSON, no explanations. Write for a business owner who wants results, not a developer who wants specs.</rules>',
    ].join('\n');

    // Select seeds to expand — skip any whose slugs already exist in index
    const availableSeeds = domain.seeds.filter(seed => !existingSlugs.has(slugify(seed)));

    if (availableSeeds.length === 0) {
        console.log(`[SCENARIO ENGINE]   ${domain.name}: all seeds already generated — skipping`);
        return [];
    }

    // Take up to SCENARIOS_PER_DOMAIN seeds
    const seedsToProcess = availableSeeds.slice(0, SCENARIOS_PER_DOMAIN);

    for (const seed of seedsToProcess) {
        try {
            // ── Expand the seed with Groq ──
            let description = seed; // fallback to raw seed if Groq fails
            try {
                description = await callGroq(systemPrompt, seed, 300);
                if (!description || description.length < 30) {
                    description = `${seed}. This automation handles the full flow from trigger to outcome, keeping the business owner informed at each step.`;
                }
            } catch (groqErr) {
                console.warn(`[SCENARIO ENGINE]   Groq expansion failed for "${seed.slice(0, 40)}" — using seed text`);
                description = seed;
            }

            // ── Generate n8n workflow JSON ──
            const workflowJson = generateWorkflowJson(domain, seed, description);
            const slug         = slugify(seed);
            const timestamp    = Date.now();
            const filename     = `${timestamp}-${slug}.json`;

            // ── Save to disk ──
            const domainDir  = path.join(SCENARIOS_DIR, domain.id);
            const outputPath = path.join(domainDir, filename);
            fs.mkdirSync(domainDir, { recursive: true });
            fs.writeFileSync(outputPath, JSON.stringify(workflowJson, null, 2));

            // ── Push to n8n (unless dry-run) ──
            let n8nResult = { skipped: true, reason: 'dry-run mode' };
            if (!dryRun) {
                try {
                    n8nResult = await pushToN8n(workflowJson);
                } catch (n8nErr) {
                    n8nResult = { error: n8nErr.message };
                    console.warn(`[SCENARIO ENGINE]   n8n push failed: ${n8nErr.message}`);
                }
            }

            const meta = {
                domainId:    domain.id,
                domainName:  domain.name,
                seed,
                slug,
                description,
                filename,
                filePath:    outputPath,
                generatedAt: new Date(timestamp).toISOString(),
                n8n:         n8nResult,
            };

            generated.push(meta);

            const n8nStatus = n8nResult.pushed
                ? `→ n8n #${n8nResult.n8nId}`
                : n8nResult.skipped
                    ? `→ disk only (${n8nResult.reason})`
                    : `→ n8n push failed`;

            console.log(`[SCENARIO ENGINE]   Generated: ${domain.name} - ${seed.slice(0, 55)} ${n8nStatus}`);

            // Small delay to avoid Groq rate limit
            await new Promise(r => setTimeout(r, 400));

        } catch (err) {
            console.error(`[SCENARIO ENGINE]   Error processing seed "${seed.slice(0, 40)}": ${err.message}`);
        }
    }

    return generated;
}

// ─── Main Engine ──────────────────────────────────────────────────────────────

async function runScenarioEngine(options = {}) {
    const args    = process.argv.slice(2);
    const dryRun  = args.includes('--dry-run') || options.dryRun || false;
    const onlyId  = args.find(a => a.startsWith('--domain='))?.split('=')[1]
                 || (args.indexOf('--domain') !== -1 ? args[args.indexOf('--domain') + 1] : null)
                 || options.domain
                 || null;

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log(  '║         GRIDHAND N8N SCENARIO ENGINE — STARTING          ║');
    console.log(  '╚═══════════════════════════════════════════════════════════╝');
    console.log(`\n  Mode:     ${dryRun ? 'DRY RUN (no n8n push)' : N8N_API_KEY ? 'LIVE (pushing to n8n)' : 'DISK ONLY (set N8N_API_KEY to push)'}`);
    console.log(`  Domains:  ${onlyId ? onlyId : 'all 15'}`);
    console.log(`  Groq key: ${GROQ_API_KEY ? 'set' : 'MISSING — descriptions will use raw seeds'}`);
    console.log(`  n8n URL:  ${N8N_BASE_URL}`);
    console.log(`  Output:   ${SCENARIOS_DIR}\n`);

    // Ensure scenarios directory exists
    fs.mkdirSync(SCENARIOS_DIR, { recursive: true });

    // Load existing index to skip duplicates
    const index = loadIndex();

    // Run domain agents
    const domainsToRun = onlyId
        ? SCENARIO_DOMAINS.filter(d => d.id === onlyId)
        : SCENARIO_DOMAINS;

    if (onlyId && domainsToRun.length === 0) {
        console.error(`[SCENARIO ENGINE] Unknown domain: "${onlyId}". Valid domains:\n  ${SCENARIO_DOMAINS.map(d => d.id).join('\n  ')}`);
        process.exit(1);
    }

    const allGenerated = [];

    for (const domain of domainsToRun) {
        try {
            const results = await runDomainAgent(domain, index, { dryRun });
            allGenerated.push(...results);
        } catch (err) {
            console.error(`[SCENARIO ENGINE] Domain "${domain.id}" failed: ${err.message}`);
        }
    }

    // ── Update index ──
    index.generated.push(...allGenerated);
    index.lastRun   = new Date().toISOString();
    index.totalCount = index.generated.length;
    saveIndex(index);

    // ── Summary ──
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log(  '║              SCENARIO ENGINE COMPLETE                    ║');
    console.log(  '╚═══════════════════════════════════════════════════════════╝');
    console.log(`\n  Generated this run: ${allGenerated.length} scenarios`);
    console.log(`  Total in index:     ${index.generated.length} scenarios`);
    console.log(`  Index saved:        ${INDEX_FILE}`);

    if (!N8N_API_KEY && !dryRun) {
        console.log(`\n  Ready to deploy to n8n — set N8N_API_KEY env var to push workflows`);
        console.log(`  n8n instance: ${N8N_BASE_URL}`);
    }

    const pushedCount = allGenerated.filter(s => s.n8n?.pushed).length;
    if (pushedCount > 0) {
        console.log(`\n  Pushed to n8n: ${pushedCount} workflows`);
    }

    // Domain breakdown
    if (allGenerated.length > 0) {
        console.log('\n  By domain:');
        const byDomain = {};
        for (const s of allGenerated) {
            byDomain[s.domainName] = (byDomain[s.domainName] || 0) + 1;
        }
        for (const [name, count] of Object.entries(byDomain)) {
            console.log(`    ${name}: ${count} new`);
        }
    }

    console.log('');
    return allGenerated;
}

// ─── Daily 2am Scheduler (used when required from server.js) ─────────────────

function scheduleDailyRun() {
    // Calculate ms until next 2:00 AM local time
    function msUntilNextTwoAM() {
        const now  = new Date();
        const next = new Date(now);
        next.setHours(2, 0, 0, 0);
        if (next <= now) next.setDate(next.getDate() + 1);
        return next - now;
    }

    const msUntil = msUntilNextTwoAM();
    const hours   = Math.floor(msUntil / 3600000);
    const minutes = Math.floor((msUntil % 3600000) / 60000);

    console.log(`[SCENARIO ENGINE] Scheduled — next run in ${hours}h ${minutes}m (daily at 2am)`);

    setTimeout(() => {
        // Run now (it's 2am)
        runScenarioEngine().catch(e =>
            console.error('[SCENARIO ENGINE] Daily run error:', e.message)
        );
        // Then repeat every 24 hours
        setInterval(() => {
            runScenarioEngine().catch(e =>
                console.error('[SCENARIO ENGINE] Daily run error:', e.message)
            );
        }, 24 * 60 * 60 * 1000);
    }, msUntil);
}

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = {
    runScenarioEngine,
    scheduleDailyRun,
    SCENARIO_DOMAINS,
    generateWorkflowJson,
};

// ─── Direct execution ─────────────────────────────────────────────────────────

if (require.main === module) {
    runScenarioEngine().catch(err => {
        console.error('[SCENARIO ENGINE] Fatal error:', err.message);
        process.exit(1);
    });
}
