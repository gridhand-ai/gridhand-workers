// Universal AI Client Factory
// Supports: Anthropic (Claude), Moonshot (Kimi), Ollama (local), OpenAI
// Each client config can bring their own API keys + choose their own model
// Falls back to server env vars if no client key provided

const Anthropic = require('@anthropic-ai/sdk');

// ─── Provider Configs ──────────────────────────────────────────────────────────
const PROVIDER_DEFAULTS = {
    anthropic: {
        baseUrl: 'https://api.anthropic.com',
        defaultModel: 'claude-haiku-4-5-20251001',
    },
    moonshot: {
        baseUrl: 'https://api.moonshot.ai/v1',
        defaultModel: 'kimi-k2.5',
        openaiCompat: true,
    },
    perplexity: {
        baseUrl: 'https://api.perplexity.ai',
        defaultModel: 'llama-3.1-sonar-small-128k-online',
        openaiCompat: true,
    },
    ollama: {
        baseUrl: 'http://localhost:11434/v1',
        defaultModel: 'qwen2.5:7b',
        openaiCompat: true,
        noAuth: true,
    },
    openai: {
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-mini',
        openaiCompat: true,
    },
};

// ─── Parse model string "provider/model-id" ───────────────────────────────────
function parseModel(modelString) {
    if (!modelString) return { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' };
    const slash = modelString.indexOf('/');
    if (slash === -1) return { provider: 'anthropic', modelId: modelString };
    return {
        provider: modelString.slice(0, slash),
        modelId: modelString.slice(slash + 1),
    };
}

// ─── Get API key for a provider ───────────────────────────────────────────────
function getApiKey(provider, clientApiKeys) {
    // Client's own key first, then server env fallback
    const clientKey = clientApiKeys?.[provider];
    if (clientKey) return clientKey;

    const envMap = {
        anthropic:  process.env.ANTHROPIC_API_KEY,
        moonshot:   process.env.MOONSHOT_API_KEY,
        openai:     process.env.OPENAI_API_KEY,
        perplexity: process.env.PERPLEXITY_API_KEY,
        ollama:     null, // no key needed for local
    };
    return envMap[provider] || null;
}

// ─── Anthropic Claude ─────────────────────────────────────────────────────────
async function callAnthropic(modelId, apiKey, systemPrompt, messages, maxTokens) {
    if (!apiKey) throw new Error('Anthropic API key required. Add apiKeys.anthropic to client config.');
    const client = new Anthropic({
        apiKey,
        defaultHeaders: {
            // Token-efficient tool use — reduces token cost when Claude tools are defined
            'anthropic-beta': 'token-efficient-tools-2025-02-19',
        },
    });
    const response = await client.messages.create({
        model: modelId,
        max_tokens: maxTokens,
        // Prompt caching: system prompt is wrapped in an array with cache_control.
        // After the first call, Anthropic caches this block for 5 minutes.
        // Subsequent turns in the same conversation read it from cache at ~10% of input token cost.
        // For a 300-token system prompt across 5 SMS turns: 1500 → ~420 input tokens (72% savings).
        system: [
            {
                type: 'text',
                text: systemPrompt,
                cache_control: { type: 'ephemeral' },
            },
        ],
        messages,
    });
    return response.content[0]?.text?.trim() || '';
}

// ─── Anthropic Batch API ───────────────────────────────────────────────────────
// Use when processing multiple customers simultaneously (cron jobs, bulk outbound AI generation).
// Fire N Claude calls in one request instead of a sequential loop.
// Each item: { customId, systemPrompt, messages, maxTokens? }
// Returns Map<customId, replyString>
async function callAnthropicBatch(modelId, apiKey, requests) {
    if (!apiKey) throw new Error('Anthropic API key required for batch calls.');
    const client = new Anthropic({
        apiKey,
        defaultHeaders: {
            'anthropic-beta': 'token-efficient-tools-2025-02-19,message-batches-2024-09-24',
        },
    });

    const batchRequests = requests.map(({ customId, systemPrompt, messages, maxTokens = 150 }) => ({
        custom_id: customId,
        params: {
            model: modelId,
            max_tokens: maxTokens,
            system: [
                {
                    type: 'text',
                    text: systemPrompt,
                    cache_control: { type: 'ephemeral' },
                },
            ],
            messages,
        },
    }));

    const batch = await client.messages.batches.create({ requests: batchRequests });

    // Poll until the batch completes (max 5 minutes for worker batches)
    let result = batch;
    const deadline = Date.now() + 5 * 60 * 1000;
    while (result.processing_status === 'in_progress' && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000));
        result = await client.messages.batches.retrieve(batch.id);
    }

    if (result.processing_status !== 'ended') {
        throw new Error(`Batch ${batch.id} did not complete within 5 minutes — status: ${result.processing_status}`);
    }

    // Collect results into a Map keyed by customId
    const replies = new Map();
    for await (const item of await client.messages.batches.results(batch.id)) {
        if (item.result.type === 'succeeded') {
            replies.set(item.custom_id, item.result.message.content[0]?.text?.trim() || '');
        } else {
            replies.set(item.custom_id, null); // caller can check for null = failed
        }
    }
    return replies;
}

// ─── OpenAI-compatible (Moonshot, Ollama, OpenAI) ────────────────────────────
async function callOpenAICompat(modelId, apiKey, baseUrl, systemPrompt, messages, maxTokens, noAuth = false) {
    const headers = { 'Content-Type': 'application/json' };
    if (!noAuth) {
        if (!apiKey) throw new Error(`API key required for this model. Add to client config.`);
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const body = {
        model: modelId,
        max_tokens: maxTokens,
        messages: [
            { role: 'system', content: systemPrompt },
            ...messages,
        ],
    };

    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`AI API error (${res.status}): ${err.slice(0, 200)}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
}

// ─── Batch call: process multiple customers in one Anthropic request ───────────
// requests: Array<{ customId, systemPrompt, messages, maxTokens? }>
// Returns: Map<customId, replyString | null>
// Only supports Anthropic — falls through to sequential calls for other providers.
async function callBatch({ modelString, clientApiKeys, requests }) {
    const { provider, modelId } = parseModel(modelString);
    if (provider !== 'anthropic') {
        // Non-Anthropic providers don't support batch — run sequentially
        const replies = new Map();
        for (const req of requests) {
            try {
                const r = await call({ modelString, clientApiKeys, systemPrompt: req.systemPrompt, messages: req.messages, maxTokens: req.maxTokens || 150 });
                replies.set(req.customId, r);
            } catch (_) {
                replies.set(req.customId, null);
            }
        }
        return replies;
    }
    const apiKey = getApiKey('anthropic', clientApiKeys);
    return callAnthropicBatch(modelId, apiKey, requests);
}

// ─── Main: call the right AI based on client model config ─────────────────────
// Auto-fallback: if Anthropic is overloaded/down, switches to OpenAI gpt-4o-mini
async function call({ modelString, clientApiKeys, systemPrompt, messages, maxTokens = 150, _workerName = null }) {
    const { provider, modelId } = parseModel(modelString);
    const providerConfig = PROVIDER_DEFAULTS[provider];

    if (!providerConfig) {
        throw new Error(`Unknown AI provider: "${provider}". Supported: anthropic, moonshot, ollama, openai`);
    }

    const apiKey = getApiKey(provider, clientApiKeys);

    // Custom Ollama URL from client config
    const baseUrl = clientApiKeys?.ollamaBaseUrl || providerConfig.baseUrl;

    try {
        if (provider === 'anthropic') {
            return await callAnthropic(modelId, apiKey, systemPrompt, messages, maxTokens);
        } else if (providerConfig.openaiCompat) {
            return await callOpenAICompat(modelId, apiKey, baseUrl, systemPrompt, messages, maxTokens, providerConfig.noAuth);
        }
        throw new Error(`Provider "${provider}" not implemented`);
    } catch (e) {
        // Auto-fallback: Anthropic overloaded (529) or server error (5xx)
        // Priority: Ollama (local/free) → Moonshot/Kimi (cloud/free) → OpenAI (paid)
        const isAnthropicDown = provider === 'anthropic' && (
            e.message?.includes('529') ||
            e.message?.includes('overloaded') ||
            e.message?.includes('503') ||
            e.message?.includes('500')
        );

        if (isAnthropicDown) {
            const emitFallback = async (label) => {
                try {
                    const events = require('./events');
                    await events.emit('provider_fallback', {
                        workerName: _workerName || 'unknown',
                        provider: label,
                        error: e.message,
                    });
                } catch (_) {}
            };

            // 1. Try Ollama (local, free, no key — works in dev)
            try {
                const ollama = PROVIDER_DEFAULTS.ollama;
                const result = await callOpenAICompat(ollama.defaultModel, null, ollama.baseUrl, systemPrompt, messages, maxTokens, true);
                await emitFallback('ollama/qwen2.5:7b (local)');
                return result;
            } catch (_) {}

            // 2. Try Perplexity (cloud, you already have a key)
            const perplexityKey = getApiKey('perplexity', clientApiKeys);
            if (perplexityKey) {
                try {
                    const px = PROVIDER_DEFAULTS.perplexity;
                    const result = await callOpenAICompat(px.defaultModel, perplexityKey, px.baseUrl, systemPrompt, messages, maxTokens);
                    await emitFallback('perplexity/llama-3.1-sonar-small');
                    return result;
                } catch (_) {}
            }

            // 3. Try Moonshot/Kimi (cloud, free tier — works in production)
            const moonshotKey = getApiKey('moonshot', clientApiKeys);
            if (moonshotKey) {
                try {
                    const moonshot = PROVIDER_DEFAULTS.moonshot;
                    const result = await callOpenAICompat(moonshot.defaultModel, moonshotKey, moonshot.baseUrl, systemPrompt, messages, maxTokens);
                    await emitFallback('moonshot/kimi-k2.5');
                    return result;
                } catch (_) {}
            }

            // 3. Try OpenAI (paid — last resort if key exists)
            const openaiKey = getApiKey('openai', clientApiKeys);
            if (openaiKey) {
                const openai = PROVIDER_DEFAULTS.openai;
                const result = await callOpenAICompat('gpt-4o-mini', openaiKey, openai.baseUrl, systemPrompt, messages, maxTokens);
                await emitFallback('openai/gpt-4o-mini');
                return result;
            }
        }

        throw e;
    }
}

// ─── Get a display-friendly model name for logs ───────────────────────────────
function getModelLabel(modelString) {
    const { provider, modelId } = parseModel(modelString);
    const labels = {
        'claude-haiku-4-5-20251001': 'Claude Haiku (cheap)',
        'claude-sonnet-4-6': 'Claude Sonnet (premium)',
        'kimi-k2.5': 'Kimi K2.5 (free)',
        'qwen2.5:7b': 'Qwen 2.5 7B (local/free)',
        'gpt-4o-mini': 'GPT-4o Mini',
        'llama-3.1-sonar-small-128k-online': 'Perplexity Sonar Small',
        'llama-3.1-sonar-large-128k-online': 'Perplexity Sonar Large',
    };
    return labels[modelId] || `${provider}/${modelId}`;
}

// ─── Validate that a client's AI config is ready to use ───────────────────────
function validate(clientConfig) {
    const { provider } = parseModel(clientConfig.model);
    const apiKey = getApiKey(provider, clientConfig.apiKeys);
    const issues = [];

    if (provider === 'anthropic' && !apiKey) {
        issues.push('Missing Anthropic API key — add apiKeys.anthropic to client config or set ANTHROPIC_API_KEY on server');
    }
    if (provider === 'moonshot' && !apiKey) {
        issues.push('Missing Moonshot API key — add apiKeys.moonshot to client config');
    }
    if (provider === 'openai' && !apiKey) {
        issues.push('Missing OpenAI API key — add apiKeys.openai to client config');
    }
    if (provider === 'perplexity' && !apiKey) {
        issues.push('Missing Perplexity API key — add apiKeys.perplexity to client config or set PERPLEXITY_API_KEY');
    }
    if (!clientConfig.apiKeys?.twilio?.accountSid && !process.env.TWILIO_ACCOUNT_SID) {
        issues.push('Missing Twilio credentials — add apiKeys.twilio to client config or set TWILIO_ACCOUNT_SID on server');
    }

    return { valid: issues.length === 0, issues, model: getModelLabel(clientConfig.model) };
}

module.exports = { call, callBatch, parseModel, getApiKey, getModelLabel, validate };
