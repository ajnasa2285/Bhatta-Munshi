const express = require("express");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { config, assertRequiredConfig } = require("./config");
const sheets = require("./sheets");

assertRequiredConfig();

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

const SYSTEM_PROMPT = `
You are an expert Munshi (accountant) for an Indian Brick Kiln (ईंट भट्ठा).
Analyze the text or audio transcription and return ONLY a valid JSON object (no markdown, no backticks):
{
  "intent": "sale" | "expense" | "daily_closing" | "correction" | "unknown",
  "name": "Customer or party name",
  "grade": "1st/अव्वल" | "2nd/दोयम" | "3rd/सोयम" | "Tukda/टुकड़ा" | "Roda/रोड़ा" | "Chatka/चटका" | "Other",
  "quantity": 0,
  "amount_payable": 0,
  "amount_received": 0,
  "pending_amount": 0,
  "mode_of_payment": "Cash" | "UPI" | "Bank Transfer" | "Credit",
  "category": "Coal/कोयला" | "Labor/मजदूरी" | "Diesel/डीजल" | "Soil/मिट्टी" | "Maintenance" | "Other",
  "paid_to": "",
  "amount": 0,
  "remarks": "",
  "total_jama": 0,
  "total_kharcha": 0,
  "maalik_ko_diya": 0,
  "munshi_cash_in_hand": 0,
  "notes": "",
  "target_customer": "",
  "field_to_update": "",
  "corrected_value": "",
  "reply_text": "A brief confirmation message in Hindi acknowledging the recorded entry"
}
`;

async function sendWhatsAppReply(targetNumber, text) {
  try {
    const cleanNumber = targetNumber.replace("@s.whatsapp.net", "").replace("@c.us", "");
    const url = `${config.gateway.baseUrl}/message/sendText/Bhatta-bot1`;
    await axios.post(
      url,
      {
        number: cleanNumber,
        text: text,
      },
      {
        headers: {
          apikey: config.gateway.key,
        },
      }
    );
    console.log(`[Reply] Confirmation sent to ${cleanNumber}`);
  } catch (err) {
    console.error("[Reply Error]", err.response?.data || err.message);
  }
}

app.post("/webhook", async (req, res) => {
  res.status(200).send("OK");

  try {
    const body = req.body;
    console.log("[Webhook Hit] Event:", body?.event);

    const data = body?.data;
    if (!data) return;

    const key = data.key || {};
    const remoteJid = key.remoteJid || "";
    const senderNumber = remoteJid.replace("@s.whatsapp.net", "").replace("@c.us", "");

    const msg = data.message || {};
    
    // Extract text across different WhatsApp message types
    let userText = 
      msg.conversation || 
      msg.extendedTextMessage?.text || 
      msg.imageMessage?.caption || 
      msg.videoMessage?.caption || 
      "";

    // Extract audio
    let base64Audio = msg.base64 || data.base64 || "";

    console.log(`[Incoming] Sender: ${senderNumber}, Text: "${userText}", Audio: ${Boolean(base64Audio)}`);

    if (!userText && !base64Audio) {
      console.log("[Webhook] No text or audio content found in message payload.");
      return;
    }

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    let result;
    if (base64Audio && base64Audio.length > 100) {
      console.log("[Gemini] Analyzing audio payload...");
      result = await model.generateContent([
        { text: SYSTEM_PROMPT },
        {
          inlineData: {
            mimeType: "audio/ogg; codecs=opus",
            data: base64Audio.replace(/^data:audio\/\w+;base64,/, ""),
          },
        },
      ]);
    } else {
      console.log(`[Gemini] Analyzing text: "${userText}"`);
      result = await model.generateContent([
        { text: SYSTEM_PROMPT },
        { text: `Parse this entry: "${userText}"` },
      ]);
    }

    const rawText = result.response.text().trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    console.log("[Gemini Response Raw]:", rawText);

    const parsed = JSON.parse(rawText);
    console.log("[Parsed JSON]:", parsed);

    if (parsed.intent === "sale") {
      await sheets.logSale(parsed);
      console.log("[Sheets] Sale logged successfully.");
    } else if (parsed.intent === "expense") {
      await sheets.logExpense(parsed);
      console.log("[Sheets] Expense logged successfully.");
    } else if (parsed.intent === "daily_closing") {
      await sheets.logDailyClosing(parsed);
      console.log("[Sheets] Daily Closing logged successfully.");
    } else if (parsed.intent === "correction") {
      await sheets.applyCorrection(parsed);
      console.log("[Sheets] Correction applied successfully.");
    }

    if (parsed.reply_text) {
      await sendWhatsAppReply(remoteJid, parsed.reply_text);
    }
  } catch (err) {
    console.error("[Webhook Error]:", err.message, err.stack);
  }
});

const PORT = config.port || 10000;
app.listen(PORT, async () => {
  console.log(`Munshi server listening on port ${PORT}`);
  try {
    await sheets.ensureAllTabs();
    console.log("Google Sheet tabs verified.");
  } catch (e) {
    console.error("Sheet init error:", e.message);
  }
});
