const fs = require('fs');
const path = require('path');

const MEMORY_DIR = path.join(__dirname, '../memory');
const MAX_HISTORY = 20;

function getMemoryPath(clientSlug, customerNumber) {
    const dir = path.join(MEMORY_DIR, clientSlug);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const safe = customerNumber.replace(/[^a-zA-Z0-9]/g, '');
    return path.join(dir, `${safe}.json`);
}

function loadHistory(clientSlug, customerNumber) {
    try {
        const filePath = getMemoryPath(clientSlug, customerNumber);
        if (!fs.existsSync(filePath)) return [];
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return [];
    }
}

function saveMessage(clientSlug, customerNumber, role, content) {
    try {
        const filePath = getMemoryPath(clientSlug, customerNumber);
        const history = loadHistory(clientSlug, customerNumber);
        history.push({ role, content, ts: Date.now() });
        fs.writeFileSync(filePath, JSON.stringify(history.slice(-MAX_HISTORY), null, 2));
    } catch (e) {
        console.log(`[Memory] Failed to save: ${e.message}`);
    }
}

function clearHistory(clientSlug, customerNumber) {
    try {
        const filePath = getMemoryPath(clientSlug, customerNumber);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
        console.log(`[Memory] Failed to clear: ${e.message}`);
    }
}

module.exports = { loadHistory, saveMessage, clearHistory };
