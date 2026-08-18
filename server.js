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
    console.log('Google Sheets credentials loaded from Secret File.');
  } catch (err) {
    console.error('Failed to load credentials.json:', err.message);
  }
} else {
  console.error('Warning: credentials.json Secret File not found at', CREDENTIALS_PATH);
}

// Ensure required tabs exist
async function verifySheets() {
  if (!sheets || !SPREADSHEET_ID) return;
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const existingTabs = meta.data.sheets.map(s => s.properties.title);
    const requiredTabs = ['Sales', 'Expenses', 'Daily_Summary'];
    const requests = [];

    for (const tab of requiredTabs) {
      if (!existingTabs.includes(tab)) {
        requests.push({ addSheet: { properties: { title: tab } } });
      }
    }

    if (requests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { requests }
      });
    }
    console.log('Google Sheet tabs verified.');
  } catch (err) {
    console.error('Error verifying sheet tabs:', err.message);
  }
}
verifySheets();

// --- Send WhatsApp Reply ---
async function sendWhatsAppReply(recipient, text) {
  if (!WHATSAPP_GATEWAY_BASE_URL || !WHATSAPP_GATEWAY_KEY || !WHATSAPP_GATEWAY_TYPE) {
    console.error('[Reply Error] Missing WhatsApp gateway config:', {
      hasUrl: !!WHATSAPP_GATEWAY_BASE_URL,
      hasKey: !!WHATSAPP_GATEWAY_KEY,
      hasType: !!WHATSAPP_GATEWAY_TYPE
    });
    return;
  }
  try {
    const cleanNumber = recipient.replace('@s.whatsapp.net', '').replace('@c.us', '');
    await axios.post(
      `${WHATSAPP_GATEWAY_BASE_URL}/message/sendText/${WHATSAPP_GATEWAY_TYPE}`,
      {
        number: cleanNumber,
        text: text
      },
      { headers: { apikey: WHATSAPP_GATEWAY_KEY } }
    );
    console.log(`[Reply] Confirmation sent to ${cleanNumber}`);
  } catch (error) {
    console.error('[Reply Error]:', JSON.stringify(error.response?.data || error.message, null, 2));
  }
}

// --- Delete Last Matching Sale Entry ---
async function deleteLastSaleEntry(customerName) {
  if (!sheets || !SPREADSHEET_ID) return false;
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sales!A2:E'
    });

    const rows = response.data.values || [];
    let targetRowIndex = -1;

    for (let i = rows.length - 1; i >= 0; i--) {
      if (!customerName || (rows[i][1] && rows[i][1].includes(customerName))) {
        targetRowIndex = i + 2;
        break;
      }
    }

    if (targetRowIndex === -1) return false;

    const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const salesSheet = sheetMeta.data.sheets.find(s => s.properties.title === 'Sales');
    const sheetId = salesSheet.properties.sheetId;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: sheetId,
              dimension: 'ROWS',
              startIndex: targetRowIndex - 1,
              endIndex: targetRowIndex
            }
          }
        }]
      }
    });

    return true;
  } catch (err) {
    console.error('Error deleting entry from sheets:', err.message);
    return false;
  }
}

// --- System Prompt for Gemini ---
const SYSTEM_PROMPT = `
You are the AI Munshi (Accountant) for an Indian Brick Kiln (ईंट भट्ठा).
Analyze incoming transaction text or voice transcripts and return ONLY valid JSON matching this schema:

{
  "intent": "sale" | "expense" | "daily_summary" | "delete_sale" | "ignore",
  "name": string (Customer name strictly in Devanagari Hindi, e.g., "सुरेश", "रोहित". Transliterate English/Hinglish to Hindi),
  "grade": string (Must be strictly one of: "अव्वल", "दोयम", "सोयम", "मीठा", "खंगड़", "पीला", "रोड़ा", "गुम्मा", "चाटका"),
  "quantity": number (Number of bricks sold),
  "amount_payable": number (Total price for the bricks),
  "amount_received": number (Jama / advance payment received),
  "pending_amount": number (Remaining balance),
  "mode_of_payment": "Cash" | "Online" | "Pending",
  "category": string (Expense category: "कोयला", "लेबर/मजदूरी", "डीजल", "मिट्टी", "अन्य"),
  "paid_to": string (Payee name strictly in Devanagari Hindi),
  "amount": number (Expense amount),
  "remarks": string,
  "total_jama": number,
  "total_kharcha": number,
  "maalik_ko_diya": number,
  "munshi_cash_in_hand": number,
  "target_customer": string (For delete_sale intent: customer name in Hindi),
  "reply_text": string (Polite confirmation message in Devanagari Hindi)
}

RULES:
1. If input is casual chat, group chatter, or non-accounting text, set intent to "ignore" and reply_text to "".
2. If the user asks to cancel/delete a sale (e.g., "रोहित की एंट्री डिलीट करो", "गलत एंट्री हो गई कैंसिल करो"), set intent to "delete_sale" and extract "target_customer" in Hindi.
3. If user says "meetha" or "मीठा", strictly set grade to "मीठा".
4. Always calculate pending_amount = amount_payable - amount_received.
`;

// --- Webhook Endpoint ---
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body?.data;
    if (!data) return res.sendStatus(200);

    const sender = data.key?.remoteJid || '';

    if (sender.includes('@g.us')) {
      return res.sendStatus(200);
    }

    let contents = [];
    const message = data.message;
    const text = message?.conversation || message?.extendedTextMessage?.text;
    const audioMessage = message?.audioMessage;

    if (text) {
      console.log(`[Incoming] Sender: ${sender}, Text: "${text}"`);
      contents = [
        `${SYSTEM_PROMPT}\n\nInput message: "${text}"`
      ];
    } else if (audioMessage) {
      console.log(`[Gemini] Analyzing audio payload from ${sender}...`);
      const base64Audio = req.body?.data?.message?.base64 || '';
      if (!base64Audio) return res.sendStatus(200);

      contents = [
        SYSTEM_PROMPT,
        {
          inlineData: {
            mimeType: 'audio/ogg; codecs=opus',
            data: base64Audio
          }
        }
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

    if (parsed.intent === 'sale' && sheets) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Sales!A:I',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[
            timestamp,
            parsed.name || '',
            parsed.grade || '',
            parsed.quantity || 0,
            parsed.amount_payable || 0,
            parsed.amount_received || 0,
            parsed.pending_amount || 0,
            parsed.mode_of_payment || 'Cash',
            parsed.remarks || ''
          ]]
        }
      });
      console.log('[Sheets] Sale logged successfully.');
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }
    else if (parsed.intent === 'expense' && sheets) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Expenses!A:E',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[
            timestamp,
            parsed.category || 'अन्य',
            parsed.paid_to || '',
            parsed.amount || 0,
            parsed.remarks || ''
          ]]
        }
      });
      console.log('[Sheets] Expense logged successfully.');
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }
    else if (parsed.intent === 'daily_summary' && sheets) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Daily_Summary!A:F',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[
            timestamp,
            parsed.total_jama || 0,
            parsed.total_kharcha || 0,
            parsed.maalik_ko_diya || 0,
            parsed.munshi_cash_in_hand || 0,
            parsed.remarks || ''
          ]]
        }
      });
      console.log('[Sheets] Daily summary logged.');
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }
    else if (parsed.intent === 'delete_sale') {
      const deleted = await deleteLastSaleEntry(parsed.target_customer);
      const reply = deleted
        ? `${parsed.target_customer ? parsed.target_customer + ' की ' : ''}पिछली एंट्री सफलतापूर्वक हटा दी गई है।`
        : 'डिलीट करने के लिए कोई एंट्री नहीं मिली।';
      await sendWhatsAppReply(sender, reply);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error('[Webhook Error]:', error);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Munshi server listening on port ${PORT}`);
});
