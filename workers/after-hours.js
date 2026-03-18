const base = require('./base');

// Check if business is currently open based on hours string
// hours format examples: "Mon-Fri 9am-5pm", "Mon-Thu 2pm-4pm", "24/7"
function isBusinessOpen(hoursString) {
    if (!hoursString) return true; // assume open if no hours set
    if (hoursString.toLowerCase().includes('24/7')) return true;

    const now = new Date();
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const currentDay = dayNames[now.getDay()];
    const currentHour = now.getHours();
    const currentMin = now.getMinutes();
    const currentTotal = currentHour * 60 + currentMin;

    // Try to parse "Mon-Fri 9am-5pm" style
    const match = hoursString.match(/([A-Za-z]+)-?([A-Za-z]*)\s+(\d+)(am|pm)?-(\d+)(am|pm)/i);
    if (!match) return true; // can't parse, assume open

    const [, startDay, endDay, startHrRaw, startAmPm, endHrRaw, endAmPm] = match;
    const dayIndex = dayNames.indexOf(currentDay);

    const startDayIdx = dayNames.findIndex(d => d.toLowerCase() === startDay.toLowerCase().slice(0, 3));
    const endDayIdx = endDay
        ? dayNames.findIndex(d => d.toLowerCase() === endDay.toLowerCase().slice(0, 3))
        : startDayIdx;

    if (dayIndex < startDayIdx || dayIndex > endDayIdx) return false;

    let startHr = parseInt(startHrRaw);
    let endHr = parseInt(endHrRaw);

    if (startAmPm?.toLowerCase() === 'pm' && startHr !== 12) startHr += 12;
    if (startAmPm?.toLowerCase() === 'am' && startHr === 12) startHr = 0;
    if (endAmPm?.toLowerCase() === 'pm' && endHr !== 12) endHr += 12;
    if (endAmPm?.toLowerCase() === 'am' && endHr === 12) endHr = 0;

    const openTotal = startHr * 60;
    const closeTotal = endHr * 60;

    return currentTotal >= openTotal && currentTotal < closeTotal;
}

// Inbound: handle messages received outside business hours
async function run({ client, message, customerNumber }) {
    const biz = client.business;
    const tone = base.getTone(client);
    const settings = client.settings?.['after-hours'] || {};
    const captureMessage = settings.captureLeadInfo !== false;

    const systemPrompt = `You are an after-hours assistant for ${biz.name}, a ${biz.industry} business.
The business is currently CLOSED. Hours: ${biz.hours}.
${tone}
- Keep replies SHORT — 2-3 sentences max.
- Let the customer know the business is closed and share the hours.
- If they have a question you can answer from business info, answer it briefly.
- ${captureMessage ? "Ask if you can take a message or note down what they need so the team can follow up." : "Let them know the team will be in touch when they reopen."}
- For urgent matters, provide the phone number: ${biz.phone}.
- Never promise specific callbacks — say "the team will follow up."
- Sign off as ${biz.name}.

BUSINESS INFO:
- Hours: ${biz.hours}
- Phone: ${biz.phone}
- Website: ${biz.website || 'N/A'}
- Services: ${biz.services?.map(s => s.name).join(', ') || 'N/A'}`;

    return base.run({ client, message, customerNumber, workerName: 'AfterHours', systemPrompt, maxTokens: 200 });
}

module.exports = { run, isBusinessOpen };
