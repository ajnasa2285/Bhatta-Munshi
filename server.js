require('dotenv').config();
const fs = require('fs');
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json({ limit: '50mb' }));

// --- Environment Variables ---
const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const WHATSAPP_GATEWAY_BASE_URL = process.env.WHATSAPP_GATEWAY_BASE_URL;
const WHATSAPP_GATEWAY_KEY = process.env.WHATSAPP_GATEWAY_KEY;
const WHATSAPP_GATEWAY_TYPE = process.env.WHATSAPP_GATEWAY_TYPE;
const OWNER_PHONE_NUMBER = process.env.OWNER_PHONE_NUMBER || '919277078095';
const COAL_TUB_KG = Number(process.env.COAL_TUB_KG) || 40;

// --- Primary Model ---
const MODEL_NAME = process.env.MODEL_NAME || 'gemini-3.6-flash';

// --- Authorized Phone Whitelist ---
const ALLOWED_NUMBERS = process.env.ALLOWED_NUMBERS
  ? process.env.ALLOWED_NUMBERS.split(',').map(num => num.trim())
  : ['919277078095'];

// --- Immediate Deduplication Lock ---
const processedMessageIds = new Set();
const MAX_TRACKED_IDS = 1000;

function checkAndLockMessage(messageId) {
  if (!messageId) return false;
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > MAX_TRACKED_IDS) {
    const oldest = processedMessageIds.values().next().value;
    processedMessageIds.delete(oldest);
  }
  return false;
}

// --- In-Memory Image Cache ---
const lastImageCache = new Map();

// --- Initialize Gemini Client ---
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || '');

// --- Initialize Google Sheets API ---
let auth = null;
let sheets = null;
const CREDENTIALS_PATH = '/etc/secrets/credentials.json';

if (fs.existsSync(CREDENTIALS_PATH)) {
  try {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheets = google.sheets({ version: 'v4', auth });
    console.log('Google Sheets credentials loaded successfully.');
  } catch (err) {
    console.error('Failed to load credentials.json:', err.message);
  }
} else {
  console.error('Warning: credentials.json Secret File not found at', CREDENTIALS_PATH);
}

// --- Date Formatter Helper (Asia/Kolkata) ---
function getISTDate(offsetDays = 0) {
  const now = new Date();
  const istTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  if (offsetDays !== 0) {
    istTime.setDate(istTime.getDate() + offsetDays);
  }
  const d = String(istTime.getDate()).padStart(2, '0');
  const m = String(istTime.getMonth() + 1).padStart(2, '0');
  const y = istTime.getFullYear();
  return `${d}-${m}-${y}`;
}

function resolveDateStr(inputDate) {
  if (!inputDate || inputDate.toLowerCase() === 'today' || inputDate === 'आज') {
    return getISTDate(0);
  }
  if (inputDate.toLowerCase() === 'yesterday' || inputDate === 'कल') {
    return getISTDate(-1);
  }
  return inputDate.replace(/\//g, '-').trim();
}

// --- Sheets API Append Helper with Retry ---
async function appendWithRetry(params, retries = 2, delay = 800) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await sheets.spreadsheets.values.append(params);
    } catch (err) {
      const status = err.status || err.code || (err.response && err.response.status);
      if ((status === 503 || status === 500 || status === 429) && attempt < retries) {
        await new Promise(res => setTimeout(res, delay));
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
}

// --- WhatsApp Reply Helper ---
async function sendWhatsAppReply(recipient, text) {
  if (!WHATSAPP_GATEWAY_BASE_URL || !WHATSAPP_GATEWAY_KEY || !WHATSAPP_GATEWAY_TYPE) return;
  try {
    const cleanNumber = recipient.replace('@s.whatsapp.net', '').replace('@c.us', '');
    await axios.post(
      `${WHATSAPP_GATEWAY_BASE_URL}/message/sendText/${WHATSAPP_GATEWAY_TYPE}`,
      { number: cleanNumber, text: text },
      { headers: { apikey: WHATSAPP_GATEWAY_KEY } }
    );
    console.log(`[Reply] Sent to ${cleanNumber}`);
  } catch (error) {
    console.error('[Reply Error]:', JSON.stringify(error.response?.data || error.message, null, 2));
  }
}

// --- Transliteration & Phonetic Normalization (CANONICAL TARGET: कधंई) ---
function normalizeHindi(str) {
  if (!str) return '';
  let s = str.toString().trim().toLowerCase();

  const transMap = [
    [/kanhai|kanahi|kandhai|कन्हाई|कनहाई|कधई|कन्धाई|कंधाई/g, 'कधंई'],
    [/santram|santuram/g, 'सन्तराम'],
    [/anup|anoop/g, 'अनूप'],
    [/singh/g, 'सिंह'],
    [/balgobind|balgovind|balgovinda/g, 'बालगोविन्द'],
    [/blooming|bird/g, 'ब्लूमिंग'],
    [/mahulara|mahulada/g, 'महुलारा'],
    [/mukim|mukeem/g, 'मुकीम'],
    [/nanhe|nanhey/g, 'नन्हे'],
    [/mulayam|yadav/g, 'मुलायम'],
    [/ramkumar|ram kumar/g, 'रामकुमार'],
    [/gagan/g, 'गगन'],
    [/meetha|mitha/g, 'मीठा'],
    [/awwal|awal/g, 'अव्वल'],
    [/peela|pila/g, 'पीला'],
    [/roda|rodda/g, 'रोड़ा'],
    [/trolly|trolley|trauli|ट्राली|ट्रॉली/g, 'ट्रॉली'],
    [/bindha|vindha/g, 'विन्धा'],
    [/chintu/g, 'चिन्टू'],
    [/khedu|khedoo/g, 'खेदू'],
    [/suraj/g, 'सूरज'],
    [/diesel/g, 'डीजल'],
    [/jai\s*prakash|jaiprakash/g, 'जय प्रकाश'],
    [/gaushala|goshala/g, 'गौशाला']
  ];

  for (const [regex, hindiVal] of transMap) s = s.replace(regex, hindiVal);

  return s
    .replace(/[\u0902\u0901]/g, 'न')
    .replace(/[\u093E\u093F\u0940\u0941\u0942\u0943\u0947\u0948\u094B\u094C\u094D]/g, '')
    .replace(/[\s\.\-_]/g, '');
}

function parseTotalQty(val) {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  const numbers = val.toString().match(/\d+/g);
  if (!numbers) return 0;
  return numbers.reduce((sum, n) => sum + Number(n), 0);
}

function repairTruncatedJSON(jsonStr) {
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];
    if (char === '\\' && inString) {
      escaped = !escaped;
      continue;
    }
    if (char === '"' && !escaped) {
      inString = !inString;
    }
    if (!inString) {
      if (char === '{') openBraces++;
      else if (char === '}') openBraces = Math.max(0, openBraces - 1);
      else if (char === '[') openBrackets++;
      else if (char === ']') openBrackets = Math.max(0, openBrackets - 1);
    }
    escaped = false;
  }

  if (inString) jsonStr += '"';
  jsonStr = jsonStr.replace(/,\s*$/, '');

  while (openBrackets > 0) { jsonStr += ']'; openBrackets--; }
  while (openBraces > 0) { jsonStr += '}'; openBraces--; }

  return jsonStr;
}

// --- Dynamic Memory Loader from Sheet ---
async function getDynamicRules() {
  try {
    if (!sheets || !SPREADSHEET_ID) return '';
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Agent_Memory!A2:E'
    });
    const rows = res.data.values || [];
    let memoryPrompt = `CRITICAL CANONICAL RULES (Learned from Owner):\n`;
    memoryPrompt += `- Primary Master Customer: Canonical name is strictly "कधंई" (Village: पूरे काशीराम). Map all spellings (कन्हाई, कन्धाई, कंधाई, कधई, कनहाई, Kanhai) strictly to "कधंई".\n`;

    rows.forEach(r => {
      if (r[1] && r[2]) {
        memoryPrompt += `- Shorthand/Alias "${r[1]}" -> Standard Name: "${r[2]}" (Location: ${r[3] || 'N/A'}). Note: ${r[4] || ''}\n`;
      }
    });
    return memoryPrompt;
  } catch (err) {
    return `- Primary Master Customer: Canonical name is strictly "कधंई" (Village: पूरे काशीराम). Map all spellings (कन्हाई, कन्धाई, कधई) to "कधंई".\n`;
  }
}

// --- Dynamic Prompt Builder ---
async function buildSystemPrompt() {
  const dynamicRules = await getDynamicRules();

  return `
You are the Chief AI Accountant & Operations Manager for an Indian Brick Kiln (ईंट भट्ठा). Current year is 2026.
Analyze transaction text, voice transcripts, or photos of daily diary pages. Return ONLY valid JSON matching this schema:

{
  "intent": "batch_update" | "order" | "dispatch" | "expense" | "daily_summary" | "query_date_summary" | "query_customer" | "update_entry" | "delete_entry" | "recheck_with_image" | "generate_invoice" | "learn_memory" | "coal_entry" | "green_brick_entry" | "clarification" | "ignore",
  "target_tabs": ["Orders" | "Supply_Dispatch" | "Expenses" | "Daily_Closing" | "Customer_Ledger" | "Coal_Fuel_Khata" | "Green_Brick_Stock" | "Agent_Memory" | "ALL"],
  "delete_all": boolean,
  "search_filter": {
    "customer_name": string,
    "paid_to": string,
    "grade": string,
    "date": string,
    "scope": "full" | "closing" | "dispatch" | "orders" | "expenses",
    "row_number": number,
    "row_numbers": [number]
  },
  "fields_to_update": {
    "date": string,
    "village": string,
    "destination": string,
    "grade": string,
    "customer_name": string,
    "quantity": string | number,
    "total_ordered_qty": string | number,
    "dispatched_qty": string | number,
    "total_dispatched": number,
    "amount_payable": number,
    "amount_received": number,
    "driver": string,
    "category": string,
    "paid_to": string,
    "amount": number,
    "remarks": string,
    "status": "Completed" | "Pending" | "Partial"
  },
  "updates": [
    {
      "target_tab": string,
      "row_number": number,
      "filter": { "customer_name": string, "grade": string },
      "fields": object
    }
  ],
  "orders": [
    {
      "date": string,
      "name": string,
      "village": string,
      "grade": string,
      "quantity": string | number,
      "amount_payable": number,
      "amount_received": number,
      "pending_amount": number,
      "mode_of_payment": "Cash" | "UPI" | "Online"
    }
  ],
  "dispatches": [
    {
      "date": string,
      "name": string,
      "village": string,
      "grade": string,
      "total_ordered_qty": string | number,
      "dispatched_qty": string | number,
      "driver": string,
      "is_credit": boolean
    }
  ],
  "expenses": [
    {
      "date": string,
      "category": string,
      "paid_to": string,
      "amount": number,
      "remarks": string
    }
  ],
  "daily_closing": {
    "date": string,
    "opening_balance": number,
    "total_jama": number,
    "total_kharcha": number,
    "maalik_ko_diya": number,
    "closing_balance": number
  },
  "coal_consumption_tubs": number,
  "green_brick_rain_loss": number,
  "pathera_molding_entries": [
    {
      "worker_name": string,
      "bricks_count": number,
      "advance_paid": number
    }
  ],
  "learned_memory_rule": {
    "is_learning_instruction": boolean,
    "category": string,
    "alias_trigger": string,
    "canonical_value": string,
    "associated_location": string
  },
  "invoice_request": {
    "customer_name": string,
    "village": string,
    "grade": string,
    "quantity": number,
    "rate_per_thousand": number
  },
  "reply_text": string
}

${dynamicRules}

PRICE LIST BENCHMARKS:
- अव्वल (Awwal): ₹14,500 – ₹15,500 (per 2,000)
- मीठा (Meetha): ₹12,500 – ₹13,500 (per 2,000 -> ₹6,500 per 1,000)
- खंजड़ (Khanjad): ₹12,000 – ₹13,000 (per 2,000)
- गोड़िया (Godiya): ₹8,500 – ₹9,000 (per 2,000 -> ₹4,500 per 1,000)
- पीला (Peela): ₹8,000 (per 2,000)
- अव्वल रोड़ा: ₹5,000 – ₹5,500 (प्रति ट्रॉली)
- पीला रोड़ा: ₹2,500 – ₹3,000 (प्रति ट्रॉली)

CRITICAL RULES:
1. RODA UNIT IS ALWAYS 'ट्रॉली'.
2. SINGLE ROW PER CUSTOMER FOR MIXED DISPATCHES (e.g. '1000 गोड़िया / 1000 मीठा').
3. Standardize canonical customer 'कधंई' across all orders, dispatches, and queries.
4. Auto-detect Phone Call orders / Voice recordings with advance payments and output in 'orders'.
5. When learning a new rule (e.g. 'याद रखना X का मतलब Y है'), set intent: 'learn_memory' and populate 'learned_memory_rule'.
6. When invoice or bill is requested (e.g. 'कधंई का बिल बनाओ'), set intent: 'generate_invoice' and populate 'invoice_request'.
7. Format all dates as DD-MM-YYYY using current year 2026.
`;
}

// --- Gemini Content Generation Helper ---
async function generateContentWithRetry(contents, retries = 3, delay = 1500) {
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.0,
      maxOutputTokens: 8192
    }
  });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await model.generateContent(contents);
    } catch (err) {
      const status = err.status || (err.response && err.response.status);
      console.warn(`[Gemini Attempt ${attempt}] Status: ${status || err.message}`);
      if ((status === 503 || status === 429 || status === 500) && attempt < retries) {
        await new Promise(res => setTimeout(res, delay));
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
}

// --- Smart Cross-Tab Dispatch Processor ---
async function processBatchDispatches(dateStr, dispatches) {
  if (!sheets || !SPREADSHEET_ID || !dispatches || dispatches.length === 0) return;

  const [dispatchRes, orderRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Supply_Dispatch!A2:J' }),
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A2:I' })
  ]);

  const dispatchRows = dispatchRes.data.values || [];
  const orderRows = orderRes.data.values || [];

  const rowsToAppend = [];
  const updatesToRun = [];

  for (const dispatch of dispatches) {
    const searchNameNorm = normalizeHindi(dispatch.name);
    const targetGradeNorm = normalizeHindi(dispatch.grade);
    const numericDispatched = parseTotalQty(dispatch.dispatched_qty);

    let targetRowIndex = -1;
    let targetRow = null;

    for (let i = 0; i < dispatchRows.length; i++) {
      const rowCustomerNorm = normalizeHindi(dispatchRows[i][1]);
      const rowGradeNorm = normalizeHindi(dispatchRows[i][3]);

      if (searchNameNorm && (rowCustomerNorm.includes(searchNameNorm) || searchNameNorm.includes(rowCustomerNorm))) {
        if (!targetGradeNorm || rowGradeNorm.includes(targetGradeNorm) || targetGradeNorm.includes(rowGradeNorm)) {
          targetRowIndex = i + 2;
          targetRow = dispatchRows[i];
          break;
        }
      }
    }

    let masterOrderedQty = parseTotalQty(dispatch.total_ordered_qty);
    let matchedVillage = dispatch.village || '';

    // Lookup original master order from Orders sheet if Total Ordered is unknown
    if (masterOrderedQty === 0 || !dispatch.total_ordered_qty) {
      if (targetRow && parseTotalQty(targetRow[4]) > 0) {
        masterOrderedQty = parseTotalQty(targetRow[4]);
        matchedVillage = matchedVillage || targetRow[2];
      } else {
        for (let j = orderRows.length - 1; j >= 0; j--) {
          const oNameNorm = normalizeHindi(orderRows[j][1]);
          const oGradeNorm = normalizeHindi(orderRows[j][3]);

          if (searchNameNorm && (oNameNorm.includes(searchNameNorm) || searchNameNorm.includes(oNameNorm))) {
            if (!targetGradeNorm || oGradeNorm.includes(targetGradeNorm) || targetGradeNorm.includes(oGradeNorm)) {
              masterOrderedQty = parseTotalQty(orderRows[j][4]);
              matchedVillage = matchedVillage || orderRows[j][2];
              break;
            }
          }
        }
      }
    }

    if (masterOrderedQty === 0) masterOrderedQty = numericDispatched;

    if (targetRowIndex !== -1 && targetRow) {
      const prevDispatchedNum = parseTotalQty(targetRow[6]) || parseTotalQty(targetRow[5]) || 0;
      const finalDispatchedNum = prevDispatchedNum + numericDispatched;
      const balanceRemaining = Math.max(0, masterOrderedQty - finalDispatchedNum);
      const status = balanceRemaining === 0 ? 'Completed' : 'Partial';

      updatesToRun.push(
        sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `Supply_Dispatch!A${targetRowIndex}:J${targetRowIndex}`,
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[
              dispatch.date || dateStr,
              targetRow[1] || dispatch.name,
              matchedVillage || targetRow[2] || '',
              dispatch.grade || targetRow[3],
              masterOrderedQty,
              dispatch.dispatched_qty,
              finalDispatchedNum,
              balanceRemaining,
              dispatch.driver || targetRow[8] || '',
              status
            ]]
          }
        })
      );
    } else {
      const balanceRemaining = Math.max(0, masterOrderedQty - numericDispatched);
      const status = balanceRemaining === 0 ? 'Completed' : 'Partial';

      rowsToAppend.push([
        dispatch.date || dateStr,
        dispatch.name || 'नकद ग्राहक',
        matchedVillage,
        dispatch.grade || 'अव्वल',
        masterOrderedQty,
        dispatch.dispatched_qty,
        numericDispatched,
        balanceRemaining,
        dispatch.driver || '',
        status
      ]);
    }
  }

  const tasks = [...updatesToRun];
  if (rowsToAppend.length > 0) {
    tasks.push(
      appendWithRetry({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Supply_Dispatch!A:J',
        valueInputOption: 'USER_ENTERED',
        resource: { values: rowsToAppend }
      })
    );
  }
  await Promise.all(tasks);
}

// --- Customer Ledger Rebuild Engine ---
async function regenerateCustomerLedger() {
  if (!sheets || !SPREADSHEET_ID) return;
  try {
    const [ordersRes, dispatchRes] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A2:I' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Supply_Dispatch!A2:J' })
    ]);

    const orders = ordersRes.data.values || [];
    const dispatches = dispatchRes.data.values || [];
    const ledgerMap = new Map();

    for (const o of orders) {
      const name = o[1];
      if (!name) continue;
      const key = normalizeHindi(name);
      const item = ledgerMap.get(key) || { name, village: o[2] || '', orderedBricks: 0, dispatchedBricks: 0, totalBilled: 0, totalPaid: 0 };
      item.orderedBricks += parseTotalQty(o[4]);
      item.totalBilled += Number(o[5]) || 0;
      item.totalPaid += Number(o[6]) || 0;
      ledgerMap.set(key, item);
    }

    for (const d of dispatches) {
      const name = d[1];
      if (!name) continue;
      const key = normalizeHindi(name);
      const item = ledgerMap.get(key) || { name, village: d[2] || '', orderedBricks: parseTotalQty(d[4]), dispatchedBricks: 0, totalBilled: 0, totalPaid: 0 };
      item.dispatchedBricks += parseTotalQty(d[6]) || parseTotalQty(d[5]);
      ledgerMap.set(key, item);
    }

    const ledgerRows = [];
    for (const [, acc] of ledgerMap.entries()) {
      const pendingBricks = Math.max(0, acc.orderedBricks - acc.dispatchedBricks);
      const netDue = Math.max(0, acc.totalBilled - acc.totalPaid);
      const status = (pendingBricks === 0 && netDue === 0) ? 'बेबाक (Settled)' : 'बाकी (Pending)';

      ledgerRows.push([
        acc.name,
        acc.village,
        acc.orderedBricks,
        acc.dispatchedBricks,
        pendingBricks,
        acc.totalBilled,
        acc.totalPaid,
        netDue,
        status
      ]);
    }

    if (ledgerRows.length > 0) {
      await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: 'Customer_Ledger!A2:I' });
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Customer_Ledger!A2:I',
        valueInputOption: 'USER_ENTERED',
        resource: { values: ledgerRows }
      });
      console.log(`[Ledger] Rebuilt ${ledgerRows.length} customer ledger accounts.`);
    }
  } catch (err) {
    console.error('[Ledger Regeneration Error]:', err.message);
  }
}

// --- GST 6% Invoice Formatter ---
function formatGSTInvoice({ invoiceNo, date, customerName, village, grade, qty, ratePerThousand }) {
  const quantity = Number(qty) || 2000;
  const rate = Number(ratePerThousand) || 7500;
  const taxableValue = (quantity * rate) / 1000;
  const cgst = taxableValue * 0.03;
  const sgst = taxableValue * 0.03;
  const totalAmount = taxableValue + cgst + sgst;

  return `
=========================================
          ${process.env.KILN_NAME || 'श्री गणेश ईंट उद्योग'}
           TAX INVOICE (पक्का बिल)
=========================================
इनवॉइस सं०: ${invoiceNo || `BK-${Date.now().toString().slice(-4)}`}
दिनांक: ${date || getISTDate(0)}
GSTIN: ${process.env.KILN_GSTIN || '09AAAAA0000A1Z5'}
State: Uttar Pradesh (Code: ${process.env.KILN_STATE_CODE || '09'})

क्रेता का विवरण (Billed To):
नाम: ${customerName || 'कधंई'}
गाँव/पता: ${village || 'पूरे काशीराम'}, उत्तर प्रदेश
-----------------------------------------
विवरण: लाल पक्की ईंट (${grade || 'अव्वल'})
HSN Code: 69041000
मात्रा: ${quantity.toLocaleString('en-IN')} नग
दर (Rate): ₹${rate.toLocaleString('en-IN')} / हज़ार
-----------------------------------------
कर योग्य मूल्य (Taxable Amount): ₹${taxableValue.toFixed(2)}
CGST @ 3%                     : ₹${cgst.toFixed(2)}
SGST @ 3%                     : ₹${sgst.toFixed(2)}
-----------------------------------------
कुल इनवॉइस मूल्य (Total Value) : ₹${totalAmount.toFixed(2)}
=========================================
बैंक विवरण (Bank Details):
• बैंक: ${process.env.BANK_NAME || 'State Bank of India'}
• खाता: ${process.env.BANK_ACCOUNT_NO || 'XXXXXXXXXXXX1234'}
• IFSC: ${process.env.BANK_IFSC || 'SBIN000XXXX'}
• खाता धारक: ${process.env.BANK_ACCOUNT_HOLDER || 'श्री गणेश ईंट उद्योग'}
=========================================`;
}

// --- Dynamic Row-by-Row Update Core ---
async function updateSingleRow(tab, rowIndex, updates) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tab}!A${rowIndex}:J${rowIndex}`
    });
    const row = res.data.values?.[0] || [];
    while (row.length < 10) row.push('');

    if (updates.date) row[0] = updates.date;

    if (tab === 'Orders') {
      if (updates.customer_name || updates.name) row[1] = updates.customer_name || updates.name;
      if (updates.village || updates.destination) row[2] = updates.village || updates.destination;
      if (updates.grade) row[3] = updates.grade;
      if (updates.quantity !== undefined) row[4] = updates.quantity;
      if (updates.amount_payable !== undefined) row[5] = updates.amount_payable;
      if (updates.amount_received !== undefined) row[6] = updates.amount_received;
      row[7] = Math.max(0, (Number(row[5]) || 0) - (Number(row[6]) || 0));
      if (updates.mode_of_payment) row[8] = updates.mode_of_payment;
    } else if (tab === 'Supply_Dispatch') {
      if (updates.customer_name || updates.name) row[1] = updates.customer_name || updates.name;
      if (updates.village || updates.destination) row[2] = updates.village || updates.destination;
      if (updates.grade) row[3] = updates.grade;
      if (updates.total_ordered_qty !== undefined) row[4] = updates.total_ordered_qty;
      if (updates.dispatched_qty !== undefined) row[5] = updates.dispatched_qty;
      if (updates.total_dispatched !== undefined) {
        row[6] = Number(updates.total_dispatched) || parseTotalQty(updates.total_dispatched);
      }
      const ord = parseTotalQty(row[4]);
      const disp = Number(row[6]) || 0;
      row[7] = Math.max(0, ord - disp);
      if (updates.driver !== undefined) row[8] = updates.driver;
      row[9] = row[7] === 0 ? 'Completed' : 'Partial';
    } else if (tab === 'Expenses') {
      if (updates.category) row[1] = updates.category;
      if (updates.paid_to) row[2] = updates.paid_to;
      if (updates.amount !== undefined) row[3] = updates.amount;
      if (updates.remarks) row[4] = updates.remarks;
    } else if (tab === 'Daily_Closing') {
      if (updates.opening_balance !== undefined) row[1] = updates.opening_balance;
      if (updates.total_jama !== undefined) row[2] = updates.total_jama;
      if (updates.total_kharcha !== undefined) row[3] = updates.total_kharcha;
      if (updates.maalik_ko_diya !== undefined) row[4] = updates.maalik_ko_diya;
      if (updates.closing_balance !== undefined) row[5] = updates.closing_balance;
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tab}!A${rowIndex}:J${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] }
    });
    return true;
  } catch (err) {
    console.error(`[Update Row Error ${tab}:${rowIndex}]:`, err.message);
    return false;
  }
}

async function findRowByFilter(tab, filter) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tab}!A2:J` });
    const rows = res.data.values || [];
    const searchNameNorm = normalizeHindi(filter?.customer_name || filter?.name);
    const searchPayeeNorm = normalizeHindi(filter?.paid_to);
    const searchGradeNorm = normalizeHindi(filter?.grade);

    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const matchName = searchNameNorm && (normalizeHindi(row[1]).includes(searchNameNorm) || searchNameNorm.includes(normalizeHindi(row[1])));
      const matchPayee = searchPayeeNorm && (normalizeHindi(row[2]).includes(searchPayeeNorm) || searchPayeeNorm.includes(normalizeHindi(row[2])));

      if (matchName || matchPayee) {
        if (searchGradeNorm && row[3] && !normalizeHindi(row[3]).includes(searchGradeNorm)) continue;
        return i + 2;
      }
    }
  } catch (err) {
    console.error(`[Find Row Error in ${tab}]:`, err.message);
  }
  return -1;
}

async function executeBatchUpdates(updatesList) {
  if (!sheets || !SPREADSHEET_ID || !Array.isArray(updatesList) || updatesList.length === 0) return 0;
  let updatedCount = 0;
  for (const item of updatesList) {
    const tab = item.target_tab || 'Supply_Dispatch';
    let targetRow = item.row_number;
    if (!targetRow || targetRow < 2) {
      targetRow = await findRowByFilter(tab, item.filter || item);
    }
    if (targetRow && targetRow >= 2) {
      const ok = await updateSingleRow(tab, targetRow, item.fields || item.fields_to_update || item);
      if (ok) updatedCount++;
    }
  }
  return updatedCount;
}

async function deleteSheetEntries(targetTabs, filter, deleteAll = false) {
  if (!sheets || !SPREADSHEET_ID) return { success: false, deletedFrom: [], count: 0 };
  const allTabs = ['Orders', 'Supply_Dispatch', 'Expenses', 'Daily_Closing'];
  const tabsToProcess = (targetTabs === 'ALL' || !targetTabs) ? allTabs : (Array.isArray(targetTabs) ? targetTabs : [targetTabs]);
  const deletedTabs = [];

  if (deleteAll) {
    await Promise.all(
      tabsToProcess.map(tab =>
        sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `${tab}!A2:Z` })
          .then(() => deletedTabs.push(tab))
          .catch(err => console.error(`[Clear Error in ${tab}]:`, err.message))
      )
    );
    return { success: deletedTabs.length > 0, deletedFrom: deletedTabs, clearedAll: true, count: 0 };
  }

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  let totalDeletedCount = 0;
  const searchNameNorm = normalizeHindi(filter?.customer_name);

  for (const tab of tabsToProcess) {
    const sheetMeta = meta.data.sheets.find(s => s.properties.title === tab);
    if (!sheetMeta) continue;
    const sheetId = sheetMeta.properties.sheetId;

    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tab}!A2:J` });
    const rows = res.data.values || [];
    if (rows.length === 0) continue;

    const requests = [];
    if (searchNameNorm) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (normalizeHindi(rows[i][1]).includes(searchNameNorm)) {
          requests.push({
            deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: i + 1, endIndex: i + 2 } }
          });
          totalDeletedCount++;
          break;
        }
      }
    }

    if (requests.length > 0) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests } });
      deletedTabs.push(tab);
    }
  }

  return { success: deletedTabs.length > 0, deletedFrom: deletedTabs, clearedAll: false, count: totalDeletedCount };
}

// --- Date Report Generator ---
async function generateDateReport(dateStr, scope = 'full') {
  if (!sheets || !SPREADSHEET_ID) return null;
  const targetDate = resolveDateStr(dateStr);

  try {
    const [closingRes, dispatchRes, orderRes, expenseRes] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Daily_Closing!A2:F' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Supply_Dispatch!A2:J' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A2:I' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Expenses!A2:E' })
    ]);

    const isDateMatch = cell => cell && cell.toString().replace(/\//g, '-').trim() === targetDate;

    const closingRows = (closingRes.data.values || []).filter(r => isDateMatch(r[0]));
    const dispatchRows = (dispatchRes.data.values || []).filter(r => isDateMatch(r[0]));
    const expenseRows = (expenseRes.data.values || []).filter(r => isDateMatch(r[0]));
    const closing = closingRows[closingRows.length - 1];

    if (!closing && dispatchRows.length === 0 && expenseRows.length === 0) {
      return `⚠️ दिनांक *${targetDate}* का कोई रिकॉर्ड शीट में दर्ज नहीं मिला।`;
    }

    let fullText = `📋 *दिनांक ${targetDate} का दैनिक हिसाब*\n`;
    if (closing) {
      fullText += `\n💰 *रोकड़ मिलान:*` +
                  `\n• प्रारम्भिक बचत: ₹${Number(closing[1] || 0).toLocaleString('en-IN')}` +
                  `\n• कुल जमा (Jama): ₹${Number(closing[2] || 0).toLocaleString('en-IN')}` +
                  `\n• कुल खर्चा (Kharcha): ₹${Number(closing[3] || 0).toLocaleString('en-IN')}` +
                  `\n• मालिक को दिया: ₹${Number(closing[4] || 0).toLocaleString('en-IN')}` +
                  `\n• *अंतिम बचत (Closing): ₹${Number(closing[5] || 0).toLocaleString('en-IN')}*`;
    }

    if (dispatchRows.length > 0) {
      fullText += `\n\n🚚 *सप्लाई / डिस्पैच (${dispatchRows.length} गाड़ियां):*`;
      dispatchRows.forEach((d, i) => {
        fullText += `\n${i + 1}. ${d[1]} (${d[2] || 'भट्ठा'}): ${d[5] || d[4]} [${d[3]}] ${d[8] ? `- ड्राइवर ${d[8]}` : ''}`;
      });
    }

    if (expenseRows.length > 0) {
      let expSum = 0;
      fullText += `\n\n💸 *खर्च विवरण:*`;
      expenseRows.forEach((e, i) => {
        const amt = Number(e[3]) || 0;
        expSum += amt;
        fullText += `\n• ${e[2] || e[1]}: ₹${amt.toLocaleString('en-IN')} ${e[4] ? `(${e[4]})` : ''}`;
      });
      fullText += `\n*कुल खर्चा:* ₹${expSum.toLocaleString('en-IN')}`;
    }

    return fullText;
  } catch (err) {
    console.error('[Date Report Error]:', err.message);
    return null;
  }
}

// --- Customer Search Helper ---
async function getCustomerDetails(customerName, targetDate = null) {
  if (!sheets || !SPREADSHEET_ID || !customerName) return null;
  const searchNorm = normalizeHindi(customerName);
  const cleanDate = targetDate ? resolveDateStr(targetDate) : null;

  try {
    const [dispatchRes, orderRes, ledgerRes] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Supply_Dispatch!A2:J' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A2:I' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Customer_Ledger!A2:I' })
    ]);

    const dispatchRows = dispatchRes.data.values || [];
    const orderRows = orderRes.data.values || [];
    const ledgerRows = ledgerRes.data.values || [];

    const dispatches = dispatchRows.filter(row => {
      const nameNorm = normalizeHindi(row[1]);
      const matchName = nameNorm && (nameNorm.includes(searchNorm) || searchNorm.includes(nameNorm));
      const rowDate = (row[0] || '').replace(/\//g, '-').trim();
      return matchName && (cleanDate ? rowDate === cleanDate : true);
    });

    const orders = orderRows.filter(row => {
      const nameNorm = normalizeHindi(row[1]);
      const matchName = nameNorm && (nameNorm.includes(searchNorm) || searchNorm.includes(nameNorm));
      const rowDate = (row[0] || '').replace(/\//g, '-').trim();
      return matchName && (cleanDate ? rowDate === cleanDate : true);
    });

    const ledgerAcc = ledgerRows.find(r => normalizeHindi(r[0]).includes(searchNorm));

    if (dispatches.length === 0 && orders.length === 0 && !ledgerAcc) return null;

    return {
      name: ledgerAcc?.[0] || dispatches[0]?.[1] || orders[0]?.[1] || customerName,
      village: ledgerAcc?.[1] || dispatches[0]?.[2] || orders[0]?.[2] || '',
      filterDate: cleanDate,
      ledger: ledgerAcc ? {
        orderedBricks: ledgerAcc[2],
        dispatchedBricks: ledgerAcc[3],
        pendingBricks: ledgerAcc[4],
        totalBilled: ledgerAcc[5],
        totalPaid: ledgerAcc[6],
        netDue: ledgerAcc[7],
        status: ledgerAcc[8]
      } : null,
      dispatches: dispatches.map(d => ({
        date: d[0], grade: d[3], qty: d[5] || d[4], total_disp: d[6], remaining: d[7], driver: d[8], status: d[9]
      })),
      orders: orders.map(o => ({
        date: o[0], grade: o[3], qty: o[4], payable: o[5], received: o[6], pending: o[7]
      }))
    };
  } catch (err) {
    console.error('[Customer Query Error]:', err.message);
    return null;
  }
}

// --- Smart Idempotent Schema Structure Synchronizer ---
async function ensureSchemaStructure() {
  if (!sheets || !SPREADSHEET_ID) return;

  const SCHEMA = {
    "Daily_Closing": ["Date", "Opening_Balance", "Total_Jama", "Total_Kharcha", "Maalik_Ko_Diya", "Closing_Balance"],
    "Orders": ["Date", "Customer_Name", "Village", "Brick_Grade", "Quantity", "Amount_Payable", "Amount_Received", "Pending_Amount", "Mode_of_Payment"],
    "Supply_Dispatch": ["Date", "Customer_Name", "Village", "Brick_Grade", "Master_Order_Qty", "Dispatched_Today", "Total_Dispatched", "Remaining_Bricks", "Driver", "Status"],
    "Expenses": ["Date", "Category", "Paid_To", "Amount", "Remarks"],
    "Customer_Ledger": ["Customer_Name", "Village", "Ordered_Bricks", "Dispatched_Bricks", "Pending_Bricks", "Total_Billed", "Total_Paid", "Net_Due", "Status"],
    "Agent_Memory": ["Category", "Alias_Trigger", "Canonical_Value", "Associated_Location", "Notes"],
    "Coal_Fuel_Khata": ["Date", "Description", "Inward_MT", "Rate", "Tubs_Burnt", "Kg_Per_Tub", "Consumed_MT", "Status"],
    "Green_Brick_Stock": ["Date", "Molded_Inward", "Bhari_Loaded", "Rain_Damage_Lost", "Status"],
    "Stock_Inventory": ["Date", "Brick_Grade", "Opening_Stock", "Production_Nikasi", "Dispatched_Deducted", "Damaged_Lost", "Closing_Stock"],
    "Labor_Pathera_Khata": ["Date", "Worker_Name", "Work_Type", "Bricks_Counted", "Rate_Per_1000", "Wages_Earned", "Advance_Khoraki_Paid", "Net_Labor_Balance"]
  };

  const SEED_MEMORY = [
    ["Primary Customer", "कन्हाई", "कधंई", "पूरे काशीराम", "Master name mapping"],
    ["Primary Customer", "कन्धाई", "कधंई", "पूरे काशीराम", "Master name mapping"],
    ["Primary Customer", "कधई", "कधंई", "पूरे काशीराम", "Master name mapping"],
    ["Primary Customer", "कनहाई", "कधंई", "पूरे काशीराम", "Master name mapping"]
  ];

  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheetMap = new Map();
    meta.data.sheets.forEach(s => sheetMap.set(s.properties.title, s.properties.sheetId));

    // 1. Create missing tabs only
    const missingTabs = Object.keys(SCHEMA).filter(t => !sheetMap.has(t));
    if (missingTabs.length > 0) {
      console.log(`[Schema Sync] Creating ${missingTabs.length} missing tab(s): ${missingTabs.join(', ')}`);
      const createRes = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: missingTabs.map(title => ({ addSheet: { properties: { title } } }))
        }
      });
      createRes.data.replies.forEach(r => {
        sheetMap.set(r.addSheet.properties.title, r.addSheet.properties.sheetId);
      });
    }

    // 2. Fetch all existing Row 1 headers in a single batch read
    const ranges = Object.keys(SCHEMA).map(t => `${t}!1:1`);
    const batchRes = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: SPREADSHEET_ID,
      ranges
    });

    const formatRequests = [];
    const valueUpdates = [];

    Object.keys(SCHEMA).forEach((tabName, idx) => {
      const requiredHeaders = SCHEMA[tabName];
      const existingHeaders = batchRes.data.valueRanges[idx]?.values?.[0] || [];
      const sheetId = sheetMap.get(tabName);

      const isHeaderMismatch =
        requiredHeaders.length !== existingHeaders.length ||
        requiredHeaders.some((h, i) => h !== existingHeaders[i]);

      if (isHeaderMismatch) {
        console.log(`[Schema Sync] Updating headers for tab: ${tabName}`);

        valueUpdates.push({
          range: `${tabName}!A1:${String.fromCharCode(64 + requiredHeaders.length)}1`,
          values: [requiredHeaders]
        });

        formatRequests.push(
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: requiredHeaders.length
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.91, green: 0.92, blue: 0.93 },
                  textFormat: { bold: true, underline: true, fontSize: 12 },
                  horizontalAlignment: 'CENTER'
                }
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
            }
          },
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: 'gridProperties.frozenRowCount'
            }
          }
        );
      }
    });

    if (valueUpdates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { valueInputOption: 'USER_ENTERED', data: valueUpdates }
      });
    }

    if (formatRequests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { requests: formatRequests }
      });
    }

    // 3. Seed canonical memory if Agent_Memory is empty
    const memCheck = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Agent_Memory!A2:E'
    });
    if (!memCheck.data.values || memCheck.data.values.length === 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Agent_Memory!A:E',
        valueInputOption: 'USER_ENTERED',
        resource: { values: SEED_MEMORY }
      });
    }

    if (missingTabs.length === 0 && valueUpdates.length === 0) {
      console.log('⚡ [Schema Sync] Sheet structure is already up-to-date. Zero API writes needed.');
    }
  } catch (err) {
    console.error('[Schema Sync Error]:', err.message);
  }
}

// --- Main Webhook Endpoint ---
app.post(['/webhook', '/webhook/*', '/webhook/messages-upsert'], async (req, res) => {
  res.sendStatus(200);

  try {
    const data = req.body?.data;
    if (!data || data.key?.fromMe) return;

    const sender = data.key?.remoteJid || '';
    const messageId = data.key?.id || '';

    if (!sender || sender.includes('@g.us')) return;

    const cleanSenderNumber = sender.replace('@s.whatsapp.net', '').replace('@c.us', '').trim();
    if (!cleanSenderNumber) return;

    if (ALLOWED_NUMBERS.length > 0 && !ALLOWED_NUMBERS.includes(cleanSenderNumber)) return;
    if (checkAndLockMessage(messageId)) return;

    const systemPrompt = await buildSystemPrompt();
    let contents = [];
    const message = data.message;
    const text = message?.conversation || message?.extendedTextMessage?.text;
    const audioMessage = message?.audioMessage;
    const imageMessage = message?.imageMessage;

    if (imageMessage) {
      const caption = imageMessage.caption || '';
      const base64Image = req.body?.data?.message?.base64 || '';
      if (!base64Image) return;
      const mimeType = imageMessage.mimetype || 'image/jpeg';
      lastImageCache.set(cleanSenderNumber, { base64: base64Image, mimeType });

      contents = [
        `${systemPrompt}\n\nUSER CAPTION: "${caption}"\nExtract all transactions, dispatches, jama, and closing balances from this diary image.`,
        { inlineData: { mimeType, data: base64Image } }
      ];
    } else if (text) {
      contents = [`${systemPrompt}\n\nInput message / voice order transcript: "${text}"`];
    } else if (audioMessage) {
      const base64Audio = req.body?.data?.message?.base64 || '';
      if (!base64Audio) return;
      contents = [
        `${systemPrompt}\n\nTranscribe and parse phone call recording / audio voice note into structured brick kiln orders, dispatches, or expenses.`,
        { inlineData: { mimeType: 'audio/ogg; codecs=opus', data: base64Audio } }
      ];
    } else {
      return;
    }

    const result = await generateContentWithRetry(contents);
    let rawText = result.response.text().trim();
    const firstBrace = rawText.indexOf('{');
    if (firstBrace !== -1) rawText = rawText.slice(firstBrace);

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      parsed = JSON.parse(repairTruncatedJSON(rawText));
    }
    console.log('[Parsed Intent]:', parsed.intent);

    const defaultDate = getISTDate(0);

    // --- 1. DYNAMIC MEMORY RULE LEARNING ---
    if (parsed.intent === 'learn_memory' || (parsed.learned_memory_rule && parsed.learned_memory_rule.is_learning_instruction)) {
      const mem = parsed.learned_memory_rule;
      if (sheets && mem?.alias_trigger && mem?.canonical_value) {
        await appendWithRetry({
          spreadsheetId: SPREADSHEET_ID,
          range: 'Agent_Memory!A:E',
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[
              mem.category || 'Customer Alias',
              mem.alias_trigger,
              mem.canonical_value,
              mem.associated_location || '',
              'Trained from WhatsApp chat'
            ]]
          }
        });
        await sendWhatsAppReply(sender, `🧠 *नया नियम याद कर लिया गया है!*\n• उपनाम/गलत वर्तनी: "${mem.alias_trigger}"\n• सही मानक नाम: *${mem.canonical_value}* ${mem.associated_location ? `(${mem.associated_location})` : ''}`);
        return;
      }
    }

    // --- 2. GST INVOICE GENERATION ---
    if (parsed.intent === 'generate_invoice' || (text && (text.includes('बिल बनाओ') || text.toLowerCase().startsWith('bill')))) {
      const invReq = parsed.invoice_request || {};
      const invoiceCard = formatGSTInvoice({
        invoiceNo: `BK-${Date.now().toString().slice(-4)}`,
        date: defaultDate,
        customerName: invReq.customer_name || 'कधंई',
        village: invReq.village || 'पूरे काशीराम',
        grade: invReq.grade || 'अव्वल',
        qty: invReq.quantity || 2000,
        ratePerThousand: invReq.rate_per_thousand || 7500
      });
      await sendWhatsAppReply(sender, invoiceCard);
      return;
    }

    // --- 3. SCOPED DATE QUERIES ---
    if (parsed.intent === 'query_date_summary' && sheets) {
      const targetDate = parsed.search_filter?.date || 'yesterday';
      const scope = parsed.search_filter?.scope || 'full';
      const report = await generateDateReport(targetDate, scope);
      await sendWhatsAppReply(sender, report || 'संबंधित तारीख का कोई रिकॉर्ड नहीं मिला।');
    }
    // --- 4. CUSTOMER QUERIES WITH DUAL LEDGER ---
    else if (parsed.intent === 'query_customer' && sheets) {
      const customerName = parsed.search_filter?.customer_name || parsed.name;
      const dateFilter = parsed.search_filter?.date || null;
      const data = await getCustomerDetails(customerName, dateFilter);

      if (data) {
        let reply = `🧱 *ग्राहक खाता बही: ${data.name}* ${data.village ? `(${data.village})` : ''}\n`;
        if (data.ledger) {
          reply += `\n📊 *लाइव खाता स्थिति:*` +
                   `\n• कुल बुक ईंटें: ${Number(data.ledger.orderedBricks).toLocaleString('en-IN')}` +
                   `\n• सप्लाई हो चुकीं: ${Number(data.ledger.dispatchedBricks).toLocaleString('en-IN')}` +
                   `\n• *बाकी ईंटें (Pending): ${Number(data.ledger.pendingBricks).toLocaleString('en-IN')}*` +
                   `\n• कुल बिल: ₹${Number(data.ledger.totalBilled).toLocaleString('en-IN')}` +
                   `\n• कुल जमा: ₹${Number(data.ledger.totalPaid).toLocaleString('en-IN')}` +
                   `\n• *बकाया रकम (Due): ₹${Number(data.ledger.netDue).toLocaleString('en-IN')}*` +
                   `\n• खाता स्थिति: *${data.ledger.status}*\n`;
        }

        if (data.dispatches.length > 0) {
          reply += `\n🚚 *हालिया सप्लाई विवरण:*`;
          data.dispatches.slice(-3).forEach(d => {
            reply += `\n• ${d.date}: ${d.qty} [${d.grade}] | बाकी: ${d.remaining} (${d.driver || 'N/A'})`;
          });
        }
        await sendWhatsAppReply(sender, reply);
      } else {
        await sendWhatsAppReply(sender, `माफ कीजिए, "${customerName}" का कोई रिकॉर्ड नहीं मिला।`);
      }
    }
    // --- 5. BATCH TRANSACTION ENTRIES & CROSS-RECONCILIATION ---
    else if ((parsed.intent === 'batch_update' || parsed.intent === 'recheck_with_image') && sheets) {
      const asyncTasks = [];

      // A. Save Orders
      if (parsed.orders && parsed.orders.length > 0) {
        const orderRows = parsed.orders.map(o => [
          o.date || defaultDate,
          o.name || 'नकद ग्राहक',
          o.village || '',
          o.grade || 'अव्वल',
          o.quantity || 0,
          o.amount_payable || (o.amount_received || 0),
          o.amount_received || 0,
          o.pending_amount || Math.max(0, (o.amount_payable || 0) - (o.amount_received || 0)),
          o.mode_of_payment || 'Cash'
        ]);
        asyncTasks.push(
          appendWithRetry({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Orders!A:I',
            valueInputOption: 'USER_ENTERED',
            resource: { values: orderRows }
          })
        );
      }

      // B. Save Dispatches with Cross-Tab Match
      if (parsed.dispatches && parsed.dispatches.length > 0) {
        asyncTasks.push(processBatchDispatches(defaultDate, parsed.dispatches));
      }

      // C. Save Expenses
      if (parsed.expenses && parsed.expenses.length > 0) {
        const expenseRows = parsed.expenses.map(e => [
          e.date || defaultDate,
          e.category || 'अन्य',
          e.paid_to || '',
          e.amount || 0,
          e.remarks || ''
        ]);
        asyncTasks.push(
          appendWithRetry({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Expenses!A:E',
            valueInputOption: 'USER_ENTERED',
            resource: { values: expenseRows }
          })
        );
      }

      // D. Cash Math Verification & Daily Closing
      let anomalyAlert = '';
      if (parsed.daily_closing && (parsed.daily_closing.total_jama || parsed.daily_closing.closing_balance)) {
        const dc = parsed.daily_closing;
        const opening = Number(dc.opening_balance) || 0;
        const jama = Number(dc.total_jama) || 0;
        const kharcha = Number(dc.total_kharcha) || 0;
        const owner = Number(dc.maalik_ko_diya) || 0;
        const reportedClosing = Number(dc.closing_balance) || 0;
        const expectedClosing = opening + jama - kharcha - owner;
        const diff = reportedClosing - expectedClosing;

        if (diff !== 0) {
          anomalyAlert = `\n\n⚠️ *रोकड़ गड़बड़ी अलर्ट:* मुंशी के हिसाब में ₹${Math.abs(diff)} का अंतर है (अपेक्षित बचत: ₹${expectedClosing}, मुंशी बचत: ₹${reportedClosing})।`;
        }

        asyncTasks.push(
          appendWithRetry({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Daily_Closing!A:F',
            valueInputOption: 'USER_ENTERED',
            resource: {
              values: [[
                dc.date || defaultDate,
                opening, jama, kharcha, owner, reportedClosing
              ]]
            }
          })
        );
      }

      // E. Coal Consumption Calculation
      if (parsed.coal_consumption_tubs && Number(parsed.coal_consumption_tubs) > 0) {
        const tubs = Number(parsed.coal_consumption_tubs);
        const consumedMT = (tubs * COAL_TUB_KG) / 1000;
        asyncTasks.push(
          appendWithRetry({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Coal_Fuel_Khata!A:H',
            valueInputOption: 'USER_ENTERED',
            resource: {
              values: [[defaultDate, 'Daily Feeding (झोकाई)', 0, 0, tubs, COAL_TUB_KG, consumedMT, 'Debited']]
            }
          })
        );
      }

      // F. Green Brick Rain Damage
      if (parsed.green_brick_rain_loss && Number(parsed.green_brick_rain_loss) > 0) {
        asyncTasks.push(
          appendWithRetry({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Green_Brick_Stock!A:E',
            valueInputOption: 'USER_ENTERED',
            resource: {
              values: [[defaultDate, 0, 0, Number(parsed.green_brick_rain_loss), 'Rain Damage Write-off']]
            }
          })
        );
      }

      await Promise.all(asyncTasks);

      // Rebuild Master Customer Ledger
      await regenerateCustomerLedger();

      const finalReply = (parsed.reply_text || '✅ डायरी डेटा सफलतापूर्वक दर्ज कर दिया गया है।') + anomalyAlert;
      await sendWhatsAppReply(sender, finalReply);
    }
    // --- 6. SINGLE ORDER / DISPATCH / EXPENSE INTENTS ---
    else if (parsed.intent === 'order' && sheets) {
      const ordersToProcess = (parsed.orders && parsed.orders.length > 0) ? parsed.orders : [parsed];
      const rows = ordersToProcess.map(o => [
        o.date || defaultDate,
        o.name || 'नकद ग्राहक',
        o.village || '',
        o.grade || 'अव्वल',
        o.quantity || 0,
        o.amount_payable || (o.amount_received || 0),
        o.amount_received || 0,
        o.pending_amount || 0,
        o.mode_of_payment || 'Cash'
      ]);
      await appendWithRetry({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A:I', valueInputOption: 'USER_ENTERED', resource: { values: rows } });
      await regenerateCustomerLedger();
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }
    else if (parsed.intent === 'dispatch' && sheets) {
      const dispatchesToProcess = (parsed.dispatches && parsed.dispatches.length > 0) ? parsed.dispatches : [parsed];
      await processBatchDispatches(defaultDate, dispatchesToProcess);
      await regenerateCustomerLedger();
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }
    else if (parsed.intent === 'expense' && sheets) {
      const expensesToProcess = (parsed.expenses && parsed.expenses.length > 0) ? parsed.expenses : [parsed];
      const rows = expensesToProcess.map(e => [
        e.date || defaultDate,
        e.category || 'अन्य',
        e.paid_to || '',
        e.amount || 0,
        e.remarks || ''
      ]);
      await appendWithRetry({ spreadsheetId: SPREADSHEET_ID, range: 'Expenses!A:E', valueInputOption: 'USER_ENTERED', resource: { values: rows } });
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }
    // --- 7. UPDATES & DELETIONS ---
    else if (parsed.intent === 'update_entry' && sheets) {
      let updatesList = Array.isArray(parsed.updates) && parsed.updates.length > 0 ? parsed.updates : [{
        target_tab: (parsed.target_tabs && parsed.target_tabs[0]) || 'Supply_Dispatch',
        row_number: parsed.search_filter?.row_number,
        filter: parsed.search_filter,
        fields: parsed.fields_to_update
      }];
      const count = await executeBatchUpdates(updatesList);
      await regenerateCustomerLedger();
      await sendWhatsAppReply(sender, count > 0 ? (parsed.reply_text || `✅ ${count} प्रविष्टि(याँ) अपडेट हो गईं।`) : 'माफ कीजिए, यह एंट्री नहीं मिली।');
    }
    else if (parsed.intent === 'delete_entry' && sheets) {
      const result = await deleteSheetEntries(parsed.target_tabs, parsed.search_filter, parsed.delete_all || false);
      if (parsed.delete_all) lastImageCache.delete(cleanSenderNumber);
      await regenerateCustomerLedger();
      await sendWhatsAppReply(sender, result.success ? (parsed.reply_text || `✅ प्रविष्टि हटा दी गई है।`) : 'डिलीट करने के लिए कोई एंट्री नहीं मिली।');
    }
    else if (parsed.reply_text) {
      await sendWhatsAppReply(sender, parsed.reply_text);
    }
  } catch (error) {
    console.error('[Webhook Error]:', error);
  }
});

// --- Scheduled End-of-Day Owner WhatsApp Report (8:30 PM IST Daily) ---
cron.schedule('30 20 * * *', async () => {
  try {
    const today = getISTDate(0);
    const report = await generateDateReport(today, 'full');
    if (report && OWNER_PHONE_NUMBER) {
      const header = `👑 *मालिक दैनिक रिपोर्ट (Daily Owner Snapshot)*\n`;
      await sendWhatsAppReply(OWNER_PHONE_NUMBER, header + report);
      console.log(`[Cron] Nightly report dispatched to Owner (${OWNER_PHONE_NUMBER}).`);
    }
  } catch (err) {
    console.error('[Nightly Cron Error]:', err.message);
  }
}, {
  timezone: 'Asia/Kolkata'
});

app.listen(PORT, async () => {
  console.log(`🚀 Brick Kiln Munshi AI Server running on port ${PORT}`);
  await ensureSchemaStructure();
});
