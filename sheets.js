const { google } = require('googleapis');
const config = require('../config');

const TABS = config.sheets.tabs;

const HEADERS = {
  [TABS.SALES]: [
    'Date',
    'Name',
    'Grade',
    'Quantity',
    'Amount Payable',
    'Amount Received',
    'Pending Amount',
    'Mode of Payment',
  ],
  [TABS.EXPENSES]: [
    'Date',
    'Category',
    'Paid To',
    'Amount',
    'Mode of Payment',
    'Remarks',
  ],
  [TABS.DAILY_CLOSING]: [
    'Date',
    'Total Jama',
    'Total Kharcha',
    'Maalik Ko Diya',
    'Munshi Cash In Hand',
    'Notes',
  ],
};

const VALID_GRADES = [
  'Awwal',
  'Meetha',
  'Khanjad',
  'Peela',
  'Godiya',
  'Addha Awwal',
  'Addha Peela',
  'Other',
];

let sheetsClientPromise = null;

function getAuth() {
  const creds = config.sheets.credentials;
  if (!creds) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_CREDENTIALS is not configured. Cannot connect to Google Sheets.'
    );
  }
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: creds.client_email,
      private_key: creds.private_key,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheetsClient() {
  if (!sheetsClientPromise) {
    const auth = getAuth();
    sheetsClientPromise = google.sheets({ version: 'v4', auth });
  }
  return sheetsClientPromise;
}

/**
 * Ensures the spreadsheet has Sales, Expenses, and Daily_Closing tabs
 * with correct header rows. Creates missing tabs. Idempotent — safe to
 * call on every server startup.
 */
async function initializeSheet() {
  const sheets = await getSheetsClient();
  const spreadsheetId = config.sheets.sheetId;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingTitles = meta.data.sheets.map((s) => s.properties.title);

  const requests = [];
  for (const tabName of Object.values(TABS)) {
    if (!existingTitles.includes(tabName)) {
      requests.push({
        addSheet: {
          properties: { title: tabName },
        },
      });
    }
  }

  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
    console.log(
      `✅ Created missing tabs: ${requests
        .map((r) => r.addSheet.properties.title)
        .join(', ')}`
    );
  }

  // Ensure header row exists on each tab (only writes if row 1 is empty)
  for (const tabName of Object.values(TABS)) {
    const range = `${tabName}!A1:Z1`;
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });
    const hasHeader = existing.data.values && existing.data.values.length > 0;
    if (!hasHeader) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [HEADERS[tabName]] },
      });
      console.log(`✅ Wrote header row for tab "${tabName}"`);
    }
  }
}

async function appendRow(tabName, rowValues) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheets.sheetId,
    range: `${tabName}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowValues] },
  });
}

/**
 * @param {string} dateIST - formatted IST date/time string
 * @param {object} data - { name, grade, quantity, amount_payable, amount_received, pending_amount, mode_of_payment }
 */
async function appendSaleRow(dateIST, data) {
  const grade = VALID_GRADES.includes(data.grade) ? data.grade : 'Other';
  const row = [
    dateIST,
    data.name || '',
    grade,
    data.quantity ?? '',
    data.amount_payable ?? '',
    data.amount_received ?? 0,
    data.pending_amount ??
      Math.max((data.amount_payable || 0) - (data.amount_received || 0), 0),
    data.mode_of_payment || 'Not specified',
  ];
  await appendRow(TABS.SALES, row);
  return row;
}

/**
 * @param {string} dateIST
 * @param {object} data - { category, paid_to, amount, mode_of_payment, remarks }
 */
async function appendExpenseRow(dateIST, data) {
  const row = [
    dateIST,
    data.category || 'Other',
    data.paid_to || '',
    data.amount ?? '',
    data.mode_of_payment || 'Not specified',
    data.remarks || '',
  ];
  await appendRow(TABS.EXPENSES, row);
  return row;
}

/**
 * @param {string} dateIST
 * @param {object} data - { total_jama, total_kharcha, maalik_ko_diya, munshi_cash_in_hand, notes }
 */
async function appendDailyClosingRow(dateIST, data) {
  const row = [
    dateIST,
    data.total_jama ?? '',
    data.total_kharcha ?? '',
    data.maalik_ko_diya ?? '',
    data.munshi_cash_in_hand ?? '',
    data.notes || '',
  ];
  await appendRow(TABS.DAILY_CLOSING, row);
  return row;
}

/**
 * Finds the most recent Sales row matching a customer name (case-insensitive,
 * partial match) and updates the given field with a new value, appending an
 * audit note in a trailing "Audit Note" column (created if missing).
 *
 * @param {object} correction - { target_name, field_to_correct, old_value, new_value, audit_note }
 * @returns {Promise<{found: boolean, rowNumber?: number}>}
 */
async function applyCorrection(correction) {
  const sheets = await getSheetsClient();
  const spreadsheetId = config.sheets.sheetId;

  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${TABS.SALES}!A1:I`,
  });
  const rows = result.data.values || [];
  if (rows.length < 2) return { found: false };

  const header = rows[0];
  const nameColIdx = header.indexOf('Name');
  const fieldMap = {
    name: 'Name',
    grade: 'Grade',
    quantity: 'Quantity',
    amount_payable: 'Amount Payable',
    amount_received: 'Amount Received',
    pending_amount: 'Pending Amount',
    mode_of_payment: 'Mode of Payment',
  };
  const targetHeader =
    fieldMap[correction.field_to_correct] || correction.field_to_correct;
  let fieldColIdx = header.indexOf(targetHeader);

  const searchName = (correction.target_name || '').toLowerCase().trim();

  // Search from the bottom (most recent) upward for a matching name.
  let matchRowIdx = -1;
  for (let i = rows.length - 1; i >= 1; i--) {
    const rowName = (rows[i][nameColIdx] || '').toLowerCase().trim();
    if (rowName && (rowName.includes(searchName) || searchName.includes(rowName))) {
      matchRowIdx = i;
      break;
    }
  }

  if (matchRowIdx === -1) {
    return { found: false };
  }

  const sheetRowNumber = matchRowIdx + 1; // 1-indexed sheet row

  // Ensure an "Audit Note" column exists (header index 8, column I).
  let auditColIdx = header.indexOf('Audit Note');
  if (auditColIdx === -1) {
    auditColIdx = header.length;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${TABS.SALES}!${columnLetter(auditColIdx)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Audit Note']] },
    });
  }

  if (fieldColIdx === -1) {
    // Unknown field to correct — still log the audit note without changing a value.
    fieldColIdx = null;
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${TABS.SALES}!${columnLetter(fieldColIdx)}${sheetRowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[correction.new_value]] },
    });

    // Recompute Pending Amount if Amount Payable or Amount Received changed.
    if (
      correction.field_to_correct === 'amount_payable' ||
      correction.field_to_correct === 'amount_received'
    ) {
      const payableIdx = header.indexOf('Amount Payable');
      const receivedIdx = header.indexOf('Amount Received');
      const pendingIdx = header.indexOf('Pending Amount');
      const rowNow = (
        await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${TABS.SALES}!A${sheetRowNumber}:I${sheetRowNumber}`,
        })
      ).data.values[0];
      const payable = Number(rowNow[payableIdx]) || 0;
      const received = Number(rowNow[receivedIdx]) || 0;
      if (pendingIdx !== -1) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${TABS.SALES}!${columnLetter(pendingIdx)}${sheetRowNumber}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[Math.max(payable - received, 0)]] },
        });
      }
    }
  }

  const existingAuditNote =
    (rows[matchRowIdx][auditColIdx] || '') && rows[matchRowIdx][auditColIdx] !== ''
      ? `${rows[matchRowIdx][auditColIdx]}; `
      : '';
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${TABS.SALES}!${columnLetter(auditColIdx)}${sheetRowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[`${existingAuditNote}${correction.audit_note || ''}`]],
    },
  });

  return { found: true, rowNumber: sheetRowNumber };
}

/**
 * Fetches the last N sales rows as a compact text block, useful as context
 * for the LLM when resolving CORRECTION references.
 */
async function getRecentSalesContext(limit = 15) {
  const sheets = await getSheetsClient();
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${TABS.SALES}!A1:H`,
  });
  const rows = result.data.values || [];
  if (rows.length < 2) return '';
  const header = rows[0];
  const dataRows = rows.slice(-limit);
  return dataRows
    .map((r) => header.map((h, i) => `${h}: ${r[i] ?? ''}`).join(', '))
    .join('\n');
}

function columnLetter(index) {
  // 0-indexed column number -> spreadsheet column letter (0 -> A, 25 -> Z, 26 -> AA...)
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

module.exports = {
  initializeSheet,
  appendSaleRow,
  appendExpenseRow,
  appendDailyClosingRow,
  applyCorrection,
  getRecentSalesContext,
  TABS,
};
