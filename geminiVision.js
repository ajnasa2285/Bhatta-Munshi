const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);

/**
 * Reads a photo of a handwritten ledger page (bahi-khata) and returns a
 * clean plain-text transcription of its contents using Gemini 1.5 Flash
 * vision/OCR capability. No OpenAI used.
 *
 * @param {string} base64Image - base64-encoded image bytes
 * @param {string} mimeType - e.g. 'image/jpeg', 'image/png'
 * @returns {Promise<string>} transcribed ledger text
 */
async function readLedgerImage(base64Image, mimeType = 'image/jpeg') {
  const model = genAI.getGenerativeModel({ model: config.gemini.model });

  const prompt = `You are reading a photo of a handwritten ledger page (bahi-khata) from an Indian brick kiln (ईंट भट्ठा).
The handwriting may be in Hindi (Devanagari), English, or numerals mixed with local shorthand for:
- Brick grades: Awwal, Meetha, Khanjad, Peela, Godiya, Addha Awwal, Addha Peela
- Money amounts (₹, Rs, /-)
- Names of customers/thekedars and workers
- Dates in Indian formats (DD/MM/YY etc.)

Transcribe EVERY legible line of the ledger as accurately as possible, preserving the original script
(Hindi words in Devanagari, English words in English, numbers as digits).
If a word or number is unclear, make your best guess and mark it with [?] immediately after.
Output ONLY the transcription, line by line. No extra commentary, no markdown formatting.`;

  const result = await model.generateContent([
    { text: prompt },
    {
      inlineData: {
        mimeType,
        data: base64Image,
      },
    },
  ]);

  const response = result.response;
  const text = response.text().trim();
  return text;
}

module.exports = {
  readLedgerImage,
};
