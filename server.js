require('dotenv').config();
const fs = require('fs');
const express = require('express');
const axios = require('axios');
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

// --- Authorized Phone Whitelist ---
const ALLOWED_NUMBERS = process.env.ALLOWED_NUMBERS
  ? process.env.ALLOWED_NUMBERS.split(',').map(num => num.trim())
  : ['919277078095'];

// --- Deduplication Cache ---
const processedMessageIds = new Set();
const MAX_TRACKED_IDS = 500;

function isDuplicateMessage(messageId) {
  if (!messageId) return false;
  return processedMessageIds.has(messageId);
}

function markMessageProcessed(messageId) {
  if (!messageId) return;
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > MAX_TRACKED_IDS) {
    const oldest = processedMessageIds.values().next().value;
    processedMessageIds.delete(oldest);
  }
}

// --- In-Memory Image Cache for Cross-Verification ---
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

// --- Date Formatter Helper ---
function getISTDateOnly() {
  const now = new Date();
  return now.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' }).replace(/\//g, '-');
}

// --- Sheets API Helper with Exponential Backoff Retry ---
async function appendWithRetry(params, retries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await sheets.spreadsheets.values.append(params);
    } catch (err) {
      const status = err.status || err.code || (err.response && err.response.status);
      if ((status === 503 || status === 500 || status === 429) && attempt < retries) {
        console.warn(`[Sheets Warning] Attempt ${attempt} failed with ${status}. Retrying in ${delay}ms...`);
        await new Promise(res => setTimeout(res, delay));
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
}

// --- Gemini Generate Helper with Retry Loop ---
async function generateContentWithRetry(model, contents, retries = 3, delay = 1500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await model.generateContent(contents);
    } catch (err) {
      const status = err.status || (err.response && err.response.status);
      if ((status === 503 || status === 429 || status === 500) && attempt < retries) {
        console.warn(`[Gemini Spike] 503/429 on attempt ${attempt}. Retrying in ${delay}ms...`);
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
  if (!WHATSAPP_GATEWAY_BASE_URL || !WHATSAPP_GATEWAY_KEY || !WHATSAPP_GATEWAY_TYPE) {
    console.error('[Reply Error] Missing WhatsApp gateway configuration.');
    return;
  }
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

// --- Enhanced Hindi & English Transliteration Normalization ---
function normalizeHindi(str) {
  if (!str) return '';
  let s = str.toString().trim().toLowerCase();

  const transMap = [
    [/kanhai|kanahi|kandhai|कन्हाई|कनहाई/g, 'कन्धाई'],
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
    [/bindha|vindha/g, 'विन्धा'],
    [/chintu/g, 'चिन्टू'],
    [/suraj/g, 'सूरज'],
    [/diesel/g, 'डीजल'],
    [/pending/g, 'पेंडिंग'],
    [/completed|complete/g, 'कंप्लीट']
  ];

  for (const [regex, hindiVal] of transMap) {
    s = s.replace(regex, hindiVal);
  }

  return s
    .replace(/[\u0902\u0901]/g, 'न')
    .replace(/[\u093E\u093F\u0940\u0941\u0942\u0943\u0947\u0948\u094B\u094C\u094D]/g, '')
    .replace(/[\s\.\-_]/g, '');
}

// --- Supply / Dispatch Update & Upsert Logic ---
async function logOrUpdateDispatch(dateStr, dispatch) {
  if (!sheets || !SPREADSHEET_ID) return;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Supply_Dispatch!A2:J'
  });

  const rows = res.data.values || [];
  let targetRowIndex = -1;
  let targetRow = null;

  const searchNameNorm = normalizeHindi(dispatch.name);
  const targetGradeNorm = normalizeHindi(dispatch.grade);

  for (let i = 0; i < rows.length; i++) {
    const rowCustomerNorm = normalizeHindi(rows[i][1]);
    const rowGradeNorm = normalizeHindi(rows[i][3]);

    if (searchNameNorm && (rowCustomerNorm.includes(searchNameNorm) || searchNameNorm.includes(rowCustomerNorm))) {
      if (!targetGradeNorm || rowGradeNorm.includes(targetGradeNorm) || targetGradeNorm.includes(rowGradeNorm)) {
        targetRowIndex = i + 2;
        targetRow = rows[i];
        break;
      }
    }
  }

  const rawQty = dispatch.dispatched_qty;
  const isTrolley = typeof rawQty === 'string' && (rawQty.includes('trolly') || rawQty.includes('ट्रॉली') || rawQty.includes('गाड़ी') || rawQty.includes('रोड़ा'));
  const dispatchedQty = isTrolley ? rawQty : (Number(rawQty) || 0);
  const newTotalOrdered = dispatch.total_ordered_qty ? (Number(dispatch.total_ordered_qty) || dispatchedQty) : dispatchedQty;

  if (targetRowIndex !== -1 && targetRow) {
    const prevDispatched = Number(targetRow[5]) || 0;
    const finalOrdered = Math.max(newTotalOrdered, Number(targetRow[4]) || 0);
    const finalDispatched = (typeof dispatchedQty === 'number' && typeof prevDispatched === 'number')
      ? (prevDispatched > 0 && prevDispatched === dispatchedQty ? prevDispatched : prevDispatched + dispatchedQty)
      : dispatchedQty;

    const balanceRemaining = (typeof finalOrdered === 'number' && typeof finalDispatched === 'number')
      ? Math.max(0, finalOrdered - finalDispatched)
      : 0;

    const newStatus = isTrolley || (typeof finalOrdered === 'number' && finalDispatched >= finalOrdered)
      ? 'Completed'
      : 'Partial';

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Supply_Dispatch!E${targetRowIndex}:J${targetRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          finalOrdered,
          dispatchedQty,
          finalDispatched,
          balanceRemaining,
          dispatch.driver || targetRow[8] || '',
          newStatus
        ]]
      }
    });
    console.log(`[Supply_Dispatch] Adjusted row ${targetRowIndex} for ${dispatch.name}`);
  } else {
    const balanceRemaining = typeof newTotalOrdered === 'number' && typeof dispatchedQty === 'number'
      ? Math.max(0, newTotalOrdered - dispatchedQty)
      : 0;

    let status = 'Completed';
    if (dispatchedQty === 0 && !isTrolley) status = 'Pending';
    else if (balanceRemaining > 0 && typeof balanceRemaining === 'number') status = 'Partial';

    const rowDate = dispatch.date || dateStr;

    await appendWithRetry({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Supply_Dispatch!A:J',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          rowDate,
          dispatch.name || 'नकद ग्राहक',
          dispatch.village || '',
          dispatch.grade || 'अव्वल',
          newTotalOrdered,
          dispatchedQty,
          dispatchedQty,
          balanceRemaining,
          dispatch.driver || '',
          status
        ]]
      }
    });
    console.log(`[Supply_Dispatch] Logged new row for ${dispatch.name}`);
  }
}

// --- Dynamic Targeted Rectification / Update Logic ---
async function updateSheetEntry(targetTabs, filter, updates) {
  if (!sheets || !SPREADSHEET_ID) return false;

  let tabsToSearch = Array.isArray(targetTabs) ? targetTabs : (targetTabs ? [targetTabs] : []);
  if (tabsToSearch.length === 0 || tabsToSearch.includes('ALL')) {
    tabsToSearch = ['Orders', 'Supply_Dispatch', 'Expenses', 'Daily_Closing'];
  }

  // 1. Direct Row Number Targeted Update
  if (filter?.row_number && filter.row_number >= 2) {
    const tab = tabsToSearch[0] || 'Supply_Dispatch';
    const rowIndex = filter.row_number;
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${tab}!A${rowIndex}:J${rowIndex}`
      });
      const row = res.data.values?.[0];
      if (row) {
        if (updates.date) row[0] = updates.date;
        if (tab === 'Orders') {
          if (updates.village) row[2] = updates.village;
          if (updates.grade) row[3] = updates.grade;
          if (updates.quantity) row[4] = updates.quantity;
          if (updates.amount_payable) row[5] = updates.amount_payable;
          if (updates.amount_received) row[6] = updates.amount_received;
          const payable = Number(row[5]) || 0;
          const received = Number(row[6]) || 0;
          row[7] = Math.max(0, payable - received);
        } else if (tab === 'Supply_Dispatch') {
          if (updates.village) row[2] = updates.village;
          if (updates.grade) row[3] = updates.grade;
          if (updates.quantity) {
            row[4] = updates.quantity;
            row[5] = updates.quantity;
            row[6] = updates.quantity;
            row[7] = 0;
            row[9] = 'Completed';
          }
          if (updates.driver) row[8] = updates.driver;
          if (updates.status) row[9] = updates.status;
        } else if (tab === 'Expenses') {
          if (updates.category) row[1] = updates.category;
          if (updates.paid_to) row[2] = updates.paid_to;
          if (updates.amount) row[3] = updates.amount;
          if (updates.remarks) row[4] = updates.remarks;
        }

        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${tab}!A${rowIndex}:J${rowIndex}`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [row] }
        });
        console.log(`[Update Success] Rectified ${tab} row ${rowIndex}`);
        return true;
      }
    } catch (err) {
      console.error(`[Row Update Error in ${tab}]:`, err.message);
    }
  }

  // 2. Targeted Search by Name, Payee, and Grade/Village
  const searchNameNorm = normalizeHindi(filter?.customer_name);
  const searchPayeeNorm = normalizeHindi(filter?.paid_to);
  const searchGradeNorm = normalizeHindi(filter?.grade || updates?.grade);
  let updateCount = 0;

  for (const tab of tabsToSearch) {
    try {
      const range = `${tab}!A2:J`;
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
      const rows = res.data.values || [];

      let targetRowIndex = -1;
      let targetRow = null;

      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        const rowNameNorm = normalizeHindi(row[1]);
        const rowPayeeNorm = normalizeHindi(row[2]);
        const rowGradeNorm = normalizeHindi(row[3]);

        const matchName = searchNameNorm && (rowNameNorm.includes(searchNameNorm) || searchNameNorm.includes(rowNameNorm));
        const matchPayee = searchPayeeNorm && (rowPayeeNorm.includes(searchPayeeNorm) || searchPayeeNorm.includes(rowPayeeNorm));

        if (matchName || matchPayee) {
          if (searchGradeNorm && rowGradeNorm && !rowGradeNorm.includes(searchGradeNorm) && !searchGradeNorm.includes(rowGradeNorm)) {
            continue;
          }
          targetRowIndex = i + 2;
          targetRow = [...row];
          break;
        }
      }

      if (targetRowIndex !== -1 && targetRow) {
        if (updates.date) targetRow[0] = updates.date;

        if (tab === 'Orders') {
          if (updates.village) targetRow[2] = updates.village;
          if (updates.grade) targetRow[3] = updates.grade;
          if (updates.quantity) targetRow[4] = updates.quantity;
          if (updates.amount_payable) targetRow[5] = updates.amount_payable;
          if (updates.amount_received !== undefined && updates.amount_received !== null) targetRow[6] = updates.amount_received;

          const payable = Number(targetRow[5]) || 0;
          const received = Number(targetRow[6]) || 0;
          targetRow[7] = Math.max(0, payable - received);
        } else if (tab === 'Supply_Dispatch') {
          if (updates.village) targetRow[2] = updates.village;
          if (updates.grade) targetRow[3] = updates.grade;
          if (updates.quantity) {
            const cleanQty = (typeof updates.quantity === 'string' && (updates.quantity.includes('trolly') || updates.quantity.includes('गाड़ी') || updates.quantity.includes('रोड़ा')))
              ? updates.quantity
              : Number(updates.quantity) || updates.quantity;

            targetRow[4] = cleanQty;
            targetRow[5] = cleanQty;
            targetRow[6] = cleanQty;
            targetRow[7] = 0;
            targetRow[9] = 'Completed';
          }
          if (updates.driver) targetRow[8] = updates.driver;
          if (updates.status) targetRow[9] = updates.status;
        } else if (tab === 'Expenses') {
          if (updates.category) targetRow[1] = updates.category;
          if (updates.paid_to) targetRow[2] = updates.paid_to;
          if (updates.amount) targetRow[3] = updates.amount;
          if (updates.remarks) targetRow[4] = updates.remarks;
        }

        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${tab}!A${targetRowIndex}:J${targetRowIndex}`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [targetRow] }
        });

        console.log(`[Update Success] Rectified ${tab} row ${targetRowIndex}`);
        updateCount++;
      }
    } catch (err) {
      console.error(`[Update Error in ${tab}]:`, err.message);
    }
  }

  return updateCount > 0;
}

// --- Dynamic Targeted Deletion Logic ---
async function deleteSheetEntry(targetTabs, filter, deleteAll = false) {
  if (!sheets || !SPREADSHEET_ID) return { success: false, deletedFrom: [] };

  const allTabs = ['Orders', 'Supply_Dispatch', 'Expenses', 'Daily_Closing'];
  let tabsToProcess = [];

  if (Array.isArray(targetTabs)) {
    if (targetTabs.includes('ALL')) tabsToProcess = allTabs;
    else tabsToProcess = targetTabs;
  } else if (targetTabs === 'ALL' || !targetTabs) {
    tabsToProcess = allTabs;
  } else {
    tabsToProcess = [targetTabs];
  }

  const deletedTabs = [];

  // CASE 1: Explicit Full Clear of entire sheet data
  if (deleteAll) {
    for (const tab of tabsToProcess) {
      try {
        await sheets.spreadsheets.values.clear({
          spreadsheetId: SPREADSHEET_ID,
          range: `${tab}!A2:Z`
        });
        console.log(`[Clear Success] Cleared data rows from ${tab}`);
        deletedTabs.push(tab);
      } catch (err) {
        console.error(`[Clear Error in ${tab}]:`, err.message);
      }
    }
    return {
      success: deletedTabs.length > 0,
      deletedFrom: deletedTabs,
      clearedAll: true
    };
  }

  // CASE 2: Targeted Row Deletion by Specific Filter (Name, Payee, Grade, Row Number)
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const searchNameNorm = normalizeHindi(filter?.customer_name);
  const searchPayeeNorm = normalizeHindi(filter?.paid_to);
  const searchGradeNorm = normalizeHindi(filter?.grade);
  const targetRowNumber = filter?.row_number;

  for (const tab of tabsToProcess) {
    const sheetMeta = meta.data.sheets.find(s => s.properties.title === tab);
    if (!sheetMeta) continue;
    const sheetId = sheetMeta.properties.sheetId;

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tab}!A2:J`
    });
    const rows = res.data.values || [];
    if (rows.length === 0) continue;

    let rowIndexToDelete = -1;

    if (targetRowNumber && targetRowNumber >= 2 && targetRowNumber <= rows.length + 1) {
      rowIndexToDelete = targetRowNumber - 1; // 0-based for batchUpdate
    } else if (searchNameNorm || searchPayeeNorm) {
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        const rowNameNorm = normalizeHindi(row[1]);
        const rowPayeeNorm = normalizeHindi(row[2]);
        const rowGradeNorm = normalizeHindi(row[3]);

        const matchName = searchNameNorm && (rowNameNorm.includes(searchNameNorm) || searchNameNorm.includes(rowNameNorm));
        const matchPayee = searchPayeeNorm && (rowPayeeNorm.includes(searchPayeeNorm) || searchPayeeNorm.includes(rowPayeeNorm));

        if (matchName || matchPayee) {
          if (searchGradeNorm && rowGradeNorm && !rowGradeNorm.includes(searchGradeNorm) && !searchGradeNorm.includes(rowGradeNorm)) {
            continue;
          }
          rowIndexToDelete = i + 1; // 0-based for API
          break;
        }
      }
    } else {
      // Single previous row deletion (only last row)
      rowIndexToDelete = rows.length;
    }

    if (rowIndexToDelete !== -1 && rowIndexToDelete <= rows.length) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId: sheetId,
                dimension: 'ROWS',
                startIndex: rowIndexToDelete,
                endIndex: rowIndexToDelete + 1
              }
            }
          }]
        }
      });
      console.log(`[Delete Success] Deleted row ${rowIndexToDelete + 1} from ${tab}`);
      deletedTabs.push(tab);
    }
  }

  return {
    success: deletedTabs.length > 0,
    deletedFrom: deletedTabs,
    clearedAll: false
  };
}

// --- System Prompt for Gemini with Targeted Rectification & Deletion Rules ---
const SYSTEM_PROMPT = `
You are the AI Munshi (Accountant) for an Indian Brick Kiln (ईंट भट्ठा).
Analyze incoming transaction text, voice transcripts, or photos of diary pages and return ONLY valid JSON matching this schema:

{
  "intent": "batch_update" | "order" | "dispatch" | "expense" | "daily_summary" | "update_entry" | "delete_entry" | "recheck_with_image" | "clarification" | "ignore",
  "target_tabs": ["Orders" | "Supply_Dispatch" | "Expenses" | "Daily_Closing" | "ALL"],
  "delete_all": boolean,
  "search_filter": {
    "customer_name": string,
    "paid_to": string,
    "grade": string,
    "row_number": number
  },
  "fields_to_update": {
    "date": string,
    "village": string,
    "grade": string,
    "quantity": string | number,
    "amount_payable": number,
    "amount_received": number,
    "driver": string,
    "category": string,
    "paid_to": string,
    "amount": number,
    "remarks": string,
    "status": "Completed" | "Pending" | "Partial"
  },
  "orders": [
    {
      "date": string,
      "name": string,
      "village": string,
      "grade": string,
      "quantity": number,
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
      "driver": string
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
    "closing_balance": number,
    "remarks": string
  },
  "reply_text": string
}

BRICK GRADE & REGISTER ABBREVIATIONS:
- "I" or "अ०" -> "अव्वल"
- "II" or "दो०" -> "दोयम"
- "III" or "सो०" -> "सोयम"
- "मी०" -> "मीठा"
- "गो०" -> "गोड़िया"
- "खं०" -> "खंजड़"
- "पी०" -> "पीला"
- "रोड़ा पी०" or "पी० रो०" -> "पीला रोड़ा"
- "रोड़ा" -> "रोड़ा"

CRITICAL TARGETED RECTIFICATION & DELETION RULES:
1. RECTIFICATIONS & UPDATES:
   - When user asks to change, fix, correct, adjust, or update any entry (e.g. "सन्तराम का गाँव बरईपारा कर दो", "अनूप सिंह का 500 मीठा की जगह 4000 मीठा कर दो", "डीजल का खर्चा 2500 करो", "Update the above entry in orders"):
     * intent: "update_entry"
     * search_filter: extract target customer_name, paid_to, grade, or row_number (standardized to Hindi Devanagari).
     * fields_to_update: set new updated values.
     * If multiple orders/items are provided to be updated, populate the orders array with the updated objects and keep intent as "update_entry".
2. TARGETED DELETIONS:
   - When user asks to delete a specific entry (e.g. "कन्धाई की एंट्री हटाओ", "मुलायम यादव का डिस्पैच डिलीट करो", "सूरज का खर्चा डिलीट करो"):
     * intent: "delete_entry"
     * delete_all: false
     * search_filter: { customer_name: "कन्धाई" (or paid_to: "सूरज") }
     * target_tabs: ["Orders", "Supply_Dispatch"] or specified tab.
   - When user asks "Delete the previous entry" or "पिछली एंट्री हटाओ":
     * intent: "delete_entry"
     * delete_all: false
     * target_tabs: ["Supply_Dispatch"] (or active tab)
     * search_filter: { customer_name: "" }
   - Only set delete_all: true when user explicitly commands "Delete all entries", "Sab clear karo", or "Sheet poori saaf karo".
3. DIARY PHOTO RULES:
   - Always parse top cash bookings into orders and dispatches accurately.
   - Standardize all names to Hindi Devanagari.
`;

// --- Webhook Endpoint ---
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body?.data;
    if (!data) return res.sendStatus(200);

    const sender = data.key?.remoteJid || '';
    const messageId = data.key?.id || '';

    if (!sender || sender.includes('@g.us')) return res.sendStatus(200);

    const cleanSenderNumber = sender.replace('@s.whatsapp.net', '').replace('@c.us', '').trim();
    if (!cleanSenderNumber) return res.sendStatus(200);

    if (ALLOWED_NUMBERS.length > 0 && !ALLOWED_NUMBERS.includes(cleanSenderNumber)) {
      console.warn(`[Security] Ignored unauthorized message from ${cleanSenderNumber}`);
      return res.sendStatus(200);
    }

    if (isDuplicateMessage(messageId)) {
      console.log(`[Dedup] Skipping duplicate message ${messageId}`);
      return res.sendStatus(200);
    }

    let contents = [];
    const message = data.message;
    const text = message?.conversation || message?.extendedTextMessage?.text;
    const audioMessage = message?.audioMessage;
    const imageMessage = message?.imageMessage;

    const isRecheckQuery = text && (
      text.toLowerCase().includes('recheck') || 
      text.toLowerCase().includes('match') || 
      text.toLowerCase().includes('image') || 
      text.toLowerCase().includes('photo') || 
      text.toLowerCase().includes('not present') ||
      text.includes('नहीं मिला') ||
      text.includes('फोटो से') ||
      text.includes('चेक करो')
    );

    if (imageMessage) {
      const caption = imageMessage.caption || '';
      console.log(`[Gemini] Processing diary image from ${sender} (Caption: "${caption}")...`);
      const base64Image = req.body?.data?.message?.base64 || '';
      if (!base64Image) return res.sendStatus(200);
      const mimeType = imageMessage.mimetype || 'image/jpeg';
      
      lastImageCache.set(cleanSenderNumber, { base64: base64Image, mimeType });

      const promptHeader = caption 
        ? `${SYSTEM_PROMPT}\n\nUSER CAPTION / INSTRUCTIONS: "${caption}"\nCarefully fulfill the caption instructions and extract all diary data accurately.`
        : SYSTEM_PROMPT;

      contents = [
        promptHeader,
        { inlineData: { mimeType: mimeType, data: base64Image } }
      ];
    } else if (text && isRecheckQuery && lastImageCache.has(cleanSenderNumber)) {
      console.log(`[Gemini] Re-evaluating cached image against user query: "${text}"`);
      const cached = lastImageCache.get(cleanSenderNumber);
      contents = [
        `${SYSTEM_PROMPT}\n\nUSER QUERY: "${text}"\nThe user is asking to recheck/verify against the attached register photo. Carefully extract any missing entries and return a complete "batch_update".`,
        { inlineData: { mimeType: cached.mimeType, data: cached.base64 } }
      ];
    } else if (text) {
      console.log(`[Incoming] Text from ${sender}: "${text}"`);
      contents = [`${SYSTEM_PROMPT}\n\nInput message: "${text}"`];
    } else if (audioMessage) {
      console.log(`[Gemini] Processing voice note from ${sender}...`);
      const base64Audio = req.body?.data?.message?.base64 || '';
      if (!base64Audio) return res.sendStatus(200);
      contents = [
        SYSTEM_PROMPT,
        { inlineData: { mimeType: 'audio/ogg; codecs=opus', data: base64Audio } }
      ];
    } else {
      return res.sendStatus(200);
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });

    const result = await generateContentWithRetry(model, contents);
    const responseText = result.response.text();
    const parsed = JSON.parse(responseText.trim());
    console.log('[Parsed JSON]:', parsed);

    markMessageProcessed(messageId);
    const defaultDate = getISTDateOnly();

    // 1. Batch Update & Recheck Intent
    if ((parsed.intent === 'batch_update' || parsed.intent === 'recheck_with_image') && sheets) {
      if (parsed.orders && parsed.orders.length > 0) {
        const orderRows = parsed.orders.map(o => [
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
        await appendWithRetry({
          spreadsheetId: SPREADSHEET_ID,
          range: 'Orders!A:I',
          valueInputOption: 'USER_ENTERED',
          resource: { values: orderRows }
        });
      }

      if (parsed.dispatches && parsed.dispatches.length > 0) {
        for (const d of parsed.dispatches) {
          await logOrUpdateDispatch(d.date || defaultDate, d);
        }
      }

      if (parsed.expenses && parsed.expenses.length > 0) {
        const expenseRows = parsed.expenses.map(e => [
          e.date || defaultDate,
          e.category || 'अन्य',
          e.paid_to || '',
          e.amount || 0,
          e.remarks || ''
        ]);
        await appendWithRetry({
          spreadsheetId: SPREADSHEET_ID,
          range: 'Expenses!A:E',
          valueInputOption: 'USER_ENTERED',
          resource: { values: expenseRows }
        });
      }

      if (parsed.daily_closing && (parsed.daily_closing.total_jama || parsed.daily_closing.closing_balance)) {
        const dc = parsed.daily_closing;
        await appendWithRetry({
          spreadsheetId: SPREADSHEET_ID,
          range: 'Daily_Closing!A:G',
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[
              dc.date || defaultDate,
              dc.opening_balance || 0,
              dc.total_jama || 0,
              dc.total_kharcha || 0,
              dc.maalik_ko_diya || 0,
              dc.closing_balance || 0,
              dc.remarks || ''
            ]]
          }
        });
      }

      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }

    // 2. Single or Multiple Orders Intent
    else if (parsed.intent === 'order' && sheets) {
      const ordersToProcess = (parsed.orders && parsed.orders.length > 0) ? parsed.orders : [parsed];
      for (const order of ordersToProcess) {
        await appendWithRetry({
          spreadsheetId: SPREADSHEET_ID,
          range: 'Orders!A:I',
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[
              order.date || defaultDate,
              order.name || 'नकद ग्राहक',
              order.village || '',
              order.grade || 'अव्वल',
              order.quantity || 0,
              order.amount_payable || (order.amount_received || 0),
              order.amount_received || 0,
              order.pending_amount || 0,
              order.mode_of_payment || 'Cash'
            ]]
          }
        });
      }
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }

    // 3. Single or Multiple Dispatches Intent
    else if (parsed.intent === 'dispatch' && sheets) {
      const dispatchesToProcess = (parsed.dispatches && parsed.dispatches.length > 0) ? parsed.dispatches : [parsed];
      for (const dispatch of dispatchesToProcess) {
        await logOrUpdateDispatch(dispatch.date || defaultDate, dispatch);
      }
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }

    // 4. Single or Multiple Expenses Intent
    else if (parsed.intent === 'expense' && sheets) {
      const expensesToProcess = (parsed.expenses && parsed.expenses.length > 0) ? parsed.expenses : [parsed];
      for (const expense of expensesToProcess) {
        await appendWithRetry({
          spreadsheetId: SPREADSHEET_ID,
          range: 'Expenses!A:E',
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[
              expense.date || defaultDate,
              expense.category || 'अन्य',
              expense.paid_to || '',
              expense.amount || 0,
              expense.remarks || ''
            ]]
          }
        });
      }
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }

    // 5. Daily Summary Intent
    else if (parsed.intent === 'daily_summary' && sheets) {
      const dc = parsed.daily_closing || parsed;
      await appendWithRetry({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Daily_Closing!A:G',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[
            dc.date || defaultDate,
            dc.opening_balance || 0,
            dc.total_jama || 0,
            dc.total_kharcha || 0,
            dc.maalik_ko_diya || 0,
            dc.closing_balance || 0,
            dc.remarks || ''
          ]]
        }
      });
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }

    // 6. Targeted Rectification / Update Intent
    else if (parsed.intent === 'update_entry' && sheets) {
      if (parsed.orders && parsed.orders.length > 0) {
        let updatedAny = false;
        for (const order of parsed.orders) {
          const filter = { customer_name: order.name, paid_to: null, grade: order.grade, row_number: null };
          const success = await updateSheetEntry(parsed.target_tabs, filter, order);
          if (success) updatedAny = true;
        }
        const reply = updatedAny
          ? (parsed.reply_text || 'एंट्री सफलतापूर्वक अपडेट कर दी गई है।')
          : 'माफ कीजिए, यह एंट्री शीट में नहीं मिली।';
        await sendWhatsAppReply(sender, reply);
      } else {
        const success = await updateSheetEntry(parsed.target_tabs, parsed.search_filter, parsed.fields_to_update);
        const reply = success
          ? (parsed.reply_text || 'एंट्री सफलतापूर्वक अपडेट कर दी गई है।')
          : 'माफ कीजिए, यह एंट्री शीट में नहीं मिली।';
        await sendWhatsAppReply(sender, reply);
      }
    }

    // 7. Targeted Deletion Intent
    else if (parsed.intent === 'delete_entry' && sheets) {
      const result = await deleteSheetEntry(parsed.target_tabs, parsed.search_filter, parsed.delete_all || false);
      if (parsed.delete_all) lastImageCache.delete(cleanSenderNumber);

      let reply;
      if (result.success) {
        const tabsJoined = result.deletedFrom.join(' और ');
        reply = parsed.reply_text || (result.clearedAll
          ? `✅ ${tabsJoined} के सभी डेटा को सफलतापूर्वक साफ (क्लियर) कर दिया गया है।`
          : `✅ ${tabsJoined} से संबंधित प्रविष्टि सफलतापूर्वक हटा दी गई है।`);
      } else {
        reply = 'माफ कीजिए, डिलीट करने के लिए कोई संबंधित एंट्री नहीं मिली।';
      }
      await sendWhatsAppReply(sender, reply);
    }

    // 8. Clarification / Unhandled Reply Fallback
    else if (parsed.reply_text) {
      await sendWhatsAppReply(sender, parsed.reply_text);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error('[Webhook Error]:', error);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Munshi server running on port ${PORT}`);
});
