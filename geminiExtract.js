const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);

const VALID_GRADES = [
  'Awwal',
  'Meetha',
  'Khanjad',
  'Peela',
  'Godiya',
  'Addha Awwal',
  'Addha Peela',
  'Other',
];

const VALID_EXPENSE_CATEGORIES = [
  'Labour',
  'Diesel',
  'Driver',
  'Machine Repair',
  'Ration-Tea',
  'Other',
];

const SYSTEM_PROMPT = `You are the extraction engine for "Munshi Agent", a WhatsApp bookkeeping assistant
for an Indian brick kiln (ईंट भट्ठा). You receive a transcribed Hindi/English/Hinglish message
(from a voice note, text message, or handwritten ledger photo) written by the site munshi (accountant).

Your job: classify the message into exactly ONE of 4 intents, then extract structured fields as JSON.

INTENTS:

1. "SALE" — Dispatch/sale of bricks to a customer or thekedar (contractor).
   Fields to extract:
     - name (string): customer/thekedar name
     - grade (string): one of ${JSON.stringify(VALID_GRADES)}. If the spoken grade doesn't match
       exactly, pick the closest valid grade; if truly ambiguous, use "Other".
     - quantity (number): number of bricks
     - amount_payable (number): total amount owed for this sale
     - amount_received (number): amount actually paid now (0 if none mentioned)
     - pending_amount (number): if not explicitly stated, compute as (amount_payable - amount_received)
     - mode_of_payment (string): e.g. "Cash", "UPI", "Bank Transfer", "Cheque", "Udhaar/Credit"; use "Not specified" if unclear

2. "EXPENSE" — Site costs: diesel, driver payments, daily wages/labour, machine repair, tea/ration, etc.
   Fields to extract:
     - category (string): one of ${JSON.stringify(VALID_EXPENSE_CATEGORIES)}
     - paid_to (string): person or vendor paid
     - amount (number)
     - mode_of_payment (string): e.g. "Cash", "UPI", "Bank Transfer"; use "Not specified" if unclear
     - remarks (string): any extra context, short

3. "DAILY_CLOSING" — Evening cash reconciliation / rokar milaan statement.
   Fields to extract:
     - total_jama (number): total collections/income for the day
     - total_kharcha (number): total expenses for the day
     - maalik_ko_diya (number): amount handed over to the owner/maalik
     - munshi_cash_in_hand (number): cash remaining with the munshi
     - notes (string): any extra remarks; empty string if none

4. "CORRECTION" — The munshi is correcting a PREVIOUS entry (e.g. "Suresh ka 4000 nahi 3000 tha",
   "kal wali entry galat thi, quantity 500 hogi 1000 nahi").
   Fields to extract:
     - target_name (string): the customer/vendor name the correction refers to
     - field_to_correct (string): which field is being corrected, e.g. "amount_payable", "amount_received",
       "quantity", "pending_amount", "grade", "mode_of_payment", or best guess
     - old_value (string|number|null): the incorrect value mentioned, if any
     - new_value (string|number): the corrected value
     - audit_note (string): a short human-readable note describing the correction, in Hindi, e.g.
       "सुरेश ठेकेदार की राशि ₹4000 से ₹3000 सुधारी गई"

GENERAL RULES:
- Always respond with STRICT JSON ONLY. No markdown fences, no commentary, no leading/trailing text.
- All numbers must be plain numbers (no currency symbols, no commas), e.g. 12000 not "₹12,000".
- If a message contains information you truly cannot classify into any of the 4 intents (e.g. pure greeting,
  unrelated chit-chat), return {"intent": "UNKNOWN", "reason": "<short reason>"}.
- Always include a top-level "intent" field with one of: "SALE", "EXPENSE", "DAILY_CLOSING", "CORRECTION", "UNKNOWN".
- Always include a top-level "spoken_summary_hi" field: a concise, natural Hindi (Devanagari) confirmation
  sentence summarizing what was recorded, suitable for sending back to the munshi on WhatsApp.
  Example: "सुरेश ठेकेदार: 3000 अव्वल ईंट, ₹12,000 नकद, ₹8,000 उधारी दर्ज कर दी गई है।"
  For UNKNOWN intent, spoken_summary_hi should politely ask the munshi to clarify.
- Include a top-level "confidence" field (0.0 to 1.0) reflecting how confident you are in the extraction.
- Return the intent-specific fields nested under a top-level "data" object.

Respond with JSON matching this shape:
{
  "intent": "SALE" | "EXPENSE" | "DAILY_CLOSING" | "CORRECTION" | "UNKNOWN",
  "confidence": 0.0-1.0,
  "data": { ...intent-specific fields... },
  "spoken_summary_hi": "..."
}`;

function safeJsonParse(rawText) {
  // Gemini sometimes wraps JSON in markdown fences despite instructions; strip them defensively.
  const cleaned = rawText
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    // Try to salvage the first { ... } block if there's stray text around it.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error(`Failed to parse Gemini extraction JSON: ${err.message}\nRaw: ${rawText}`);
  }
}

function coerceNumbers(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const numericKeys = [
    'quantity',
    'amount_payable',
    'amount_received',
    'pending_amount',
    'amount',
    'total_jama',
    'total_kharcha',
    'maalik_ko_diya',
    'munshi_cash_in_hand',
  ];
  for (const key of numericKeys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      const n = Number(String(obj[key]).replace(/[₹,\s]/g, ''));
      if (!Number.isNaN(n)) obj[key] = n;
    }
  }
  return obj;
}

function postProcess(parsed) {
  if (parsed.intent === 'SALE' && parsed.data) {
    coerceNumbers(parsed.data);
    const { amount_payable, amount_received, pending_amount } = parsed.data;
    if (
      (pending_amount === undefined || pending_amount === null) &&
      typeof amount_payable === 'number' &&
      typeof amount_received === 'number'
    ) {
      parsed.data.pending_amount = Math.max(amount_payable - amount_received, 0);
    }
    if (!VALID_GRADES.includes(parsed.data.grade)) {
      parsed.data.grade = 'Other';
    }
  }

  if (parsed.intent === 'EXPENSE' && parsed.data) {
    coerceNumbers(parsed.data);
    if (!VALID_EXPENSE_CATEGORIES.includes(parsed.data.category)) {
      parsed.data.category = 'Other';
    }
  }

  if (parsed.intent === 'DAILY_CLOSING' && parsed.data) {
    coerceNumbers(parsed.data);
  }

  return parsed;
}

/**
 * Extracts structured intent + data from a transcribed message.
 * @param {string} transcribedText - plain text (from voice, image OCR, or direct text message)
 * @param {object} [context] - optional context, e.g. { senderName, recentSalesContext }
 * @returns {Promise<object>} parsed extraction result
 */
async function extractIntent(transcribedText, context = {}) {
  const model = genAI.getGenerativeModel({
    model: config.gemini.model,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  });

  let contextBlock = '';
  if (context.recentSalesContext) {
    contextBlock = `\n\nRECENT SALES CONTEXT (for resolving CORRECTION references):\n${context.recentSalesContext}`;
  }

  const userPrompt = `Message to classify and extract:\n"""\n${transcribedText}\n"""${contextBlock}`;

  const result = await model.generateContent([
    { text: SYSTEM_PROMPT },
    { text: userPrompt },
  ]);

  const rawText = result.response.text();
  const parsed = safeJsonParse(rawText);
  return postProcess(parsed);
}

module.exports = {
  extractIntent,
  VALID_GRADES,
  VALID_EXPENSE_CATEGORIES,
};
