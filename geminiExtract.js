const { GoogleGenerativeAI } = require("@google/generative-ai");
const { config } = require("./config");

const apiKey = config?.geminiApiKey || config?.gemini?.apiKey || process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(apiKey);

const VALID_GRADES = [
  "Awwal",
  "Meetha",
  "Khanjad",
  "Peela",
  "Godiya",
  "Addha Awwal",
  "Addha Peela",
  "Other"
];

const SYSTEM_PROMPT = `You are an expert Munshi (accountant) AI for an Indian brick kiln (ईंट भट्ठा).
Classify and extract incoming messages into one of 4 entry types:

1. SALE (Brick dispatches):
   - Grades: Awwal, Meetha, Khanjad, Peela, Godiya, Addha Awwal, Addha Peela
   - Extract: name, grade, quantity, amount_payable, amount_received, pending_amount, mode_of_payment (Cash/Online).
   - If pending amount is not explicitly stated, compute: (amount_payable - amount_received).

2. EXPENSE (Kharcha / Daily site costs):
   - Categories: Labour / Diesel / Driver / Machine Repair / Ration-Tea / Other
   - Extract: category, paid_to, amount, mode_of_payment (Cash/Online), remarks.

3. DAILY_CLOSING (Evening cash handover / Rokar hisab):
   - Extract: total_jama, total_kharcha, maalik_ko_diya, munshi_cash_in_hand, notes.

4. CORRECTION (Munshi correcting a previous mistake):
   - Extract: target_customer, field_to_update, corrected_value, notes.

Return ONLY a valid JSON object matching this schema:
{
  "entry_type": "SALE" | "EXPENSE" | "DAILY_CLOSING" | "CORRECTION" | "UNKNOWN",
  "sale_data": {
    "name": string,
    "grade": "Awwal" | "Meetha" | "Khanjad" | "Peela" | "Godiya" | "Addha Awwal" | "Addha Peela" | "Other",
    "quantity": number,
    "amount_payable": number,
    "amount_received": number,
    "pending_amount": number,
    "mode_of_payment": "Cash" | "Online"
  },
  "expense_data": {
    "category": string,
    "paid_to": string,
    "amount": number,
    "mode_of_payment": "Cash" | "Online",
    "remarks": string
  },
  "daily_closing_data": {
    "total_jama": number,
    "total_kharcha": number,
    "maalik_ko_diya": number,
    "munshi_cash_in_hand": number,
    "notes": string
  },
  "correction_data": {
    "target_customer": string,
    "field_to_update": string,
    "corrected_value": string | number,
    "notes": string
  },
  "spoken_summary_hi": string
}`;

async function extractLedgerData(rawText) {
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    generationConfig: { responseMimeType: "application/json" },
  });

  const prompt = `${SYSTEM_PROMPT}\n\nUser Message: "${rawText}"`;
  const result = await model.generateContent(prompt);
  const raw = result.response.text();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const parseErr = new Error("EXTRACTION_JSON_PARSE_FAILED");
    parseErr.userMessage = "Entry process karne mein dikkat aayi. Kripya dobara bhejein.";
    throw parseErr;
  }

  const isAmbiguous = parsed.entry_type === "UNKNOWN";
  return { data: parsed, isAmbiguous };
}

module.exports = { extractLedgerData, VALID_GRADES };
