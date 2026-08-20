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

// --- Primary Model ---
const MODEL_NAME = 'gemini-3.6-flash';

// --- Authorized Phone Whitelist ---
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

// --- In-Memory Image Cache ---
const lastImageCache = new Map();

// --- Initialize Gemini Client ---
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
} else {
  console.error('Warning: credentials.json Secret File not found at', CREDENTIALS_PATH);
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
  if (!inputDate || inputDate.toLowerCase() === 'today' || inputDate === 'आज') {
    return getISTDate(0);
  }
  if (inputDate.toLowerCase() === 'yesterday' || inputDate === 'कल') {
    return getISTDate(-1);
  }
  return inputDate.replace(/\//g, '-').trim();
}

// --- Sheets API Append Helper with Retry ---
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

// --- Gemini Content Generation Helper ---
async function generateContentWithRetry(contents, retries = 3, delay = 1500) {
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
      console.warn(`[Gemini Attempt ${attempt}] Status: ${status || err.message}`);
      if ((status === 503 || status === 429 || status === 500) && attempt < retries) {
        await new Promise(res => setTimeout(res, delay));
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
}

// --- WhatsApp Reply Helper ---
async function sendWhatsAppReply(recipient, text) {
  if (!WHATSAPP_GATEWAY_BASE_URL || !WHATSAPP_GATEWAY_KEY || !WHATSAPP_GATEWAY_TYPE) return;
  try {
    const cleanNumber = recipient.replace('@s.whatsapp.net', '').replace('@c.us', '');
    await axios.post(
      `${WHATSAPP_GATEWAY_BASE_URL}/message/sendText/${WHATSAPP_GATEWAY_TYPE}`,
      { number: cleanNumber, text: text },
      { headers: { apikey: WHATSAPP_GATEWAY_KEY } }
    );
    console.log(`[Reply] Sent to ${cleanNumber}`);
  } catch (error) {
    console.error('[Reply Error]:', JSON.stringify(error.response?.data || error.message, null, 2));
  }
}

// --- Transliteration & Phonetic Normalization ---
function normalizeHindi(str) {
  if (!str) return '';
  let s = str.toString().trim().toLowerCase();

  const transMap = [
    [/kanhai|kanahi|kandhai|कन्हाई|कनहाई/g, 'कन्धाई'],
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
    [/roda|rodda/g, 'रोड़ा'],
    [/bindha|vindha/g, 'विन्धा'],
    [/chintu/g, 'चिन्टू'],
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

function parseTotalQty(val) {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  const numbers = val.toString().match(/\d+/g);
  if (!numbers) return 0;
  return numbers.reduce((sum, n) => sum + Number(n), 0);
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

// --- Batched Dispatch Processor with Single Row Mixed Support & Cumulative Tracking ---
async function processBatchDispatches(dateStr, dispatches) {
  if (!sheets || !SPREADSHEET_ID || !dispatches || dispatches.length === 0) return;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Supply_Dispatch!A2:J'
  });

  const rows = res.data.values || [];
  const rowsToAppend = [];
  const updatesToRun = [];

  for (const dispatch of dispatches) {
    const searchNameNorm = normalizeHindi(dispatch.name);
    const targetGradeNorm = normalizeHindi(dispatch.grade);

    let targetRowIndex = -1;
    let targetRow = null;

    for (let i = 0; i < rows.length; i++) {
      const rowCustomerNorm = normalizeHindi(rows[i][1]);
      const rowGradeNorm = normalizeHindi(rows[i][3]);

      if (searchNameNorm && (rowCustomerNorm.includes(searchNameNorm) || searchNameNorm.includes(rowCustomerNorm))) {
        if (!targetGradeNorm || rowGradeNorm.includes(targetGradeNorm) || targetGradeNorm.includes(rowGradeNorm)) {
          targetRowIndex = i + 2;
          targetRow = rows[i];
          break;
        }
      }
    }

    const rawQty = dispatch.dispatched_qty;
    const numericDispatched = parseTotalQty(rawQty);
    const numericOrdered = parseTotalQty(dispatch.total_ordered_qty || rawQty);

    if (targetRowIndex !== -1 && targetRow) {
      const prevDispatchedNum = parseTotalQty(targetRow[6]) || 0;
      const finalDispatchedNum = prevDispatchedNum + numericDispatched;
      const balanceRemaining = Math.max(0, numericOrdered - finalDispatchedNum);
      const status = balanceRemaining === 0 ? 'Completed' : 'Partial';

      updatesToRun.push(
        sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `Supply_Dispatch!D${targetRowIndex}:J${targetRowIndex}`,
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[
              dispatch.grade || targetRow[3],
              dispatch.total_ordered_qty || targetRow[4],
              rawQty,
              finalDispatchedNum,
              balanceRemaining,
              dispatch.driver || targetRow[8] || '',
              status
            ]]
          }
        })
      );
    } else {
      const balanceRemaining = Math.max(0, numericOrdered - numericDispatched);
      const status = balanceRemaining === 0 ? 'Completed' : 'Partial';

      rowsToAppend.push([
        dispatch.date || dateStr,
        dispatch.name || 'नकद ग्राहक',
        dispatch.village || '',
        dispatch.grade || 'अव्वल',
        dispatch.total_ordered_qty || rawQty,
        rawQty,
        numericDispatched,
        balanceRemaining,
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

// --- Dynamic Row-by-Row Update Core (Supports Comprehensive Field Aliases) ---
async function updateSingleRow(tab, rowIndex, updates) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tab}!A${rowIndex}:J${rowIndex}`
    });
    const row = res.data.values?.[0] || [];
    while (row.length < 10) row.push('');

    if (updates.date) row[0] = updates.date;

    if (tab === 'Orders') {
      if (updates.customer_name || updates.name || updates.customer) {
        row[1] = updates.customer_name || updates.name || updates.customer;
      }
      if (updates.village || updates.destination || updates.location || updates.address) {
        row[2] = updates.village || updates.destination || updates.location || updates.address;
      }
      if (updates.grade || updates.brick_grade) {
        row[3] = updates.grade || updates.brick_grade;
      }
      if (updates.quantity !== undefined || updates.qty !== undefined || updates.ordered_qty !== undefined) {
        row[4] = updates.quantity || updates.qty || updates.ordered_qty;
      }
      if (updates.amount_payable !== undefined || updates.total_amount !== undefined) {
        row[5] = updates.amount_payable || updates.total_amount;
      }
      if (updates.amount_received !== undefined || updates.received !== undefined) {
        row[6] = updates.amount_received !== undefined ? updates.amount_received : updates.received;
      }
      const payable = Number(row[5]) || 0;
      const received = Number(row[6]) || 0;
      row[7] = Math.max(0, payable - received);
      if (updates.mode_of_payment || updates.payment_mode) {
        row[8] = updates.mode_of_payment || updates.payment_mode;
      }
    } else if (tab === 'Supply_Dispatch') {
      if (updates.customer_name || updates.name || updates.customer) {
        row[1] = updates.customer_name || updates.name || updates.customer;
      }
      if (updates.village || updates.destination || updates.location || updates.address) {
        row[2] = updates.village || updates.destination || updates.location || updates.address;
      }
      if (updates.grade || updates.brick_grade) {
        row[3] = updates.grade || updates.brick_grade;
      }
      if (updates.total_ordered_qty !== undefined || updates.ordered_qty !== undefined) {
        row[4] = updates.total_ordered_qty !== undefined ? updates.total_ordered_qty : updates.ordered_qty;
      }
      if (updates.dispatched_qty !== undefined || updates.quantity !== undefined || updates.qty !== undefined) {
        row[5] = updates.dispatched_qty !== undefined ? updates.dispatched_qty : (updates.quantity !== undefined ? updates.quantity : updates.qty);
      }
      if (updates.total_dispatched !== undefined) {
        row[6] = Number(updates.total_dispatched) || parseTotalQty(updates.total_dispatched);
      } else if (updates.dispatched_qty !== undefined || updates.quantity !== undefined || updates.qty !== undefined) {
        row[6] = parseTotalQty(row[5]);
      }
      const orderedNum = parseTotalQty(row[4]);
      const dispatchedNum = Number(row[6]) || 0;
      row[7] = Math.max(0, orderedNum - dispatchedNum);
      if (updates.driver !== undefined || updates.vehicle !== undefined) {
        row[8] = updates.driver !== undefined ? updates.driver : updates.vehicle;
      }
      row[9] = row[7] === 0 ? 'Completed' : 'Partial';
      if (updates.status) row[9] = updates.status;
    } else if (tab === 'Expenses') {
      if (updates.category) row[1] = updates.category;
      if (updates.paid_to || updates.person) row[2] = updates.paid_to || updates.person;
      if (updates.amount !== undefined) row[3] = updates.amount;
      if (updates.remarks || updates.description) row[4] = updates.remarks || updates.description;
    } else if (tab === 'Daily_Closing') {
      if (updates.opening_balance !== undefined) row[1] = updates.opening_balance;
      if (updates.total_jama !== undefined) row[2] = updates.total_jama;
      if (updates.total_kharcha !== undefined) row[3] = updates.total_kharcha;
      if (updates.maalik_ko_diya !== undefined) row[4] = updates.maalik_ko_diya;
      if (updates.closing_balance !== undefined) row[5] = updates.closing_balance;
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tab}!A${rowIndex}:J${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] }
    });
    return true;
  } catch (err) {
    console.error(`[Update Row Error ${tab}:${rowIndex}]:`, err.message);
    return false;
  }
}

// --- Helper to Find Row Index by Filter ---
async function findRowByFilter(tab, filter) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tab}!A2:J` });
    const rows = res.data.values || [];
    const searchNameNorm = normalizeHindi(filter?.customer_name || filter?.name || filter?.customer);
    const searchPayeeNorm = normalizeHindi(filter?.paid_to);
    const searchGradeNorm = normalizeHindi(filter?.grade || filter?.brick_grade);

    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const rowNameNorm = normalizeHindi(row[1]);
      const rowPayeeNorm = normalizeHindi(row[2]);
      const rowGradeNorm = normalizeHindi(row[3]);

      const matchName = searchNameNorm && (rowNameNorm.includes(searchNameNorm) || searchNameNorm.includes(rowNameNorm));
      const matchPayee = searchPayeeNorm && (rowPayeeNorm.includes(searchPayeeNorm) || searchPayeeNorm.includes(rowPayeeNorm));

      if (matchName || matchPayee) {
        if (searchGradeNorm && rowGradeNorm && !rowGradeNorm.includes(searchGradeNorm) && !searchGradeNorm.includes(rowGradeNorm)) {
          continue;
        }
        return i + 2;
      }
    }
  } catch (err) {
    console.error(`[Find Row Error in ${tab}]:`, err.message);
  }
  return -1;
}

// --- Multi-Row Batch Updates Engine ---
async function executeBatchUpdates(updatesList) {
  if (!sheets || !SPREADSHEET_ID || !Array.isArray(updatesList) || updatesList.length === 0) return 0;
  let updatedCount = 0;

  for (const item of updatesList) {
    const tab = item.target_tab || 'Supply_Dispatch';
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

// --- Multi-Row Batch Deletion Engine (Deletes in Descending Order) ---
async function deleteSheetEntries(targetTabs, filter, deleteAll = false) {
  if (!sheets || !SPREADSHEET_ID) return { success: false, deletedFrom: [], count: 0 };

  const allTabs = ['Orders', 'Supply_Dispatch', 'Expenses', 'Daily_Closing'];
  let tabsToProcess = [];

  if (Array.isArray(targetTabs)) {
    if (targetTabs.includes('ALL')) tabsToProcess = allTabs;
    else tabsToProcess = targetTabs;
  } else if (targetTabs === 'ALL' || !targetTabs) {
    tabsToProcess = allTabs;
  } else {
    tabsToProcess = [targetTabs];
  }

  const deletedTabs = [];
  let totalDeletedCount = 0;

  if (deleteAll) {
    await Promise.all(
      tabsToProcess.map(tab =>
        sheets.spreadsheets.values.clear({
          spreadsheetId: SPREADSHEET_ID,
          range: `${tab}!A2:Z`
        }).then(() => deletedTabs.push(tab)).catch(err => console.error(`[Clear Error in ${tab}]:`, err.message))
      )
    );
    return { success: deletedTabs.length > 0, deletedFrom: deletedTabs, clearedAll: true, count: 0 };
  }

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const searchNameNorm = normalizeHindi(filter?.customer_name);
  const searchPayeeNorm = normalizeHindi(filter?.paid_to);
  const searchGradeNorm = normalizeHindi(filter?.grade);

  let rowList = [];
  if (Array.isArray(filter?.row_numbers) && filter.row_numbers.length > 0) {
    rowList = filter.row_numbers;
  } else if (filter?.row_number) {
    rowList = [filter.row_number];
  }

  for (const tab of tabsToProcess) {
    const sheetMeta = meta.data.sheets.find(s => s.properties.title === tab);
    if (!sheetMeta) continue;
    const sheetId = sheetMeta.properties.sheetId;

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tab}!A2:J`
    });
    const rows = res.data.values || [];
    if (rows.length === 0) continue;

    const requests = [];

    if (rowList.length > 0) {
      const sortedRows = [...new Set(rowList)]
        .map(Number)
        .filter(n => n >= 2 && n <= rows.length + 1)
        .sort((a, b) => b - a);

      for (const r of sortedRows) {
        requests.push({
          deleteDimension: {
            range: {
              sheetId: sheetId,
              dimension: 'ROWS',
              startIndex: r - 1,
              endIndex: r
            }
          }
        });
      }
      totalDeletedCount += sortedRows.length;
    } else if (searchNameNorm || searchPayeeNorm) {
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        const rowNameNorm = normalizeHindi(row[1]);
        const rowPayeeNorm = normalizeHindi(row[2]);
        const rowGradeNorm = normalizeHindi(row[3]);

        const matchName = searchNameNorm && (rowNameNorm.includes(searchNameNorm) || searchNameNorm.includes(rowNameNorm));
        const matchPayee = searchPayeeNorm && (rowPayeeNorm.includes(searchPayeeNorm) || searchPayeeNorm.includes(rowPayeeNorm));

        if (matchName || matchPayee) {
          if (searchGradeNorm && rowGradeNorm && !rowGradeNorm.includes(searchGradeNorm) && !searchGradeNorm.includes(rowGradeNorm)) {
            continue;
          }
          requests.push({
            deleteDimension: {
              range: {
                sheetId: sheetId,
                dimension: 'ROWS',
                startIndex: i + 1,
                endIndex: i + 2
              }
            }
          });
          totalDeletedCount++;
          break;
        }
      }
    }

    if (requests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { requests }
      });
      deletedTabs.push(tab);
    }
  }

  return { success: deletedTabs.length > 0, deletedFrom: deletedTabs, clearedAll: false, count: totalDeletedCount };
}

// --- Granular Date-Specific Report Builder ---
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

    const isDateMatch = (cell) => {
      if (!cell) return false;
      const clean = cell.toString().replace(/\//g, '-').trim();
      return clean === targetDate || clean.includes(targetDate);
    };

    const closingRows = (closingRes.data.values || []).filter(r => isDateMatch(r[0]));
    const dispatchRows = (dispatchRes.data.values || []).filter(r => isDateMatch(r[0]));
    const orderRows = (orderRes.data.values || []).filter(r => isDateMatch(r[0]));
    const expenseRows = (expenseRes.data.values || []).filter(r => isDateMatch(r[0]));

    const closing = closingRows.length > 0 ? closingRows[closingRows.length - 1] : null;

    if (!closing && dispatchRows.length === 0 && orderRows.length === 0 && expenseRows.length === 0) {
      return `⚠️ दिनांक *${targetDate}* का कोई रिकॉर्ड शीट में दर्ज नहीं मिला।`;
    }

    // 1. DISPATCH ONLY SUMMARY
    if (scope === 'dispatch') {
      if (dispatchRows.length === 0) return `🚚 दिनांक *${targetDate}* को कोई ईंट सप्लाई/डिस्पैच दर्ज नहीं है।`;
      let text = `🚚 *ईंट सप्लाई / डिस्पैच विवरण (${targetDate})*\n`;
      let totalQtyCount = 0;
      dispatchRows.forEach((d, i) => {
        const qty = d[5] || d[4] || '0';
        totalQtyCount += parseTotalQty(qty);
        text += `\n${i + 1}. *${d[1]}* ${d[2] ? `(${d[2]})` : ''}\n` +
                `   • ग्रेड: ${d[3] || 'अव्वल'} | मात्रा: ${qty}\n` +
                `   • ड्राइवर: ${d[8] || 'N/A'} | स्थिति: ${d[9] || 'Completed'}`;
      });
      text += `\n\n📌 *कुल डिस्पैच:* ${totalQtyCount > 0 ? `${totalQtyCount.toLocaleString('en-IN')} ईंटें` : `${dispatchRows.length} गाड़ियां`}`;
      return text;
    }

    // 2. ORDER ONLY SUMMARY
    if (scope === 'orders') {
      if (orderRows.length === 0) return `📝 दिनांक *${targetDate}* को कोई नया ऑर्डर बुक नहीं हुआ है।`;
      let text = `📝 *ऑर्डर बुकिंग विवरण (${targetDate})*\n`;
      let totalAmount = 0;
      let totalReceived = 0;
      orderRows.forEach((o, i) => {
        const payable = Number(o[5]) || 0;
        const rec = Number(o[6]) || 0;
        totalAmount += payable;
        totalReceived += rec;
        text += `\n${i + 1}. *${o[1]}* ${o[2] ? `(${o[2]})` : ''}\n` +
                `   • ग्रेड: ${o[3]} | मात्रा: ${o[4]}\n` +
                `   • कुल रकम: ₹${payable.toLocaleString('en-IN')} | जमा: ₹${rec.toLocaleString('en-IN')} | बाकी: ₹${(o[7] || 0)}`;
      });
      text += `\n\n📌 *कुल ऑर्डर मूल्य:* ₹${totalAmount.toLocaleString('en-IN')} (जमा: ₹${totalReceived.toLocaleString('en-IN')})`;
      return text;
    }

    // 3. EXPENSES ONLY SUMMARY
    if (scope === 'expenses') {
      if (expenseRows.length === 0) return `💸 दिनांक *${targetDate}* को कोई खर्चा दर्ज नहीं है।`;
      let text = `💸 *खर्चों का विवरण (${targetDate})*\n`;
      let totalExp = 0;
      expenseRows.forEach((e, i) => {
        const amt = Number(e[3]) || 0;
        totalExp += amt;
        text += `\n${i + 1}. *${e[2] || e[1]}*: ₹${amt.toLocaleString('en-IN')} ${e[4] ? `(${e[4]})` : ''}`;
      });
      text += `\n\n📌 *कुल खर्चा:* ₹${totalExp.toLocaleString('en-IN')}`;
      return text;
    }

    // 4. CLOSING ONLY SUMMARY
    if (scope === 'closing') {
      if (!closing) return `📊 दिनांक *${targetDate}* की दैनिक क्लोजिंग प्रविष्टि नहीं मिली।`;
      return `📊 *दैनिक क्लोजिंग हिसाब (${targetDate})*\n\n` +
             `• *प्रारम्भिक बचत (Opening):* ₹${Number(closing[1] || 0).toLocaleString('en-IN')}\n` +
             `• *कुल जमा (Total Jama):* ₹${Number(closing[2] || 0).toLocaleString('en-IN')}\n` +
             `• *कुल खर्चा (Kharcha):* ₹${Number(closing[3] || 0).toLocaleString('en-IN')}\n` +
             `• *मालिक को दिया:* ₹${Number(closing[4] || 0).toLocaleString('en-IN')}\n` +
             `• *अंतिम बचत (Closing Balance):* ₹${Number(closing[5] || 0).toLocaleString('en-IN')}`;
    }

    // 5. FULL COMPLETE BREAKDOWN
    let fullText = `📋 *दिनांक ${targetDate} का सम्पूर्ण दैनिक हिसाब*\n`;

    if (closing) {
      fullText += `\n💰 *रोकड़ / क्लोजिंग बैलेंस:*` +
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

    if (orderRows.length > 0) {
      fullText += `\n\n📝 *नए ऑर्डर:* ${orderRows.length} ग्राहक (विस्तार के लिए 'ऑर्डर समरी' पूछें)`;
    }

    return fullText;
  } catch (err) {
    console.error('[Date Report Error]:', err.message);
    return null;
  }
}

// --- Customer Search Helper (Supports Customer + Optional Date Filter) ---
async function getCustomerDetails(customerName, targetDate = null) {
  if (!sheets || !SPREADSHEET_ID || !customerName) return null;
  const searchNorm = normalizeHindi(customerName);
  const cleanDate = targetDate ? resolveDateStr(targetDate) : null;

  try {
    const [dispatchRes, orderRes] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Supply_Dispatch!A2:J' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A2:I' })
    ]);

    const dispatchRows = dispatchRes.data.values || [];
    const orderRows = orderRes.data.values || [];

    const dispatches = dispatchRows.filter(row => {
      const nameNorm = normalizeHindi(row[1]);
      const matchName = nameNorm && (nameNorm.includes(searchNorm) || searchNorm.includes(nameNorm));
      const rowDate = (row[0] || '').replace(/\//g, '-').trim();
      const matchDate = cleanDate ? (rowDate === cleanDate) : true;
      return matchName && matchDate;
    });

    const orders = orderRows.filter(row => {
      const nameNorm = normalizeHindi(row[1]);
      const matchName = nameNorm && (nameNorm.includes(searchNorm) || searchNorm.includes(nameNorm));
      const rowDate = (row[0] || '').replace(/\//g, '-').trim();
      const matchDate = cleanDate ? (rowDate === cleanDate) : true;
      return matchName && matchDate;
    });

    if (dispatches.length === 0 && orders.length === 0) return null;

    return {
      name: dispatches[0]?.[1] || orders[0]?.[1] || customerName,
      village: dispatches[0]?.[2] || orders[0]?.[2] || '',
      filterDate: cleanDate,
      dispatches: dispatches.map(d => ({
        date: d[0] || '',
        grade: d[3] || 'अव्वल',
        total_ordered: d[4] || '0',
        dispatched_today: d[5] || '0',
        total_dispatched: d[6] || '0',
        balance_remaining: d[7] || '0',
        driver: d[8] || '',
        status: d[9] || 'Completed'
      })),
      orders: orders.map(o => ({
        date: o[0] || '',
        grade: o[3] || 'अव्वल',
        quantity: o[4] || '0',
        payable: o[5] || '0',
        received: o[6] || '0',
        pending_amount: o[7] || '0'
      }))
    };
  } catch (err) {
    console.error('[Customer Query Error]:', err.message);
    return null;
  }
}

// --- System Prompt for Gemini ---
const SYSTEM_PROMPT = `
You are the AI Munshi (Accountant) for an Indian Brick Kiln (ईंट भट्ठा). Current year is 2026.
Analyze incoming transaction text, voice transcripts, or photos of diary pages and return ONLY valid JSON matching this schema:

{
  "intent": "batch_update" | "order" | "dispatch" | "expense" | "daily_summary" | "query_date_summary" | "query_customer" | "update_entry" | "delete_entry" | "recheck_with_image" | "clarification" | "ignore",
  "target_tabs": ["Orders" | "Supply_Dispatch" | "Expenses" | "Daily_Closing" | "ALL"],
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
      "target_tab": "Orders" | "Supply_Dispatch" | "Expenses" | "Daily_Closing",
      "row_number": number,
      "filter": { "customer_name": string, "grade": string },
      "fields": {
        "customer_name": string,
        "village": string,
        "destination": string,
        "grade": string,
        "total_dispatched": number,
        "dispatched_qty": string | number,
        "total_ordered_qty": string | number,
        "amount_received": number,
        "amount_payable": number,
        "quantity": string | number,
        "driver": string
      }
    }
  ],
  "orders": [
    {
      "date": string,
      "name": string,
      "village": string,
      "grade": string,
      "quantity": string | number,
      "amount_payable": number,
      "amount_received": number,
      "pending_amount": number,
      "mode_of_payment": "Cash" | "UPI" | "Online"
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
      "driver": string
    }
  ],
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
  "reply_text": string
}

PRICE LIST BENCHMARKS (Per 2,000 Bricks / गाड़ी):
- अव्वल (Awwal / I): ₹14,500 – ₹15,500
- मीठा (Meetha / मी०): ₹12,500 – ₹13,500 (approx. ₹13,000 / 2,000 -> ₹6,500 per 1,000)
- खंजड़ (Khanjad / खं०): ₹12,000 – ₹13,000
- गोड़िया (Godiya / गो०): ₹8,500 – ₹9,000 (approx. ₹4,500 / 1,000)
- पीला (Peela / पी०): ₹8,000
- अव्वल रोड़ा (Awwal Roda / रोडा I): ₹5,000 – ₹5,500
- पीला रोड़ा (Peela Roda): ₹2,500 – ₹3,000

CRITICAL INTENT RULES:
1. "query_date_summary":
   - "कल का हिसाब बताओ" -> intent: "query_date_summary", search_filter: { "date": "yesterday", "scope": "full" }
   - "12 august 2026 ka dispatch summary batao" -> intent: "query_date_summary", search_filter: { "date": "12-08-2026", "scope": "dispatch" }
   - "12 august ka order summary batao" -> intent: "query_date_summary", search_filter: { "date": "12-08-2026", "scope": "orders" }
   - "कल का खर्चा बताओ" -> intent: "query_date_summary", search_filter: { "date": "yesterday", "scope": "expenses" }
   - "कल की बचत / क्लोजिंग बताओ" -> intent: "query_date_summary", search_filter: { "date": "yesterday", "scope": "closing" }
2. "query_customer":
   - "अनूप सिंह का स्टेटस बताओ" -> intent: "query_customer", search_filter: { "customer_name": "अनूप सिंह" }
   - "अनूप सिंह का 12-08-2026 का डिस्पैच बताओ" -> intent: "query_customer", search_filter: { "customer_name": "अनूप सिंह", "date": "12-08-2026" }
3. "delete_entry":
   - "पंक्ति 12, 13 और 14 को हटा दो" -> intent: "delete_entry", search_filter: { "row_numbers": [12, 13, 14] }
4. "update_entry":
   - "पंक्ति 8 में नाम जय प्रकाश और स्थान गौशाला कर दो" -> intent: "update_entry", updates: [{ target_tab: "Supply_Dispatch", row_number: 8, fields: { customer_name: "जय प्रकाश", village: "गौशाला" } }]
5. Always convert Roman numerals or abbreviations like "I", "1", "रोडा I" to standard Hindi "अव्वल" or "अव्वल रोड़ा". Never output raw English "I".
6. Always format dates to DD-MM-YYYY using current year 2026.
`;

// --- Webhook Endpoint ---
app.post(['/webhook', '/webhook/*', '/webhook/messages-upsert'], async (req, res) => {
  res.sendStatus(200);

  try {
    const data = req.body?.data;
    if (!data) return;

    if (data.key?.fromMe) return;

    const sender = data.key?.remoteJid || '';
    const messageId = data.key?.id || '';

    if (!sender || sender.includes('@g.us')) return;

    const cleanSenderNumber = sender.replace('@s.whatsapp.net', '').replace('@c.us', '').trim();
    if (!cleanSenderNumber) return;

    if (ALLOWED_NUMBERS.length > 0 && !ALLOWED_NUMBERS.includes(cleanSenderNumber)) {
      return;
    }

    if (checkAndLockMessage(messageId)) {
      return;
    }

    let contents = [];
    const message = data.message;
    const text = message?.conversation || message?.extendedTextMessage?.text;
    const audioMessage = message?.audioMessage;
    const imageMessage = message?.imageMessage;

    const isRecheckQuery = text && (
      text.toLowerCase().includes('recheck') ||
      text.toLowerCase().includes('match') ||
      text.toLowerCase().includes('image') ||
      text.toLowerCase().includes('photo') ||
      text.toLowerCase().includes('not present') ||
      text.includes('नहीं मिला') ||
      text.includes('फोटो से') ||
      text.includes('चेक करो')
    );

    if (imageMessage) {
      const caption = imageMessage.caption || '';
      const base64Image = req.body?.data?.message?.base64 || '';
      if (!base64Image) return;
      const mimeType = imageMessage.mimetype || 'image/jpeg';

      lastImageCache.set(cleanSenderNumber, { base64: base64Image, mimeType });

      const promptHeader = caption
        ? `${SYSTEM_PROMPT}\n\nUSER CAPTION / INSTRUCTIONS: "${caption}"\nFulfill caption instructions and extract all data.`
        : SYSTEM_PROMPT;

      contents = [promptHeader, { inlineData: { mimeType: mimeType, data: base64Image } }];
    } else if (text && isRecheckQuery && lastImageCache.has(cleanSenderNumber)) {
      const cached = lastImageCache.get(cleanSenderNumber);
      contents = [
        `${SYSTEM_PROMPT}\n\nUSER QUERY: "${text}"\nRecheck against register photo. Extract any missing entries and return complete batch_update.`,
        { inlineData: { mimeType: cached.mimeType, data: cached.base64 } }
      ];
    } else if (text) {
      contents = [`${SYSTEM_PROMPT}\n\nInput message: "${text}"`];
    } else if (audioMessage) {
      const base64Audio = req.body?.data?.message?.base64 || '';
      if (!base64Audio) return;
      contents = [
        SYSTEM_PROMPT,
        { inlineData: { mimeType: 'audio/ogg; codecs=opus', data: base64Audio } }
      ];
    } else {
      return;
    }

    const result = await generateContentWithRetry(contents);

    let rawText = result.response.text().trim();
    const firstBrace = rawText.indexOf('{');
    if (firstBrace !== -1) {
      rawText = rawText.slice(firstBrace);
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      console.warn('[JSON Parse Warning] Repairing output text...');
      parsed = JSON.parse(repairTruncatedJSON(rawText));
    }
    console.log('[Parsed JSON]:', parsed);

    const defaultDate = getISTDate(0);

    // --- 1. SCOPED DATE QUERIES ---
    if ((parsed.intent === 'query_date_summary' || parsed.intent === 'query_summary') && sheets) {
      const targetDate = parsed.search_filter?.date || parsed.daily_closing?.date || 'yesterday';
      const scope = parsed.search_filter?.scope || 'full';
      const report = await generateDateReport(targetDate, scope);
      await sendWhatsAppReply(sender, report || 'माफ कीजिए, संबंधित तारीख का कोई रिकॉर्ड नहीं मिला।');
    }
    // --- 2. CUSTOMER SPECIFIC QUERIES ---
    else if (parsed.intent === 'query_customer' && sheets) {
      const customerName = parsed.search_filter?.customer_name || parsed.name;
      const dateFilter = parsed.search_filter?.date || null;
      const data = await getCustomerDetails(customerName, dateFilter);

      if (data) {
        let reply = `🧱 *ग्राहक विवरण: ${data.name}* ${data.village ? `(${data.village})` : ''} ${data.filterDate ? `[दिनांक: ${data.filterDate}]` : ''}\n`;

        if (data.dispatches.length > 0) {
          reply += `\n🚚 *सप्लाई / डिस्पैच:*`;
          data.dispatches.forEach((d, idx) => {
            reply += `\n${idx + 1}. *तारीख:* ${d.date} | *ग्रेड:* ${d.grade}\n` +
                     `   • *मात्रा:* ${d.dispatched_today || d.total_dispatched}\n` +
                     `   • *बाकी (Balance):* ${d.balance_remaining}\n` +
                     `   • *ड्राइवर:* ${d.driver || 'N/A'} (${d.status})`;
          });
        }

        if (data.orders.length > 0) {
          reply += `\n\n💰 *ऑर्डर व पेमेंट:*`;
          data.orders.forEach((o, idx) => {
            reply += `\n${idx + 1}. *तारीख:* ${o.date} | *ग्रेड:* ${o.grade} (${o.quantity})\n` +
                     `   • *रकम:* ₹${Number(o.payable).toLocaleString('en-IN')} | *जमा:* ₹${Number(o.received).toLocaleString('en-IN')} | *बाकी:* ₹${Number(o.pending_amount).toLocaleString('en-IN')}`;
          });
        }

        await sendWhatsAppReply(sender, reply);
      } else {
        const notFoundText = dateFilter 
          ? `माफ कीजिए, "${customerName}" का दिनांक ${dateFilter} को कोई रिकॉर्ड नहीं मिला।`
          : `माफ कीजिए, "${customerName}" का कोई रिकॉर्ड शीट में नहीं मिला।`;
        await sendWhatsAppReply(sender, notFoundText);
      }
    }
    // --- 3. BATCH TRANSACTION ENTRIES ---
    else if ((parsed.intent === 'batch_update' || parsed.intent === 'recheck_with_image') && sheets) {
      const asyncTasks = [];

      if (parsed.orders && parsed.orders.length > 0) {
        const orderRows = parsed.orders.map(o => [
          o.date || defaultDate,
          o.name || 'नकद ग्राहक',
          o.village || '',
          o.grade || 'अव्वल',
          o.quantity || 0,
          o.amount_payable || (o.amount_received || 0),
          o.amount_received || 0,
          o.pending_amount || 0,
          o.mode_of_payment || 'Cash'
        ]);
        asyncTasks.push(
          appendWithRetry({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Orders!A:I',
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

      if (parsed.daily_closing && (parsed.daily_closing.total_jama || parsed.daily_closing.closing_balance)) {
        const dc = parsed.daily_closing;
        asyncTasks.push(
          appendWithRetry({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Daily_Closing!A:F',
            valueInputOption: 'USER_ENTERED',
            resource: {
              values: [[
                dc.date || defaultDate,
                dc.opening_balance || 0,
                dc.total_jama || 0,
                dc.total_kharcha || 0,
                dc.maalik_ko_diya || 0,
                dc.closing_balance || 0
              ]]
            }
          })
        );
      }

      await Promise.all(asyncTasks);
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }
    else if (parsed.intent === 'order' && sheets) {
      const ordersToProcess = (parsed.orders && parsed.orders.length > 0) ? parsed.orders : [parsed];
      const rows = ordersToProcess.map(o => [
        o.date || defaultDate,
        o.name || 'नकद ग्राहक',
        o.village || '',
        o.grade || 'अव्वल',
        o.quantity || 0,
        o.amount_payable || (o.amount_received || 0),
        o.amount_received || 0,
        o.pending_amount || 0,
        o.mode_of_payment || 'Cash'
      ]);
      await appendWithRetry({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Orders!A:I',
        valueInputOption: 'USER_ENTERED',
        resource: { values: rows }
      });
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }
    else if (parsed.intent === 'dispatch' && sheets) {
      const dispatchesToProcess = (parsed.dispatches && parsed.dispatches.length > 0) ? parsed.dispatches : [parsed];
      await processBatchDispatches(defaultDate, dispatchesToProcess);
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }
    else if (parsed.intent === 'expense' && sheets) {
      const expensesToProcess = (parsed.expenses && parsed.expenses.length > 0) ? parsed.expenses : [parsed];
      const rows = expensesToProcess.map(e => [
        e.date || defaultDate,
        e.category || 'अन्य',
        e.paid_to || '',
        e.amount || 0,
        e.remarks || ''
      ]);
      await appendWithRetry({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Expenses!A:E',
        valueInputOption: 'USER_ENTERED',
        resource: { values: rows }
      });
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }
    else if (parsed.intent === 'daily_summary' && sheets) {
      const dc = parsed.daily_closing || parsed;
      await appendWithRetry({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Daily_Closing!A:F',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[
            dc.date || defaultDate,
            dc.opening_balance || 0,
            dc.total_jama || 0,
            dc.total_kharcha || 0,
            dc.maalik_ko_diya || 0,
            dc.closing_balance || 0
          ]]
        }
      });
      if (parsed.reply_text) await sendWhatsAppReply(sender, parsed.reply_text);
    }
    // --- 4. MULTI & SINGLE ROW UPDATES ---
    else if (parsed.intent === 'update_entry' && sheets) {
      let updatesList = [];
      if (Array.isArray(parsed.updates) && parsed.updates.length > 0) {
        updatesList = parsed.updates;
      } else if (parsed.orders && parsed.orders.length > 0) {
        updatesList = parsed.orders.map(o => ({
          target_tab: 'Orders',
          filter: { customer_name: o.name, grade: o.grade },
          fields: o
        }));
      } else if (parsed.fields_to_update) {
        updatesList = [{
          target_tab: (parsed.target_tabs && parsed.target_tabs[0]) || 'Supply_Dispatch',
          row_number: parsed.search_filter?.row_number,
          filter: parsed.search_filter,
          fields: parsed.fields_to_update
        }];
      }

      const count = await executeBatchUpdates(updatesList);
      const reply = count > 0
        ? (parsed.reply_text || `✅ ${count} प्रविष्टि(याँ) सफलतापूर्वक अपडेट कर दी गई हैं।`)
        : 'माफ कीजिए, यह एंट्री शीट में नहीं मिली।';
      await sendWhatsAppReply(sender, reply);
    }
    // --- 5. MULTI & SINGLE ROW DELETIONS ---
    else if (parsed.intent === 'delete_entry' && sheets) {
      const result = await deleteSheetEntries(parsed.target_tabs, parsed.search_filter, parsed.delete_all || false);
      if (parsed.delete_all) lastImageCache.delete(cleanSenderNumber);

      let reply;
      if (result.success) {
        const tabsJoined = result.deletedFrom.join(' और ');
        reply = parsed.reply_text || (result.clearedAll
          ? `✅ ${tabsJoined} के सभी डेटा को साफ कर दिया गया है।`
          : `✅ ${tabsJoined} से ${result.count > 1 ? `${result.count} प्रविष्टियाँ` : 'प्रविष्टि'} सफलतापूर्वक हटा दी गई हैं।`);
      } else {
        reply = 'माफ कीजिए, डिलीट करने के लिए कोई संबंधित एंट्री नहीं मिली।';
      }
      await sendWhatsAppReply(sender, reply);
    }
    else if (parsed.reply_text) {
      await sendWhatsAppReply(sender, parsed.reply_text);
    }
  } catch (error) {
    console.error('[Webhook Error]:', error);
  }
});

app.listen(PORT, () => {
  console.log(`Munshi server running on port ${PORT}`);
});
