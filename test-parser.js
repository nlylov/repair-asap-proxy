const { getAvailableSlots } = require('./lib/calendarService');

function parseNaturalDate(input) {
    if (!input) return null;
    const lowerInput = String(input).toLowerCase().trim();
    // Get current NYC time
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));

    if (lowerInput === 'today') return now.toISOString().split('T')[0];

    if (lowerInput === 'tomorrow') {
        const t = new Date(now);
        t.setDate(t.getDate() + 1);
        return t.toISOString().split('T')[0];
    }

    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const currentDayIndex = now.getDay(); // 0 is Sunday

    let targetDayIndex = -1;
    for (let i = 0; i < days.length; i++) {
        if (lowerInput.includes(days[i])) {
            targetDayIndex = i;
            break;
        }
    }

    if (targetDayIndex !== -1) {
        let daysToAdd = targetDayIndex - currentDayIndex;
        if (daysToAdd <= 0) {
            daysToAdd += 7; // It's past this week's occurrence, move to next week
        }

        if (lowerInput.includes('next ')) {
            daysToAdd += 7;
        }

        const t = new Date(now);
        t.setDate(t.getDate() + daysToAdd);
        return t.toISOString().split('T')[0];
    }

    // Fallback: If AI sends YYYY-MM-DD anyway but messes up the year, auto-correct the year
    if (input.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const parts = input.split('-');
        const currentYear = now.getFullYear();
        if (parseInt(parts[0]) < currentYear) {
            parts[0] = currentYear.toString();
        }
        // Basic check: if it's still in the past this year, don't crash, just use today
        const fixedStr = parts.join('-');
        const todayStr = now.toISOString().split('T')[0];
        if (fixedStr < todayStr) return todayStr;
        return fixedStr;
    }

    return null;
}

const tests = [
    "Wednesday",
    "Thursday",
    "tomorrow",
    "next Monday",
    "2023-11-01",
    "November first",
    "11-01-2026",
    "Nov 1st"
];

for (const t of tests) {
    try {
        const res = parseNaturalDate(t);
        console.log(`Input: "${t}" -> Output: ${res}`);
    } catch (e) {
        console.error(`Input: "${t}" -> ERROR:`, e.message);
    }
}
