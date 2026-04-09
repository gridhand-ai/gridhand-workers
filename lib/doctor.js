// ─── GRIDHAND Doctor — pre-flight health check for client configs ─────────────
// Run before going live with any client. Checks:
//   ✓ Client config is valid JSON with required fields
//   ✓ Billing tier is set
//   ✓ AI provider key is present and reachable
//   ✓ Twilio credentials are present
//   ✓ Supabase is reachable
//   ✓ Assigned workers all exist as files
//   ✓ Memory directory is writable
//
// Usage:
//   node lib/doctor.js                    — check all clients
//   node lib/doctor.js test-client        — check one client by slug
//   node lib/doctor.js --json             — machine-readable output

const fs    = require('fs');
const path  = require('path');

const { loadClientBySlug } = require('../clients/loader');
const aiClient   = require('./ai-client');
const taskCounter = require('./task-counter');

const CLIENTS_DIR = path.join(__dirname, '../clients');
const WORKERS_DIR = path.join(__dirname, '../workers');
const MEMORY_DIR  = path.join(__dirname, '../memory');

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';

function pass(msg)  { return `${GREEN}✓${RESET} ${msg}`; }
function fail(msg)  { return `${RED}✗${RESET} ${msg}`; }
function warn(msg)  { return `${YELLOW}⚠${RESET} ${msg}`; }

// ─── Check single client ──────────────────────────────────────────────────────
async function checkClient(slug) {
    const results = { slug, passed: [], failed: [], warnings: [], ok: true };

    const client = loadClientBySlug(slug);
    if (!client) {
        results.failed.push('Config file not found or invalid JSON');
        results.ok = false;
        return results;
    }

    // ── Required fields ───────────────────────────────────────────────────────
    const required = ['slug', 'twilioNumber', 'model', 'business', 'workers'];
    for (const field of required) {
        if (client[field]) {
            results.passed.push(`Field "${field}" present`);
        } else {
            results.failed.push(`Missing required field: "${field}"`);
            results.ok = false;
        }
    }

    // ── Billing tier ──────────────────────────────────────────────────────────
    const tier = client?.billing?.tier;
    if (tier && ['free', 'starter', 'growth', 'command'].includes(tier)) {
        const { limit } = taskCounter.getTierLimit(client);
        const count = taskCounter.getCount(slug);
        results.passed.push(`Billing tier: ${tier} (${count}/${limit === Infinity ? '∞' : limit} tasks used this month)`);
    } else {
        results.warnings.push('billing.tier not set — defaulting to free (100 tasks/month)');
    }

    // ── Workers exist ─────────────────────────────────────────────────────────
    const assignedWorkers = client.workers || [];
    for (const w of assignedWorkers) {
        const workerPath = path.join(WORKERS_DIR, `${w}.js`);
        if (fs.existsSync(workerPath)) {
            results.passed.push(`Worker "${w}" file exists`);
        } else {
            results.failed.push(`Worker "${w}" not found at workers/${w}.js`);
            results.ok = false;
        }
    }

    if (assignedWorkers.length === 0) {
        results.warnings.push('No workers assigned — client will not respond to messages');
    }

    // ── AI provider reachable ─────────────────────────────────────────────────
    try {
        const validation = aiClient.validate(client);
        if (validation.valid) {
            results.passed.push(`AI provider ready: ${validation.model}`);
        } else {
            for (const issue of validation.issues) {
                results.failed.push(issue);
                results.ok = false;
            }
        }
    } catch (e) {
        results.failed.push(`AI config error: ${e.message}`);
        results.ok = false;
    }

    // ── Twilio number format ──────────────────────────────────────────────────
    const twilio = client.twilioNumber;
    if (/^\+1\d{10}$/.test(twilio)) {
        results.passed.push(`Twilio number valid: ${twilio}`);
    } else if (twilio && twilio !== '+1XXXXXXXXXX') {
        results.warnings.push(`Twilio number format looks off: ${twilio}`);
    } else {
        results.failed.push('Twilio number is placeholder — replace with real number');
        results.ok = false;
    }

    // ── Memory dir writable ───────────────────────────────────────────────────
    try {
        const dir = path.join(MEMORY_DIR, slug);
        fs.mkdirSync(dir, { recursive: true });
        const testFile = path.join(dir, '.write-test');
        fs.writeFileSync(testFile, 'ok');
        fs.unlinkSync(testFile);
        results.passed.push('Memory directory writable');
    } catch (e) {
        results.failed.push(`Memory directory not writable: ${e.message}`);
        results.ok = false;
    }

    // ── Business info complete ────────────────────────────────────────────────
    const biz = client.business || {};
    const bizFields = ['name', 'hours', 'phone'];
    for (const f of bizFields) {
        if (biz[f]) {
            results.passed.push(`Business.${f}: "${biz[f]}"`);
        } else {
            results.warnings.push(`business.${f} not set — workers may give incomplete answers`);
        }
    }

    return results;
}

// ─── Check Supabase reachability ──────────────────────────────────────────────
async function checkSupabase() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) return { ok: false, msg: 'SUPABASE_URL or SERVICE_ROLE_KEY not set' };

    try {
        const res = await fetch(`${url}/rest/v1/clients?select=count&limit=1`, {
            headers: {
                apikey: key,
                Authorization: `Bearer ${key}`,
            },
        });
        if (res.ok) return { ok: true, msg: 'Supabase reachable' };
        return { ok: false, msg: `Supabase returned ${res.status}` };
    } catch (e) {
        return { ok: false, msg: `Supabase unreachable: ${e.message}` };
    }
}

// ─── Print results for one client ────────────────────────────────────────────
function printClientResults(results) {
    const status = results.ok ? `${GREEN}${BOLD}PASS${RESET}` : `${RED}${BOLD}FAIL${RESET}`;
    console.log(`\n${BOLD}── ${results.slug} ──────────────────────────${RESET} ${status}`);
    results.passed.forEach(m => console.log(`  ${pass(m)}`));
    results.warnings.forEach(m => console.log(`  ${warn(m)}`));
    results.failed.forEach(m => console.log(`  ${fail(m)}`));
}

// ─── Get all client slugs ─────────────────────────────────────────────────────
function getAllSlugs() {
    return fs.readdirSync(CLIENTS_DIR)
        .filter(f => f.endsWith('.json') && !f.startsWith('_') && f !== 'registry.json')
        .map(f => f.replace('.json', ''));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const args     = process.argv.slice(2);
    const jsonMode = args.includes('--json');
    const target   = args.find(a => !a.startsWith('--'));

    console.log(`${BOLD}GRIDHAND Doctor${RESET} — pre-flight health check`);
    console.log(`${'─'.repeat(50)}`);

    // Supabase check
    const sbCheck = await checkSupabase();
    if (!jsonMode) {
        console.log(sbCheck.ok ? `\n${pass('Supabase: ' + sbCheck.msg)}` : `\n${fail('Supabase: ' + sbCheck.msg)}`);
    }

    // Client checks
    const slugs = target ? [target] : getAllSlugs();
    const allResults = [];

    for (const slug of slugs) {
        const results = await checkClient(slug);
        allResults.push(results);
        if (!jsonMode) printClientResults(results);
    }

    if (jsonMode) {
        console.log(JSON.stringify({ supabase: sbCheck, clients: allResults }, null, 2));
        return;
    }

    // Summary
    const passed = allResults.filter(r => r.ok).length;
    const failed = allResults.filter(r => !r.ok).length;
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`${BOLD}Summary:${RESET} ${GREEN}${passed} passed${RESET}  ${failed > 0 ? RED : ''}${failed} failed${RESET}`);
    if (failed > 0) {
        console.log(`\n${RED}Fix the issues above before going live.${RESET}`);
        process.exit(1);
    } else {
        console.log(`\n${GREEN}All clients healthy. Ready to go live.${RESET}`);
    }
}

main().catch(e => {
    console.error('Doctor failed:', e.message);
    process.exit(1);
});
