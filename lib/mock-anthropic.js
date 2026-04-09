// ─── Mock Anthropic Service — test workers without burning real API tokens ─────
// Deterministic local mock that mimics the Anthropic API response shape.
// Inspired by claw-code's mock-anthropic-service.
//
// Usage in tests:
//   process.env.USE_MOCK_AI = '1'
//   const ai = require('./ai-client')
//   // All calls now return mock responses — no real API calls, no token spend
//
// Mock behaviors:
//   - Returns realistic-looking replies based on worker type
//   - Simulates upset detection trigger phrases
//   - Simulates overload (529) to test fallback logic
//   - Simulates empty response to test retry logic
//   - Latency simulation (configurable)

const MOCK_REPLIES = {
    receptionist: [
        "Hi there! Thanks for reaching out to us. How can I help you today?",
        "Thanks for your message! We'd love to help. What can we assist you with?",
        "Hello! Great to hear from you. Let me know what you need and we'll take care of it.",
    ],
    'review-requester': [
        "Hi! We hope your recent visit went well. We'd love your feedback — it only takes 30 seconds: {reviewLink}",
        "Thanks for choosing us! If you have a moment, we'd really appreciate a quick review: {reviewLink}",
    ],
    faq: [
        "Great question! Our hours are Monday through Friday, 9am to 5pm. Is there anything else I can help you with?",
        "We offer a range of services starting at competitive prices. Would you like me to walk you through the options?",
    ],
    booking: [
        "I'd be happy to help you schedule an appointment! What day and time works best for you?",
        "Absolutely, let's get you booked in. Do you have a preferred day of the week?",
    ],
    'invoice-chaser': [
        "Hi! Just a friendly reminder that invoice #INV-001 is due. Please let us know if you have any questions.",
        "Quick reminder about your outstanding balance. Feel free to reach out if you need any assistance.",
    ],
    default: [
        "Thanks for reaching out! We'll get back to you shortly.",
        "Got your message! Someone from our team will follow up soon.",
    ],
};

const UPSET_REPLY = "I understand your concern and want to make sure you're taken care of. Someone from our team will reach out to you directly very shortly. We appreciate your patience.";

// ─── Simulate different failure modes for testing ─────────────────────────────
const MOCK_SCENARIOS = {
    normal:   'normal',
    upset:    'upset',      // triggers escalation path
    overload: 'overload',   // simulates Anthropic 529 → tests fallback
    empty:    'empty',      // simulates empty response → tests retry
    slow:     'slow',       // simulates latency
};

let currentScenario = MOCK_SCENARIOS.normal;
let callCount = 0;

function setScenario(scenario) {
    currentScenario = scenario;
    callCount = 0;
    console.log(`[MockAI] Scenario set to: ${scenario}`);
}

function getScenario() { return currentScenario; }
function getCallCount() { return callCount; }
function resetCallCount() { callCount = 0; }

// ─── Mock call — drop-in replacement for ai-client.call() ────────────────────
async function mockCall({ modelString, systemPrompt, messages, maxTokens = 150, _workerName = null }) {
    callCount++;

    // Simulate latency
    if (currentScenario === 'slow') {
        await new Promise(r => setTimeout(r, 800));
    }

    // Simulate overload → triggers fallback logic in ai-client
    if (currentScenario === 'overload') {
        throw new Error('AI API error (529): Anthropic is temporarily overloaded. Please retry.');
    }

    // Simulate empty response → triggers retry logic
    if (currentScenario === 'empty') {
        return '';
    }

    // Simulate upset customer response
    if (currentScenario === 'upset') {
        return UPSET_REPLY;
    }

    // Normal: return a realistic reply for the worker type
    const workerName = _workerName || 'default';
    const replies = MOCK_REPLIES[workerName] || MOCK_REPLIES.default;
    const reply = replies[callCount % replies.length];

    // Inject placeholders if present in system prompt
    const reviewLink = systemPrompt?.match(/reviewLink['":\s]+([^\s'"]+)/)?.[1] || 'https://g.page/r/demo';
    return reply.replace('{reviewLink}', reviewLink);
}

// ─── Patch ai-client in test mode ────────────────────────────────────────────
// Call this at the top of any test file:
//   require('../lib/mock-anthropic').enableMock()
function enableMock() {
    const aiClient = require('./ai-client');
    aiClient._originalCall = aiClient.call;
    aiClient.call = mockCall;
    console.log('[MockAI] Mock enabled — no real API calls will be made');
}

function disableMock() {
    const aiClient = require('./ai-client');
    if (aiClient._originalCall) {
        aiClient.call = aiClient._originalCall;
        delete aiClient._originalCall;
        console.log('[MockAI] Mock disabled — real API calls restored');
    }
}

// ─── Quick smoke test ─────────────────────────────────────────────────────────
async function runSmokeTest() {
    console.log('\n[MockAI] Running smoke test...\n');
    enableMock();

    const base = require('../workers/base');
    const mockClient = {
        slug: 'mock-test',
        model: 'anthropic/claude-haiku-4-5-20251001',
        apiKeys: {},
        billing: { tier: 'starter' },
        business: { name: 'Test Business', hours: 'Mon-Fri 9-5', phone: '555-0000' },
        settings: { global: { tone: 'friendly', faqHandoff: false, escalateOnUpset: true } },
        workers: ['receptionist'],
    };

    const tests = [
        { scenario: 'normal',   message: 'Hi, what are your hours?',          expect: 'response' },
        { scenario: 'upset',    message: 'This is ridiculous I want a refund', expect: 'escalation' },
        { scenario: 'overload', message: 'Book an appointment please',          expect: 'fallback or retry' },
        { scenario: 'empty',    message: 'Hello?',                             expect: 'retry + fallback reply' },
    ];

    for (const t of tests) {
        setScenario(t.scenario);
        console.log(`  Testing: ${t.scenario} (expect: ${t.expect})`);
        try {
            const reply = await base.run({
                client: mockClient,
                message: t.message,
                customerNumber: '+15550000001',
                workerName: 'receptionist',
                systemPrompt: 'You are a helpful receptionist.',
            });
            console.log(`  ✓ Got reply: "${(reply || '').slice(0, 60)}..."\n`);
        } catch (e) {
            console.log(`  ✗ Error: ${e.message}\n`);
        }
    }

    disableMock();
    console.log('[MockAI] Smoke test complete.\n');
}

module.exports = { enableMock, disableMock, setScenario, getScenario, getCallCount, resetCallCount, mockCall, runSmokeTest, MOCK_SCENARIOS };
