const { resolveMediaToTempFile, cleanupTempFile } = require("./mediaDownload");
const { transcribeVoiceNote } = require("./geminiAudio");
const { extractLedgerTextFromImage } = require("./geminiVision");
const { extractLedgerData } = require("./geminiExtract");
const {
  ensureAllTabs,
  routeParsedVisionData,
  logSale,
  logExpense,
  logDailyClosing,
  applyCorrection
} = require("./sheets");
const gateway = require("./gateway");
const { config } = require("./config");

async function handleIncomingMessage(normalized) {
  const { from, type } = normalized;
  if (!from) return;

  if (config.allowedNumbers.length > 0 && !config.allowedNumbers.includes(from)) {
    await gateway.sendText(from, "Aap authorized nahi hain. Manager se sampark karein.");
    return;
  }

  let tempFileToCleanup = null;

  try {
    // 1. IMAGE FLOW: Multi-tab register parser (Orders, Dispatch, Expenses, Closing)
    if (type === "image") {
      const ext = (normalized.mimeType || "image/jpeg").includes("png") ? "png" : "jpg";
      const { tmpPath } = await resolveMediaToTempFile(normalized, ext);
      tempFileToCleanup = tmpPath;

      const parsedData = await extractLedgerTextFromImage(tmpPath, normalized.mimeType || "image/jpeg");

      await routeParsedVisionData(parsedData);

      const orderCount = parsedData.orders?.length || 0;
      const dispatchCount = parsedData.supply_dispatch?.length || 0;
      const expenseCount = parsedData.expenses?.length || 0;
      const totalKharcha = parsedData.daily_closing?.total_kharcha || 0;
      const closingBachat = parsedData.daily_closing?.closing_balance || 0;

      const reply = 
        `✅ *डायरी पेज सफलतापूर्वक दर्ज हो गया!*\n\n` +
        `📅 *तारीख:* ${parsedData.date || "आज"}\n` +
        `📦 *वसूली/ऑर्डर:* ${orderCount} प्रविष्टियां\n` +
        `🚚 *गाड़ी डिस्पैच:* ${dispatchCount} लोड\n` +
        `💸 *खर्चा:* ${expenseCount} मद (कुल ₹${totalKharcha})\n` +
        `💼 *मुंशी अंतिम बचत:* ₹${closingBachat}`;

      await gateway.sendText(from, reply);
      return;
    }

    // 2. AUDIO & TEXT FLOW: Single entry parsing via voice/text notes
    let rawText = "";

    if (type === "text") {
      rawText = normalized.text || "";
      if (!rawText.trim()) {
        await gateway.sendText(from, "Kripya text, voice note ya photo bhejein.");
        return;
      }
    } else if (type === "audio") {
      const { tmpPath } = await resolveMediaToTempFile(normalized, "ogg");
      tempFileToCleanup = tmpPath;
      rawText = await transcribeVoiceNote(tmpPath);
    } else {
      await gateway.sendText(from, "Yeh message format support nahi karta.");
      return;
    }

    const { data, isAmbiguous } = await extractLedgerData(rawText);

    if (isAmbiguous) {
      await gateway.sendText(from, "Entry samajh nahi aayi. Kripya dobara saaf bhejein.");
      return;
    }

    if (data.entry_type === "SALE" || data.entry_type === "ORDER") {
      await logSale(data.sale_data || data.order_data);
    } else if (data.entry_type === "EXPENSE") {
      await logExpense(data.expense_data);
    } else if (data.entry_type === "DAILY_CLOSING") {
      await logDailyClosing(data.daily_closing_data);
    } else if (data.entry_type === "CORRECTION") {
      await applyCorrection(data.correction_data);
    }

    await gateway.sendText(from, data.spoken_summary_hi || "Entry darj ho gayi hai.");
  } catch (err) {
    console.error("Error processing message:", err);
    await gateway.sendText(from, err.userMessage || "Entry process karne mein error aaya.");
  } finally {
    if (tempFileToCleanup) cleanupTempFile(tempFileToCleanup);
  }
}

async function initSheets() {
  try {
    await ensureAllTabs();
    console.log("Google Sheet tabs verified.");
  } catch (err) {
    console.error("Error verifying Sheet tabs:", err.message);
  }
}

module.exports = { handleIncomingMessage, initSheets };
