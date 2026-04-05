/**
 * GRIDHAND Open House Brain — CRM Integration
 *
 * Primary: Follow Up Boss (https://api.followupboss.com/v1)
 * Fallback: Supabase li_leads table (cross-worker query)
 *
 * All public functions return normalized lead/contact objects.
 */

'use strict';

require('dotenv').config();

const axios           = require('axios');
const { createClient } = require('@supabase/supabase-js');
const db              = require('./db');

const FUB_BASE = 'https://api.followupboss.com/v1';

// Shared Supabase for fallback CRM queries
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Core Request Helpers ─────────────────────────────────────────────────────

async function fubRequest(apiKey, method, path, data = null) {
    try {
        const config = {
            method,
            url:  `${FUB_BASE}${path}`,
            auth: { username: apiKey, password: '' },
            headers: { 'Content-Type': 'application/json' },
            timeout: 12000,
        };

        if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
            config.data = data;
        }
        if (data && method === 'GET') {
            config.params = data;
        }

        const resp = await axios(config);
        return { ok: true, data: resp.data, error: null };
    } catch (err) {
        const error = err.response?.data?.errorMessage || err.response?.data?.message || err.message;
        console.error(`[CRM/FUB] ${method} ${path} failed: ${error}`);
        return { ok: false, data: null, error };
    }
}

async function crmRequest(clientSlug, method, path, data = null) {
    const client = await db.getClient(clientSlug);
    if (!client) return { ok: false, data: null, error: `No client: ${clientSlug}` };

    if (client.crm_type === 'followupboss' && client.fub_api_key) {
        return fubRequest(client.fub_api_key, method, path, data);
    }

    // No CRM configured — caller should fall back to Supabase
    return { ok: false, data: null, error: 'no_crm_configured' };
}

// ─── Lead Normalization ───────────────────────────────────────────────────────

function normalizeFubPerson(person) {
    const phones = person.phones || [];
    const emails = person.emails || [];
    const tags   = person.tags || [];

    // Extract area/zip from address
    const address = person.address || {};
    const zip     = address.zip || '';

    // Extract price range from custom fields if present
    const customFields = person.customFields || {};
    const priceMin = parseInt(customFields.priceMin || customFields.price_min || 0);
    const priceMax = parseInt(customFields.priceMax || customFields.price_max || 0);
    const beds     = parseInt(customFields.beds || customFields.bedrooms || 0);

    return {
        id:          String(person.id),
        name:        [person.firstName, person.lastName].filter(Boolean).join(' ').trim() || 'Unknown',
        firstName:   person.firstName || '',
        lastName:    person.lastName  || '',
        phone:       phones[0]?.value || '',
        email:       emails[0]?.value || '',
        zip,
        city:        address.city || '',
        state:       address.state || '',
        score:       person.score || 0,
        stage:       person.stage || '',
        tags,
        priceMin,
        priceMax,
        beds,
        source:      'followupboss',
        raw:         person,
    };
}

function normalizeSupabaseLead(lead) {
    return {
        id:        String(lead.id),
        name:      lead.name || 'Unknown',
        firstName: (lead.name || '').split(' ')[0] || '',
        lastName:  (lead.name || '').split(' ').slice(1).join(' ') || '',
        phone:     lead.phone || '',
        email:     lead.email || '',
        zip:       lead.zip || '',
        city:      lead.city || '',
        state:     lead.state || '',
        score:     lead.score || 0,
        stage:     lead.stage || '',
        tags:      lead.tags || [],
        priceMin:  lead.price_min || 0,
        priceMax:  lead.price_max || 0,
        beds:      lead.bedrooms || 0,
        source:    'supabase',
        raw:       lead,
    };
}

// ─── Lead Queries ─────────────────────────────────────────────────────────────

async function getLeadsInArea(clientSlug, zipCodes = [], radiusMiles = 10) {
    const client = await db.getClient(clientSlug);
    if (!client) return [];

    if (client.crm_type === 'followupboss' && client.fub_api_key) {
        // FUB doesn't have radius search — filter by zip codes
        if (!zipCodes.length) return [];

        const allLeads = [];
        // FUB paginates at 100 per page
        let page = 1;
        while (allLeads.length < 500) { // cap at 500
            const result = await fubRequest(
                client.fub_api_key,
                'GET',
                '/people',
                { limit: 100, offset: (page - 1) * 100 }
            );

            if (!result.ok || !result.data?.people?.length) break;

            const matches = result.data.people.filter(p => {
                const zip = p.address?.zip || '';
                return zipCodes.includes(zip);
            });

            allLeads.push(...matches.map(normalizeFubPerson));
            if (result.data.people.length < 100) break;
            page++;
        }

        return allLeads.slice(0, 100); // max 100 per spec
    }

    // Fallback: Supabase li_leads
    const { data, error } = await supabase
        .from('li_leads')
        .select('*')
        .in('zip', zipCodes)
        .eq('client_slug', clientSlug)
        .limit(100);

    if (error) {
        console.error(`[CRM] Supabase fallback failed: ${error.message}`);
        return [];
    }

    return (data || []).map(normalizeSupabaseLead);
}

async function getHotLeads(clientSlug) {
    const client = await db.getClient(clientSlug);
    if (!client) return [];

    if (client.crm_type === 'followupboss' && client.fub_api_key) {
        const result = await fubRequest(
            client.fub_api_key,
            'GET',
            '/people',
            { limit: 100, sort: '-score' }
        );

        if (!result.ok) return [];

        return (result.data?.people || [])
            .filter(p => (p.score || 0) > 70)
            .map(normalizeFubPerson);
    }

    // Fallback
    const { data, error } = await supabase
        .from('li_leads')
        .select('*')
        .eq('client_slug', clientSlug)
        .gt('score', 70)
        .limit(50);

    if (error) return [];
    return (data || []).map(normalizeSupabaseLead);
}

async function searchByPhone(clientSlug, phone) {
    const client = await db.getClient(clientSlug);
    if (!client) return null;

    // Normalize phone — strip non-digits
    const digits = phone.replace(/\D/g, '');

    if (client.crm_type === 'followupboss' && client.fub_api_key) {
        const result = await fubRequest(
            client.fub_api_key,
            'GET',
            '/people',
            { phoneNumber: digits }
        );

        if (!result.ok) return null;
        const people = result.data?.people || [];
        if (!people.length) return null;
        return normalizeFubPerson(people[0]);
    }

    // Fallback
    const { data, error } = await supabase
        .from('li_leads')
        .select('*')
        .eq('client_slug', clientSlug)
        .ilike('phone', `%${digits.slice(-10)}%`)
        .maybeSingle();

    if (error || !data) return null;
    return normalizeSupabaseLead(data);
}

// ─── Lead Mutations ───────────────────────────────────────────────────────────

async function createContact(clientSlug, visitor) {
    const client = await db.getClient(clientSlug);
    if (!client) return { ok: false, data: null, error: 'No client' };

    if (client.crm_type === 'followupboss' && client.fub_api_key) {
        const nameParts = (visitor.name || '').split(' ');
        const payload = {
            firstName: nameParts[0] || '',
            lastName:  nameParts.slice(1).join(' ') || '',
            phones:    [{ value: visitor.phone, type: 'mobile' }],
            emails:    visitor.email ? [{ value: visitor.email, type: 'personal' }] : [],
            source:    'Open House',
            tags:      ['open-house', 'gridhand'],
        };

        return fubRequest(client.fub_api_key, 'POST', '/people', payload);
    }

    // Fallback: store in li_leads
    const { data, error } = await supabase
        .from('li_leads')
        .insert({
            client_slug: clientSlug,
            name:        visitor.name,
            phone:       visitor.phone,
            email:       visitor.email || null,
            source:      'open-house',
            tags:        ['open-house', 'gridhand'],
        })
        .select()
        .single();

    if (error) return { ok: false, data: null, error: error.message };
    return { ok: true, data, error: null };
}

async function addNote(clientSlug, contactId, note) {
    const client = await db.getClient(clientSlug);
    if (!client) return { ok: false, data: null, error: 'No client' };

    if (client.crm_type === 'followupboss' && client.fub_api_key) {
        return fubRequest(client.fub_api_key, 'POST', '/notes', {
            personId: parseInt(contactId),
            note,
        });
    }

    return { ok: true, data: { note }, error: null };
}

async function createFollowUpTask(clientSlug, contactId, dueDate, note) {
    const client = await db.getClient(clientSlug);
    if (!client) return { ok: false, data: null, error: 'No client' };

    if (client.crm_type === 'followupboss' && client.fub_api_key) {
        return fubRequest(client.fub_api_key, 'POST', '/tasks', {
            personId:    parseInt(contactId),
            type:        'Phone',
            dueDate,
            description: note,
        });
    }

    return { ok: true, data: { contactId, dueDate, note }, error: null };
}

async function updateLeadStatus(clientSlug, contactId, status) {
    const client = await db.getClient(clientSlug);
    if (!client) return { ok: false, data: null, error: 'No client' };

    if (client.crm_type === 'followupboss' && client.fub_api_key) {
        return fubRequest(
            client.fub_api_key,
            'PUT',
            `/people/${contactId}`,
            { stage: status }
        );
    }

    // Fallback: update li_leads
    const { error } = await supabase
        .from('li_leads')
        .update({ stage: status })
        .eq('id', contactId)
        .eq('client_slug', clientSlug);

    if (error) return { ok: false, data: null, error: error.message };
    return { ok: true, data: { contactId, status }, error: null };
}

module.exports = {
    crmRequest,
    getLeadsInArea,
    getHotLeads,
    searchByPhone,
    createContact,
    addNote,
    createFollowUpTask,
    updateLeadStatus,
};
