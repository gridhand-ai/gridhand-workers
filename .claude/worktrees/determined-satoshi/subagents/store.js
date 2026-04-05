// Shared data storage utility for all subagents
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

function getPath(...parts) {
    const dir = path.join(DATA_DIR, ...parts.slice(0, -1));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(DATA_DIR, ...parts);
}

function read(filePath, defaultVal = null) {
    try {
        if (!fs.existsSync(filePath)) return defaultVal;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return defaultVal;
    }
}

function write(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch (e) {
        console.log(`[Store] Write failed: ${e.message}`);
        return false;
    }
}

function readJson(namespace, key) {
    const safe = (key || '').replace(/[^a-zA-Z0-9_-]/g, '');
    return read(getPath(namespace, `${safe}.json`));
}

function writeJson(namespace, key, data) {
    const safe = (key || '').replace(/[^a-zA-Z0-9_-]/g, '');
    return write(getPath(namespace, `${safe}.json`), data);
}

function readGlobal(namespace, filename) {
    return read(getPath(namespace, filename));
}

function writeGlobal(namespace, filename, data) {
    return write(getPath(namespace, filename), data);
}

// Append to a list stored in a file (capped at maxItems)
function appendToList(namespace, filename, item, maxItems = 1000) {
    const filePath = getPath(namespace, filename);
    const list = read(filePath, []);
    list.push(item);
    write(filePath, list.slice(-maxItems));
}

module.exports = { readJson, writeJson, readGlobal, writeGlobal, appendToList, getPath };
