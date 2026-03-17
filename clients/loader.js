const fs = require('fs');
const path = require('path');

// Map of Twilio phone numbers to client config files
// Key: Twilio number (e.g. "+14144044418")
// Value: client config filename (e.g. "insurance-center-milwaukee")
const NUMBER_MAP = {
    // Add entries here as you onboard clients
    '+14144044418': 'test-client'
};

function loadClient(twilioNumber) {
    const slug = NUMBER_MAP[twilioNumber];
    if (!slug) return null;

    const filePath = path.join(__dirname, `${slug}.json`);
    if (!fs.existsSync(filePath)) {
        console.log(`[Loader] Config file not found: ${filePath}`);
        return null;
    }

    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.log(`[Loader] Failed to parse config: ${e.message}`);
        return null;
    }
}

module.exports = { loadClient, NUMBER_MAP };
