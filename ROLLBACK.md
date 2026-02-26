# Repair ASAP — AI Hub Rollback Guide

## Current Working State (Before AI Hub)
- **Git commit:** `96ab423` — "feat: check-customer API for returning customer detection"
- **Date:** February 25, 2026, ~20:30 EST
- **Status:** Everything works — chatbot, quote form, calendar slots, Telegram notifications

## What Was Added (commit `cf9d5e0`)
- `lib/ai-hub.js` — AI Hub core (GHL context, GPT-4o, response delivery)
- `lib/knowledge-base.js` — Pricing, services, channel rules
- `lib/config.js` — Added `aiHub` config section
- `api/index.js` — Added `/api/ai-hub/webhook` + `/api/ai-hub/test` routes

## How to Rollback

### Option 1: Revert to pre-AI-Hub state (nuclear option)
```bash
cd ~/Developer/repair-asap-proxy
git revert cf9d5e0
git push origin main
```
This creates a new commit that undoes all AI Hub changes. Safe, preserves history.

### Option 2: Just disable AI Hub (soft option)
Set in Vercel Environment Variables:
```
AI_HUB_ENABLED=false
```
The endpoints still exist but won't process anything.

### Option 3: Disconnect GHL webhook (immediate stop)
In GHL Prosbuddy → Workflows → Yelp Autoresponder:
1. Open the workflow
2. Delete or disable the Webhook action that points to Vercel
3. Re-add the GPT block with the original prompt (saved below)

## Original GHL Yelp Workflow (Pre-AI-Hub)
```
Trigger: Yelp Customer Reply
  → Condition: is_first_message = true
    → GPT Powered by OpenAI (GPT-4 Mini)
      Prompt: "Respond to a Yelp customer. Greet them by name,
               ask for address, preferred time, and 1-2 photos."
    → Send Yelp Message (GPT response)
```

## Current GHL Yelp Workflow (Modified Today)
```
Trigger: Yelp Customer Reply
  → GPT Powered by OpenAI (GPT-5)
    Prompt: Full system prompt with pricing and rules (see below)
    Chat History: ON
  → Send Yelp Message (GPT response)
```

The full prompt that was set (or should have been set) in the GHL GPT block:
```
You are the AI sales assistant for Repair ASAP LLC, a licensed and insured
handyman service in New York City.

ROLE: Respond to ALL Yelp messages. Maintain a natural, multi-turn conversation.
Your goal is to qualify the lead, provide pricing, and book an appointment.

STYLE RULES:
- Professional but warm, not corporate, not casual
- Keep messages 60-120 words (1-2 short paragraphs)
- Use the customer name from: {{yelp_customer_reply.name}}
- Current message: {{yelp_customer_reply.yelp_message_content}}

PRICING (always say "typically ranges from"):
- TV Wall Mounting: $150-$300
- Furniture Assembly (single item): $150-$350
- IKEA PAX Wardrobe (large): $250-$450
- AC Installation (window/through-wall): $200-$400
- Light Fixture/Chandelier: $150-$250+
- Painting (per room): $400-$800+
- Flooring (per room): $500-$1,200+
- Drywall Repair (patch): $150-$250+
- Faucet/Toilet Installation: $150-$300
- Door Installation: $200-$400
- Lock Installation: $150-$200+
- Wallpaper Installation (per wall): $300-$600+
- Minimum service call: $150

WHAT TO DO:
1. Customer describes a service: give price range, ask for address, photos, preferred time
2. Customer gives details: provide specific price, offer 2 time slots
3. Customer confirms: book appointment, say "Our technician will confirm the details"
4. Customer asks about availability: "Same-day and next-day slots usually available"
5. Price question: Give range, then "Send a photo and we will give you an exact flat-rate quote"

WHAT NOT TO DO:
- Never guarantee exact price without assessment
- Never promise exact arrival time
- Never ask for the customer real phone number (Yelp uses proxy numbers)
- Never say "I am an AI" or "I am a chatbot"
- Never offer discounts or promotions
- Never argue with the customer

ESCALATION: If project over $500, customer is upset, requests discount, or needs non-standard
work, say "Let me have our team review this and get back to you shortly"

SERVICE AREA: Manhattan, Brooklyn, Queens, Staten Island, Nassau County.
For other areas: "Our primary service area is Manhattan through Nassau County.
For your area, let me check, can you share your address?"

WARRANTY: 1-year labor warranty, 60-day parts warranty.
Payment upon completion. Methods: Cash, Zelle, Venmo, Card, Apple Pay.
```

## Vercel Environment Variables (existing)
- `OPENAI_API_KEY` — OpenAI API key
- `OPENAI_ASSISTANT_ID` — chatbot assistant ID
- `PROSBUDDY_API_TOKEN` — GHL CRM token
- `PROSBUDDY_LOCATION_ID` — GHL location
- `GOOGLE_SHEET_ID` — leads spreadsheet
- `GOOGLE_SERVICE_ACCOUNT_CREDENTIALS` — service account JSON
- `TELEGRAM_BOT_TOKEN` — Telegram notifications
- `TELEGRAM_CHAT_ID` — notification chat
