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

// --- Immediate Synchronous Deduplication Lock ---
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

// --- Sheets API Helper with Retry ---
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

// --- Gemini Generate Helper with Retry Loop ---
async function generateContentWithRetry(model, contents, retries = 2, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await model.generateContent(contents);
    } catch (err) {
      const status = err.status || (err.response && err.response.status);
      if ((status === 503 || status === 429 || status === 500) && attempt < retries) {
        console.warn(`[Gemini Spike] ${status} on attempt ${attempt}. Retrying in ${delay}ms...`);
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

// --- Enhanced Transliteration Normalization ---
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

  for (const [regex, hindiVal] of transMap) s = s.replace(regex, hindiVal);

  return s
    .replace(/[\u0902\u0901]/g, 'न')
    .replace(/[\u093E\u093F\u0940\u0941\u0942\u0943\u0947\u0948\u094B\u094C\u094D]/g, '')
    .replace(/[\s\.\-_]/g, '');
}

// --- Helper to parse numeric sum from mixed strings ---
function parseTotalQty(val) {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  const numbers = val.toString().match(/\d+/g);
  if (!numbers) return 0;
  return numbers.reduce((sum, n) => sum + Number(n), 0);
}

// --- Batched Dispatch Processor with Single Row Mixed Support ---
async function processBatchDispatches(dateStr, dispatches) {
  if (!sheets || !SPREADSHEET_ID || !dispatches || dispatches.length === 0) return;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Supply_Dispatch!A2:J'
  });

  const rows = res.data.values || [];
  const rowsToAppend = [];
  const updatesToRun = [];

  for (const dispatch of dispatches) {
    const searchNameNorm = normalizeHindi(dispatch.name);
    const targetGradeNorm = normalizeHindi(dispatch.grade);

    let targetRowIndex = -1;
    let targetRow = null;

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
    const numericDispatched = parseTotalQty(rawQty);
    const numericOrdered = parseTotalQty(dispatch.total_ordered_qty || rawQty);

    if (targetRowIndex !== -1 && targetRow) {
      const prevDispatchedNum = parseTotalQty(targetRow[6]) || 0;
      const finalDispatchedNum = prevDispatchedNum + numericDispatched;
      const balanceRemaining = Math.max(0, numericOrdered - finalDispatchedNum);
      const status = balanceRemaining === 0 ? 'Completed' : 'Partial';

      updatesToRun.push(
        sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `Supply_Dispatch!D${targetRowIndex}:J${targetRowIndex}`,
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[
              dispatch.grade || targetRow[3],
              dispatch.total_ordered_qty || targetRow[4],
              rawQty,
              finalDispatchedNum,
              balanceRemaining,
              dispatch.driver || targetRow[8] || '',
              status
            ]]
          }
        })
      );
    } else {
      const balanceRemaining = Math.max(0, numericOrdered - numericDispatched);
      const status = balanceRemaining === 0 ? 'Completed' : 'Partial';

      rowsToAppend.push([
        dispatch.date || dateStr,
        dispatch.name || 'नकद ग्राहक',
        dispatch.village || '',
        dispatch.grade || 'अव्वल',
        dispatch.total_ordered_qty || rawQty,
        rawQty,
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

// --- Dynamic Targeted Rectification / Update Logic ---
async function updateSheetEntry(targetTabs, filter, updates) {
  if (!sheets || !SPREADSHEET_ID) return false;

  let tabsToSearch = Array.isArray(targetTabs) ? targetTabs : (targetTabs ? [targetTabs] : []);
  if (tabsToSearch.length === 0 || tabsToSearch.includes('ALL')) {
    tabsToSearch = ['Orders', 'Supply_Dispatch', 'Expenses', 'Daily_Closing'];
  }

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
            row[6] = parseTotalQty(updates.quantity);
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
      }
    } catch (err) {
      console.error(`[Row Update Error in ${tab}]:`, err.message);
    }
  }

  const searchNameNorm = normalizeHindi(filter?.customer_name);
  const searchPayeeNorm = normalizeHindi(filter?.paid_to);
  const searchGradeNorm = normalizeHindi(filter?.grade || updates?.grade);
  let updateCount = 0;

  for (const tab of tabsToSearch) {
    try {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tab}!A2:J` });
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
            targetRow[4] = updates.quantity;
            targetRow[5] = updates.quantity;
            targetRow[6] = parseTotalQty(updates.quantity);
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
        } else if (tab === 'Daily_Closing') {
          if (updates.opening_balance !== undefined) targetRow[1] = updates.opening_balance;
          if (updates.total_jama !== undefined) targetRow[2] = updates.total_jama;
          if (updates.total_kharcha !== undefined) targetRow[3] = updates.total_kharcha;
          if (updates.maalik_ko_diya !== undefined) targetRow[4] = updates.maalik_ko_diya;
          if (updates.closing_balance !== undefined) targetRow[5] = updates.closing_balance;
        }

        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${tab}!A${targetRowIndex}:J${targetRowIndex}`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [targetRow] }
        });
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

  if (deleteAll) {
    await Promise.all(
      tabsToProcess.map(tab =>
        sheets.spreadsheets.values.clear({
          spreadsheetId: SPREADSHEET_ID,
          range: `${tab}!A2:Z`
        }).then(() => deletedTabs.push(tab)).catch(err => console.error(`[Clear Error in ${tab}]:`, err.message))
      )
    );
    return { success: deletedTabs.length > 0, deletedFrom: deletedTabs, clearedAll: true };
  }

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
      rowIndexToDelete = targetRowNumber - 1;
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
          rowIndexToDelete = i + 1;
          break;
        }
      }
    } else {
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
      deletedTabs.push(tab);
    }
  }

  return { success: deletedTabs.length > 0, deletedFrom: deletedTabs, clearedAll: false };
}

// --- System Prompt for Gemini with Correlation & Mixed-Item Formatting ---
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
    "closing_balance": number
  },
  "reply_text": string
}

PRICE LIST BENCHMARKS (Per 2,000 Bricks / गाड़ी):
- अव्वल (Awwal / I): ₹14,500 – ₹15,500
- मीठा (Meetha / मी०): ₹12,500 – ₹13,500 (approx. ₹13,000 / 2,000 -> ₹6,500 per 1,000)
- खंजड़ (Khanjad / खं०): ₹12,000 – ₹13,000
- गोड़िया (Godiya / गो०): ₹8,500 – ₹9,000 (approx. ₹4,500 / 1,000)
- पीला (Peela / पी०): ₹8,000
- अव्वल रोड़ा (Awwal Roda / रोडा I): ₹5,000 – ₹5,500
- पीला रोड़ा (Peela Roda): ₹2,500 – ₹3,000

CRITICAL CONSOLIDATION & CORRELATION RULES:
1. SINGLE ROW PER CUSTOMER FOR MIXED ORDERS (DO NOT GENERATE MULTIPLE ENTRIES):
   - When a customer purchases multiple grades in one transaction (e.g. मुलायम यादव - ₹11,200 for 1000 गोड़िया & 1000 मीठा), create EXACTLY ONE order row:
     * name: "मुलायम यादव"
     * village: "गँडोली"
     * grade: "गोड़िया & मीठा"
     * quantity: "1000 गोड़िया / 1000 मीठा"
     * amount_payable: 11200
     * amount_received: 11200
     * pending_amount: 0
2. SINGLE ROW PER CUSTOMER FOR MIXED DISPATCHES:
   - For mixed dispatches on the same trip:
     * name: "मुलायम यादव"
     * village: "गँडोली"
     * grade: "गोड़िया & मीठा"
     * total_ordered_qty: "1000 गो०, 1000 मी०"
     * dispatched_qty: "1000 गो०, 1000 मी०"
     * driver: "चिन्टू"
3. DEDUCING ORDER QUANTITIES FROM CASH & DISPATCH:
   - सन्तराम (बरईपारा) - ₹14,500 -> 2,000 अव्वल.
   - मुकीम (इटौंजा) - ₹15,000 -> 2,000 अव्वल.
   - कन्धाई (पूरे काशीराम) - ₹52,000 -> 8,000 मीठा.
   - नन्हेखा (सरूरपुर) - ₹10,000 -> 1,000 अव्वल.
4. ALL NUMBERS ARE STANDARD ENGLISH DIGITS (0-9). Do NOT read English digit "4" as Devanagari "५".
5. DAILY CLOSING 6-COLUMN EXACT ALIGNMENT:
   - "opening_balance" = top बचत (e.g. 300).
   - "total_jama" = sum of all cash receipts (e.g. 103000).
   - "total_kharcha" = total expenses (e.g. 15100).
   - "maalik_ko_diya" = cash given to owner (e.g. 81500).
   - "closing_balance" = final cash in hand remaining (e.g. 6400).
6. Standardize all Indian names to Hindi Devanagari.
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
      return res.sendStatus(200);
    }

    if (checkAndLockMessage(messageId)) {
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
      const base64Image = req.body?.data?.message?.base64 || '';
      if (!base64Image) return res.sendStatus(200);
      const mimeType = imageMessage.mimetype || 'image/jpeg';
      
      lastImageCache.set(cleanSenderNumber, { base64: base64Image, mimeType });

      const promptHeader = caption 
        ? `${SYSTEM_PROMPT}\n\nUSER CAPTION / INSTRUCTIONS: "${caption}"\nFulfill caption instructions and extract all data.`
        : SYSTEM_PROMPT;

      contents = [promptHeader, { inlineData: { mimeType, data: base64Image } }];
    } else if (text && isRecheckQuery && lastImageCache.has(cleanSenderNumber)) {
      const cached = lastImageCache.get(cleanSenderNumber);
      contents = [
        `${SYSTEM_PROMPT}\n\nUSER QUERY: "${text}"\nRecheck against register photo. Extract any missing entries and return complete batch_update.`,
        { inlineData: { mimeType: cached.mimeType, data: cached.base64 } }
      ];
    } else if (text) {
      contents = [`${SYSTEM_PROMPT}\n\nInput message: "${text}"`];
    } else if (audioMessage) {
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
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.0,
        maxOutputTokens: 4000
      }
    });

    const result = await generateContentWithRetry(model, contents);
    
    // JSON cleanup to prevent markdown parsing errors
    let rawText = result.response.text().trim();
    if (rawText.startsWith('```')) {
      rawText = rawText.replace(/^
