const { logger } = require('./utils/log');

const GHL_API = 'https://services.leadconnectorhq.com';
const CALENDAR_ID = process.env.GHL_CALENDAR_ID || '7HO6RR4BeCFNPMh88hoT';
const LOCATION_ID = process.env.PROSBUDDY_LOCATION_ID;
const TIMEZONE = 'America/New_York';

/**
 * Get available slots for a given date range.
 * @param {string} date - YYYY-MM-DD format
 * @param {number} [daysAhead=1] - How many days to check (1 = just that day)
 * @returns {{ slots: string[], date: string, error?: string }}
 */
async function getAvailableSlots(date, daysAhead = 1) {
    const apiKey = process.env.PROSBUDDY_API_TOKEN;
    if (!apiKey) return { slots: [], date, error: 'API token missing' };

    try {
        // Convert date to timestamps in ms
        const startDate = new Date(`${date}T00:00:00`);
        const endDate = new Date(startDate.getTime() + daysAhead * 86400000);

        const params = new URLSearchParams({
            startDate: startDate.getTime().toString(),
            endDate: endDate.getTime().toString(),
            timezone: TIMEZONE,
        });

        const url = `${GHL_API}/calendars/${CALENDAR_ID}/free-slots?${params}`;
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Version': '2021-04-15',
            },
        });

        const data = await response.json();

        if (!response.ok) {
            logger.error('Calendar free-slots error', { status: response.status, body: data });
            return { slots: [], date, error: `Calendar API: ${response.status}` };
        }

        // GHL returns { <date>: { slots: ["2024-01-15T09:00:00-05:00", ...] } }
        // or { slots: { <date>: ["..."] } }
        let allSlots = [];

        if (data.slots && typeof data.slots === 'object') {
            // Format: { slots: { "2024-01-15": ["09:00", "09:30", ...] } }
            for (const [day, daySlots] of Object.entries(data.slots)) {
                if (Array.isArray(daySlots)) {
                    allSlots.push(...daySlots);
                }
            }
        } else if (typeof data === 'object') {
            // Alternative format: { "2024-01-15": { slots: [...] } }
            for (const [day, dayData] of Object.entries(data)) {
                if (dayData?.slots && Array.isArray(dayData.slots)) {
                    allSlots.push(...dayData.slots);
                }
            }
        }

        // Format slots for human readability
        const formattedSlots = allSlots.map(slot => {
            try {
                const d = new Date(slot);
                return d.toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true,
                    timeZone: TIMEZONE,
                });
            } catch {
                return slot;
            }
        });

        logger.info('Available slots', { date, count: formattedSlots.length });
        return { slots: formattedSlots, date, raw: allSlots };

    } catch (error) {
        logger.error('Calendar getAvailableSlots error', error);
        return { slots: [], date, error: error.message };
    }
}

/**
 * Book an appointment in the GHL calendar.
 * @param {Object} params
 * @param {string} params.contactId - GHL contact ID
 * @param {string} params.startTime - ISO 8601 datetime (e.g. "2026-02-25T11:00:00-05:00")
 * @param {string} params.service - Service description
 * @param {string} params.address - Job address
 * @param {string} [params.contactName] - Name for the appointment title
 * @returns {{ success: boolean, appointmentId?: string, error?: string }}
 */
async function bookAppointment({ contactId, startTime, service, address, contactName }) {
    const apiKey = process.env.PROSBUDDY_API_TOKEN;
    if (!apiKey || !LOCATION_ID) {
        return { success: false, error: 'API config missing' };
    }

    try {
        // Calculate end time (1.5 hours default for handyman service)
        const start = new Date(startTime);
        const end = new Date(start.getTime() + 90 * 60 * 1000); // 1h 30m

        const payload = {
            calendarId: CALENDAR_ID,
            locationId: LOCATION_ID,
            contactId,
            startTime: start.toISOString(),
            endTime: end.toISOString(),
            title: `Handyman Service for ${contactName || 'Customer'}`,
            description: [
                `🔧 Service: ${service}`,
                `📍 Address: ${address || 'TBD'}`,
                `📋 Booked via Website Chatbot`,
            ].join('\n'),
            address: address || '',
            appointmentStatus: 'new',
            toNotify: true, // Trigger automations (SMS confirmation etc.)
        };

        const response = await fetch(`${GHL_API}/calendars/events/appointments`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Version': '2021-04-15',
            },
            body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!response.ok) {
            logger.error('Calendar booking error', { status: response.status, body: data });
            return { success: false, error: `Booking failed: ${response.status} - ${data.message || JSON.stringify(data)}` };
        }

        const appointmentId = data?.id || data?.appointment?.id || data?.eventId;
        logger.info('Appointment booked', {
            appointmentId,
            contactId,
            startTime: start.toISOString(),
            service,
        });

        return {
            success: true,
            appointmentId,
            startTime: start.toISOString(),
            endTime: end.toISOString(),
        };

    } catch (error) {
        logger.error('Calendar bookAppointment error', error);
        return { success: false, error: error.message };
    }
}

module.exports = { getAvailableSlots, bookAppointment };
