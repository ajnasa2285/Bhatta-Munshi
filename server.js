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

// --- Deduplication Cache ---
const processedMessageIds = new Set();
const MAX_TRACKED_IDS = 500;

function isDuplicateMessage(messageId) {
  if (!messageId) return false;
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > MAX_TRACKED_IDS) {
    const oldest = processedMessageIds.values().next().value;
    processedMessageIds.delete(oldest);
  }
  return false;
}

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

// --- Hindi Normalization Helper for Robust Matching ---
function normalizeHindi(str) {
  if (!str) return '';
  return str
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[\u0902\u0901]/g, 'न') // convert anusvara/chandrabindu (ं, ँ) to न (e.g. संतराम -> सन्तरम)
    .replace(/[\u093E\u093F\u0940\u0941\u0942\u0943\u0947\u0948\u094B\u094C\u094D]/g, ''); // strip matras for root matching
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

  for (let i = 0; i < rows.length; i++) {
    const rowCustomerNorm = normalizeHindi(rows[i][1]);
    const rowStatus = rows[i][9] || '';
    if (searchNameNorm && rowCustomerNorm.includes(searchNameNorm) && rowStatus !== 'Completed') {
      targetRowIndex = i + 2; // Offset for header + 1-based index
      targetRow = rows[i];
      break;
    }
  }

  const dispatchedQty = Number(dispatch.dispatched_qty) || 0;

  if (targetRowIndex !== -1 && targetRow) {
    const totalOrdered = Number(targetRow[4]) || dispatchedQty;
    const prevDispatched = Number(targetRow[6]) || 0;
    const newTotalDispatched = prevDispatched + dispatchedQty;
    const balanceRemaining = Math.max(0, totalOrdered - newTotalDispatched);
    const newStatus = (totalOrdered > 0 && newTotalDispatched >= totalOrdered) ? 'Completed' : 'Partial';

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Supply_Dispatch!F${targetRowIndex}:J${targetRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          dispatchedQty,
          newTotalDispatched,
          balanceRemaining,
          dispatch.driver || targetRow[8] || '',
          newStatus
        ]]
      }
    });
    console.log(`[Supply_Dispatch] Updated row ${targetRowIndex} for ${dispatch.name}`);
  } else {
    const totalOrdered = Number(dispatch.total_ordered_qty) || dispatchedQty;
    const balanceRemaining = Math.max(0, totalOrdered - dispatchedQty);
    let status = 'Completed';
    if (dispatchedQty === 0) status = 'Pending';
    else if (balanceRemaining > 0) status = 'Partial';

    await appendWithRetry({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Supply_Dispatch!A:J',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          dateStr,
          dispatch.name || 'नकद ग्राहक',
          dispatch.village || '',
          dispatch.grade || 'अव्वल',
          totalOrdered,
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

// --- Dynamic Row Update Logic with Fuzzy Matching & Cross-Tab Fallback ---
async function updateSheetEntry(targetTab, filter, updates) {
  if (!sheets || !SPREADSHEET_ID) return false;

  const tabsToSearch = targetTab ? [targetTab] : ['Orders', 'Supply_Dispatch', 'Expenses'];
  const searchNameNorm = normalizeHindi(filter?.customer_name);
  const searchPayeeNorm = normalizeHindi(filter?.paid_to);

  for (const tab of tabsToSearch) {
    try {
      const range = `${tab}!A2:J`;
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
      const rows = res.data.values || [];

      let rowIndex = -1;
      let targetRow = null;

      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        const rowNameNorm = normalizeHindi(row[1]);
        const rowPayeeNorm = normalizeHindi(row[2]);

        const matchName = searchNameNorm && (rowNameNorm.includes(searchNameNorm) || searchNameNorm.includes(rowNameNorm));
        const matchPayee = searchPayeeNorm && (rowPayeeNorm.includes(searchPayeeNorm) || searchPayeeNorm.includes(rowPayeeNorm));

        if (matchName || matchPayee) {
          rowIndex = i + 2; // Offset for header + 1-based index
          targetRow = [...row];
          break;
        }
      }

      if (rowIndex !== -1 && targetRow) {
        if (tab === 'Orders') {
          // Columns: [Date, Customer Name, Village, Grade, Quantity, Amount Payable, Amount Received, Pending Amount, Mode]
          if (updates.village) targetRow[2] = updates.village;
          if (updates.grade) targetRow[3] = updates.grade;
          if (updates.quantity) targetRow[4] = updates.quantity;
          if (updates.amount_payable) targetRow[5] = updates.amount_payable;
          if (updates.amount_received) targetRow[6] = updates.amount_received;
          
          const payable = Number(targetRow[5]) || 0;
          const received = Number(targetRow[6]) || 0;
          targetRow[7] = Math.max(0, payable - received);
        } else if (tab === 'Supply_Dispatch') {
          // Columns: [Date, Customer Name, Village, Grade, Total Ordered, Dispatched Today, Total Dispatched, Balance, Driver, Status]
          if (updates.village) targetRow[2] = updates.village;
          if (updates.grade) targetRow[3] = updates.grade;
          if (updates.driver) targetRow[8] = updates.driver;
        } else if (tab === 'Expenses') {
          // Columns: [Date, Category, Paid To, Amount, Remarks]
          if (updates.category) targetRow[1] = updates.category;
          if (updates.paid_to) targetRow[2] = updates.paid_to;
          if (updates.amount) targetRow[3] = updates.amount;
          if (updates.remarks) targetRow[4] = updates.remarks;
        }

        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${tab}!A${rowIndex}:J${rowIndex}`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [targetRow] }
        });

        console.log(`[Update Success] Updated ${tab} row ${rowIndex}`);
        return true;
      }
    } catch (err) {
      console.error(`[Update Error in ${tab}]:`, err.message);
    }
  }

  return false;
}

// --- Dynamic Row Delete Logic with Multi-Tab Search ---
async function deleteSheetEntry(targetTab, filter) {
  if (!sheets || !SPREADSHEET_ID) return false;

  const tab = targetTab || 'Orders';
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetMeta = meta.data.sheets.find(s => s.properties.title === tab);
  if (!sheetMeta) return false;
  const sheetId = sheetMeta.properties.sheetId;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tab}!A2:J`
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return false;

  let rowIndexToDelete = -1;
  const searchNameNorm = normalizeHindi(filter?.customer_name);
  const searchPayeeNorm = normalizeHindi(filter?.paid_to);

  if (searchNameNorm || searchPayeeNorm) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const rowNameNorm = normalizeHindi(row[1]);
      const rowPayeeNorm = normalizeHindi(row[2]);
      
      const matchName = searchNameNorm && (rowNameNorm.includes(searchNameNorm) || searchNameNorm.includes(rowNameNorm));
      const matchPayee = searchPayeeNorm && (rowPayeeNorm.includes(searchPayeeNorm) || searchPayeeNorm.includes(rowPayeeNorm));
      
      if (matchName || matchPayee) {
        rowIndexToDelete = i + 1; // 0-based index for API
        break;
      }
    }
  } else {
    // If no specific filter given, delete the latest (last) entry
    rowIndexToDelete = rows.length;
  }

  if (rowIndexToDelete === -1) return false;

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

  return true;
}

// --- System Prompt for Gemini ---
const SYSTEM_PROMPT = `
You are the AI Munshi (Accountant) for an Indian Brick Kiln (ईंट भट्ठा).
Analyze incoming transaction text, voice transcripts, or photos of diary pages and return ONLY valid JSON matching this schema:

{
  "intent": "batch_update" | "order" | "dispatch" | "expense" | "daily_summary" | "update_entry" | "delete_entry" | "ignore",
  "target_tab": "Orders" | "Supply_Dispatch" | "Expenses" | "Daily_Closing",
  "search_filter": {
    "customer_name": string,
    "paid_to": string
  },
  "fields_to_update": {
    "village": string,
    "grade": string,
    "quantity": number,
    "amount_payable": number,
    "amount_received": number,
    "driver": string,
    "category": string,
    "paid_to": string,
    "amount": number,
    "remarks": string
  },
  "orders": [
    {
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
      "name": string,
      "village": string,
      "grade": string,
      "total_ordered_qty": number,
      "dispatched_qty": number,
      "driver": string
    }
  ],
  "expenses": [
    {
      "category": string,
      "paid_to": string,
      "amount": number,
      "remarks": string
    }
  ],
  "daily_closing": {
    "opening_balance": number,
    "total_jama": number,
    "total_kharcha": number,
    "maalik_ko_diya": number,
    "closing_balance": number,
    "remarks": string
  },
  "reply_text": string
}

BRICK GRADE & TERMINOLOGY STANDARDIZATION:
- "अव्वल" (अ० / I / Avwal)
- "दोयम" (दो० / II / Doyam)
- "सोयम" (सो० / III / Soyam)
- "मीठा" (मी० / Meetha)
- "गोड़िया" (गो० / Godiya)
- "खंजड़" (खं० / Khanjjad / Khangar)
- "पीला" (पी० / Peela)
- "अव्वल रोड़ा" (अ० रो०)
- "पीला रोड़ा" (पी० रो०)
- "रोड़ा" (रो० / Roda)
- "गुम्मा" (Gumma)
- "चाटका" (Chatka)

PARSING RULES:
1. DIARY PHOTO PARSING: When an image is provided, parse it as "batch_update", populate all sections (orders, dispatches, expenses, daily_closing), and generate a clear summary in "reply_text".
2. If customer name is missing, use "नकद ग्राहक".
3. Never put village names into the customer "name" field.
4. Calculate pending_amount = amount_payable - amount_received.
5. If an order is placed without delivery, create an order in "orders" and also a dispatch item in "dispatches" with dispatched_qty: 0 and total_ordered_qty populated.
6. For modifications (e.g., "सन्तरम का गाँव बरईपारा कर दो", "राम का रेट बदल दो"), use intent "update_entry" with search_filter and fields_to_update.
7. For deletions by name (e.g., "सन्तरम वाली एंट्री हटा दो"), use intent "delete_entry" with search_filter.
8. For general delete requests (e.g., "delete previous entry", "delete last entry", "पिछली एंट्री डिलीट करो"), set intent to "delete_entry", target_tab to "Orders", and search_filter to null.
`;

// --- Webhook Endpoint ---
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body?.data;
    if (!data) return res.sendStatus(200);

    const sender = data.key?.remoteJid || '';
    const messageId = data.key?.id || '';

    if (isDuplicateMessage(messageId)) {
      console.log(`[Dedup] Skipping duplicate message ${messageId}`);
      return res.sendStatus(200);
    }

    if (sender.includes('@g.us')) return res.sendStatus(200);

    let contents = [];
    const message = data.message;
    const text = message?.conversation || message?.extendedTextMessage?.text;
    const audioMessage = message?.audioMessage;
    const imageMessage = message?.imageMessage;

    if (text) {
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
    } else if (imageMessage) {
      console.log(`[Gemini] Processing diary image from ${sender}...`);
      const base64Image = req.body?.data?.message?.base64 || '';
      if (!base64Image) return res.sendStatus(200);
      const mimeType = imageMessage.mimetype || 'image/jpeg';
      contents = [
        SYSTEM_PROMPT,
        { inlineData: { mimeType: mimeType, data: base64Image } }
      ];
    } else {
      return res.sendStatus(200);
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });

    const result = await model.generateContent(contents);
    const responseText = result.response.text();
    const parsed = JSON.parse(responseText.trim());
    console.log('[Parsed JSON]:', parsed);

    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    // 1. Batch Update (Diary Photos)
    if (parsed.intent === 'batch_update' && sheets) {
      if (parsed.orders && parsed.orders.length > 0) {
        const orderRows = parsed.orders.map(o => [
          timestamp,
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
          await logOrUpdateDispatch(timestamp, d);
        }
      }

      if (parsed.expenses && parsed.expenses.length > 0) {
        const expenseRows = parsed.expenses.map(e => [
          timestamp,
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
              timestamp,
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

    // 2. Single Order Intent
    else if (parsed.intent === 'order' && sheets) {
      const order = parsed.orders?.[0] || parsed;
      await appendWithRetry({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Orders!A:I',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[
            timestamp,
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
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }

    // 3. Single Dispatch Intent
    else if (parsed.intent === 'dispatch' && sheets) {
      const dispatch = parsed.dispatches?.[0] || parsed;
      await logOrUpdateDispatch(timestamp, dispatch);
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }

    // 4. Single Expense Intent
    else if (parsed.intent === 'expense' && sheets) {
      const expense = parsed.expenses?.[0] || parsed;
      await appendWithRetry({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Expenses!A:E',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[
            timestamp,
            expense.category || 'अन्य',
            expense.paid_to || '',
            expense.amount || 0,
            expense.remarks || ''
          ]]
        }
      });
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }

    // 5. Single Daily Closing Intent
    else if (parsed.intent === 'daily_summary' && sheets) {
      const dc = parsed.daily_closing || parsed;
      await appendWithRetry({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Daily_Closing!A:G',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[
            timestamp,
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

    // 6. Update Entry Intent
    else if (parsed.intent === 'update_entry' && sheets) {
      const success = await updateSheetEntry(parsed.target_tab, parsed.search_filter, parsed.fields_to_update);
      const reply = success 
        ? (parsed.reply_text || 'एंट्री सफलतापूर्वक अपडेट कर दी गई है।')
        : 'माफ कीजिए, यह एंट्री शीट में नहीं मिली।';
      await sendWhatsAppReply(sender, reply);
    }

    // 7. Delete Entry Intent
    else if (parsed.intent === 'delete_entry' && sheets) {
      const success = await deleteSheetEntry(parsed.target_tab, parsed.search_filter);
      const reply = success 
        ? (parsed.reply_text || 'एंट्री सफलतापूर्वक डिलीट कर दी गई है।')
        : 'माफ कीजिए, डिलीट करने के लिए एंट्री नहीं मिली।';
      await sendWhatsAppReply(sender, reply);
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
