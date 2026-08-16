const fs = require("fs");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { config } = require("./config");

const apiKey = config?.geminiApiKey || config?.gemini?.apiKey || process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(apiKey);

async function transcribeVoiceNote(filePath) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const audioData = fs.readFileSync(filePath).toString("base64");

  const prompt = `Listen to this Hindi voice note from an Indian brick kiln (ईंट भट्ठा).
Transcribe the spoken Hindi/Hinglish accurately into text. Focus on brick grades (Awwal, Meetha, Khanjad, Peela, Godiya, Addha Awwal, Addha Peela), amounts, customer names, expenses, and cash settlements. Return ONLY the transcribed text.`;

  const result = await model.generateContent([
    { inlineData: { data: audioData, mimeType: "audio/ogg" } },
    { text: prompt },
  ]);

  const text = (result.response.text() || "").trim();
  if (!text) {
    const err = new Error("EMPTY_TRANSCRIPTION");
    err.userMessage = "Voice note saaf nahi suna gaya. Kripya dobara clearly bole.";
    throw err;
  }
  return text;
}

module.exports = { transcribeVoiceNote };
