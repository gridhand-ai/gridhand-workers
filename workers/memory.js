const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_HISTORY = 20;

async function loadHistory(clientSlug, customerNumber) {
    try {
        const { data } = await supabase
            .from('conversation_memory')
            .select('messages')
            .eq('client_slug', clientSlug)
            .eq('customer_phone', customerNumber)
            .maybeSingle();
        return data?.messages || [];
    } catch {
        return [];
    }
}

async function saveMessage(clientSlug, customerNumber, role, content) {
    try {
        const history = await loadHistory(clientSlug, customerNumber);
        const updated = [...history, { role, content, ts: Date.now() }].slice(-MAX_HISTORY);
        await supabase
            .from('conversation_memory')
            .upsert(
                { client_slug: clientSlug, customer_phone: customerNumber, messages: updated },
                { onConflict: 'client_slug,customer_phone' }
            );
    } catch (e) {
        console.log(`[Memory] Failed to save: ${e.message}`);
    }
}

async function clearHistory(clientSlug, customerNumber) {
    try {
        await supabase
            .from('conversation_memory')
            .delete()
            .eq('client_slug', clientSlug)
            .eq('customer_phone', customerNumber);
    } catch (e) {
        console.log(`[Memory] Failed to clear: ${e.message}`);
    }
}

module.exports = { loadHistory, saveMessage, clearHistory };
