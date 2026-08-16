const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('./config');

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);

/**
 * Transcribes a WhatsApp voice note (Hindi/English/Hinglish) into plain text
 * using Gemini 1.5 Flash's native audio understanding. No OpenAI/Whisper used.
 *
 * @param {string} base64Audio - base64-encoded audio bytes
 * @param {string} mimeType - e.g. 'audio/ogg', 'audio/mpeg', 'audio/wav'
 * @returns {Promise<string>} transcribed text (kept in original language/script)
 */
async function transcribeAudio(base64Audio, mimeType = 'audio/ogg') {
  const model = genAI.getGenerativeModel({ model: config.gemini.model });

  const prompt = `You are transcribing a voice note from a brick kiln (ईंट भट्ठा) munshi (site accountant) in India.
The speech may be in Hindi, English, or a Hindi-English mix (Hinglish), and may include local terms
for brick grades (Awwal, Meetha, Khanjad, Peela, Godiya, Addha Awwal, Addha Peela), money, and workers' names.

Transcribe the audio EXACTLY as spoken. Rules:
- Keep numbers as spoken (e.g. "bees hazar" -> keep the words, do not convert to digits yourself).
- Preserve Hindi words in Devanagari script where spoken in Hindi; keep English words in English.
- Do not translate. Do not summarize. Do not add commentary.
- Output ONLY the raw transcription text, nothing else.`;

  const result = await model.generateContent([
    { text: prompt },
    {
      inlineData: {
        mimeType,
        data: base64Audio,
      },
    },
  ]);

  const response = result.response;
  const text = response.text().trim();
  return text;
}

module.exports = {
  transcribeAudio,
};
