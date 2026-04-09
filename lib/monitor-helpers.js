// ─── Monitor helpers ──────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');

const CLIENTS_DIR = path.join(__dirname, '../clients');

function getAllClientSlugs() {
    try {
        return fs.readdirSync(CLIENTS_DIR)
            .filter(f => f.endsWith('.json') && !f.startsWith('_') && f !== 'registry.json')
            .map(f => f.replace('.json', ''));
    } catch {
        return [];
    }
}

module.exports = { getAllClientSlugs };
