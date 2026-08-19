const fs = require("fs");
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
const { config } = require("./config");

const apiKey =
  config?.geminiApiKey ||
  config?.gemini?.apiKey ||
  process.env.GEMINI_API_KEY ||
  "";
const genAI = new GoogleGenerativeAI(apiKey);

const SYSTEM_INSTRUCTION = `
You are an expert Indian Brick Kiln (ईंट भट्ठा) Diary Parser.
Extract all handwritten daily register data strictly into 4 distinct structured objects:

1. DAILY_CLOSING (Top Right Section Calculation):
   - opening_balance: Initial "बचत" carried forward from yesterday.
   - total_jama: Total cash collection from sales/advances today (e.g. बालगोविन्द महुलारा 15500).
   - total_cash_in_hand: opening_balance + total_jama.
   - total_kharcha: Total expenses ("खर्चा") deducted (e.g. 4300).
   - subtotal: total_cash_in_hand - total_kharcha.
   - given_to_owner: Amount handed over to owner ("साहब को दिया").
   - closing_balance: Final remaining cash with Munshi ("बचत").

2. ORDERS (Only entries between Top "बचत" and "बिक्री" where cash was received):
   - customer_name, village, grade, quantity, amount_payable, amount_received, mode_of_payment ("Cash"/"Online").
   - pending_amount must be calculated as Math.max(0, amount_payable - amount_received).

3. SUPPLY_DISPATCH (Lines strictly listed under "बिक्री"):
   - customer_name, village_or_site, grade, dispatched_quantity, driver_name.
   - Grade mapping rules:
     * "अ०" -> "अव्वल"
     * "मी०" -> "मीठा"
     * "रोडा पी०" / "१ रोडा पी०" -> "1 गाड़ी रोड़ा पीला" (Do NOT confuse with 500 मीठा)
     * "दोयम", "पक्का", "चटका" -> standard names.
   - Driver names are written at the far right of each row (e.g., बिन्धा, चिन्टू, सूरज).

4. EXPENSES (Lines strictly listed under "खर्चा"):
   - paid_to (e.g., सूरज, डीजल, चिन्टू/बिन्धा 6 पर्ची), amount, remarks.
`;

const responseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    date: { type: SchemaType.STRING, description: "Date on the page e.g. 19-8-26" },
    daily_closing: {
      type: SchemaType.OBJECT,
      properties: {
        opening_balance: { type: SchemaType.NUMBER },
        total_jama: { type: SchemaType.NUMBER },
        total_cash_in_hand: { type: SchemaType.NUMBER },
        total_kharcha: { type: SchemaType.NUMBER },
        subtotal: { type: SchemaType.NUMBER },
        given_to_owner: { type: SchemaType.NUMBER },
        closing_balance: { type: SchemaType.NUMBER },
      },
      required: ["opening_balance", "total_kharcha", "closing_balance"],
    },
    orders: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          customer_name: { type: SchemaType.STRING },
          village: { type: SchemaType.STRING },
          grade: { type: SchemaType.STRING },
          quantity: { type: SchemaType.NUMBER },
          amount_payable: { type: SchemaType.NUMBER },
          amount_received: { type: SchemaType.NUMBER },
          pending_amount: { type: SchemaType.NUMBER },
          mode_of_payment: { type: SchemaType.STRING },
        },
      },
    },
    supply_dispatch: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          customer_name: { type: SchemaType.STRING },
          village_or_site: { type: SchemaType.STRING },
          grade: { type: SchemaType.STRING },
          dispatched_quantity: { type: SchemaType.STRING },
          driver_name: { type: SchemaType.STRING },
        },
      },
    },
    expenses: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          paid_to: { type: SchemaType.STRING },
          amount: { type: SchemaType.NUMBER },
          remarks: { type: SchemaType.STRING },
        },
      },
    },
  },
  required: ["daily_closing", "orders", "supply_dispatch", "expenses"],
};

async function extractLedgerTextFromImage(filePath, mimeType = "image/jpeg") {
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: SYSTEM_INSTRUCTION,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: responseSchema,
    },
  });

  const imageData = fs.readFileSync(filePath).toString("base64");

  const result = await model.generateContent([
    { inlineData: { data: imageData, mimeType } },
    { text: "Parse and extract this brick kiln ledger page into the structured JSON schema." },
  ]);

  const rawText = (result.response.text() || "").trim();
  if (!rawText || rawText.length < 5) {
    const err = new Error("EMPTY_VISION_EXTRACTION");
    err.userMessage = "Photo saaf nahi padhi ja saki. Kripya achhi roshni mein dobara bhejein.";
    throw err;
  }

  const parsedData = JSON.parse(rawText);

  // Safeguard: Enforce non-negative pending amount calculation
  if (parsedData.orders && Array.isArray(parsedData.orders)) {
    parsedData.orders.forEach((order) => {
      const payable = order.amount_payable || 0;
      const received = order.amount_received || 0;
      order.pending_amount = Math.max(0, payable - received);
    });
  }

  return parsedData;
}

module.exports = { extractLedgerTextFromImage };
