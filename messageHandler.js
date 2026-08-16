const { resolveMediaToTempFile, cleanupTempFile } = require("./mediaDownload");
const { transcribeVoiceNote } = require("./whisper");
const { extractLedgerTextFromImage } = require("./vision");
const { extractLedgerData } = require("./extract");
const {
  ensureAllTabs,
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

  let rawText;
  let tempFileToCleanup = null;

  try {
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
    } else if (type === "image") {
      const ext = (normalized.mimeType || "image/jpeg").includes("png") ? "png" : "jpg";
      const { tmpPath } = await resolveMediaToTempFile(normalized, ext);
      tempFileToCleanup = tmpPath;
      rawText = await extractLedgerTextFromImage(tmpPath, normalized.mimeType || "image/jpeg");
    } else {
      await gateway.sendText(from, "Yeh message format support nahi karta.");
      return;
    }

    const { data, isAmbiguous } = await extractLedgerData(rawText);

    if (isAmbiguous) {
      await gateway.sendText(from, "Entry samajh nahi aayi. Kripya dobara saaf bhejein.");
      return;
    }

    if (data.entry_type === "SALE") {
      await logSale(data.sale_data);
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
