const base = require('./base');

// Check if business is currently open based on hours string
// hours format examples: "Mon-Fri 9am-5pm", "Mon-Thu 2pm-4pm", "24/7"
// multi-segment: "Mon-Thu 10am-9pm, Fri-Sun 10am-10pm"
function isBusinessOpen(hoursString) {
    if (!hoursString) return true; // assume open if no hours set
    if (hoursString.toLowerCase().includes('24/7')) return true;

    const now = new Date();
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const currentDay = dayNames[now.getDay()];
    const currentHour = now.getHours();
    const currentMin = now.getMinutes();
    const currentTotal = currentHour * 60 + currentMin;
    const dayIndex = dayNames.indexOf(currentDay);

    // Split by comma to support multi-segment hours like "Mon-Thu 10am-9pm, Fri-Sun 10am-10pm"
    const segments = hoursString.split(',').map(s => s.trim());

    let parsedAny = false;

    for (const segment of segments) {
        // Try to parse "Mon-Fri 9am-5pm" style within each segment
        const match = segment.match(/([A-Za-z]+)-?([A-Za-z]*)\s+(\d+)(am|pm)?-(\d+)(am|pm)/i);
        if (!match) continue;

        parsedAny = true;
        const [, startDay, endDay, startHrRaw, startAmPm, endHrRaw, endAmPm] = match;

        const startDayIdx = dayNames.findIndex(d => d.toLowerCase() === startDay.toLowerCase().slice(0, 3));
        const endDayIdx = endDay
            ? dayNames.findIndex(d => d.toLowerCase() === endDay.toLowerCase().slice(0, 3))
            : startDayIdx;

        // Current day not in this segment's day range — try next segment
        // Handle week-wrap ranges like Fri-Sun (startDayIdx=5, endDayIdx=0)
        const inRange = startDayIdx <= endDayIdx
            ? (dayIndex >= startDayIdx && dayIndex <= endDayIdx)
            : (dayIndex >= startDayIdx || dayIndex <= endDayIdx);
        if (!inRange) continue;

        let startHr = parseInt(startHrRaw);
        let endHr = parseInt(endHrRaw);

        if (startAmPm?.toLowerCase() === 'pm' && startHr !== 12) startHr += 12;
        if (startAmPm?.toLowerCase() === 'am' && startHr === 12) startHr = 0;
        if (endAmPm?.toLowerCase() === 'pm' && endHr !== 12) endHr += 12;
        if (endAmPm?.toLowerCase() === 'am' && endHr === 12) endHr = 0;

        const openTotal = startHr * 60;
        const closeTotal = endHr * 60;

        if (currentTotal >= openTotal && currentTotal < closeTotal) return true;
    }

    // If we parsed at least one segment but none matched, business is closed
    // If we couldn't parse anything, assume open
    return !parsedAny;
}

if (require.main === module) {
    // Inline tests for multi-segment hours parsing
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    function testOpen(hoursString, dayName, hour, min, expectOpen) {
        // Temporarily override Date to simulate a specific day/time
        const OrigDate = global.Date;
        const fakeDay = dayNames.indexOf(dayName);
        global.Date = class extends OrigDate {
            constructor(...args) { if (args.length) { super(...args); } else { super(2026, 0, 4 + fakeDay); } }
            getDay() { return fakeDay; }
            getHours() { return hour; }
            getMinutes() { return min; }
        };
        const result = isBusinessOpen(hoursString);
        global.Date = OrigDate;
        const pass = result === expectOpen;
        console.log(`${pass ? 'PASS' : 'FAIL'} | ${dayName} ${hour}:${String(min).padStart(2,'0')} | expected ${expectOpen ? 'open' : 'closed'} | got ${result ? 'open' : 'closed'} | "${hoursString}"`);
        return pass;
    }

    const hours = 'Mon-Thu 10am-9pm, Fri-Sun 10am-10pm';
    let allPassed = true;
    allPassed = testOpen(hours, 'Fri', 11, 0, true)  && allPassed; // Friday 11am — should be open
    allPassed = testOpen(hours, 'Mon', 8,  0, false) && allPassed; // Monday 8am  — should be closed (before open)
    allPassed = testOpen(hours, 'Sat', 10, 0, true)  && allPassed; // Saturday 10am — open
    allPassed = testOpen(hours, 'Sun', 22, 0, false) && allPassed; // Sunday 10pm — after close (10pm = 22:00, closeTotal=22*60, currentTotal=22*60, not < close)
    allPassed = testOpen(hours, 'Thu', 20, 59, true) && allPassed; // Thursday 8:59pm — open
    allPassed = testOpen(hours, 'Thu', 21, 0, false) && allPassed; // Thursday 9pm — closed (at close boundary)
    console.log(allPassed ? '\nAll tests passed.' : '\nSome tests FAILED.');
}

// Inbound: handle messages received outside business hours
async function run({ client, message, customerNumber }) {
    const biz = client.business;
    const tone = base.getTone(client);
    const settings = client.settings?.['after-hours'] || {};
    const captureMessage = settings.captureLeadInfo !== false;

    const systemPrompt = `You are an after-hours assistant for ${biz.name}, a ${biz.industry} business. The business is currently CLOSED. ${tone}

<business>
Hours: ${biz.hours}
Phone: ${biz.phone}
Website: ${biz.website || 'N/A'}
Services: ${biz.services?.map(s => s.name).join(', ') || 'N/A'}
</business>

<rules>
- Keep replies SHORT — 2-3 sentences max.
- Let the customer know the business is closed and share the hours.
- If they have a question you can answer from business info, answer it briefly.
- ${captureMessage ? 'Ask if you can take a message or note down what they need so the team can follow up.' : 'Let them know the team will be in touch when they reopen.'}
- For urgent matters, provide the phone number: ${biz.phone}.
- Never promise specific callbacks — say "the team will follow up."
- Sign off as ${biz.name}.
</rules>`;

    return base.run({ client, message, customerNumber, workerName: 'AfterHours', systemPrompt, maxTokens: 200 });
}

module.exports = { run, isBusinessOpen };
