const fs = require('fs');
const path = require('path');

// Map of Twilio phone numbers to client config files
// Key: Twilio number (e.g. "+14144044418")
// Value: client config filename (e.g. "test-client")
const NUMBER_MAP = {
    // Add entries here as you onboard clients
    '+14144044418': 'astros-playland'
};

const REGISTRY_PATH = path.join(__dirname, 'registry.json');

// Load the dynamic registry (written by /provision endpoint — no redeploy needed)
function loadRegistry() {
    try {
        if (fs.existsSync(REGISTRY_PATH)) {
            return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
        }
    } catch (e) {
        console.log(`[Loader] Failed to read registry.json: ${e.message}`);
    }
    return {};
}

function resolveSlug(twilioNumber) {
    // Check static map first, then dynamic registry
    if (NUMBER_MAP[twilioNumber]) return NUMBER_MAP[twilioNumber];
    const registry = loadRegistry();
    return registry[twilioNumber] || null;
}

function loadClient(twilioNumber) {
    const slug = resolveSlug(twilioNumber);
    if (!slug) return null;

    const filePath = path.join(__dirname, `${slug}.json`);
    if (!fs.existsSync(filePath)) {
        console.log(`[Loader] Config file not found: ${filePath}`);
        return null;
    }

    try {
        const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        // Inject slug if not present in the file
        if (!config.slug) config.slug = slug;
        return config;
    } catch (e) {
        console.log(`[Loader] Failed to parse config: ${e.message}`);
        return null;
    }
}

function loadClientBySlug(slug) {
    const filePath = path.join(__dirname, `${slug}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
        const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!config.slug) config.slug = slug;
        return config;
    } catch (e) {
        console.log(`[Loader] Failed to parse config: ${e.message}`);
        return null;
    }
}

/**
 * Load client config by Supabase UUID (supabaseClientId field in JSON).
 * Used by integration event dispatcher — Make.com events carry clientId not phone.
 */
function loadClientBySupabaseId(supabaseId) {
    if (!supabaseId) return null;
    try {
        const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.json') && f !== 'registry.json');
        for (const file of files) {
            try {
                const config = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
                if (config.supabaseClientId === supabaseId) {
                    if (!config.slug) config.slug = file.replace('.json', '');
                    return config;
                }
            } catch { /* skip unparseable files */ }
        }
    } catch (e) {
        console.log(`[Loader] loadClientBySupabaseId error: ${e.message}`);
    }
    return null;
}

module.exports = { loadClient, loadClientBySlug, loadClientBySupabaseId, NUMBER_MAP };
