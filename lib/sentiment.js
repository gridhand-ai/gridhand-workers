'use strict'
// ── Sentiment Analysis — local Ollama, zero API cost ─────────────────────────
// Uses gemma4:e2b (2B local model) for fast binary/ternary classification.
// Falls back to groq/llama-3.1-8b-instant if Ollama is unreachable.
// Never burns GPT-5.5 or Gemini tokens for this task.

const { call } = require('./ai-client')

const SYSTEM = `You are a sentiment classifier. Respond with ONLY one word: positive, negative, or neutral.
No explanation. No punctuation. Just the single word.`

/**
 * Classify sentiment of a text string.
 * @param {string} text
 * @returns {Promise<'positive'|'negative'|'neutral'>}
 */
async function classify(text) {
    if (!text || text.trim().length < 3) return 'neutral'

    try {
        const result = await call({
            modelString: 'ollama/gemma4:e2b',
            systemPrompt: SYSTEM,
            messages: [{ role: 'user', content: text.slice(0, 500) }],
            maxTokens: 5,
        })
        const word = result?.toLowerCase().trim()
        if (['positive', 'negative', 'neutral'].includes(word)) return word
    } catch {
        // Ollama unreachable — fall back to Groq fast model
    }

    try {
        const result = await call({
            modelString: 'groq/llama-3.1-8b-instant',
            systemPrompt: SYSTEM,
            messages: [{ role: 'user', content: text.slice(0, 500) }],
            maxTokens: 5,
        })
        const word = result?.toLowerCase().trim()
        if (['positive', 'negative', 'neutral'].includes(word)) return word
    } catch {
        // Both failed
    }

    return 'neutral'
}

/**
 * Score sentiment as a number: positive=1, neutral=0, negative=-1
 */
async function score(text) {
    const s = await classify(text)
    return s === 'positive' ? 1 : s === 'negative' ? -1 : 0
}

/**
 * Batch classify an array of texts. Returns array of results.
 */
async function classifyBatch(texts) {
    return Promise.all(texts.map(t => classify(t)))
}

module.exports = { classify, score, classifyBatch }
