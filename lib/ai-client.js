// Universal AI Client Factory
// Supports: Anthropic (Claude), Moonshot (Kimi), Ollama (local), OpenAI, Gemini, Perplexity
//
// ─── Available Ollama Models (local, free) ────────────────────────────────────
//   ollama/deepseek-r1:7b     → math, financial reasoning, ROI calculations
//   ollama/llava:7b           → vision, screenshot analysis
//   ollama/mistral:7b         → report writing, summaries
//   ollama/gemma4:e2b         → fast classification tasks
//   ollama/nomic-embed-text   → embeddings (use with lib/embeddings.js)
//   ollama/qwen3:8b           → default general purpose
// ─── Fast Classification (free) ──────────────────────────────────────────────
//   groq/llama-3.1-8b-instant → binary classification, approval queue (800 tokens/sec)
// Each client config can bring their own API keys + choose their own model
// Falls back to server env vars if no client key provided
//
// SECTOR RESTRICTION: Never generate content for healthcare, dental, medical,
// or HIPAA-regulated industries. GRIDHAND serves SMB verticals only.
//
// LOCAL-FIRST MODE (OLLAMA_FIRST=true):
// When enabled, every AI call tries Ollama first (free, local).
// Only falls back to Claude Haiku if Ollama is unreachable or returns a
// low-quality response. Expected savings: ~80% of Haiku spend per SMS.

const Anthropic    = require('@anthropic-ai/sdk');
const tokenTracker = require('./token-tracker');

// ─── Provider Configs ──────────────────────────────────────────────────────────
// OLLAMA_BASE_URL env var overrides the default Ollama endpoint.
// In production (Railway): set to the Cloudflare tunnel URL, e.g.:
//   OLLAMA_BASE_URL=https://stamp-successful-lending-seven.trycloudflare.com/v1
const _ollamaBase = process.env.OLLAMA_BASE_URL || process.env.OLLAMA_URL
    ? `${(process.env.OLLAMA_BASE_URL || process.env.OLLAMA_URL).replace(/\/v1\/?$/, '')}/v1`
    : 'http://localhost:11434/v1';

const PROVIDER_DEFAULTS = {
    anthropic: {
        baseUrl: 'https://api.anthropic.com',
        defaultModel: 'groq/llama-3.3-70b-versatile',
    },
    groq: {
        baseUrl: 'https://api.groq.com/openai/v1',
        defaultModel: 'llama-3.3-70b-versatile',
        openaiCompat: true,
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
        baseUrl: _ollamaBase,
        defaultModel: 'qwen3:8b',   // upgraded from qwen2.5:7b
        openaiCompat: true,
        noAuth: true,
    },
    openai: {
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-5.5',
        openaiCompat: true,
    },
    gemini: {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        defaultModel: 'gemini-2.5-flash',
        openaiCompat: true,
    },
    deepseek: {
        baseUrl: 'https://api.deepseek.com/v1',
        defaultModel: 'deepseek-v4-pro', // deepseek-chat aliases to flash but retires 2026-07-24
        openaiCompat: true,
    },
};

// ─── Quality gate for local model responses ───────────────────────────────────
// Returns true if the response is usable. Rejects garbage outputs that small
// models sometimes produce when they misfire on structured prompts.
function isQualityResponse(text) {
    if (!text || text.length < 20) return false;
    const t = text.trim();
    // Reject raw JSON bleedthrough or bare null/undefined/NaN literals
    if (/^[\{\[\]]/.test(t) || /^(null|undefined|NaN)$/i.test(t)) return false;
    // Reject explicit confusion / inability patterns at the start of response
    if (/^(error:|i (can't|cannot|am unable|don't know)|sorry,? i|i'm not able|i do not)/i.test(t)) return false;
    // Reject suspiciously short non-sentences (likely truncated/garbled)
    if (t.length < 30 && !/[.!?]/.test(t)) return false;
    return true;
}

// ─── Parse model string "provider/model-id" ───────────────────────────────────
function parseModel(modelString) {
    if (!modelString) return { provider: 'groq', modelId: 'llama-3.3-70b-versatile' };
    const slash = modelString.indexOf('/');
    // Bare model name with no slash = treat as Groq. Explicit 'anthropic/...' required to hit Anthropic API.
    if (slash === -1) return { provider: 'groq', modelId: modelString };
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
        groq:       process.env.GROQ_API_KEY,
        moonshot:   process.env.MOONSHOT_API_KEY,
        openai:     process.env.OPENAI_API_KEY,
        perplexity: process.env.PERPLEXITY_API_KEY,
        gemini:     process.env.GEMINI_API_KEY,
        deepseek:   process.env.DEEPSEEK_API_KEY,
        ollama:     null, // no key needed for local
    };
    return envMap[provider] || null;
}

// ─── Anthropic Claude ─────────────────────────────────────────────────────────
async function callAnthropic(modelId, apiKey, systemPrompt, messages, maxTokens, _tag = 'anthropic') {
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
    // Report token usage — commander/directors are the main Anthropic callers
    if (response.usage) {
        tokenTracker.logUsage('anthropic', _tag, response.usage.input_tokens || 0, response.usage.output_tokens || 0);
    }
    return response.content[0]?.text?.trim() || '';
}

// ─── Anthropic Batch API ───────────────────────────────────────────────────────
// Use when processing multiple customers simultaneously (cron jobs, bulk outbound AI generation).
// Fire N Claude calls in one request instead of a sequential loop.
// Each item: { customId, systemPrompt, messages, maxTokens? }
// Returns Map<customId, replyString>
async function callAnthropicBatch(modelId, apiKey, requests, _workerName = null) {
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
    let batchInputTokens = 0;
    let batchOutputTokens = 0;
    for await (const item of await client.messages.batches.results(batch.id)) {
        if (item.result.type === 'succeeded') {
            replies.set(item.custom_id, item.result.message.content[0]?.text?.trim() || '');
            try {
                batchInputTokens  += item?.result?.message?.usage?.input_tokens  || 0;
                batchOutputTokens += item?.result?.message?.usage?.output_tokens || 0;
            } catch (_) {}
        } else {
            replies.set(item.custom_id, null); // caller can check for null = failed
        }
    }
    // Log aggregated batch token usage once — mirrors callAnthropic() line 126
    try {
        const _tag = _workerName || `anthropic/${modelId}`;
        tokenTracker.logUsage('anthropic', _tag, batchInputTokens, batchOutputTokens);
    } catch (_) {}
    return replies;
}

// ─── OpenAI-compatible (Moonshot, Ollama, OpenAI) ────────────────────────────
async function callOpenAICompat(modelId, apiKey, baseUrl, systemPrompt, messages, maxTokens, noAuth = false, _tag = 'openai-compat') {
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

    // Retry up to 4 times on 429 (rate limit) with exponential backoff + jitter.
    // Groq free tier = 6k TPM — our parallel director/specialist dispatches can spike this.
    const MAX_RETRIES = 4;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        // 12s timeout — prevents hung requests when Ollama is loading a cold model
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);

        let res;
        try {
            res = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }

        if (res.status === 429) {
            if (attempt === MAX_RETRIES) {
                const err = await res.text();
                throw new Error(`AI API rate limit (429) after ${MAX_RETRIES} retries: ${err.slice(0, 200)}`);
            }
            // Respect Retry-After header if present, otherwise exponential backoff with jitter
            const retryAfter = res.headers.get('retry-after');
            const waitMs = retryAfter
                ? Math.min(parseInt(retryAfter, 10) * 1000, 30000)
                : Math.min(1000 * 2 ** attempt + Math.random() * 500, 20000);
            console.warn(`[ai-client] 429 rate limit — waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${MAX_RETRIES}`);
            await new Promise(r => setTimeout(r, waitMs));
            continue;
        }

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`AI API error (${res.status}): ${err.slice(0, 200)}`);
        }

        const data = await res.json();
        const raw = data.choices?.[0]?.message?.content?.trim() || '';

        // Report token usage to tracker — detect provider by baseUrl
        if (data.usage) {
            const provider = baseUrl?.includes('groq.com') ? 'groq'
                           : baseUrl?.includes('localhost') || baseUrl?.includes('trycloudflare') ? 'ollama'
                           : baseUrl?.includes('moonshot') ? 'moonshot'
                           : baseUrl?.includes('perplexity') ? 'perplexity'
                           : baseUrl?.includes('openai.com') ? 'openai'
                           : 'groq'; // default non-Anthropic to groq for cost tracking
            tokenTracker.logUsage(provider, _tag, data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0);
        }

        // Strip <think>...</think> reasoning blocks emitted by Qwen3 and similar models.
        // These must never reach customer SMS — strip before returning.
        return raw
            .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
            .replace(/<think>[\s\S]*$/gi, '') // unclosed think tag fallback
            .trim() || raw; // fall back to raw if stripping emptied the string
    }
}

// ─── Batch call: process multiple customers in one Anthropic request ───────────
// requests: Array<{ customId, systemPrompt, messages, maxTokens? }>
// Returns: Map<customId, replyString | null>
// Only supports Anthropic — falls through to sequential calls for other providers.
async function callBatch({ modelString, clientApiKeys, requests, _workerName = null }) {
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
    return callAnthropicBatch(modelId, apiKey, requests, _workerName);
}

// ─── Main: call the right AI based on client model config ─────────────────────
// Routing priority when OLLAMA_FIRST=true (local-first mode):
//   1. Ollama/qwen3:8b (free, local) — used if reachable + quality check passes
//   2. Original model (Anthropic Haiku by default) — fallback only
//
// Standard routing (OLLAMA_FIRST not set):
//   1. Configured provider (usually Anthropic)
//   2. Auto-fallback chain: Ollama → Perplexity → Moonshot → OpenAI (on 5xx only)
//
// Tier-based routing (tier param overrides all other routing):
//   tier='director'          → always claude-opus-4-7 (Anthropic), bypasses OLLAMA_FIRST
//   tier='specialist'        → always groq/llama-3.3-70b-versatile, no Anthropic fallback
//   tier='quality_escalate'  → run Groq first; escalate to claude-sonnet-4-6 if quality fails
//   tier=undefined           → standard routing (existing behavior)
async function call({ modelString, clientApiKeys, systemPrompt, messages, maxTokens = 150, _workerName = null, tier = undefined }) {
    // ── TIER-BASED ROUTING (overrides modelString and OLLAMA_FIRST) ──────────
    if (tier === 'director') {
        // Directors use DeepSeek V4 Pro — best reasoning, 1M context, active promo until 2026-05-05
        const dsConfig = PROVIDER_DEFAULTS.deepseek;
        const apiKey = getApiKey('deepseek', clientApiKeys);
        const _tag = _workerName ? `${_workerName}/tier-director` : 'tier-director/deepseek-v4-pro';
        return callOpenAICompat('deepseek-v4-pro', apiKey, dsConfig.baseUrl, systemPrompt, messages, maxTokens, false, _tag);
    }

    if (tier === 'specialist') {
        // Specialists use DeepSeek V4 Flash — better quality than Groq, cheaper, 1M context
        const dsConfig = PROVIDER_DEFAULTS.deepseek;
        const apiKey = getApiKey('deepseek', clientApiKeys);
        const _tag = _workerName ? `${_workerName}/tier-specialist` : 'tier-specialist/deepseek-v4-flash';
        return callOpenAICompat('deepseek-v4-flash', apiKey, dsConfig.baseUrl, systemPrompt, messages, maxTokens, false, _tag);
    }

    if (tier === 'quality_escalate') {
        // Run Groq first (fast/free); if quality fails escalate to DeepSeek V4 Pro
        const groqConfig = PROVIDER_DEFAULTS.groq;
        const groqKey = getApiKey('groq', clientApiKeys);
        const _tag = _workerName ? `${_workerName}/tier-quality` : 'tier-quality/groq';
        try {
            const groqResult = await callOpenAICompat(
                'llama-3.3-70b-versatile', groqKey, groqConfig.baseUrl,
                systemPrompt, messages, maxTokens, false, _tag
            );
            if (isQualityResponse(groqResult)) {
                return groqResult;
            }
            console.warn(`[ai-client] quality_escalate: Groq quality check failed for ${_workerName || 'worker'} — escalating to DeepSeek V4 Pro`);
        } catch (groqErr) {
            console.warn(`[ai-client] quality_escalate: Groq failed (${groqErr.message?.slice(0, 60)}) — escalating to DeepSeek V4 Pro`);
        }
        // Escalate to DeepSeek V4 Pro on quality failure
        const dsConfig = PROVIDER_DEFAULTS.deepseek;
        const dsKey = getApiKey('deepseek', clientApiKeys);
        const retryTag = _workerName ? `${_workerName}/tier-quality-v4pro` : 'tier-quality-v4pro/deepseek';
        return callOpenAICompat('deepseek-v4-pro', dsKey, dsConfig.baseUrl, systemPrompt, messages, maxTokens, false, retryTag);
    }
    // ── END TIER-BASED ROUTING ────────────────────────────────────────────────

    const { provider, modelId } = parseModel(modelString);
    const providerConfig = PROVIDER_DEFAULTS[provider];

    if (!providerConfig) {
        throw new Error(`Unknown AI provider: "${provider}". Supported: anthropic, groq, moonshot, ollama, openai, deepseek, gemini, perplexity`);
    }

    const apiKey = getApiKey(provider, clientApiKeys);

    // Custom Ollama URL from client config (overrides env var)
    const baseUrl = clientApiKeys?.ollamaBaseUrl || providerConfig.baseUrl;

    const emitFallback = async (label, errMsg = '') => {
        try {
            const events = require('./events');
            await events.emit('provider_fallback', {
                workerName: _workerName || 'unknown',
                provider: label,
                error: errMsg,
            });
        } catch (_) {}
    };

    // ── LOCAL-FIRST MODE ──────────────────────────────────────────────────────
    // Try Ollama before hitting any paid API. Only falls through to the
    // configured model if Ollama is unreachable or returns a garbage response.
    const _tag = _workerName || `${provider}/${modelId}`;

    if (process.env.OLLAMA_FIRST === 'true' && provider !== 'ollama') {
        try {
            const ollama = PROVIDER_DEFAULTS.ollama;
            const localResult = await callOpenAICompat(
                ollama.defaultModel, null, ollama.baseUrl,
                systemPrompt, messages, maxTokens, true, `${_tag}/ollama-first`
            );
            if (isQualityResponse(localResult)) {
                // Good local response — use it, skip paid API entirely
                console.log(`[ai-client] local/qwen3:8b used for ${_workerName || 'worker'} (free)`);
                return localResult;
            }
            // Low-quality response — log it and fall through to paid model
            console.warn(`[ai-client] local/qwen3:8b quality check failed for ${_workerName || 'worker'} — falling back to ${provider}`);
            await emitFallback(`${provider}/${modelId} (local quality fail)`);
        } catch (localErr) {
            // Ollama unreachable (tunnel down, server offline) — fall through silently
            console.warn(`[ai-client] Ollama unreachable (${localErr.message?.slice(0, 60)}) — falling back to ${provider}`);
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    try {
        if (provider === 'anthropic') {
            return await callAnthropic(modelId, apiKey, systemPrompt, messages, maxTokens, _tag);
        } else if (providerConfig.openaiCompat) {
            return await callOpenAICompat(modelId, apiKey, baseUrl, systemPrompt, messages, maxTokens, providerConfig.noAuth, _tag);
        }
        throw new Error(`Provider "${provider}" not implemented`);
    } catch (e) {
        // Auto-fallback: Anthropic overloaded (529) or server error (5xx)
        // Priority: Ollama (local/free) → Moonshot/Kimi (cloud/free) → OpenAI (paid)
        const isAnthropicDown = provider === 'anthropic' && (
            e.message?.includes('529') ||
            e.message?.includes('overloaded') ||
            e.message?.includes('503') ||
            e.message?.includes('500') ||
            e.message?.includes('401') ||
            e.message?.includes('credit') ||
            e.message?.includes('billing')
        );

        if (isAnthropicDown) {
            // 1. Try Ollama (local, free, no key — works in dev)
            try {
                const ollama = PROVIDER_DEFAULTS.ollama;
                const result = await callOpenAICompat(ollama.defaultModel, null, ollama.baseUrl, systemPrompt, messages, maxTokens, true);
                await emitFallback(`ollama/${ollama.defaultModel} (local)`, e.message);
                return result;
            } catch (_) {}

            // 2. Try Perplexity (cloud, you already have a key)
            const perplexityKey = getApiKey('perplexity', clientApiKeys);
            if (perplexityKey) {
                try {
                    const px = PROVIDER_DEFAULTS.perplexity;
                    const result = await callOpenAICompat(px.defaultModel, perplexityKey, px.baseUrl, systemPrompt, messages, maxTokens);
                    await emitFallback('perplexity/llama-3.1-sonar-small', e.message);
                    return result;
                } catch (_) {}
            }

            // 3. Try Moonshot/Kimi (cloud, free tier — works in production)
            const moonshotKey = getApiKey('moonshot', clientApiKeys);
            if (moonshotKey) {
                try {
                    const moonshot = PROVIDER_DEFAULTS.moonshot;
                    const result = await callOpenAICompat(moonshot.defaultModel, moonshotKey, moonshot.baseUrl, systemPrompt, messages, maxTokens);
                    await emitFallback('moonshot/kimi-k2.5', e.message);
                    return result;
                } catch (_) {}
            }

            // 4. Try OpenAI (paid — last resort if key exists)
            const openaiKey = getApiKey('openai', clientApiKeys);
            if (openaiKey) {
                const openai = PROVIDER_DEFAULTS.openai;
                const result = await callOpenAICompat(openai.defaultModel, openaiKey, openai.baseUrl, systemPrompt, messages, maxTokens);
                await emitFallback(`openai/${openai.defaultModel}`, e.message);
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
        'qwen3:8b': 'Qwen3 8B (local/free)',
        'gpt-5.5': 'GPT-5.5',
        'gpt-4o-mini': 'GPT-4o Mini',
        'llama-3.1-sonar-small-128k-online': 'Perplexity Sonar Small',
        'llama-3.1-sonar-large-128k-online': 'Perplexity Sonar Large',
        'gemini-2.0-flash': 'Gemini Flash 2.0 (cheap/large-context)',
        'deepseek-v4-pro': 'DeepSeek V4 Pro (flagship, 1M ctx)',
        'deepseek-v4-flash': 'DeepSeek V4 Flash (fast/cheap, 1M ctx)',
        'deepseek-chat': 'DeepSeek V4 Flash (legacy alias — retire by 2026-07-24)',
        'deepseek-reasoner': 'DeepSeek V4 Flash thinking (legacy alias — retire by 2026-07-24)',
        'deepseek-r1:7b': 'DeepSeek R1 7B (local/free)',
        'llava:7b': 'LLaVA 7B (local/vision/free)',
        'mistral:7b': 'Mistral 7B (local/free)',
        'gemma4:e2b': 'Gemma4 2B (local/fast/free)',
        'llama-3.1-8b-instant': 'Llama 3.1 8B Instant (free/fast)',
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

module.exports = { call, callBatch, parseModel, getApiKey, getModelLabel, validate, isQualityResponse };
