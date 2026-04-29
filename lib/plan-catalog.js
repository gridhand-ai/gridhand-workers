// lib/plan-catalog.js
// Single source of truth for GRIDHAND plan tiers.
// All specialists/directors that reference billing tier names or costs
// MUST import from this file — never hardcode plan names or rates.

module.exports = {
  PLANS: {
    free:    { name: 'free',    monthlyRate: 0   },
    starter: { name: 'starter', monthlyRate: 197 },
    growth:  { name: 'growth',  monthlyRate: 347 },
    command: { name: 'command', monthlyRate: 497 },
  },
  PLAN_NAMES: ['free', 'starter', 'growth', 'command'],
  getPlanCost: (tier) => module.exports.PLANS[tier]?.monthlyRate ?? 0,
};
