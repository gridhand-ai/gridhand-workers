'use strict';

/**
 * Coverage Gap Analyzer + Opportunity Scorer
 *
 * Takes a client's policy portfolio and returns:
 *   - gaps[]       — missing coverage lines with severity
 *   - opportunities[] — scored, ranked cross-sell/upsell opportunities
 *   - lifeEvents[]  — detected life events from policy changes
 */

// ---------------------------------------------------------------------------
// Gap detection rules
//
// Each rule describes a gap that exists when:
//   hasPolicies   — the client HAS these lines (pre-conditions)
//   missingLines  — the client is MISSING at least one of these lines
//   conditions    — optional extra checks (functions)
//
// Gaps are detected only when ALL hasPolicies lines are present AND
// ALL missingLines are absent.
// ---------------------------------------------------------------------------

const GAP_RULES = [
    // Auto owners without umbrella — most common upsell
    {
        id:              'missing_umbrella_auto',
        missingLine:     'umbrella',
        hasPolicies:     ['auto'],
        severity:        'high',
        title:           'No Personal Umbrella',
        description:     'Client has auto insurance but no personal umbrella policy — exposed to liability above auto limits.',
        estimatedPremium: 350,
        conversionBase:  70,
    },

    // Homeowners without umbrella
    {
        id:              'missing_umbrella_home',
        missingLine:     'umbrella',
        hasPolicies:     ['home'],
        severity:        'high',
        title:           'No Personal Umbrella',
        description:     'Client has homeowners insurance but no personal umbrella — gap above home liability limits.',
        estimatedPremium: 350,
        conversionBase:  65,
    },

    // Homeowners without flood (especially relevant in flood zones)
    {
        id:              'missing_flood',
        missingLine:     'flood',
        hasPolicies:     ['home'],
        severity:        'medium',
        title:           'No Flood Insurance',
        description:     'Homeowners policy does not cover flood damage — standard HO excludes flood.',
        estimatedPremium: 900,
        conversionBase:  50,
    },

    // Auto + home but no life coverage
    {
        id:              'missing_life',
        missingLine:     'life',
        hasPolicies:     ['auto', 'home'],
        severity:        'high',
        title:           'No Life Insurance',
        description:     'Client has significant property exposure but no life coverage on file.',
        estimatedPremium: 1200,
        conversionBase:  55,
    },

    // Auto only — no homeowners (potential renter or new homebuyer)
    {
        id:              'missing_home_has_auto',
        missingLine:     'home',
        hasPolicies:     ['auto'],
        severity:        'medium',
        title:           'No Home or Renters Policy',
        description:     'Client has auto insurance on file but no home or renters policy — possible bundle opportunity.',
        estimatedPremium: 1400,
        conversionBase:  45,
    },

    // Home without renters (client may have adult children, rental property)
    {
        id:              'no_renters_investment',
        missingLine:     'renters',
        hasPolicies:     ['home'],
        severity:        'low',
        title:           'No Renters Policy (Adult Dependents / Rental Property)',
        description:     'Client owns a home — may have college-age dependents or rental units without renters coverage.',
        estimatedPremium: 200,
        conversionBase:  35,
    },

    // Business owner with no commercial coverage
    {
        id:              'missing_commercial_bop',
        missingLine:     'commercial',
        hasPolicies:     ['commercial_auto'],
        severity:        'high',
        title:           'No Business Owners Policy',
        description:     'Client has commercial auto but no BOP — business property and liability exposed.',
        estimatedPremium: 2500,
        conversionBase:  60,
    },

    // Life insurance clients without disability
    {
        id:              'missing_disability',
        missingLine:     'disability',
        hasPolicies:     ['life'],
        severity:        'medium',
        title:           'No Disability Insurance',
        description:     'Client has life coverage but income is not protected if they become disabled.',
        estimatedPremium: 1800,
        conversionBase:  40,
    },

    // Auto owners with boat or RV — check for separate coverage
    {
        id:              'missing_boat_coverage',
        missingLine:     'boat',
        hasPolicies:     ['auto'],
        severity:        'low',
        title:           'Possible Watercraft Gap',
        description:     'Agency records show no boat policy — if client owns watercraft, it may be uninsured.',
        estimatedPremium: 500,
        conversionBase:  30,
    },

    // Medicare supplement for clients age 65+
    {
        id:              'missing_medicare_supp',
        missingLine:     'medicare_supplement',
        hasPolicies:     [],                    // no pre-condition — age-driven
        severity:        'medium',
        title:           'No Medicare Supplement',
        description:     'Client is age 65+ with no Medicare Supplement policy on file — significant out-of-pocket exposure.',
        estimatedPremium: 2400,
        conversionBase:  55,
        ageMin:          65,
    },

    // Low umbrella limit (has umbrella but coverage_limit < $1M)
    {
        id:              'low_umbrella_limit',
        missingLine:     null,                  // not a missing line — an inadequacy check
        hasPolicies:     ['umbrella'],
        severity:        'medium',
        title:           'Umbrella Limit May Be Too Low',
        description:     'Client has a personal umbrella, but the coverage limit appears below $1,000,000.',
        estimatedPremium: 150,
        conversionBase:  45,
        policyCheck: (policies) => {
            const umbrella = policies.find(p => p.line_of_business === 'umbrella');
            return umbrella && umbrella.coverage_limit < 1_000_000;
        },
    },

    // Cyber liability (clients with commercial lines)
    {
        id:              'missing_cyber',
        missingLine:     'cyber',
        hasPolicies:     ['commercial'],
        severity:        'medium',
        title:           'No Cyber Liability Coverage',
        description:     'Client has commercial coverage but no cyber policy — data breach exposure.',
        estimatedPremium: 1200,
        conversionBase:  40,
    },
];

// ---------------------------------------------------------------------------
// Life event detectors
//
// Run against the delta of NEW/CHANGED policies to surface life triggers.
// ---------------------------------------------------------------------------

const LIFE_EVENT_DETECTORS = [
    {
        eventType: 'new_home',
        trigger:   (newPolicies) => newPolicies.some(p => p.line_of_business === 'home'),
        description: 'New homeowners policy added — possible recent home purchase',
    },
    {
        eventType: 'new_vehicle',
        trigger:   (newPolicies) => newPolicies.some(p => p.line_of_business === 'auto'),
        description: 'New auto policy or endorsement — possible new vehicle purchase',
    },
    {
        eventType: 'new_business',
        trigger:   (newPolicies) => newPolicies.some(p =>
            ['commercial', 'commercial_auto', 'workers_comp'].includes(p.line_of_business)
        ),
        description: 'New commercial policy detected — client may have started a business',
    },
    {
        eventType: 'new_boat_rv',
        trigger:   (newPolicies) => newPolicies.some(p => ['boat', 'rv', 'motorcycle'].includes(p.line_of_business)),
        description: 'New recreational vehicle policy — possible seasonal/lifestyle change',
    },
];

// ---------------------------------------------------------------------------
// Scoring engine
// ---------------------------------------------------------------------------

const SEVERITY_WEIGHTS = { critical: 1.0, high: 0.8, medium: 0.5, low: 0.3 };
const PREMIUM_TIERS    = [500, 1000, 2000, 5000]; // breakpoints for premium scoring 0-100

function scorePremium(amount) {
    if (amount >= PREMIUM_TIERS[3]) return 100;
    if (amount >= PREMIUM_TIERS[2]) return 75;
    if (amount >= PREMIUM_TIERS[1]) return 50;
    if (amount >= PREMIUM_TIERS[0]) return 25;
    return 10;
}

/**
 * Score a single opportunity.
 *
 * composite = 0.4 * conversionScore + 0.4 * revenueScore + 0.2 * severityBoost
 */
function scoreOpportunity(rule, client, policies) {
    const severityBoost  = (SEVERITY_WEIGHTS[rule.severity] || 0.5) * 100;
    const revenueScore   = scorePremium(rule.estimatedPremium);

    // Conversion modifiers
    let conversionScore = rule.conversionBase;

    // Long-tenured clients are more likely to buy additional lines
    if (client.client_since) {
        const yearsAsClient = (Date.now() - new Date(client.client_since)) / (1000 * 60 * 60 * 24 * 365);
        if (yearsAsClient > 5)  conversionScore += 10;
        if (yearsAsClient > 10) conversionScore += 10;
    }

    // Clients with more existing policies are more engaged
    const activePolicies = policies.filter(p => p.status === 'active').length;
    if (activePolicies >= 3) conversionScore += 8;
    if (activePolicies >= 5) conversionScore += 5;

    // Higher existing premium spend = higher willingness / wealth signal
    const totalPremium = policies.reduce((sum, p) => sum + (p.annual_premium || 0), 0);
    if (totalPremium > 5000)  conversionScore += 5;
    if (totalPremium > 15000) conversionScore += 8;

    conversionScore = Math.min(conversionScore, 100);

    const composite = (0.4 * conversionScore) + (0.4 * revenueScore) + (0.2 * severityBoost);

    return {
        conversion_score:  Math.round(conversionScore),
        revenue_score:     Math.round(revenueScore),
        composite_score:   Math.round(composite),
        scoring_factors: {
            severity_boost:    Math.round(severityBoost),
            base_conversion:   rule.conversionBase,
            tenured_bonus:     conversionScore - rule.conversionBase,
            estimated_premium: rule.estimatedPremium,
        },
    };
}

// ---------------------------------------------------------------------------
// Main analyze function
// ---------------------------------------------------------------------------

/**
 * Analyze a single client's coverage portfolio.
 *
 * @param {object} client     — normalized client record
 * @param {Array}  policies   — normalized policy records for this client
 * @param {Array}  newPolicies — policies added/changed since last scan (for life events)
 * @returns {{ gaps, opportunities, lifeEvents }}
 */
function analyzeClient(client, policies, newPolicies = []) {
    const activePolicies = policies.filter(p => p.status === 'active');
    const activeLobs     = new Set(activePolicies.map(p => p.line_of_business));
    const clientAge      = client.date_of_birth
        ? Math.floor((Date.now() - new Date(client.date_of_birth)) / (1000 * 60 * 60 * 24 * 365))
        : null;

    const gaps         = [];
    const opportunities = [];

    for (const rule of GAP_RULES) {
        // Check age gating
        if (rule.ageMin && (clientAge === null || clientAge < rule.ageMin)) continue;

        // Check required existing policies
        if (rule.hasPolicies.length > 0) {
            const hasAll = rule.hasPolicies.every(lob => activeLobs.has(lob));
            if (!hasAll) continue;
        }

        // Check missing line
        if (rule.missingLine && activeLobs.has(rule.missingLine)) continue;

        // Run custom policy check if defined
        if (rule.policyCheck && !rule.policyCheck(activePolicies)) continue;

        // Gap confirmed
        const gap = {
            gap_type:     rule.id,
            description:  rule.description,
            existing_line: rule.hasPolicies[0] || null,
            missing_line:  rule.missingLine || 'upgrade',
            severity:      rule.severity,
        };
        gaps.push(gap);

        // Build scored opportunity
        const scores = scoreOpportunity(rule, client, activePolicies);
        opportunities.push({
            opportunity_type:  rule.missingLine || 'upgrade',
            title:             rule.title,
            estimated_premium: rule.estimatedPremium,
            ...scores,
            _gap_type:         rule.id,   // link back to gap
        });
    }

    // Sort opportunities by composite score descending
    opportunities.sort((a, b) => b.composite_score - a.composite_score);

    // Life events from new/changed policies
    const lifeEvents = [];
    if (newPolicies.length > 0) {
        for (const detector of LIFE_EVENT_DETECTORS) {
            if (detector.trigger(newPolicies)) {
                lifeEvents.push({
                    event_type:       detector.eventType,
                    detected_source:  'ams_new_policy',
                    event_date:       newPolicies[0]?.effective_date || null,
                    details:          { description: detector.description },
                });
            }
        }
    }

    return { gaps, opportunities, lifeEvents };
}

/**
 * Analyze ALL clients in a book and return a flat ranked list of opportunities.
 *
 * @param {Array} clients     — all client records for the agency
 * @param {Array} policies    — all policy records for the agency
 * @param {Array} newPolicies — delta policies (for life event detection)
 * @returns {{ results: [], allOpportunities: [] }}
 */
function analyzeBook(clients, policies, newPolicies = []) {
    // Group policies by ams_client_id
    const policiesByClient = {};
    for (const policy of policies) {
        if (!policiesByClient[policy.ams_client_id]) {
            policiesByClient[policy.ams_client_id] = [];
        }
        policiesByClient[policy.ams_client_id].push(policy);
    }

    const newByClient = {};
    for (const policy of newPolicies) {
        if (!newByClient[policy.ams_client_id]) {
            newByClient[policy.ams_client_id] = [];
        }
        newByClient[policy.ams_client_id].push(policy);
    }

    const results          = [];
    const allOpportunities = [];

    for (const client of clients) {
        const clientPolicies = policiesByClient[client.ams_client_id] || [];
        const clientNew      = newByClient[client.ams_client_id]      || [];

        const { gaps, opportunities, lifeEvents } = analyzeClient(client, clientPolicies, clientNew);

        if (gaps.length > 0) {
            results.push({ client, gaps, opportunities, lifeEvents });
        }

        for (const opp of opportunities) {
            allOpportunities.push({ ...opp, client });
        }
    }

    // Global ranking
    allOpportunities.sort((a, b) => b.composite_score - a.composite_score);

    return { results, allOpportunities };
}

/**
 * Get top N opportunities across the book — used for weekly report.
 */
function getTopOpportunities(allOpportunities, n = 10) {
    return allOpportunities.slice(0, n).map((opp, i) => ({
        rank:             i + 1,
        client_name:      opp.client.full_name,
        ams_client_id:    opp.client.ams_client_id,
        opportunity:      opp.title,
        estimated_premium: opp.estimated_premium,
        composite_score:  opp.composite_score,
        conversion_score: opp.conversion_score,
        revenue_score:    opp.revenue_score,
    }));
}

module.exports = { analyzeClient, analyzeBook, getTopOpportunities, GAP_RULES };
