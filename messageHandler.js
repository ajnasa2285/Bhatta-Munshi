const config = require('../config');
const { transcribeAudio } = require('../services/geminiAudio');
const { readLedgerImage } = require('../services/geminiVision');
const { extractIntent } = require('../services/geminiExtract');
const sheets = require('../services/sheets');
const gateway = require('../services/gateway');
const { downloadMedia, cleanupTempFile } = require('../services/mediaDownload');

function nowIST() {
  // Returns a DD/MM/YYYY, HH:mm:ss string in Asia/Kolkata timezone.
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('day')}/${get('month')}/${get('year')}, ${get('hour')}:${get('minute')}:${get('second')}`;
}

function isAuthorized(fromNumber) {
  const allowed = config.access.allowedNumbers;
  // If no allow-list is configured, permit all senders (open mode).
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(fromNumber);
}

/**
 * Main pipeline: normalized message -> (transcribe/OCR if needed) ->
 * Gemini extraction -> write to Sheets -> WhatsApp confirmation reply.
 *
 * @param {object} normalizedMessage - output of normalizeWebhookPayload()
 */
async function handleIncomingMessage(normalizedMessage) {
  const { from, messageType, text, media, gatewayType } = normalizedMessage;

  if (!isAuthorized(from)) {
    console.log(`🚫 Ignoring message from unauthorized number: ${from}`);
    return;
  }

  let transcribedText = null;
  let tempFilePath = null;

  try {
    if (messageType === 'text') {
      transcribedText = text;
    } else if (messageType === 'audio') {
      const downloaded = await downloadMedia({ ...media, gatewayType });
      tempFilePath = downloaded.filePath;
      transcribedText = await transcribeAudio(downloaded.base64, downloaded.mimeType);
    } else if (messageType === 'image') {
      const downloaded = await downloadMedia({ ...media, gatewayType });
      tempFilePath = downloaded.filePath;
      const ocrText = await readLedgerImage(downloaded.base64, downloaded.mimeType);
      // If the image had a caption, include it alongside the OCR'd ledger text.
      transcribedText = text ? `${text}\n\n${ocrText}` : ocrText;
    } else {
      await gateway.sendText(
        from,
        'माफ़ कीजिए, यह मैसेज टाइप अभी सपोर्टेड नहीं है। कृपया टेक्स्ट, वॉइस नोट या फोटो भेजें।'
      );
      return;
    }

    if (!transcribedText || !transcribedText.trim()) {
      await gateway.sendText(
        from,
        'माफ़ कीजिए, मैसेज समझ नहीं आया। कृपया दोबारा भेजें।'
      );
      return;
    }

    // Give the LLM recent Sales context so CORRECTION intents can be resolved.
    const recentSalesContext = await sheets.getRecentSalesContext(15).catch(() => '');
    const extraction = await extractIntent(transcribedText, { recentSalesContext });

    const dateIST = nowIST();

    switch (extraction.intent) {
      case 'SALE': {
        await sheets.appendSaleRow(dateIST, extraction.data);
        break;
      }
      case 'EXPENSE': {
        await sheets.appendExpenseRow(dateIST, extraction.data);
        break;
      }
      case 'DAILY_CLOSING': {
        await sheets.appendDailyClosingRow(dateIST, extraction.data);
        // Also notify managers/owners with the closing summary.
        gateway
          .notifyManagers(`📊 आज का हिसाब (${dateIST}):\n${extraction.spoken_summary_hi}`)
          .catch(() => {});
        break;
      }
      case 'CORRECTION': {
        const result = await sheets.applyCorrection(extraction.data);
        if (!result.found) {
          await gateway.sendText(
            from,
            `माफ़ कीजिए, "${extraction.data.target_name}" से जुड़ी कोई हाल की एंट्री नहीं मिली। कृपया पूरी जानकारी के साथ दोबारा भेजें।`
          );
          return;
        }
        break;
      }
      case 'UNKNOWN':
      default: {
        await gateway.sendText(
          from,
          extraction.spoken_summary_hi ||
            'माफ़ कीजिए, यह मैसेज समझ नहीं आया। कृपया बिक्री, खर्च, रोज़ का हिसाब, या सुधार साफ़ शब्दों में बताएं।'
        );
        return;
      }
    }

    await gateway.sendText(from, extraction.spoken_summary_hi);
  } catch (err) {
    console.error(`❌ Error handling message from ${from}:`, err);
    try {
      await gateway.sendText(
        from,
        'माफ़ कीजिए, कुछ तकनीकी दिक्कत आ गई। कृपया थोड़ी देर बाद दोबारा कोशिश करें।'
      );
    } catch (sendErr) {
      // Nothing more we can do here.
    }
    gateway
      .notifyManagers(`⚠️ Munshi Agent error for ${from}: ${err.message}`)
      .catch(() => {});
  } finally {
    if (tempFilePath) await cleanupTempFile(tempFilePath);
  }
}

module.exports = {
  handleIncomingMessage,
};
