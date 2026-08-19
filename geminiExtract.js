const { GoogleGenerativeAI } = require("@google/generative-ai");
const { config } = require("./config");

const apiKey = config?.geminiApiKey || config?.gemini?.apiKey || process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(apiKey);

const VALID_GRADES = [
  "अव्वल",
  "दोयम",
  "सोयम",
  "मीठा",
  "गोड़िया",
  "खंजड़",
  "पीला",
  "अव्वल रोड़ा",
  "पीला रोड़ा",
  "रोड़ा",
  "गुम्मा",
  "चाटका",
  "Other"
];

const SYSTEM_PROMPT = `You are an expert Munshi (accountant) AI for an Indian brick kiln (ईंट भट्ठा).
Classify and extract incoming voice transcripts or text messages into one of 5 entry types:

1. SALE / ORDER (Cash collection, brick orders, or customer advances):
   - Extract: name (Standardize to Devanagari Hindi e.g. "बालगोविन्द"), village, grade, quantity, amount_payable, amount_received, pending_amount, mode_of_payment ("Cash"/"Online").
   - If pending amount is not stated, compute: Math.max(0, amount_payable - amount_received).

2. DISPATCH (Only vehicle/trolley dispatches without immediate payment):
   - Extract: name, village, grade, dispatched_qty, driver.

3. EXPENSE (Kharcha / Daily site costs):
   - Categories: Labour / Diesel / Driver / Machine Repair / Ration-Tea / Other
   - Extract: category, paid_to, amount, mode_of_payment ("Cash"/"Online"), remarks.

4. DAILY_CLOSING (Evening cash handover / Rokar hisab):
   - Extract: opening_balance, total_jama, total_kharcha, maalik_ko_diya, closing_balance, notes.

5. CORRECTION (Modifying a mistake in any tab):
   - Example: "अनूप सिंह 500 मीठा की जगह 4000 मीठा है बदल दो"
   - Extract:
     * target_customer: Standardized name in Hindi (e.g. "अनूप सिंह")
     * target_tab: "Supply_Dispatch" | "Orders" | "Expenses" | "Daily_Closing"
     * field_to_update: "quantity" | "grade" | "amount" | "driver" | "village"
     * corrected_value: The new updated value
     * notes: Context string

6. DELETION (Removing an entry):
   - Example: "अनूप सिंह की एंट्री डिलीट करो" or "पिछला खर्चा हटा दो"
   - Extract:
     * target_customer: Standardized name or keyword
     * target_tab: "Supply_Dispatch" | "Orders" | "Expenses" | "Daily_Closing"
     * delete_last: true / false

Return ONLY a valid JSON object matching this schema:
{
  "entry_type": "SALE" | "DISPATCH" | "EXPENSE" | "DAILY_CLOSING" | "CORRECTION" | "DELETION" | "UNKNOWN",
  "sale_data": {
    "name": string,
    "village": string,
    "grade": string,
    "quantity": number,
    "amount_payable": number,
    "amount_received": number,
    "pending_amount": number,
    "mode_of_payment": "Cash" | "Online"
  },
  "dispatch_data": {
    "name": string,
    "village": string,
    "grade": string,
    "dispatched_qty": number,
    "driver": string
  },
  "expense_data": {
    "category": string,
    "paid_to": string,
    "amount": number,
    "mode_of_payment": "Cash" | "Online",
    "remarks": string
  },
  "daily_closing_data": {
    "opening_balance": number,
    "total_jama": number,
    "total_kharcha": number,
    "maalik_ko_diya": number,
    "closing_balance": number,
    "notes": string
  },
  "correction_data": {
    "target_customer": string,
    "target_tab": "Supply_Dispatch" | "Orders" | "Expenses" | "Daily_Closing",
    "field_to_update": string,
    "corrected_value": string | number,
    "notes": string
  },
  "deletion_data": {
    "target_customer": string,
    "target_tab": "Supply_Dispatch" | "Orders" | "Expenses" | "Daily_Closing",
    "delete_last": boolean
  },
  "spoken_summary_hi": string
}`;

async function extractLedgerData(rawText) {
  const model = genAI.getGenerativeModel({
    model: "gemini-3.6-flash",
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
