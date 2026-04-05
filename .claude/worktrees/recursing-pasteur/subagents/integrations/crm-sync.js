// CRM Sync — pushes customer data from worker conversations to the client's CRM
// Supports: Go High Level (GHL), HubSpot, Airtable, webhook (generic)
// Config: client.settings.integrations.crm.provider + credentials

async function pushContact(clientSlug, customerNumber, profileData, clientSettings) {
    const integration = clientSettings?.integrations?.crm;
    if (!integration?.provider) return { skipped: true, reason: 'No CRM configured' };

    const contact = {
        phone: customerNumber,
        name: profileData.name || null,
        tags: profileData.tags || [],
        notes: profileData.notes?.map(n => n.note).join('\n') || '',
        lastContact: profileData.lastContact,
        source: 'GRIDHAND SMS Worker',
    };

    try {
        let result;
        switch (integration.provider) {
            case 'gohighlevel': result = await pushToGHL(contact, integration); break;
            case 'hubspot':     result = await pushToHubSpot(contact, integration); break;
            case 'airtable':    result = await pushToAirtable(contact, integration, clientSlug); break;
            case 'webhook':     result = await pushToWebhook(contact, integration); break;
            default: return { error: `Unsupported CRM: ${integration.provider}` };
        }
        console.log(`[CRMSync] Pushed ${customerNumber} to ${integration.provider}`);
        return result;
    } catch (e) {
        console.log(`[CRMSync] Error: ${e.message}`);
        return { error: e.message };
    }
}

async function pushToGHL(contact, integration) {
    const { apiKey, locationId } = integration.credentials;
    const res = await fetch('https://services.leadconnectorhq.com/contacts/', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Version: '2021-07-28',
        },
        body: JSON.stringify({
            phone: contact.phone,
            name: contact.name,
            locationId,
            tags: contact.tags,
            source: contact.source,
        }),
    });
    if (!res.ok) throw new Error(`GHL API: ${res.status} ${await res.text()}`);
    return await res.json();
}

async function pushToHubSpot(contact, integration) {
    const { accessToken } = integration.credentials;
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            properties: {
                phone: contact.phone,
                firstname: contact.name?.split(' ')[0] || '',
                lastname: contact.name?.split(' ').slice(1).join(' ') || '',
                hs_lead_status: 'NEW',
            },
        }),
    });
    if (!res.ok) throw new Error(`HubSpot API: ${res.status}`);
    return await res.json();
}

async function pushToAirtable(contact, integration, clientSlug) {
    const { apiKey, baseId, tableName = 'Contacts' } = integration.credentials;
    const res = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            fields: {
                Phone: contact.phone,
                Name: contact.name || '',
                Tags: contact.tags.join(', '),
                Notes: contact.notes,
                'Last Contact': contact.lastContact,
                Source: contact.source,
                Client: clientSlug,
            },
        }),
    });
    if (!res.ok) throw new Error(`Airtable API: ${res.status}`);
    return await res.json();
}

async function pushToWebhook(contact, integration) {
    const { url, secret } = integration.credentials;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(secret ? { 'X-GRIDHAND-Secret': secret } : {}),
        },
        body: JSON.stringify(contact),
    });
    if (!res.ok) throw new Error(`Webhook: ${res.status}`);
    return { success: true };
}

// Push a conversation event (booking made, payment received, etc.)
async function pushEvent(clientSlug, customerNumber, eventType, eventData, clientSettings) {
    const integration = clientSettings?.integrations?.crm;
    if (!integration?.provider || integration.provider !== 'webhook') return;

    try {
        await pushToWebhook({ customerNumber, eventType, eventData, clientSlug, ts: new Date().toISOString() }, integration);
    } catch (e) {
        console.log(`[CRMSync] Event push error: ${e.message}`);
    }
}

module.exports = { pushContact, pushEvent };
