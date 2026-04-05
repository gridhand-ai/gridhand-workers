/**
 * GridHand AI — Proprietary Software
 * Copyright (c) 2026 GridHand AI. All rights reserved.
 *
 * This source code is the confidential and proprietary property of GridHand AI.
 * Unauthorized copying, modification, distribution, or use of this software,
 * via any medium, is strictly prohibited without express written permission.
 *
 * www.gridhand.ai
 */
// Thin wrapper — delegates to lib/twilio-client which handles per-client credentials
const twilioClient = require('../lib/twilio-client');

async function sendSMS({ from, to, body, clientSlug, clientApiKeys }) {
    return twilioClient.sendSMS({ from, to, body, clientSlug, clientApiKeys });
}

module.exports = { sendSMS };
