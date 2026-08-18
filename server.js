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

// --- Deduplication: Track recently processed message IDs ---
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

// Initialize Gemini Client
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || '');

// Initialize Google Sheets API using Render Secret File
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

// --- Send WhatsApp Reply ---
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
    console.log(`[Reply] Confirmation sent to ${cleanNumber}`);
  } catch (error) {
    console.error('[Reply Error]:', JSON.stringify(error.response?.data || error.message, null, 2));
  }
}

// --- Update or Append Supply / Dispatch Tab ---
async function logOrUpdateDispatch(dateStr, dispatch) {
  if (!sheets || !SPREADSHEET_ID) return;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Supply_Dispatch!A2:J'
  });

  const rows = res.data.values || [];
  let targetRowIndex = -1;
  let targetRow = null;

  for (let i = 0; i < rows.length; i++) {
    const rowCustomer = rows[i][1] || '';
    const rowStatus = rows[i][9] || '';
    if (dispatch.name && rowCustomer.includes(dispatch.name) && rowStatus !== 'Completed') {
      targetRowIndex = i + 2;
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
    console.log(`[Supply_Dispatch] Updated existing row ${targetRowIndex} for ${dispatch.name}`);
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
    console.log(`[Supply_Dispatch] Appended new row for ${dispatch.name}`);
  }
}

// --- System Prompt for Gemini ---
const SYSTEM_PROMPT = `
You are the AI Munshi (Accountant) for an Indian Brick Kiln (ईंट भट्ठा).
Analyze incoming transaction text, voice transcripts, or photos of diary pages and return ONLY valid JSON matching this schema:

{
  "intent": "batch_update" | "order" | "dispatch" | "expense" | "daily_summary" | "ignore",
  "orders": [
    {
      "name": string (Customer name in Hindi),
      "village": string (Village / location in Hindi),
      "grade": string (Brick grade),
      "quantity": number,
      "amount_payable": number,
      "amount_received": number,
      "pending_amount": number,
      "mode_of_payment": "Cash" | "UPI" | "Online"
    }
  ],
  "dispatches": [
    {
      "name": string (Customer name in Hindi),
      "village": string (Village / destination in Hindi),
      "grade": string (Brick grade),
      "total_ordered_qty": number,
      "dispatched_qty": number,
      "driver": string (Driver / tractor name in Hindi)
    }
  ],
  "expenses": [
    {
      "category": string ("कोयला" | "लेबर/मजदूरी" | "डीजल" | "मिट्टी" | "अन्य"),
      "paid_to": string (Payee or purpose in Hindi),
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
  "reply_text": string (Concise confirmation summary in Devanagari Hindi)
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
- "गुम्मा" (Gumma)
- "चाटका" (Chatka)

PARSING RULES:
1. DIARY PHOTO PARSING: When an image is provided, parse it as "batch_update", populate all 4 sections (orders, dispatches, expenses, daily_closing), and generate a clean WhatsApp summary in "reply_text".
2. If customer name is missing, use "नकद ग्राहक".
3. Never put villages or locations into the "name" field.
4. Calculate pending_amount = amount_payable - amount_received.
5. If an order has 0 dispatched quantity, ensure it is added to dispatches with dispatched_qty: 0 and total_ordered_qty set so it becomes a Pending order.
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

    // --- 1. Batch Update (e.g. Diary Photos) ---
    if (parsed.intent === 'batch_update' && sheets) {
      // Append Orders
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

      // Update / Append Dispatches
      if (parsed.dispatches && parsed.dispatches.length > 0) {
        for (const d of parsed.dispatches) {
          await logOrUpdateDispatch(timestamp, d);
        }
      }

      // Append Expenses
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

      // Append Daily Closing
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

    // --- 2. Single Order Intent ---
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

    // --- 3. Single Dispatch Intent ---
    else if (parsed.intent === 'dispatch' && sheets) {
      const dispatch = parsed.dispatches?.[0] || parsed;
      await logOrUpdateDispatch(timestamp, dispatch);
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }

    // --- 4. Single Expense Intent ---
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

    // --- 5. Single Daily Closing Intent ---
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

    return res.sendStatus(200);
  } catch (error) {
    console.error('[Webhook Error]:', error);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Munshi server running on port ${PORT}`);
});
