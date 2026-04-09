// ─── Proactive Monitor — clawhip-style event router for Telegram ──────────────
// Sends MJ a daily summary + proactive alerts without him having to ask.
//
// Daily summary (runs at 8am CT via Railway cron or manual trigger):
//   - Tasks run per client today
//   - Clients approaching their limit (>80%)
//   - Any workers that failed
//   - Provider fallbacks that occurred
//
// Triggered alerts (called from events.js automatically):
//   - Client hits task limit
//   - Worker fails after all retries
//   - Anthropic fallback to OpenAI
//
// Usage:
//   node lib/monitor.js daily      — send daily summary to Telegram
//   node lib/monitor.js health     — quick health ping

const fs   = require('fs');
const path = require('path');

const { sendTelegramAlert }  = require('./events');
const taskCounter            = require('./task-counter');
const { getAllClientSlugs }  = require('./monitor-helpers');

// ─── Build daily summary ──────────────────────────────────────────────────────
async function buildDailySummary() {
    const slugs = getAllClientSlugs();
    const month = taskCounter.getBillingMonth();

    const lines = [
        `*GRIDHAND Daily Summary* 📊`,
        `_${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}_`,
        '',
    ];

    let totalTasks = 0;
    const atRisk = [];   // >80% of limit
    const paused = [];   // at or over limit

    for (const slug of slugs) {
        const memDir   = path.join(__dirname, '../memory', slug);
        const countFile = path.join(memDir, `tasks_${month}.json`);

        let count = 0;
        let limit = 100;
        let tier  = 'free';

        try {
            const { loadClientBySlug } = require('../clients/loader');
            const client = loadClientBySlug(slug);
            if (!client) continue;

            count = taskCounter.getCount(slug);
            const tl  = taskCounter.getTierLimit(client);
            limit = tl.limit;
            tier  = tl.tier;
            totalTasks += count;

            const pct = limit === Infinity ? 0 : Math.round((count / limit) * 100);

            if (limit !== Infinity && count >= limit) {
                paused.push({ slug, count, limit, tier });
            } else if (limit !== Infinity && pct >= 80) {
                atRisk.push({ slug, count, limit, tier, pct });
            }

            const bar  = limit === Infinity ? '∞' : `${count}/${limit}`;
            const flag  = limit !== Infinity && pct >= 80 ? ' ⚠️' : '';
            lines.push(`• \`${slug}\` — ${bar} tasks (${tier})${flag}`);
        } catch {
            continue;
        }
    }

    if (slugs.length === 0) {
        lines.push('_No clients configured yet._');
    }

    lines.push('', `*Total tasks today: ${totalTasks}*`);

    // Alerts section
    if (paused.length > 0) {
        lines.push('', `🔒 *At limit (upgrade needed):*`);
        paused.forEach(c => lines.push(`  • \`${c.slug}\` — ${c.count}/${c.limit} (${c.tier})`));
    }

    if (atRisk.length > 0) {
        lines.push('', `⚠️ *Approaching limit (>80%):*`);
        atRisk.forEach(c => lines.push(`  • \`${c.slug}\` — ${c.pct}% used (${c.count}/${c.limit})`));
    }

    // Check event log for overnight failures
    const eventLog = path.join(process.env.HOME || '/root', '.claude/events.log');
    let failures = 0;
    let fallbacks = 0;

    if (fs.existsSync(eventLog)) {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const events = fs.readFileSync(eventLog, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(e => e && e.timestamp > yesterday);

        failures  = events.filter(e => e.type === 'task_escalated').length;
        fallbacks = events.filter(e => e.type === 'provider_fallback').length;
    }

    if (failures > 0)  lines.push('', `❌ Worker failures in last 24h: ${failures}`);
    if (fallbacks > 0) lines.push(`⇄ Provider fallbacks (Anthropic → OpenAI): ${fallbacks}`);

    return lines.join('\n');
}

// ─── Quick health ping ────────────────────────────────────────────────────────
async function healthPing() {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const checks = [];

    // Supabase
    try {
        const { error } = await supabase.from('clients').select('count').limit(1);
        checks.push(error ? '❌ Supabase' : '✅ Supabase');
    } catch {
        checks.push('❌ Supabase');
    }

    // Anthropic
    try {
        const res = await fetch('https://api.anthropic.com/v1/models', {
            headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        });
        checks.push(res.ok ? '✅ Anthropic API' : `❌ Anthropic API (${res.status})`);
    } catch {
        checks.push('❌ Anthropic API');
    }

    // Twilio
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const tok = process.env.TWILIO_AUTH_TOKEN;
    if (sid && tok) {
        try {
            const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
                headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64') },
            });
            checks.push(res.ok ? '✅ Twilio' : `❌ Twilio (${res.status})`);
        } catch {
            checks.push('❌ Twilio');
        }
    } else {
        checks.push('⚠️ Twilio (no env keys)');
    }

    const allGood = checks.every(c => c.startsWith('✅'));
    const msg = [
        `*GRIDHAND Health Check* ${allGood ? '💚' : '🔴'}`,
        ...checks,
        `_${new Date().toISOString()}_`,
    ].join('\n');

    await sendTelegramAlert(msg);
    console.log(msg.replace(/[*_`]/g, ''));
}

// ─── CLI entry ────────────────────────────────────────────────────────────────
async function main() {
    const cmd = process.argv[2] || 'daily';

    if (cmd === 'health') {
        await healthPing();
    } else {
        const summary = await buildDailySummary();
        await sendTelegramAlert(summary);
        console.log(summary.replace(/[*_`]/g, ''));
    }
}

main().catch(e => {
    console.error('Monitor failed:', e.message);
    process.exit(1);
});
