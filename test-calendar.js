const { getAvailableSlots } = require('./lib/calendarService');

// Mock process.env with the live token to test the API locally
require('dotenv').config();

async function run() {
    console.log("Checking availability for 2026-03-12 (Thursday)...");
    const result = await getAvailableSlots('2026-03-12', 1);
    console.log(JSON.stringify(result, null, 2));

    console.log("\nChecking availability for 2026-03-11 (Wednesday)...");
    const result2 = await getAvailableSlots('2026-03-11', 1);
    console.log(JSON.stringify(result2, null, 2));
}

run().catch(console.error);
