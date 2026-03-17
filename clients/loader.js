const fs = require('fs');
const path = require('path');

// Map of Twilio phone numbers to client config files
// Key: Twilio number (e.g. "+14144044418")
// Value: client config filename (e.g. "test-client")
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
        const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        // Inject slug if not present in the file
        if (!config.slug) config.slug = slug;
        return config;
    } catch (e) {
        console.log(`[Loader] Failed to parse config: ${e.message}`);
        return null;
    }
}

module.exports = { loadClient, NUMBER_MAP };
