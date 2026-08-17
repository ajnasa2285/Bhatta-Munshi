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
Parse the message (Hindi, Hinglish, or English, audio transcript or text) and return strict JSON with no markdown formatting:
{
  "intent": "sale" | "expense" | "daily_closing" | "correction" | "unknown",
  "name": string,
  "grade": "1st/अव्वल" | "2nd/दोयम" | "3rd/सोयम" | "Tukda/टुकड़ा" | "Roda/रोड़ा" | "Chatka/चटका" | "Other",
  "quantity": number,
  "amount_payable": number,
  "amount_received": number,
  "pending_amount": number,
  "mode_of_payment": "Cash" | "UPI" | "Bank Transfer" | "Credit",
  "category": "Coal/कोयला" | "Labor/मजदूरी" | "Diesel/डीजल" | "Soil/मिट्टी" | "Maintenance" | "Other",
  "paid_to": string,
  "amount": number,
  "remarks": string,
  "total_jama": number,
  "total_kharcha": number,
  "maalik_ko_diya": number,
  "munshi_cash_in_hand": number,
  "notes": string,
  "target_customer": string,
  "field_to_update": string,
  "corrected_value": string,
  "reply_text": string
}
`;

async function sendWhatsAppReply(recipient, text) {
  try {
    const cleanNumber = recipient.replace("@s.whatsapp.net", "").replace("@c.us", "");
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
    console.log(`WhatsApp reply successfully sent to ${cleanNumber}`);
  } catch (err) {
    console.error("Error sending WhatsApp reply:", err.response?.data || err.message);
  }
}

app.post("/webhook", async (req, res) => {
  res.status(200).send("OK");

  try {
    const data = req.body?.data;
    if (!data) return;

    const key = data.key;
    const remoteJid = key?.remoteJid || "";
    const senderNumber = remoteJid.replace("@s.whatsapp.net", "").replace("@c.us", "");

    const msg = data.message;
    if (!msg) return;

    let userText = msg.conversation || msg.extendedTextMessage?.text || "";
    let base64Audio = msg.base64 || data.base64 || "";

    if (!userText && !base64Audio) return;

    console.log(`[Munshi] Processing input from ${senderNumber}: ${userText || "[Audio Message]"}`);

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    let result;
    if (base64Audio && base64Audio.length > 100) {
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
      result = await model.generateContent([
        { text: SYSTEM_PROMPT },
        { text: `Process this entry: "${userText}"` },
      ]);
    }

    const raw = result.response.text().trim().replace(/^```json/, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(raw);
    console.log("[Munshi] Parsed data:", parsed);

    if (parsed.intent === "sale") {
      await sheets.logSale(parsed);
    } else if (parsed.intent === "expense") {
      await sheets.logExpense(parsed);
    } else if (parsed.intent === "daily_closing") {
      await sheets.logDailyClosing(parsed);
    } else if (parsed.intent === "correction") {
      await sheets.applyCorrection(parsed);
    }

    if (parsed.reply_text) {
      await sendWhatsAppReply(remoteJid, parsed.reply_text);
    }
  } catch (err) {
    console.error("[Munshi] Webhook error:", err.message);
  }
});

const PORT = config.port || 10000;
app.listen(PORT, async () => {
  console.log(`Munshi server live on port ${PORT}`);
  try {
    await sheets.ensureAllTabs();
    console.log("Google Sheet tabs verified.");
  } catch (e) {
    console.error("Sheet init error:", e.message);
  }
});
