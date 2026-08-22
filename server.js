require('dotenv').config();
const fs = require('fs');
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const PDFDocument = require('pdfkit');

const app = express();
app.use(express.json({ limit: '50mb' }));

// --- Environment Variables & Firm Profile ---
const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const WHATSAPP_GATEWAY_BASE_URL = process.env.WHATSAPP_GATEWAY_BASE_URL;
const WHATSAPP_GATEWAY_KEY = process.env.WHATSAPP_GATEWAY_KEY;
const WHATSAPP_GATEWAY_TYPE = process.env.WHATSAPP_GATEWAY_TYPE;
const OWNER_PHONE_NUMBER = process.env.OWNER_PHONE_NUMBER || '919277078095';
const MUNSHI_PHONE_NUMBER = process.env.MUNSHI_PHONE_NUMBER || OWNER_PHONE_NUMBER;
const COAL_TUB_KG = Number(process.env.COAL_TUB_KG) || 40;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://bhatta-munshi.onrender.com';

// Firm & Bank Settlement Profile
const FIRM_NAME = process.env.KILN_NAME || 'Surendra Singh Eit Udyog';
const FIRM_ADDRESS = process.env.KILN_ADDRESS || 'Vill: Dobhiyara, Dist: Sultanpur, PIN: 227815';
const FIRM_GSTIN = process.env.KILN_GSTIN || '09AUOPS0954K1ZW';
const BANK_NAME = process.env.BANK_NAME || 'Bank of Baroda';
const BANK_ACCOUNT_NO = process.env.BANK_ACCOUNT_NO || '11150200000035';
const BANK_IFSC = process.env.BANK_IFSC || 'BARB0KUMARG';
const BANK_HOLDER = process.env.BANK_ACCOUNT_HOLDER || 'SURENDRA SINGH EIT BHATTA';

// Sequential GST Invoicing Configuration
const INVOICE_PREFIX = process.env.INVOICE_PREFIX || 'SSEU/26-27/';
const STARTING_INVOICE_NO = Number(process.env.STARTING_INVOICE_NO) || 1;

const MODEL_NAME = process.env.MODEL_NAME || 'gemini-3.6-flash';

const ALLOWED_NUMBERS = process.env.ALLOWED_NUMBERS
  ? process.env.ALLOWED_NUMBERS.split(',').map(num => num.trim())
  : ['919277078095'];

// --- Immediate Deduplication Lock ---
const processedMessageIds = new Set();
const MAX_TRACKED_IDS = 1000;

function checkAndLockMessage(messageId) {
  if (!messageId) return false;
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > MAX_TRACKED_IDS) {
    const oldest = processedMessageIds.values().next().value;
    processedMessageIds.delete(oldest);
  }
  return false;
}

const lastImageCache = new Map();
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || '');

// --- Initialize Google Sheets API ---
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
}

// --- Date Formatter Helper (Asia/Kolkata) ---
function getISTDate(offsetDays = 0) {
  const now = new Date();
  const istTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  if (offsetDays !== 0) {
    istTime.setDate(istTime.getDate() + offsetDays);
  }
  const d = String(istTime.getDate()).padStart(2, '0');
  const m = String(istTime.getMonth() + 1).padStart(2, '0');
  const y = istTime.getFullYear();
  return `${d}-${m}-${y}`;
}

function resolveDateStr(inputDate) {
  if (!inputDate || inputDate.toLowerCase() === 'today' || inputDate === 'आज') return getISTDate(0);
  if (!inputDate || inputDate.toLowerCase() === 'yesterday' || inputDate === 'कल') return getISTDate(-1);
  return inputDate.replace(/\//g, '-').trim();
}

// --- Unicode-Agnostic Roda Detector ---
function isRodaGrade(str) {
  if (!str) return false;
  const s = str.toString().toLowerCase();
  return /रो[ड़ड]|roda|rodda|trolley|ट्रॉली|ट्राली|ट्रोली|trauli/i.test(s);
}

// --- Multi-Tier Exact Rate Resolution ---
function getRateForGrade(gradeStr) {
  if (!gradeStr) return 7500;
  const g = gradeStr.toString().toLowerCase();

  // Priority 1: Multi-word & Roda Trolley Grades
  if (/रो[ड़ड].*?पीला|पीला.*?रो[ड़ड]|roda.*?peela|peela.*?roda/i.test(g)) return 2750;
  if (/रो[ड़ड].*?अव्वल|अव्वल.*?रो[ड़ड]|roda.*?awwal|awwal.*?roda/i.test(g)) return 5000;
  if (isRodaGrade(g)) return 5000;

  // Priority 2: Standard Brick Grades (Per 1,000)
  if (g.includes('अव्वल') || g.includes('awwal')) return 7500;
  if (g.includes('मीठा') || g.includes('meetha')) return 6500;
  if (g.includes('खंजड़') || g.includes('khanjad')) return 6250;
  if (g.includes('गोड़िया') || g.includes('godiya')) return 4500;
  if (g.includes('पीला') || g.includes('peela')) return 4000;

  return 7500;
}

// --- Quantity Extraction Helpers ---
function parseBrickQty(val, grade = '') {
  if (!val) return 0;
  if (isRodaGrade(grade) || isRodaGrade(val)) {
    return 0;
  }
  const cleanedVal = val.toString()
    .replace(/\d+\s*(?:ट्रॉली|ट्राली|ट्रोली|trolley|trauli|trolly)\s*(?:रो[ड़ड]ा|roda)?/gi, '')
    .trim();
  const numbers = cleanedVal.match(/\d+/g);
  if (!numbers) return 0;
  return numbers.reduce((sum, n) => sum + Number(n), 0);
}

function parseTrolleyQty(val) {
  if (!val) return 0;
  const match = val.toString().match(/(\d+)\s*(?:ट्रॉली|ट्राली|ट्रोली|trolley|trauli|trolly)/i);
  if (match) return Number(match[1]);
  const numMatch = val.toString().match(/\d+/);
  return numMatch ? Number(numMatch[0]) : 1;
}

function calculateBilledAmount(qtyVal, gradeVal) {
  const isRoda = isRodaGrade(gradeVal) || isRodaGrade(qtyVal);
  if (isRoda) {
    const tQty = parseTrolleyQty(qtyVal);
    const rate = getRateForGrade(gradeVal);
    return tQty * rate;
  }

  const qStr = (qtyVal || '').toString();
  const gStr = (gradeVal || '').toString();

  // If quantity string has mixed breakdown like "2000 अव्वल + 4000 मीठा"
  if (qStr.includes('+') || qStr.includes('/') || qStr.includes(',')) {
    let sum = 0;
    const chunks = qStr.split(/[+\/,]/);
    for (const chunk of chunks) {
      const c = chunk.trim();
      if (!c) continue;
      const cQty = parseBrickQty(c, c);
      const cRate = getRateForGrade(c);
      sum += (cQty * cRate) / 1000;
    }
    if (sum > 0) return sum;
  }

  // If grade column itself specifies a standard mixed load
  if (gStr.includes('अव्वल') && gStr.includes('मीठा')) {
    const totalQty = parseBrickQty(qtyVal, gradeVal);
    if (totalQty === 6000) {
      return (2000 * 7500 / 1000) + (4000 * 6500 / 1000); // 15000 + 26000 = 41000
    }
  }
  if (gStr.includes('गोड़िया') && gStr.includes('मीठा')) {
    const totalQty = parseBrickQty(qtyVal, gradeVal);
    if (totalQty === 2000) {
      return (1000 * 4500 / 1000) + (1000 * 6500 / 1000); // 4500 + 6500 = 11000
    }
  }

  const bQty = parseBrickQty(qtyVal, gradeVal);
  const rate = getRateForGrade(gradeVal);
  return (bQty * rate) / 1000;
}

// --- Dynamic Transliteration Engine for Safe PDF Rendering ---
function transliterateHindiToEnglish(text) {
  if (!text) return '';
  const charMap = {
    'अ':'A','आ':'Aa','इ':'I','ई':'Ee','उ':'U','ऊ':'Oo','ऋ':'Ri','ए':'E','ऐ':'Ai','ओ':'O','औ':'Au',
    'क':'K','ख':'Kh','ग':'G','घ':'Gh','ङ':'Ng',
    'च':'Ch','छ':'Chh','ज':'J','झ':'Jh','ञ':'Ny',
    'ट':'T','ठ':'Th','ड':'D','ढ':'Dh','ण':'N',
    'त':'T','थ':'Th','द':'D','ध':'Dh','न':'N',
    'प':'P','फ':'Ph','ब':'B','भ':'Bh','म':'M',
    'य':'Y','र':'R','ल':'L','व':'V','श':'Sh','ष':'Sh','स':'S','ह':'H',
    'ा':'a','ि':'i','ी':'ee','ु':'u','ू':'oo','ृ':'ri','े':'e','ै':'ai','ो':'o','ौ':'au','ं':'n','्':''
  };
  let result = '';
  const str = text.toString();
  for (let i = 0; i < str.length; i++) {
    result += charMap[str[i]] || str[i];
  }
  return result.replace(/[^\x20-\x7E]/g, '').trim();
}

function toAsciiText(str, enFallback = '') {
  if (enFallback && enFallback.trim()) return enFallback.trim();
  if (!str) return 'Customer';
  
  const map = {
    'कधंई': 'Kanhai',
    'कन्हाई': 'Kanhai',
    'कन्धाई': 'Kandhai',
    'पूरे काशीराम': 'Pure Kashiram',
    'सन्तराम': 'Santram',
    'बरई पारा': 'Barai Para',
    'मुकीम': 'Mukim',
    'इटौँजा': 'Itaunja',
    'नन्हे खा': 'Nanhe Khan',
    'सरूरपुर': 'Saroorpur',
    'मुलायम यादव': 'Mulayam Yadav',
    'गडौली': 'Gadauli',
    'बालगोविन्द': 'Balgovind',
    'महुलारा': 'Mahulara',
    'गगन सिंह': 'Gagan Singh',
    'मिल्कीपुर': 'Milkipur',
    'राम कुमार': 'Ram Kumar',
    'बसापुर': 'Basapur',
    'ब्लूमिंग बर्ड': 'Blooming Bird',
    'कुमारगंज': 'Kumarganj',
    'अनूप सिंह': 'Anoop Singh',
    'अभय': 'Abhay',
    'तिलोई': 'Tiloi',
    'अव्वल': 'Awwal (Grade 1)',
    'मीठा': 'Meetha (Grade 2)',
    'खंजड़': 'Khanjad',
    'गोड़िया': 'Godiya',
    'पीला': 'Peela',
    'रोड़ा अव्वल': 'Awwal Roda',
    'रोड़ा पीला': 'Peela Roda',
    'अव्वल रोड़ा': 'Awwal Roda',
    'पीला रोड़ा': 'Peela Roda',
    'ट्रॉली': 'Trolley'
  };

  const directMatch = map[str.toString().trim()];
  if (directMatch) return directMatch;

  const asciiClean = str.toString().replace(/[^\x00-\x7F]/g, '').trim();
  if (asciiClean.length > 0) return asciiClean;

  const transliterated = transliterateHindiToEnglish(str.toString());
  return transliterated || 'Customer';
}

// --- Transliteration & Phonetic Normalization ---
function normalizeHindi(str) {
  if (!str) return '';
  let s = str.toString().trim().toLowerCase();

  const transMap = [
    [/kanhai|kanahi|kandhai|कन्हाई|कनहाई|कधई|कन्धाई|कंधाई/g, 'कधंई'],
    [/santram|santuram/g, 'सन्तराम'],
    [/anup|anoop/g, 'अनूप'],
    [/singh/g, 'सिंह'],
    [/balgobind|balgovind|balgovinda/g, 'बालगोविन्द'],
    [/blooming|bird/g, 'ब्लूमिंग'],
    [/mahulara|mahulada/g, 'महुलारा'],
    [/mukim|mukeem/g, 'मुकीम'],
    [/nanhe|nanhey/g, 'नन्हे'],
    [/mulayam|yadav/g, 'मुलायम'],
    [/ramkumar|ram kumar/g, 'रामकुमार'],
    [/gagan/g, 'गगन'],
    [/meetha|mitha/g, 'मीठा'],
    [/awwal|awal/g, 'अव्वल'],
    [/peela|pila/g, 'पीला'],
    [/ro[ड़ड]|roda|rodda/g, 'रोड़ा'],
    [/trolly|trolley|trauli|ट्राली|ट्रॉली/g, 'ट्रॉली'],
    [/bindha|vindha/g, 'विन्धा'],
    [/chintu/g, 'चिन्टू'],
    [/khedu|khedoo/g, 'खेदू'],
    [/suraj/g, 'सूरज'],
    [/diesel/g, 'डीजल'],
    [/jai\s*prakash|jaiprakash/g, 'जय प्रकाश'],
    [/gaushala|goshala/g, 'गौशाला']
  ];

  for (const [regex, hindiVal] of transMap) s = s.replace(regex, hindiVal);

  return s
    .replace(/[\u0902\u0901]/g, 'न')
    .replace(/[\u093E\u093F\u0940\u0941\u0942\u0943\u0947\u0948\u094B\u094C\u094D]/g, '')
    .replace(/[\s\.\-_]/g, '');
}

function isCustomerMatch(rowName, rowVillage, queryStr) {
  if (!queryStr) return false;
  const nQuery = normalizeHindi(queryStr);
  const nName = normalizeHindi(rowName);
  const nVill = normalizeHindi(rowVillage);

  if (nName && (nName.includes(nQuery) || nQuery.includes(nName))) return true;
  if (nVill && (nVill.includes(nQuery) || nQuery.includes(nVill))) return true;

  const queryTokens = queryStr.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const targetStr = `${rowName || ''} ${rowVillage || ''}`.toLowerCase();
  return queryTokens.some(token => {
    const normToken = normalizeHindi(token);
    return targetStr.includes(token) || (normToken && targetStr.includes(normToken));
  });
}

async function appendWithRetry(params, retries = 2, delay = 800) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await sheets.spreadsheets.values.append(params);
    } catch (err) {
      const status = err.status || err.code || (err.response && err.response.status);
      if ((status === 503 || status === 500 || status === 429) && attempt < retries) {
        await new Promise(res => setTimeout(res, delay));
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
}

async function sendWhatsAppReply(recipient, text) {
  if (!WHATSAPP_GATEWAY_BASE_URL || !WHATSAPP_GATEWAY_KEY || !WHATSAPP_GATEWAY_TYPE || !recipient || !text) return;
  try {
    const cleanNumber = recipient.replace('@s.whatsapp.net', '').replace('@c.us', '');
    await axios.post(
      `${WHATSAPP_GATEWAY_BASE_URL}/message/sendText/${WHATSAPP_GATEWAY_TYPE}`,
      { number: cleanNumber, text: text },
      { headers: { apikey: WHATSAPP_GATEWAY_KEY }, timeout: 8000 }
    );
    console.log(`[Text Reply] Sent to ${cleanNumber}`);
  } catch (error) {
    console.error('[Reply Error]:', JSON.stringify(error.response?.data || error.message, null, 2));
  }
}

async function sendWhatsAppDocument(recipient, base64Pdf, fileName, caption = '') {
  if (!WHATSAPP_GATEWAY_BASE_URL || !WHATSAPP_GATEWAY_KEY || !WHATSAPP_GATEWAY_TYPE || !recipient) return;
  const cleanNumber = recipient.replace('@s.whatsapp.net', '').replace('@c.us', '');
  const cleanBase64 = base64Pdf.replace(/^data:application\/pdf;base64,/, '');

  const payload = {
    number: cleanNumber,
    mediatype: 'document',
    mimetype: 'application/pdf',
    caption: caption,
    media: cleanBase64,
    fileName: fileName || 'Tax_Invoice.pdf'
  };

  await axios.post(
    `${WHATSAPP_GATEWAY_BASE_URL}/message/sendMedia/${WHATSAPP_GATEWAY_TYPE}`,
    payload,
    { headers: { apikey: WHATSAPP_GATEWAY_KEY }, timeout: 15000 }
  );

  console.log(`[PDF Invoice] Dispatched to ${cleanNumber}`);
}

// --- Consecutive GST Invoice Number Generator & Logger ---
async function getNextConsecutiveInvoice(invData) {
  if (!sheets || !SPREADSHEET_ID) {
    return `${INVOICE_PREFIX}${String(Date.now()).slice(-4)}`;
  }

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Tax_Invoices!A2:A'
    });
    const rows = res.data.values || [];
    let nextNum = STARTING_INVOICE_NO;

    if (rows.length > 0) {
      const numbers = rows.map(r => {
        if (!r[0]) return 0;
        const match = r[0].toString().match(/(\d+)$/);
        return match ? parseInt(match[1], 10) : 0;
      });
      const maxExisting = Math.max(...numbers, 0);
      nextNum = Math.max(maxExisting + 1, STARTING_INVOICE_NO);
    }

    const sequentialNo = `${INVOICE_PREFIX}${String(nextNum).padStart(4, '0')}`;
    const qty = Number(invData.qty) || 2000;
    const rate = Number(invData.ratePerThousand) || 7500;
    const taxable = (qty * rate) / 1000;
    const cgst = taxable * 0.03;
    const sgst = taxable * 0.03;
    const total = taxable + cgst + sgst;

    await appendWithRetry({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Tax_Invoices!A:J',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          sequentialNo,
          invData.date || getISTDate(0),
          invData.customerName,
          invData.village,
          invData.grade,
          qty,
          taxable,
          cgst,
          sgst,
          total
        ]]
      }
    });

    console.log(`[Consecutive GST Invoice] Created: ${sequentialNo}`);
    return sequentialNo;
  } catch (err) {
    console.error('[Invoice Numbering Error]:', err.message);
    return `${INVOICE_PREFIX}${String(Date.now()).slice(-4)}`;
  }
}

// --- Dynamic A4 GST Tax Invoice PDF Generator ---
function createInvoicePDFBuffer(invoiceData) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const buffers = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers).toString('base64')));
      doc.on('error', reject);

      const {
        invoiceNo = `${INVOICE_PREFIX}0001`,
        date = getISTDate(0),
        customerName = 'Customer',
        customerNameEn = '',
        village = 'Local Site',
        villageEn = '',
        grade = 'अव्वल',
        qty = 2000,
        ratePerThousand = 7500
      } = invoiceData;

      const quantity = Number(qty) || 2000;
      const rate = Number(ratePerThousand) || 7500;
      const taxableValue = (quantity * rate) / 1000;
      const cgst = taxableValue * 0.03;
      const sgst = taxableValue * 0.03;
      const totalAmount = taxableValue + cgst + sgst;

      const safeCustomer = toAsciiText(customerName, customerNameEn);
      const safeVillage = toAsciiText(village, villageEn);
      const safeGrade = toAsciiText(grade);

      // 1. Header Banner
      doc.fillColor('#c2410c').fontSize(20).font('Helvetica-Bold').text(FIRM_NAME, { align: 'center' });
      doc.fontSize(9.5).fillColor('#334155').font('Helvetica').text(FIRM_ADDRESS, { align: 'center' });
      doc.fontSize(11).font('Helvetica-Bold').text('TAX INVOICE (PAKKA BILL)', { align: 'center' });
      doc.moveDown(0.3);

      // 2. Business Metadata
      doc.fontSize(9).fillColor('#000000').font('Helvetica').text(`GSTIN: ${FIRM_GSTIN} | State: Uttar Pradesh (Code: 09) | HSN: 69041000`, { align: 'center' });
      doc.moveDown(0.8);
      doc.rect(40, 115, 515, 1).fill('#cbd5e1');

      // 3. Invoice Metadata & Buyer Info
      doc.fontSize(10).fillColor('#0f172a').font('Helvetica');
      doc.text(`Invoice No : ${invoiceNo}`, 45, 128);
      doc.text(`Date       : ${date}`, 45, 143);

      doc.text(`Billed To  : ${safeCustomer}`, 320, 128);
      doc.text(`Address    : ${safeVillage}, UP`, 320, 143);

      // 4. Items Table Header
      const tableTop = 175;
      doc.rect(40, tableTop, 515, 22).fill('#f1f5f9');
      doc.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold');
      doc.text('Description', 50, tableTop + 6);
      doc.text('Grade', 190, tableTop + 6);
      doc.text('Quantity', 280, tableTop + 6);
      doc.text('Rate / 1000', 370, tableTop + 6);
      doc.text('Amount (INR)', 455, tableTop + 6);

      // 5. Items Row
      const rowY = tableTop + 30;
      doc.font('Helvetica').fontSize(10);
      doc.text('Burnt Clay Bricks', 50, rowY);
      doc.text(safeGrade, 190, rowY);
      doc.text(quantity.toLocaleString('en-IN') + ' Pcs', 280, rowY);
      doc.text(`Rs. ${rate.toLocaleString('en-IN')}`, 370, rowY);
      doc.text(`Rs. ${taxableValue.toFixed(2)}`, 455, rowY);

      doc.rect(40, rowY + 25, 515, 1).fill('#cbd5e1');

      // 6. Taxes & Net Calculation
      const taxY = rowY + 35;
      doc.fontSize(9).fillColor('#334155');
      doc.text('Taxable Amount:', 340, taxY);
      doc.text(`Rs. ${taxableValue.toFixed(2)}`, 455, taxY);

      doc.text('CGST @ 3%:', 340, taxY + 16);
      doc.text(`Rs. ${cgst.toFixed(2)}`, 455, taxY + 16);

      doc.text('SGST @ 3%:', 340, taxY + 32);
      doc.text(`Rs. ${sgst.toFixed(2)}`, 455, taxY + 32);

      doc.rect(330, taxY + 48, 225, 1).fill('#cbd5e1');

      doc.fontSize(11).font('Helvetica-Bold').fillColor('#0f172a');
      doc.text('Total Invoice Value:', 320, taxY + 56);
      doc.text(`Rs. ${totalAmount.toFixed(2)}`, 455, taxY + 56);

      // 7. Settlement Bank Account Details Box
      const bankY = taxY + 95;
      doc.rect(40, bankY - 8, 515, 60).stroke('#cbd5e1');
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#c2410c').text('BANK PAYMENT & SETTLEMENT DETAILS:', 50, bankY);
      doc.font('Helvetica').fillColor('#0f172a');
      doc.text(`Bank Name : ${BANK_NAME}`, 50, bankY + 14);
      doc.text(`Account No: ${BANK_ACCOUNT_NO}`, 50, bankY + 26);
      doc.text(`IFSC Code : ${BANK_IFSC} | Holder: ${BANK_HOLDER}`, 50, bankY + 38);

      // 8. Authorized Signatory Block
      const sigY = bankY + 70;
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor('#0f172a').text(`For ${FIRM_NAME}`, 320, sigY, { align: 'right', width: 235 });
      doc.fontSize(8.5).font('Helvetica').fillColor('#475569').text('(Authorized Signatory)', 320, sigY + 42, { align: 'right', width: 235 });

      // 9. Statutory Legal Disclaimer
      const footerY = sigY + 68;
      doc.rect(40, footerY - 5, 515, 1).fill('#e2e8f0');
      doc.fontSize(8).font('Helvetica-Oblique').fillColor('#64748b').text(
        'This is a computer-generated invoice and does not require a physical signature (Issued under Rule 46 of CGST Rules, 2017).',
        40,
        footerY + 4,
        { align: 'center', width: 515 }
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// --- Text Invoice Formatter Fallback ---
function formatGSTInvoice({ invoiceNo, date, customerName, village, grade, qty, ratePerThousand }) {
  const quantity = Number(qty) || 2000;
  const rate = Number(ratePerThousand) || 7500;
  const taxableValue = (quantity * rate) / 1000;
  const cgst = taxableValue * 0.03;
  const sgst = taxableValue * 0.03;
  const totalAmount = taxableValue + cgst + sgst;

  return `
=========================================
          ${FIRM_NAME}
           ${FIRM_ADDRESS}
           TAX INVOICE (पक्का बिल)
=========================================
इनवॉइस सं०: ${invoiceNo}
दिनांक: ${date || getISTDate(0)}
GSTIN: ${FIRM_GSTIN}
State: Uttar Pradesh (Code: 09)

क्रेता का विवरण (Billed To):
नाम: ${customerName || 'ग्राहक'}
गाँव/पता: ${village || 'उत्तर प्रदेश'}
-----------------------------------------
विवरण: लाल पक्की ईंट (${grade || 'अव्वल'})
HSN Code: 69041000
मात्रा: ${quantity.toLocaleString('en-IN')} नग
दर (Rate): ₹${rate.toLocaleString('en-IN')} / हज़ार
-----------------------------------------
कर योग्य मूल्य (Taxable Amount): ₹${taxableValue.toFixed(2)}
CGST @ 3%                     : ₹${cgst.toFixed(2)}
SGST @ 3%                     : ₹${sgst.toFixed(2)}
-----------------------------------------
कुल इनवॉइस मूल्य (Total Value) : ₹${totalAmount.toFixed(2)}
=========================================
बैंक विवरण (Bank Settlement Details):
• बैंक: ${BANK_NAME}
• खाता: ${BANK_ACCOUNT_NO}
• IFSC: ${BANK_IFSC}
• खाता धारक: ${BANK_HOLDER}
=========================================
(This is a computer-generated invoice and does not require a physical signature.)
For ${FIRM_NAME} - Authorized Signatory`;
}

function repairTruncatedJSON(jsonStr) {
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];
    if (char === '\\' && inString) {
      escaped = !escaped;
      continue;
    }
    if (char === '"' && !escaped) {
      inString = !inString;
    }
    if (!inString) {
      if (char === '{') openBraces++;
      else if (char === '}') openBraces = Math.max(0, openBraces - 1);
      else if (char === '[') openBrackets++;
      else if (char === ']') openBrackets = Math.max(0, openBrackets - 1);
    }
    escaped = false;
  }

  if (inString) jsonStr += '"';
  jsonStr = jsonStr.replace(/,\s*$/, '');

  while (openBrackets > 0) { jsonStr += ']'; openBrackets--; }
  while (openBraces > 0) { jsonStr += '}'; openBraces--; }

  return jsonStr;
}

// --- High-Speed In-Memory Dynamic Memory Cache ---
let cachedMemoryRules = '';
let lastMemoryFetch = 0;
const MEMORY_CACHE_TTL = 10 * 60 * 1000;

async function getDynamicRules(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedMemoryRules && (now - lastMemoryFetch < MEMORY_CACHE_TTL)) {
    return cachedMemoryRules;
  }
  try {
    if (!sheets || !SPREADSHEET_ID) return '';
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Agent_Memory!A2:E'
    });
    const rows = res.data.values || [];
    let memoryPrompt = `CRITICAL CANONICAL RULES (Learned from Owner):\n`;
    memoryPrompt += `- Primary Master Customer: Canonical name is strictly "कधंई" (Village: पूरे काशीराम). Map all spellings (कन्हाई, कन्धाई, कंधाई, कधई, कनहाई, Kanhai) strictly to "कधंई".\n`;

    rows.forEach(r => {
      if (r[1] && r[2]) {
        memoryPrompt += `- Shorthand/Alias "${r[1]}" -> Standard Name: "${r[2]}" (Location: ${r[3] || 'N/A'}). Note: ${r[4] || ''}\n`;
      }
    });
    cachedMemoryRules = memoryPrompt;
    lastMemoryFetch = now;
    return cachedMemoryRules;
  } catch (err) {
    return `- Primary Master Customer: Canonical name is strictly "कधंई" (Village: पूरे काशीराम). Map all spellings (कन्हाई, कन्धाई, कधई) to "कधंई".\n`;
  }
}

// --- Dynamic Prompt Builder ---
async function buildSystemPrompt() {
  const dynamicRules = await getDynamicRules();

  return `
You are the Chief AI Accountant & Operations Manager for an Indian Brick Kiln (ईंट भट्ठा). Current year is 2026.
Analyze transaction text, voice transcripts, or photos of daily diary pages. Return ONLY valid JSON matching this schema:

{
  "intent": "order" | "delivery_status_update" | "batch_update" | "query_slip_summary" | "dispatch" | "expense" | "daily_summary" | "query_date_summary" | "query_customer" | "update_entry" | "delete_entry" | "recheck_with_image" | "generate_invoice" | "learn_memory" | "sync_ledger" | "coal_entry" | "green_brick_entry" | "clarification" | "ignore",
  "target_tabs": ["Orders" | "Supply_Dispatch" | "Expenses" | "Daily_Closing" | "Customer_Ledger" | "Coal_Fuel_Khata" | "Green_Brick_Stock" | "Agent_Memory" | "Tax_Invoices" | "ALL"],
  "delete_all": boolean,
  "search_filter": {
    "customer_name": string,
    "paid_to": string,
    "grade": string,
    "date": string,
    "scope": "full" | "closing" | "dispatch" | "orders" | "expenses",
    "row_number": number,
    "row_numbers": [number]
  },
  "fields_to_update": {
    "date": string,
    "village": string,
    "destination": string,
    "grade": string,
    "customer_name": string,
    "quantity": string | number,
    "total_ordered_qty": string | number,
    "dispatched_qty": string | number,
    "total_dispatched": number,
    "amount_payable": number,
    "amount_received": number,
    "driver": string,
    "category": string,
    "paid_to": string,
    "amount": number,
    "remarks": string,
    "status": "Completed" | "Pending" | "Partial"
  },
  "updates": [
    {
      "target_tab": string,
      "row_number": number,
      "filter": { "customer_name": string, "grade": string },
      "fields": object
    }
  ],
  "orders": [
    {
      "date": string,
      "name": string,
      "village": string,
      "grade": string,
      "quantity": string | number,
      "unit": "नग" | "ट्रॉली",
      "amount_payable": number,
      "amount_received": number,
      "pending_amount": number,
      "mode_of_payment": "Cash" | "UPI" | "Online",
      "payment_condition": {
        "type": "cod_driver" | "advance_cash_person" | "home_parents" | "online_transfer" | "standard",
        "description": string,
        "person_name": string,
        "amount": number
      }
    }
  ],
  "dispatches": [
    {
      "date": string,
      "name": string,
      "village": string,
      "grade": string,
      "total_ordered_qty": string | number,
      "dispatched_qty": string | number,
      "unit": "नग" | "ट्रॉली",
      "driver": string,
      "is_credit": boolean
    }
  ],
  "delivery_update": {
    "customer_name": string,
    "customer_phone": string,
    "village": string,
    "stage": "loading" | "dispatched" | "eta",
    "quantity_str": string,
    "driver_name": string,
    "eta_minutes": string,
    "customer_message": string
  },
  "expenses": [
    {
      "date": string,
      "category": string,
      "paid_to": string,
      "amount": number,
      "remarks": string
    }
  ],
  "daily_closing": {
    "date": string,
    "opening_balance": number,
    "total_jama": number,
    "total_kharcha": number,
    "maalik_ko_diya": number,
    "closing_balance": number
  },
  "coal_consumption_tubs": number,
  "green_brick_rain_loss": number,
  "pathera_molding_entries": [
    {
      "worker_name": string,
      "bricks_count": number,
      "advance_paid": number
    }
  ],
  "learned_memory_rule": {
    "is_learning_instruction": boolean,
    "category": string,
    "alias_trigger": string,
    "canonical_value": string,
    "associated_location": string
  },
  "invoice_request": {
    "customer_name": string,
    "customer_name_en": string,
    "village": string,
    "village_en": string,
    "grade": string,
    "quantity": number,
    "rate_per_thousand": number
  },
  "reply_text": string
}

${dynamicRules}

PRICE LIST & REVERSE BENCHMARKS:
- अव्वल (Awwal): ₹14,500 – ₹15,500 (प्रति 2,000 -> ₹7,500 प्रति 1,000)
- मीठा (Meetha): ₹12,500 – ₹13,500 (प्रति 2,000 -> ₹6,500 प्रति 1,000) [Note: ₹52,000 = exactly 8,000 मीठा]
- खंजड़ (Khanjad): ₹12,000 – ₹13,000 (प्रति 2,000 -> ₹6,250 प्रति 1,000)
- गोड़िया (Godiya): ₹8,500 – ₹9,000 (प्रति 2,000 -> ₹4,500 प्रति 1,000)
- पीला (Peela): ₹8,000 (प्रति 2,000 -> ₹4,000 प्रति 1,000)
- अव्वल रोड़ा: ₹5,000 – ₹5,500 (प्रति ट्रॉली)
- पीला रोड़ा: ₹2,500 – ₹3,000 (प्रति ट्रॉली)

CRITICAL OPERATIONAL RULES:
1. NON-BUSINESS FILTER (SILENT IGNORE):
   - If a message, photo, or audio is NOT related to brick kiln operations (e.g. casual greetings like "Hi", "Hello", personal chat, machinery photos, selfies, weather, jokes), set intent: "ignore" and reply_text: "".
2. ADVANCE & RETROACTIVE JAMA/PAYMENTS:
   - When user records payment or settlement (e.g. "गगन सिंह का 15000 जमा दर्ज करो 10 अगस्त को"), set intent: "order".
   - Extract the specific mentioned date (e.g. "10-08-2026").
   - Set amount_payable, amount_received, and pending_amount: 0.
3. UNIVERSAL ORDERS & PAYMENT CONDITIONS:
   - Accept orders from ANY customer with details.
   - For mixed orders (e.g. 2000 अव्वल + 1 ट्रॉली रोड़ा), output SEPARATE items in the 'orders' array.
   - Classify payment condition:
     * Condition 1: Pay driver at site (cod_driver)
     * Condition 2: Paid cash to person (advance_cash_person)
     * Condition 3: Paid cash at home to parents (home_parents)
     * Condition 4: Online transfer to account holder (online_transfer)
4. DELIVERY STATUS UPDATES (LOAD / DISPATCH / ETA):
   - When text/voice says "लोड हो रहा है", "भट्ठे से निकल गया", "10-15 मिनट में पहुंचेगा", set intent: "delivery_status_update" and format a respectful Hindi notification in 'customer_message'.
5. RODA VS BRICK SEPARATION:
   - RODA is strictly measured in 'ट्रॉली'. Bricks in pieces (नग). NEVER output 6001 for 6000 bricks + 1 trolley.
6. Standardize canonical master customer 'कधंई' (Village: पूरे काशीराम).
7. Format all dates as DD-MM-YYYY using current year 2026.
`;
}

function inferOrderDetails(order, dispatches = []) {
  const isRoda = isRodaGrade(order.grade) || (order.unit === 'ट्रॉली');
  let qty = isRoda ? parseTrolleyQty(order.quantity) : parseBrickQty(order.quantity, order.grade);
  let grade = order.grade || 'अव्वल';
  const amount = Number(order.amount_received) || Number(order.amount_payable) || 0;
  const orderNameNorm = normalizeHindi(order.name);

  if (isRoda) {
    return { quantity: parseTrolleyQty(order.quantity), grade: grade, unit: 'ट्रॉली' };
  }

  if (qty === 0 && dispatches.length > 0) {
    const matchedDispatch = dispatches.find(d => {
      const dNameNorm = normalizeHindi(d.name);
      return dNameNorm && (dNameNorm.includes(orderNameNorm) || orderNameNorm.includes(dNameNorm));
    });
    if (matchedDispatch) {
      qty = parseBrickQty(matchedDispatch.dispatched_qty, matchedDispatch.grade) || parseBrickQty(matchedDispatch.total_ordered_qty, matchedDispatch.grade);
      if (matchedDispatch.grade) grade = matchedDispatch.grade;
    }
  }

  if (qty === 0 && amount > 0) {
    if (amount === 52000) {
      qty = 8000;
      grade = 'मीठा';
    } else if (amount >= 14000 && amount <= 16000) {
      qty = 2000;
      grade = 'अव्वल';
    } else if (amount >= 12000 && amount <= 13800) {
      qty = 2000;
      grade = 'मीठा';
    } else if (amount >= 8000 && amount <= 9500) {
      qty = 2000;
      grade = 'गोड़िया';
    } else if (amount >= 5000 && amount <= 5500) {
      qty = 1;
      grade = 'अव्वल रोड़ा';
      return { quantity: 1, grade: 'अव्वल रोड़ा', unit: 'ट्रॉली' };
    } else if (amount >= 2500 && amount <= 3000) {
      qty = 1;
      grade = 'पीला रोड़ा';
      return { quantity: 1, grade: 'पीला रोड़ा', unit: 'ट्रॉली' };
    } else {
      qty = Math.round((amount / 7500) * 1000);
    }
  }

  return { quantity: qty || 2000, grade: grade, unit: 'नग' };
}

async function generateContentWithRetry(contents, retries = 2, delay = 1000) {
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.0,
      maxOutputTokens: 8192
    }
  });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await model.generateContent(contents);
    } catch (err) {
      const status = err.status || (err.response && err.response.status);
      if ((status === 503 || status === 429 || status === 500) && attempt < retries) {
        await new Promise(res => setTimeout(res, delay));
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
}

async function processBatchDispatches(dateStr, dispatches) {
  if (!sheets || !SPREADSHEET_ID || !dispatches || dispatches.length === 0) return;

  const [dispatchRes, orderRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Supply_Dispatch!A2:J' }),
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A2:I' })
  ]);

  const dispatchRows = dispatchRes.data.values || [];
  const orderRows = orderRes.data.values || [];

  const rowsToAppend = [];
  const updatesToRun = [];

  for (const dispatch of dispatches) {
    const searchNameNorm = normalizeHindi(dispatch.name);
    const targetGradeNorm = normalizeHindi(dispatch.grade);
    const isRoda = isRodaGrade(dispatch.grade);
    const numericDispatched = isRoda ? parseTrolleyQty(dispatch.dispatched_qty) : parseBrickQty(dispatch.dispatched_qty, dispatch.grade);

    let targetRowIndex = -1;
    let targetRow = null;

    for (let i = 0; i < dispatchRows.length; i++) {
      const rowCustomerNorm = normalizeHindi(dispatchRows[i][1]);
      const rowGradeNorm = normalizeHindi(dispatchRows[i][3]);

      if (searchNameNorm && (rowCustomerNorm.includes(searchNameNorm) || searchNameNorm.includes(rowCustomerNorm))) {
        if (!targetGradeNorm || rowGradeNorm.includes(targetGradeNorm) || targetGradeNorm.includes(rowGradeNorm)) {
          targetRowIndex = i + 2;
          targetRow = dispatchRows[i];
          break;
        }
      }
    }

    let masterOrderedQty = isRoda ? parseTrolleyQty(dispatch.total_ordered_qty) : parseBrickQty(dispatch.total_ordered_qty, dispatch.grade);
    let matchedVillage = dispatch.village || '';

    if (masterOrderedQty === 0 || !dispatch.total_ordered_qty) {
      if (targetRow && (isRoda ? parseTrolleyQty(targetRow[4]) : parseBrickQty(targetRow[4], targetRow[3])) > 0) {
        masterOrderedQty = isRoda ? parseTrolleyQty(targetRow[4]) : parseBrickQty(targetRow[4], targetRow[3]);
        matchedVillage = matchedVillage || targetRow[2];
      } else {
        for (let j = orderRows.length - 1; j >= 0; j--) {
          const oNameNorm = normalizeHindi(orderRows[j][1]);
          const oGradeNorm = normalizeHindi(orderRows[j][3]);

          if (searchNameNorm && (oNameNorm.includes(searchNameNorm) || searchNameNorm.includes(oNameNorm))) {
            if (!targetGradeNorm || oGradeNorm.includes(targetGradeNorm) || targetGradeNorm.includes(oGradeNorm)) {
              masterOrderedQty = isRoda ? parseTrolleyQty(orderRows[j][4]) : parseBrickQty(orderRows[j][4], orderRows[j][3]);
              matchedVillage = matchedVillage || orderRows[j][2];
              break;
            }
          }
        }
      }
    }

    if (masterOrderedQty === 0) masterOrderedQty = numericDispatched;

    if (targetRowIndex !== -1 && targetRow) {
      const prevDispatchedNum = isRoda ? parseTrolleyQty(targetRow[6] || targetRow[5]) : parseBrickQty(targetRow[6] || targetRow[5], targetRow[3]);
      const finalDispatchedNum = prevDispatchedNum + numericDispatched;
      const balanceRemaining = Math.max(0, masterOrderedQty - finalDispatchedNum);
      const status = balanceRemaining === 0 ? 'Completed' : 'Partial';

      updatesToRun.push(
        sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `Supply_Dispatch!A${targetRowIndex}:J${targetRowIndex}`,
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[
              dispatch.date || dateStr,
              targetRow[1] || dispatch.name,
              matchedVillage || targetRow[2] || '',
              dispatch.grade || targetRow[3],
              isRoda ? `${masterOrderedQty} ट्रॉली` : masterOrderedQty,
              isRoda ? `${dispatch.dispatched_qty} ट्रॉली` : dispatch.dispatched_qty,
              isRoda ? `${finalDispatchedNum} ट्रॉली` : finalDispatchedNum,
              isRoda ? `${balanceRemaining} ट्रॉली` : balanceRemaining,
              dispatch.driver || targetRow[8] || '',
              status
            ]]
          }
        })
      );
    } else {
      const balanceRemaining = Math.max(0, masterOrderedQty - numericDispatched);
      const status = balanceRemaining === 0 ? 'Completed' : 'Partial';

      rowsToAppend.push([
        dispatch.date || dateStr,
        dispatch.name || 'नकद ग्राहक',
        matchedVillage,
        dispatch.grade || 'अव्वल',
        isRoda ? `${masterOrderedQty} ट्रॉली` : masterOrderedQty,
        isRoda ? `${dispatch.dispatched_qty} ट्रॉली` : dispatch.dispatched_qty,
        isRoda ? `${numericDispatched} ट्रॉली` : numericDispatched,
        isRoda ? `${balanceRemaining} ट्रॉली` : balanceRemaining,
        dispatch.driver || '',
        status
      ]);
    }
  }

  const tasks = [...updatesToRun];
  if (rowsToAppend.length > 0) {
    tasks.push(
      appendWithRetry({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Supply_Dispatch!A:J',
        valueInputOption: 'USER_ENTERED',
        resource: { values: rowsToAppend }
      })
    );
  }
  await Promise.all(tasks);
}

// --- Customer Ledger Engine (Strict 10-Column Separation & Mixed Quantity Preservation) ---
async function regenerateCustomerLedger() {
  if (!sheets || !SPREADSHEET_ID) return;
  try {
    const [ordersRes, dispatchRes] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A2:K' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Supply_Dispatch!A2:J' })
    ]);

    const orders = ordersRes.data.values || [];
    const dispatches = dispatchRes.data.values || [];
    const ledgerMap = new Map();

    // 1. Process Orders (Jama / Advance Bookings)
    for (const o of orders) {
      const name = o[1];
      if (!name) continue;
      const grade = o[3] || 'अव्वल';
      const isRoda = isRodaGrade(grade) || (o[4] && isRodaGrade(o[4]));
      const itemType = isRoda ? 'रोड़ा (Roda)' : 'ईंट (Bricks)';
      const key = `${normalizeHindi(name)}_${isRoda ? 'RODA' : 'BRICK'}`;

      const rawQtyStr = (o[4] || '').toString().trim();
      const count = isRoda ? parseTrolleyQty(o[4]) : parseBrickQty(o[4], grade);

      const item = ledgerMap.get(key) || {
        name,
        village: o[2] || '',
        itemType,
        unit: isRoda ? 'ट्रॉली' : 'नग',
        numericOrderedQty: 0,
        numericDispatchedQty: 0,
        orderedQtyDisplay: '',
        dispatchedQtyDisplay: '',
        totalBilled: 0,
        totalPaid: 0,
        hasExplicitOrder: true
      };

      item.numericOrderedQty += count;
      if (rawQtyStr && (rawQtyStr.includes('+') || rawQtyStr.includes('/') || rawQtyStr.includes(','))) {
        item.orderedQtyDisplay = rawQtyStr;
      }

      item.totalBilled += Number(o[5]) || 0;
      item.totalPaid += Number(o[6]) || 0;
      ledgerMap.set(key, item);
    }

    // 2. Process Dispatches (Supply / Deliveries)
    for (const d of dispatches) {
      const name = d[1];
      if (!name) continue;
      const grade = d[3] || 'अव्वल';
      const isRoda = isRodaGrade(grade) || isRodaGrade(d[4]) || isRodaGrade(d[5]);
      const itemType = isRoda ? 'रोड़ा (Roda)' : 'ईंट (Bricks)';
      const key = `${normalizeHindi(name)}_${isRoda ? 'RODA' : 'BRICK'}`;

      const rawDispStr = (d[5] || d[6] || '').toString().trim();
      const rawMasterStr = (d[4] || '').toString().trim();
      const dispCount = isRoda ? parseTrolleyQty(d[6] || d[5]) : parseBrickQty(d[6] || d[5], grade);
      const masterCount = isRoda ? parseTrolleyQty(d[4]) : parseBrickQty(d[4], grade);

      const item = ledgerMap.get(key) || {
        name,
        village: d[2] || '',
        itemType,
        unit: isRoda ? 'ट्रॉली' : 'नग',
        numericOrderedQty: 0,
        numericDispatchedQty: 0,
        orderedQtyDisplay: '',
        dispatchedQtyDisplay: '',
        totalBilled: 0,
        totalPaid: 0,
        hasExplicitOrder: false
      };

      item.numericDispatchedQty += dispCount;

      // Preserve explicit mixed strings like "2000 अव्वल + 4000 मीठा" or "1000 गोड़िया / 1000 मीठा"
      if (rawDispStr && (rawDispStr.includes('+') || rawDispStr.includes('/') || rawDispStr.includes(','))) {
        item.dispatchedQtyDisplay = rawDispStr;
        if (!item.orderedQtyDisplay || !item.hasExplicitOrder) {
          item.orderedQtyDisplay = rawMasterStr && (rawMasterStr.includes('+') || rawMasterStr.includes('/')) ? rawMasterStr : rawDispStr;
        }
      }

      if (!item.hasExplicitOrder) {
        item.numericOrderedQty += (masterCount > 0 ? masterCount : dispCount);
        const billedVal = calculateBilledAmount(d[5] || d[6] || d[4], grade);
        item.totalBilled += billedVal;
      }
      ledgerMap.set(key, item);
    }

    const ledgerRows = [];
    for (const [, acc] of ledgerMap.entries()) {
      const finalOrderedDisplay = acc.orderedQtyDisplay || acc.numericOrderedQty;
      const finalDispatchedDisplay = acc.dispatchedQtyDisplay || acc.numericDispatchedQty;
      const pendingQty = Math.max(0, acc.numericOrderedQty - acc.numericDispatchedQty);
      const netDue = Math.max(0, acc.totalBilled - acc.totalPaid);
      const status = (pendingQty === 0 && netDue === 0 && acc.totalBilled > 0)
        ? 'बेबाक (Settled)'
        : (netDue > 0 ? `बाकी: ₹${netDue.toLocaleString('en-IN')}` : 'बाकी माल');

      ledgerRows.push([
        acc.name,
        acc.village,
        acc.itemType,
        finalOrderedDisplay,
        finalDispatchedDisplay,
        acc.unit,
        acc.totalBilled,
        acc.totalPaid,
        netDue,
        status
      ]);
    }

    if (ledgerRows.length > 0) {
      await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: 'Customer_Ledger!A2:J' });
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Customer_Ledger!A2:J',
        valueInputOption: 'USER_ENTERED',
        resource: { values: ledgerRows }
      });
      console.log(`[Ledger] Rebuilt ${ledgerRows.length} customer ledger lines.`);
    }
  } catch (err) {
    console.error('[Ledger Regeneration Error]:', err.message);
  }
}

async function updateSingleRow(tab, rowIndex, updates) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tab}!A${rowIndex}:K${rowIndex}`
    });
    const row = res.data.values?.[0] || [];
    while (row.length < 11) row.push('');

    if (updates.date) row[0] = updates.date;

    if (tab === 'Orders') {
      if (updates.customer_name || updates.name) row[1] = updates.customer_name || updates.name;
      if (updates.village || updates.destination) row[2] = updates.village || updates.destination;
      if (updates.grade) row[3] = updates.grade;
      if (updates.quantity !== undefined) row[4] = updates.quantity;
      if (updates.amount_payable !== undefined) row[5] = updates.amount_payable;
      if (updates.amount_received !== undefined) row[6] = updates.amount_received;
      row[7] = Math.max(0, (Number(row[5]) || 0) - (Number(row[6]) || 0));
      if (updates.mode_of_payment) row[8] = updates.mode_of_payment;
    } else if (tab === 'Supply_Dispatch') {
      if (updates.customer_name || updates.name) row[1] = updates.customer_name || updates.name;
      if (updates.village || updates.destination) row[2] = updates.village || updates.destination;
      if (updates.grade) row[3] = updates.grade;
      if (updates.total_ordered_qty !== undefined) row[4] = updates.total_ordered_qty;
      if (updates.dispatched_qty !== undefined) row[5] = updates.dispatched_qty;
      if (updates.total_dispatched !== undefined) row[6] = updates.total_dispatched;
      const isRoda = isRodaGrade(row[3]);
      const ord = isRoda ? parseTrolleyQty(row[4]) : parseBrickQty(row[4], row[3]);
      const disp = isRoda ? parseTrolleyQty(row[6]) : parseBrickQty(row[6], row[3]);
      row[7] = isRoda ? `${Math.max(0, ord - disp)} ट्रॉली` : Math.max(0, ord - disp);
      if (updates.driver !== undefined) row[8] = updates.driver;
      row[9] = (ord - disp <= 0) ? 'Completed' : 'Partial';
    } else if (tab === 'Expenses') {
      if (updates.category) row[1] = updates.category;
      if (updates.paid_to) row[2] = updates.paid_to;
      if (updates.amount !== undefined) row[3] = updates.amount;
      if (updates.remarks) row[4] = updates.remarks;
    } else if (tab === 'Daily_Closing') {
      if (updates.opening_balance !== undefined) row[1] = updates.opening_balance;
      if (updates.total_jama !== undefined) row[2] = updates.total_jama;
      if (updates.total_kharcha !== undefined) row[3] = updates.total_kharcha;
      if (updates.maalik_ko_diya !== undefined) row[4] = updates.maalik_ko_diya;
      if (updates.closing_balance !== undefined) row[5] = updates.closing_balance;
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tab}!A${rowIndex}:K${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] }
    });
    return true;
  } catch (err) {
    console.error(`[Update Row Error ${tab}:${rowIndex}]:`, err.message);
    return false;
  }
}

async function findRowByFilter(tab, filter) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tab}!A2:K` });
    const rows = res.data.values || [];
    const searchName = filter?.customer_name || filter?.name;
    const searchPayee = filter?.paid_to;
    const searchGradeNorm = normalizeHindi(filter?.grade);

    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const matchName = searchName && isCustomerMatch(row[1], row[2], searchName);
      const matchPayee = searchPayee && isCustomerMatch(row[2], '', searchPayee);

      if (matchName || matchPayee) {
        if (searchGradeNorm && row[3] && !normalizeHindi(row[3]).includes(searchGradeNorm)) continue;
        return i + 2;
      }
    }
  } catch (err) {
    console.error(`[Find Row Error in ${tab}]:`, err.message);
  }
  return -1;
}

async function executeBatchUpdates(updatesList) {
  if (!sheets || !SPREADSHEET_ID || !Array.isArray(updatesList) || updatesList.length === 0) return 0;
  let updatedCount = 0;
  for (const item of updatesList) {
    const tab = item.target_tab || 'Orders';
    let targetRow = item.row_number;
    if (!targetRow || targetRow < 2) {
      targetRow = await findRowByFilter(tab, item.filter || item);
    }
    if (targetRow && targetRow >= 2) {
      const ok = await updateSingleRow(tab, targetRow, item.fields || item.fields_to_update || item);
      if (ok) updatedCount++;
    }
  }
  return updatedCount;
}

async function deleteSheetEntries(targetTabs, filter, deleteAll = false) {
  if (!sheets || !SPREADSHEET_ID) return { success: false, deletedFrom: [], count: 0 };
  const allTabs = ['Orders', 'Supply_Dispatch', 'Expenses', 'Daily_Closing'];
  const tabsToProcess = (targetTabs === 'ALL' || !targetTabs) ? allTabs : (Array.isArray(targetTabs) ? targetTabs : [targetTabs]);
  const deletedTabs = [];

  if (deleteAll) {
    await Promise.all(
      tabsToProcess.map(tab =>
        sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `${tab}!A2:Z` })
          .then(() => deletedTabs.push(tab))
          .catch(err => console.error(`[Clear Error in ${tab}]:`, err.message))
      )
    );
    return { success: deletedTabs.length > 0, deletedFrom: deletedTabs, clearedAll: true, count: 0 };
  }

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  let totalDeletedCount = 0;
  const searchName = filter?.customer_name;

  for (const tab of tabsToProcess) {
    const sheetMeta = meta.data.sheets.find(s => s.properties.title === tab);
    if (!sheetMeta) continue;
    const sheetId = sheetMeta.properties.sheetId;

    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tab}!A2:K` });
    const rows = res.data.values || [];
    if (rows.length === 0) continue;

    const requests = [];
    if (searchName) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (isCustomerMatch(rows[i][1], rows[i][2], searchName)) {
          requests.push({
            deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: i + 1, endIndex: i + 2 } }
          });
          totalDeletedCount++;
          break;
        }
      }
    }

    if (requests.length > 0) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests } });
      deletedTabs.push(tab);
    }
  }

  return { success: deletedTabs.length > 0, deletedFrom: deletedTabs, clearedAll: false, count: totalDeletedCount };
}

async function generateDateReport(dateStr, scope = 'full') {
  if (!sheets || !SPREADSHEET_ID) return null;
  const targetDate = resolveDateStr(dateStr);

  try {
    const [closingRes, dispatchRes, orderRes, expenseRes] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Daily_Closing!A2:F' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Supply_Dispatch!A2:J' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A2:I' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Expenses!A2:E' })
    ]);

    const isDateMatch = cell => cell && cell.toString().replace(/\//g, '-').trim() === targetDate;

    const closingRows = (closingRes.data.values || []).filter(r => isDateMatch(r[0]));
    const dispatchRows = (dispatchRes.data.values || []).filter(r => isDateMatch(r[0]));
    const expenseRows = (expenseRes.data.values || []).filter(r => isDateMatch(r[0]));
    const closing = closingRows[closingRows.length - 1];

    if (!closing && dispatchRows.length === 0 && expenseRows.length === 0) {
      return `⚠️ दिनांक *${targetDate}* का कोई रिकॉर्ड शीट में दर्ज नहीं मिला।`;
    }

    let fullText = `📋 *दिनांक ${targetDate} का दैनिक हिसाब*\n`;
    if (closing) {
      fullText += `\n💰 *रोकड़ मिलान:*` +
                  `\n• प्रारम्भिक बचत: ₹${Number(closing[1] || 0).toLocaleString('en-IN')}` +
                  `\n• कुल जमा (Jama): ₹${Number(closing[2] || 0).toLocaleString('en-IN')}` +
                  `\n• कुल खर्चा (Kharcha): ₹${Number(closing[3] || 0).toLocaleString('en-IN')}` +
                  `\n• मालिक को दिया: ₹${Number(closing[4] || 0).toLocaleString('en-IN')}` +
                  `\n• *अंतिम बचत (Closing): ₹${Number(closing[5] || 0).toLocaleString('en-IN')}*`;
    }

    if (dispatchRows.length > 0) {
      fullText += `\n\n🚚 *सप्लाई / डिस्पैच (${dispatchRows.length} गाड़ियां):*`;
      dispatchRows.forEach((d, i) => {
        fullText += `\n${i + 1}. ${d[1]} (${d[2] || 'भट्ठा'}): ${d[5] || d[4]} [${d[3]}] ${d[8] ? `- ड्राइवर ${d[8]}` : ''}`;
      });
    }

    if (expenseRows.length > 0) {
      let expSum = 0;
      fullText += `\n\n💸 *खर्च विवरण:*`;
      expenseRows.forEach((e, i) => {
        const amt = Number(e[3]) || 0;
        expSum += amt;
        fullText += `\n• ${e[2] || e[1]}: ₹${amt.toLocaleString('en-IN')} ${e[4] ? `(${e[4]})` : ''}`;
      });
      fullText += `\n*कुल खर्चा:* ₹${expSum.toLocaleString('en-IN')}`;
    }

    return fullText;
  } catch (err) {
    console.error('[Date Report Error]:', err.message);
    return null;
  }
}

// --- Customer Details & Aggregated Full Hisab (Bricks + Roda) ---
async function getCustomerDetails(customerName, targetDate = null) {
  if (!sheets || !SPREADSHEET_ID || !customerName) return null;
  const cleanDate = targetDate ? resolveDateStr(targetDate) : null;

  try {
    const [dispatchRes, orderRes, ledgerRes] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Supply_Dispatch!A2:J' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A2:K' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Customer_Ledger!A2:J' })
    ]);

    const dispatchRows = dispatchRes.data.values || [];
    const orderRows = orderRes.data.values || [];
    const ledgerRows = ledgerRes.data.values || [];

    const matchedLedgerLines = ledgerRows.filter(r => isCustomerMatch(r[0], r[1], customerName));

    const dispatches = dispatchRows.filter(row => {
      const matchName = isCustomerMatch(row[1], row[2], customerName);
      const rowDate = (row[0] || '').replace(/\//g, '-').trim();
      return matchName && (cleanDate ? rowDate === cleanDate : true);
    });

    const orders = orderRows.filter(row => {
      const matchName = isCustomerMatch(row[1], row[2], customerName);
      const rowDate = (row[0] || '').replace(/\//g, '-').trim();
      return matchName && (cleanDate ? rowDate === cleanDate : true);
    });

    if (dispatches.length === 0 && orders.length === 0 && matchedLedgerLines.length === 0) return null;

    let totalBrickOrdered = 0, totalBrickDispatched = 0;
    let totalRodaOrdered = 0, totalRodaDispatched = 0;
    let grandBilled = 0, grandPaid = 0;

    matchedLedgerLines.forEach(line => {
      const itemType = line[2] || '';
      const ord = parseBrickQty(line[3], itemType) || Number(line[3]) || 0;
      const disp = parseBrickQty(line[4], itemType) || Number(line[4]) || 0;
      const billed = Number(line[6]) || 0;
      const paid = Number(line[7]) || 0;

      if (isRodaGrade(itemType)) {
        totalRodaOrdered += (parseTrolleyQty(line[3]) || 1);
        totalRodaDispatched += (parseTrolleyQty(line[4]) || 1);
      } else {
        totalBrickOrdered += ord;
        totalBrickDispatched += disp;
      }
      grandBilled += billed;
      grandPaid += paid;
    });

    const grandDue = Math.max(0, grandBilled - grandPaid);

    return {
      name: matchedLedgerLines[0]?.[0] || dispatches[0]?.[1] || orders[0]?.[1] || customerName,
      village: matchedLedgerLines[0]?.[1] || dispatches[0]?.[2] || orders[0]?.[2] || '',
      filterDate: cleanDate,
      summary: {
        totalBrickOrdered,
        totalBrickDispatched,
        pendingBricks: Math.max(0, totalBrickOrdered - totalBrickDispatched),
        totalRodaOrdered,
        totalRodaDispatched,
        pendingRoda: Math.max(0, totalRodaOrdered - totalRodaDispatched),
        grandBilled,
        grandPaid,
        grandDue,
        status: grandDue === 0 && grandBilled > 0 ? 'बेबाक (Settled)' : (grandDue > 0 ? `बाकी: ₹${grandDue.toLocaleString('en-IN')}` : 'बाकी माल')
      },
      dispatches: dispatches.map(d => ({
        date: d[0], grade: d[3], qty: d[5] || d[4], total_disp: d[6], remaining: d[7], driver: d[8], status: d[9]
      })),
      orders: orders.map(o => ({
        date: o[0], grade: o[3], qty: o[4], payable: o[5], received: o[6], pending: o[7]
      }))
    };
  } catch (err) {
    console.error('[Customer Query Error]:', err.message);
    return null;
  }
}

// --- Schema Structure Synchronizer ---
async function ensureSchemaStructure() {
  if (!sheets || !SPREADSHEET_ID) return;

  const SCHEMA = {
    "Daily_Closing": ["Date", "Opening_Balance", "Total_Jama", "Total_Kharcha", "Maalik_Ko_Diya", "Closing_Balance"],
    "Orders": ["Date", "Customer_Name", "Village", "Brick_Grade", "Quantity", "Amount_Payable", "Amount_Received", "Pending_Amount", "Mode_of_Payment", "Customer_Phone", "Payment_Condition"],
    "Supply_Dispatch": ["Date", "Customer_Name", "Village", "Brick_Grade", "Master_Order_Qty", "Dispatched_Today", "Total_Dispatched", "Remaining_Bricks", "Driver", "Status"],
    "Expenses": ["Date", "Category", "Paid_To", "Amount", "Remarks"],
    "Customer_Ledger": ["Customer_Name", "Village", "Item_Type", "Ordered_Qty", "Dispatched_Qty", "Unit", "Total_Billed", "Total_Paid", "Net_Due", "Status"],
    "Agent_Memory": ["Category", "Alias_Trigger", "Canonical_Value", "Associated_Location", "Notes"],
    "Tax_Invoices": ["Invoice_No", "Date", "Customer_Name", "Village", "Brick_Grade", "Quantity", "Taxable_Value", "CGST_3Pct", "SGST_3Pct", "Total_Amount"],
    "Coal_Fuel_Khata": ["Date", "Description", "Inward_MT", "Rate", "Tubs_Burnt", "Kg_Per_Tub", "Consumed_MT", "Status"],
    "Green_Brick_Stock": ["Date", "Molded_Inward", "Bhari_Loaded", "Rain_Damage_Lost", "Status"],
    "Stock_Inventory": ["Date", "Brick_Grade", "Opening_Stock", "Production_Nikasi", "Dispatched_Deducted", "Damaged_Lost", "Closing_Stock"],
    "Labor_Pathera_Khata": ["Date", "Worker_Name", "Work_Type", "Bricks_Counted", "Rate_Per_1000", "Wages_Earned", "Advance_Khoraki_Paid", "Net_Labor_Balance"]
  };

  const SEED_MEMORY = [
    ["Primary Customer", "कन्हाई", "कधंई", "पूरे काशीराम", "Master name mapping"],
    ["Primary Customer", "कन्धाई", "कधंई", "पूरे काशीराम", "Master name mapping"],
    ["Primary Customer", "कधई", "कधंई", "पूरे काशीराम", "Master name mapping"],
    ["Primary Customer", "कनहाई", "कधंई", "पूरे काशीराम", "Master name mapping"]
  ];

  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheetMap = new Map();
    meta.data.sheets.forEach(s => sheetMap.set(s.properties.title, s.properties.sheetId));

    const missingTabs = Object.keys(SCHEMA).filter(t => !sheetMap.has(t));
    if (missingTabs.length > 0) {
      console.log(`[Schema Sync] Creating ${missingTabs.length} missing tab(s): ${missingTabs.join(', ')}`);
      const createRes = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: missingTabs.map(title => ({ addSheet: { properties: { title } } }))
        }
      });
      createRes.data.replies.forEach(r => {
        sheetMap.set(r.addSheet.properties.title, r.addSheet.properties.sheetId);
      });
    }

    const ranges = Object.keys(SCHEMA).map(t => `${t}!1:1`);
    const batchRes = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: SPREADSHEET_ID,
      ranges
    });

    const formatRequests = [];
    const valueUpdates = [];

    Object.keys(SCHEMA).forEach((tabName, idx) => {
      const requiredHeaders = SCHEMA[tabName];
      const existingHeaders = batchRes.data.valueRanges[idx]?.values?.[0] || [];
      const sheetId = sheetMap.get(tabName);

      const isHeaderMismatch =
        requiredHeaders.length !== existingHeaders.length ||
        requiredHeaders.some((h, i) => h !== existingHeaders[i]);

      if (isHeaderMismatch) {
        valueUpdates.push({
          range: `${tabName}!A1:${String.fromCharCode(64 + requiredHeaders.length)}1`,
          values: [requiredHeaders]
        });

        formatRequests.push(
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: requiredHeaders.length
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.91, green: 0.92, blue: 0.93 },
                  textFormat: { bold: true, underline: true, fontSize: 12 },
                  horizontalAlignment: 'CENTER'
                }
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
            }
          },
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: 'gridProperties.frozenRowCount'
            }
          }
        );
      }
    });

    if (valueUpdates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { valueInputOption: 'USER_ENTERED', data: valueUpdates }
      });
    }

    if (formatRequests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { requests: formatRequests }
      });
    }

    const memCheck = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Agent_Memory!A2:E'
    });
    if (!memCheck.data.values || memCheck.data.values.length === 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Agent_Memory!A:E',
        valueInputOption: 'USER_ENTERED',
        resource: { values: SEED_MEMORY }
      });
    }

    await getDynamicRules(true);
    console.log('⚡ [Schema Sync] Sheet structure is ready and Memory rules cached.');
  } catch (err) {
    console.error('[Schema Sync Error]:', err.message);
  }
}

// Health check endpoint
app.get(['/', '/health'], (req, res) => res.status(200).send('Brick Kiln AI Agent is Live! 🚀'));

// --- Main Webhook Endpoint ---
app.post(['/webhook', '/webhook/*', '/webhook/messages-upsert'], async (req, res) => {
  res.sendStatus(200);

  try {
    const data = req.body?.data;
    if (!data || data.key?.fromMe) return;

    const sender = data.key?.remoteJid || '';
    const messageId = data.key?.id || '';

    if (!sender || sender.includes('@g.us')) return;

    const cleanSenderNumber = sender.replace('@s.whatsapp.net', '').replace('@c.us', '').trim();
    if (!cleanSenderNumber) return;

    if (checkAndLockMessage(messageId)) return;

    const systemPrompt = await buildSystemPrompt();
    let contents = [];
    const message = data.message;
    const text = message?.conversation || message?.extendedTextMessage?.text;
    const audioMessage = message?.audioMessage;
    const imageMessage = message?.imageMessage;

    if (imageMessage) {
      const caption = imageMessage.caption || '';
      const base64Image = req.body?.data?.message?.base64 || '';
      if (!base64Image) return;
      const mimeType = imageMessage.mimetype || 'image/jpeg';
      lastImageCache.set(cleanSenderNumber, { base64: base64Image, mimeType });

      contents = [
        `${systemPrompt}\n\nUSER CAPTION: "${caption}"\nExtract all transactions, dispatches, jama, and closing balances from this diary image. If it's not a diary or account slip, set intent: "ignore".`,
        { inlineData: { mimeType, data: base64Image } }
      ];
    } else if (text) {
      contents = [`${systemPrompt}\n\nInput message / order transcript: "${text}"`];
    } else if (audioMessage) {
      const base64Audio = req.body?.data?.message?.base64 || '';
      if (!base64Audio) return;
      contents = [
        `${systemPrompt}\n\nTranscribe and parse phone call recording / audio voice note into structured brick kiln orders, dispatches, or expenses.`,
        { inlineData: { mimeType: 'audio/ogg; codecs=opus', data: base64Audio } }
      ];
    } else {
      return;
    }

    const result = await generateContentWithRetry(contents);
    let rawText = result.response.text().trim();
    const firstBrace = rawText.indexOf('{');
    if (firstBrace !== -1) rawText = rawText.slice(firstBrace);

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      parsed = JSON.parse(repairTruncatedJSON(rawText));
    }
    console.log(`[Parsed Intent from ${cleanSenderNumber}]:`, parsed.intent);

    // 1. STRICT NON-BUSINESS FILTER (SILENT IGNORE)
    if (parsed.intent === 'ignore') {
      console.log(`[Silent Ignore] Non-business message dropped for ${cleanSenderNumber}`);
      return;
    }

    // 2. SENDER WHITELIST CHECK (OPEN FOR ORDER BOOKING ONLY)
    const isWhitelisted = ALLOWED_NUMBERS.length === 0 || ALLOWED_NUMBERS.includes(cleanSenderNumber);
    if (!isWhitelisted && parsed.intent !== 'order') {
      console.log(`[Access Restricted] Non-whitelisted number ${cleanSenderNumber} attempted non-order intent: ${parsed.intent}`);
      return;
    }

    const defaultDate = getISTDate(0);

    // 3. DELIVERY STATUS UPDATE HANDLER (LOAD / DISPATCH / ETA PROXIMITY)
    if (parsed.intent === 'delivery_status_update') {
      const du = parsed.delivery_update || {};
      let munshiAck = `🚚 *सप्लाई स्टेटस अपडेट:* ${du.customer_name || 'ग्राहक'} (${du.stage || 'Status'})\n• विवरण: ${du.quantity_str || '1 ट्रॉली'}\n• ड्राइवर: ${du.driver_name || 'N/A'}`;
      
      if (du.customer_phone) {
        await sendWhatsAppReply(du.customer_phone, du.customer_message || `नमस्ते, ${FIRM_NAME} से आपकी ईंटों की सप्लाई का अपडेट: ${du.stage}`);
        munshiAck += `\n📲 *ग्राहक (${du.customer_phone}) को लाइव सूचना भेज दी गई है।*`;
      } else {
        munshiAck += `\nℹ️ *ग्राहक का फोन नंबर उपलब्ध नहीं है।*`;
      }
      await sendWhatsAppReply(sender, munshiAck);
      return;
    }

    // 4. MEMORY RULE LEARNING
    if (parsed.intent === 'learn_memory' || (parsed.learned_memory_rule && parsed.learned_memory_rule.is_learning_instruction)) {
      const mem = parsed.learned_memory_rule;
      if (sheets && mem?.alias_trigger && mem?.canonical_value) {
        await appendWithRetry({
          spreadsheetId: SPREADSHEET_ID,
          range: 'Agent_Memory!A:E',
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[
              mem.category || 'Customer Alias',
              mem.alias_trigger,
              mem.canonical_value,
              mem.associated_location || '',
              'Trained from WhatsApp chat'
            ]]
          }
        });
        await getDynamicRules(true);
        await sendWhatsAppReply(sender, `🧠 *नया नियम याद कर लिया गया है!*\n• उपनाम/गलत वर्तनी: "${mem.alias_trigger}"\n• सही मानक नाम: *${mem.canonical_value}* ${mem.associated_location ? `(${mem.associated_location})` : ''}`);
        return;
      }
    }

    // 5. FAST PDF GST INVOICE GENERATION (CONSECUTIVE NUMBERING & COMPLIANCE)
    if (parsed.intent === 'generate_invoice' || (text && (text.includes('बिल') || text.toLowerCase().includes('bill')))) {
      const invReq = parsed.invoice_request || {};
      
      const customerNameRaw = invReq.customer_name || 'अभय';
      const customerNameEn = invReq.customer_name_en || toAsciiText(customerNameRaw);
      const villageRaw = invReq.village || 'तिलोई';
      const villageEn = invReq.village_en || toAsciiText(villageRaw);

      const invData = {
        date: defaultDate,
        customerName: customerNameRaw,
        customerNameEn: customerNameEn,
        village: villageRaw,
        villageEn: villageEn,
        grade: invReq.grade || 'अव्वल',
        qty: invReq.quantity || 2000,
        ratePerThousand: invReq.rate_per_thousand || 7500
      };

      invData.invoiceNo = await getNextConsecutiveInvoice(invData);

      try {
        const base64Pdf = await createInvoicePDFBuffer(invData);
        await sendWhatsAppDocument(
          sender,
          base64Pdf,
          `Invoice_${invData.invoiceNo.replace(/\//g, '_')}.pdf`,
          `📄 *पक्का बिल (Tax Invoice)*\n• इनवॉइस सं०: *${invData.invoiceNo}*\n• फर्म: *${FIRM_NAME}*\n• ग्राहक: *${invData.customerName}* (${invData.village})\n• मात्रा: *${Number(invData.qty).toLocaleString('en-IN')} नग [${invData.grade}]*\n• कुल मूल्य: *₹${((invData.qty * invData.ratePerThousand / 1000) * 1.06).toFixed(2)}*`
        );
      } catch (pdfErr) {
        console.error('[PDF Fallback to Text]:', pdfErr.message);
        const fallbackText = formatGSTInvoice(invData);
        await sendWhatsAppReply(sender, fallbackText);
      }
      return;
    }

    // 6. EXPLICIT SHEET SYNC
    if (parsed.intent === 'sync_ledger' || (text && (text.includes('शीट सिंक') || text.includes('डेटा रिफ्रेश') || text.includes('sync sheet')))) {
      await regenerateCustomerLedger();
      await getDynamicRules(true);
      await sendWhatsAppReply(
        sender,
        `🔄 *शीट डेटा सफलतापूर्वक सिंक और अपडेट हो गया है!*\n\n• सभी ग्राहक खाते (ईंट व रोड़ा) 10-कॉलम संरचना में री-कैलकुलेट हो चुके हैं।\n• मेमोरी और मानक नियम सक्रिय हैं।`
      );
      return;
    }

    // 7. SCOPED DATE QUERIES
    if (parsed.intent === 'query_date_summary' && sheets) {
      const targetDate = parsed.search_filter?.date || 'yesterday';
      const scope = parsed.search_filter?.scope || 'full';
      const report = await generateDateReport(targetDate, scope);
      await sendWhatsAppReply(sender, report || 'संबंधित तारीख का कोई रिकॉर्ड नहीं मिला।');
      return;
    }

    // 8. CUSTOMER FULL HISAB QUERIES (AGGREGATED BRICKS + RODA)
    if (parsed.intent === 'query_customer' || (text && (text.includes('हिसाब') || text.toLowerCase().includes('hisab')))) {
      const customerName = parsed.search_filter?.customer_name || parsed.name || text.replace(/का|हिसाब|बताओ|hisab|batao|bataiye|de do|account/gi, '').trim();
      const dateFilter = parsed.search_filter?.date || null;
      const data = await getCustomerDetails(customerName, dateFilter);

      if (data && data.summary) {
        const s = data.summary;
        let reply = `🧱 *ग्राहक खाता बही: ${data.name}* ${data.village ? `(${data.village})` : ''}\n`;
        
        reply += `\n📊 *सप्लाई स्थिति:*` +
                 `\n• कुल ईंटें: ${s.totalBrickOrdered.toLocaleString('en-IN')} नग (सप्लाई: ${s.totalBrickDispatched.toLocaleString('en-IN')} | बाकी: ${s.pendingBricks.toLocaleString('en-IN')})` +
                 `\n• कुल रोड़ा: ${s.totalRodaOrdered} ट्रॉली (सप्लाई: ${s.totalRodaDispatched} | बाकी: ${s.pendingRoda})`;

        reply += `\n\n💰 *कुल वित्तीय मिलान (ईंट + रोड़ा):*` +
                 `\n• कुल बिल मूल्य: ₹${s.grandBilled.toLocaleString('en-IN')}` +
                 `\n• कुल जमा (Paid): ₹${s.grandPaid.toLocaleString('en-IN')}` +
                 `\n• *शुद्ध बकाया (Net Due): ₹${s.grandDue.toLocaleString('en-IN')}*` +
                 `\n• खाता स्थिति: *${s.status}*\n`;

        if (data.dispatches.length > 0) {
          reply += `\n🚚 *हालिया सप्लाई विवरण:*`;
          data.dispatches.slice(-3).forEach(d => {
            reply += `\n• ${d.date}: ${d.qty} [${d.grade}] | ड्राइवर: ${d.driver || 'N/A'}`;
          });
        }
        await sendWhatsAppReply(sender, reply);
      } else {
        await sendWhatsAppReply(sender, `माफ कीजिए, "${customerName}" का कोई रिकॉर्ड नहीं मिला।`);
      }
      return;
    }

    // 9. READ-ONLY SLIP SUMMARY
    if (parsed.intent === 'query_slip_summary') {
      let summaryReply = parsed.reply_text || '📋 पर्ची का हिसाब जांच लिया गया है।';
      if (parsed.daily_closing) {
        const { opening_balance = 0, total_jama = 0, total_kharcha = 0, maalik_ko_diya = 0, closing_balance = 0 } = parsed.daily_closing;
        const expected = Number(opening_balance) + Number(total_jama) - Number(total_kharcha) - Number(maalik_ko_diya);
        const diff = Number(closing_balance) - expected;
        if (diff !== 0 && closing_balance > 0) {
          summaryReply += `\n\n⚠️ *रोकड़ गड़बड़ी अलर्ट:* इस पर्ची में ₹${Math.abs(diff)} का अंतर है (अपेक्षित बचत: ₹${expected}, मुंशी बचत: ₹${closing_balance})।`;
        }
      }
      await sendWhatsAppReply(sender, summaryReply);
      return;
    }

    // 10. COMPREHENSIVE BATCH & IMAGE TRANSACTION HANDLER
    const hasBatchData = (parsed.orders?.length > 0) || (parsed.dispatches?.length > 0) || (parsed.expenses?.length > 0) || (parsed.daily_closing && Object.keys(parsed.daily_closing).length > 0);

    if (imageMessage || parsed.intent === 'batch_update' || parsed.intent === 'recheck_with_image' || (hasBatchData && parsed.intent !== 'order')) {
      const asyncTasks = [];

      if (parsed.orders && parsed.orders.length > 0) {
        const orderRows = parsed.orders.map(o => {
          const inferred = inferOrderDetails(o, parsed.dispatches || []);
          return [
            o.date || defaultDate,
            o.name || 'नकद ग्राहक',
            o.village || '',
            inferred.grade,
            inferred.unit === 'ट्रॉली' ? `${inferred.quantity} ट्रॉली` : inferred.quantity,
            o.amount_payable || (o.amount_received || 0),
            o.amount_received || 0,
            o.pending_amount || Math.max(0, (o.amount_payable || 0) - (o.amount_received || 0)),
            o.mode_of_payment || 'Cash',
            cleanSenderNumber,
            o.payment_condition?.description || 'Daily Slip Entry'
          ];
        });

        asyncTasks.push(
          appendWithRetry({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Orders!A:K',
            valueInputOption: 'USER_ENTERED',
            resource: { values: orderRows }
          })
        );
      }

      if (parsed.dispatches && parsed.dispatches.length > 0) {
        asyncTasks.push(processBatchDispatches(defaultDate, parsed.dispatches));
      }

      if (parsed.expenses && parsed.expenses.length > 0) {
        const expenseRows = parsed.expenses.map(e => [
          e.date || defaultDate,
          e.category || 'अन्य',
          e.paid_to || '',
          e.amount || 0,
          e.remarks || ''
        ]);
        asyncTasks.push(
          appendWithRetry({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Expenses!A:E',
            valueInputOption: 'USER_ENTERED',
            resource: { values: expenseRows }
          })
        );
      }

      let anomalyAlert = '';
      if (parsed.daily_closing && (parsed.daily_closing.total_jama || parsed.daily_closing.closing_balance || parsed.daily_closing.total_kharcha)) {
        const dc = parsed.daily_closing;
        const opening = Number(dc.opening_balance) || 0;
        const jama = Number(dc.total_jama) || 0;
        const kharcha = Number(dc.total_kharcha) || 0;
        const owner = Number(dc.maalik_ko_diya) || 0;
        const reportedClosing = Number(dc.closing_balance) || 0;
        const expectedClosing = opening + jama - kharcha - owner;
        const diff = reportedClosing - expectedClosing;

        if (diff !== 0 && reportedClosing > 0) {
          anomalyAlert = `\n\n⚠️ *रोकड़ गड़बड़ी अलर्ट:* मुंशी के हिसाब में ₹${Math.abs(diff)} का अंतर है (अपेक्षित बचत: ₹${expectedClosing}, मुंशी बचत: ₹${reportedClosing})।`;
        }

        asyncTasks.push(
          appendWithRetry({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Daily_Closing!A:F',
            valueInputOption: 'USER_ENTERED',
            resource: {
              values: [[
                dc.date || defaultDate,
                opening, jama, kharcha, owner, reportedClosing
              ]]
            }
          })
        );
      }

      if (parsed.coal_consumption_tubs && Number(parsed.coal_consumption_tubs) > 0) {
        const tubs = Number(parsed.coal_consumption_tubs);
        const consumedMT = (tubs * COAL_TUB_KG) / 1000;
        asyncTasks.push(
          appendWithRetry({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Coal_Fuel_Khata!A:H',
            valueInputOption: 'USER_ENTERED',
            resource: {
              values: [[defaultDate, 'Daily Feeding (झोकाई)', 0, 0, tubs, COAL_TUB_KG, consumedMT, 'Debited']]
            }
          })
        );
      }

      if (parsed.green_brick_rain_loss && Number(parsed.green_brick_rain_loss) > 0) {
        asyncTasks.push(
          appendWithRetry({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Green_Brick_Stock!A:E',
            valueInputOption: 'USER_ENTERED',
            resource: {
              values: [[defaultDate, 0, 0, Number(parsed.green_brick_rain_loss), 'Rain Damage Write-off']]
            }
          })
        );
      }

      await Promise.all(asyncTasks);
      await regenerateCustomerLedger();

      const finalReply = (parsed.reply_text || '✅ डायरी की सभी प्रविष्टियां दर्ज कर दी गई हैं।') + anomalyAlert;
      await sendWhatsAppReply(sender, finalReply);
      return;
    }

    // 11. UNIVERSAL ORDER BOOKING & INSTANT MUNSHI NOTIFICATION (WITH RETROACTIVE SUPPORT)
    if (parsed.intent === 'order' && sheets) {
      const ordersToProcess = (parsed.orders && parsed.orders.length > 0) ? parsed.orders : [parsed];
      const rows = ordersToProcess.map(o => {
        const inferred = inferOrderDetails(o, parsed.dispatches || []);
        const payCond = o.payment_condition?.description || o.payment_condition?.type || 'Customer Payment Entry';
        return [
          o.date ? resolveDateStr(o.date) : defaultDate,
          o.name || 'ग्राहक',
          o.village || '',
          inferred.grade,
          inferred.unit === 'ट्रॉली' ? `${inferred.quantity} ट्रॉली` : inferred.quantity,
          o.amount_payable || (o.amount_received || 0),
          o.amount_received || 0,
          o.pending_amount || Math.max(0, (o.amount_payable || 0) - (o.amount_received || 0)),
          o.mode_of_payment || 'Cash',
          cleanSenderNumber,
          payCond
        ];
      });

      await appendWithRetry({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A:K', valueInputOption: 'USER_ENTERED', resource: { values: rows } });
      await regenerateCustomerLedger();

      // Send Confirmation to Customer
      const firstOrder = ordersToProcess[0];
      const customerConfirm = `✅ *भुगतान / ऑर्डर पुष्टिकरण (${FIRM_NAME})*\n\n• नाम: *${firstOrder.name || 'ग्राहक'}*\n• दिनांक: *${firstOrder.date ? resolveDateStr(firstOrder.date) : defaultDate}*\n• जमा राशि: *₹${Number(firstOrder.amount_received || firstOrder.amount_payable || 0).toLocaleString('en-IN')}*\n• विवरण: *${ordersToProcess.map(o => `${o.quantity} [${o.grade || 'अव्वल'}]`).join(', ')}*\n\nखाता बही (Customer Ledger) में प्रविष्टि सफलतापूर्वक दर्ज व अपडेट कर दी गई है।`;
      await sendWhatsAppReply(sender, customerConfirm);

      // Instant Notification to Munshi
      let munshiAlert = `🚨 *जमा / ऑर्डर अलर्ट (${FIRM_NAME})*\n\n• ग्राहक: *${firstOrder.name || 'ग्राहक'}* (${cleanSenderNumber})\n• दिनांक: *${firstOrder.date ? resolveDateStr(firstOrder.date) : defaultDate}*\n• जमा रकम: *₹${Number(firstOrder.amount_received || firstOrder.amount_payable || 0).toLocaleString('en-IN')}*\n• विवरण: *${firstOrder.payment_condition?.description || 'N/A'}*`;
      if (MUNSHI_PHONE_NUMBER && cleanSenderNumber !== MUNSHI_PHONE_NUMBER) {
        await sendWhatsAppReply(MUNSHI_PHONE_NUMBER, munshiAlert);
      }
      return;
    }

    if (parsed.intent === 'dispatch' && sheets) {
      const dispatchesToProcess = (parsed.dispatches && parsed.dispatches.length > 0) ? parsed.dispatches : [parsed];
      await processBatchDispatches(defaultDate, dispatchesToProcess);
      await regenerateCustomerLedger();
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
      return;
    }

    if (parsed.intent === 'expense' && sheets) {
      const expensesToProcess = (parsed.expenses && parsed.expenses.length > 0) ? parsed.expenses : [parsed];
      const rows = expensesToProcess.map(e => [
        e.date || defaultDate,
        e.category || 'अन्य',
        e.paid_to || '',
        e.amount || 0,
        e.remarks || ''
      ]);
      await appendWithRetry({ spreadsheetId: SPREADSHEET_ID, range: 'Expenses!A:E', valueInputOption: 'USER_ENTERED', resource: { values: rows } });
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
      return;
    }

    if ((parsed.intent === 'daily_summary' || parsed.intent === 'daily_closing') && sheets) {
      const dc = parsed.daily_closing || parsed;
      await appendWithRetry({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Daily_Closing!A:F',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[
            dc.date || defaultDate,
            Number(dc.opening_balance) || 0,
            Number(dc.total_jama) || 0,
            Number(dc.total_kharcha) || 0,
            Number(dc.maalik_ko_diya) || 0,
            Number(dc.closing_balance) || 0
          ]]
        }
      });
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
      return;
    }

    // 12. SMART UPDATES & AUTO-HEALING PAYMENT SETTLEMENT
    if (parsed.intent === 'update_entry' && sheets) {
      let updatesList = Array.isArray(parsed.updates) && parsed.updates.length > 0 ? parsed.updates : [{
        target_tab: (parsed.target_tabs && parsed.target_tabs[0]) || 'Orders',
        row_number: parsed.search_filter?.row_number,
        filter: parsed.search_filter,
        fields: parsed.fields_to_update
      }];

      let count = await executeBatchUpdates(updatesList);

      // --- Auto-Healing Fallback for Prior/Unrecorded Orders ---
      if (count === 0 && (parsed.search_filter?.customer_name || parsed.name)) {
        const custName = parsed.search_filter?.customer_name || parsed.name;
        const custDetails = await getCustomerDetails(custName);

        if (custDetails && custDetails.dispatches.length > 0) {
          const firstDisp = custDetails.dispatches[0];
          const isRoda = isRodaGrade(firstDisp.grade);
          const qty = isRoda ? parseTrolleyQty(firstDisp.qty) : parseBrickQty(firstDisp.qty, firstDisp.grade);
          const totalVal = calculateBilledAmount(firstDisp.qty, firstDisp.grade);
          const paidVal = parsed.fields_to_update?.amount_received || totalVal;

          await appendWithRetry({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Orders!A:K',
            valueInputOption: 'USER_ENTERED',
            resource: {
              values: [[
                firstDisp.date || defaultDate,
                custDetails.name,
                custDetails.village || '',
                firstDisp.grade,
                isRoda ? `${qty} ट्रॉली` : qty,
                totalVal,
                paidVal,
                Math.max(0, totalVal - paidVal),
                'Cash',
                cleanSenderNumber,
                'Prior Unrecorded Order Auto-Settled'
              ]]
            }
          });
          count = 1;
          console.log(`[Auto-Heal Payment] Created missing Orders record for ${custDetails.name}`);
        }
      }

      await regenerateCustomerLedger();
      await sendWhatsAppReply(
        sender,
        count > 0 
          ? (parsed.reply_text || `✅ ${parsed.search_filter?.customer_name || 'ग्राहक'} का भुगतान खाता सफलतापूर्वक अपडेट और बेबाक (Settled) कर दिया गया है।`) 
          : 'माफ कीजिए, यह एंट्री नहीं मिली।'
      );
      return;
    }

    if (parsed.intent === 'delete_entry' && sheets) {
      const result = await deleteSheetEntries(parsed.target_tabs, parsed.search_filter, parsed.delete_all || false);
      if (parsed.delete_all) lastImageCache.delete(cleanSenderNumber);
      await regenerateCustomerLedger();
      await sendWhatsAppReply(sender, result.success ? (parsed.reply_text || `✅ प्रविष्टि हटा दी गई है।`) : 'डिलीट करने के लिए कोई एंट्री नहीं मिली।');
      return;
    }

    if (parsed.reply_text) {
      await sendWhatsAppReply(sender, parsed.reply_text);
    }
  } catch (error) {
    console.error('[Webhook Error]:', error);
  }
});

// --- Keep-Alive Ping (10 Mins) ---
cron.schedule('*/10 * * * *', async () => {
  try {
    if (RENDER_EXTERNAL_URL) {
      await axios.get(`${RENDER_EXTERNAL_URL}/health`, { timeout: 5000 });
      console.log('⚡ [Keep-Alive] Self ping successful.');
    }
  } catch (e) {
    // Silent catch
  }
});

// --- Scheduled End-of-Day Snapshot (8:30 PM IST Daily) ---
cron.schedule('30 20 * * *', async () => {
  try {
    const today = getISTDate(0);
    const report = await generateDateReport(today, 'full');
    if (report && OWNER_PHONE_NUMBER) {
      const header = `👑 *मालिक दैनिक रिपोर्ट (Daily Owner Snapshot)*\n`;
      await sendWhatsAppReply(OWNER_PHONE_NUMBER, header + report);
    }
  } catch (err) {
    console.error('[Nightly Cron Error]:', err.message);
  }
}, {
  timezone: 'Asia/Kolkata'
});

// --- Server Boot ---
app.listen(PORT, async () => {
  console.log(`🚀 Brick Kiln Munshi AI Server running on port ${PORT}`);
  await ensureSchemaStructure();
});
