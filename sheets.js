require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Find credentials in common deployment and local locations
const POSSIBLE_CRED_PATHS = [
  '/etc/secrets/credentials.json',
  path.join(__dirname, 'credentials.json'),
  process.env.GOOGLE_APPLICATION_CREDENTIALS
].filter(Boolean);

let credentialsPath = POSSIBLE_CRED_PATHS.find(p => fs.existsSync(p));

if (!credentialsPath) {
  console.error('❌ Error: credentials.json not found in /etc/secrets/ or local project root.');
  process.exit(1);
}

const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

const SCHEMA = {
  "Daily_Closing": [
    "Date", "Opening_Balance", "Total_Jama", "Total_Kharcha", "Maalik_Ko_Diya", "Closing_Balance"
  ],
  "Orders": [
    "Date", "Customer_Name", "Village", "Brick_Grade", "Quantity", "Amount_Payable", "Amount_Received", "Pending_Amount", "Mode_of_Payment"
  ],
  "Supply_Dispatch": [
    "Date", "Customer_Name", "Village", "Brick_Grade", "Master_Order_Qty", "Dispatched_Today", "Total_Dispatched", "Remaining_Bricks", "Driver", "Status"
  ],
  "Expenses": [
    "Date", "Category", "Paid_To", "Amount", "Remarks"
  ],
  "Customer_Ledger": [
    "Customer_Name", "Village", "Ordered_Bricks", "Dispatched_Bricks", "Pending_Bricks", "Total_Billed", "Total_Paid", "Net_Due", "Status"
  ],
  "Agent_Memory": [
    "Category", "Alias_Trigger", "Canonical_Value", "Associated_Location", "Notes"
  ],
  "Coal_Fuel_Khata": [
    "Date", "Description", "Inward_MT", "Rate", "Tubs_Burnt", "Kg_Per_Tub", "Consumed_MT", "Status"
  ],
  "Green_Brick_Stock": [
    "Date", "Molded_Inward", "Bhari_Loaded", "Rain_Damage_Lost", "Status"
  ],
  "Stock_Inventory": [
    "Date", "Brick_Grade", "Opening_Stock", "Production_Nikasi", "Dispatched_Deducted", "Damaged_Lost", "Closing_Stock"
  ],
  "Labor_Pathera_Khata": [
    "Date", "Worker_Name", "Work_Type", "Bricks_Counted", "Rate_Per_1000", "Wages_Earned", "Advance_Khoraki_Paid", "Net_Labor_Balance"
  ]
};

const SEED_MEMORY = [
  ["Primary Customer", "कन्हाई", "कधंई", "पूरे काशीराम", "Master name mapping"],
  ["Primary Customer", "कन्धाई", "कधंई", "पूरे काशीराम", "Master name mapping"],
  ["Primary Customer", "कधई", "कधंई", "पूरे काशीराम", "Master name mapping"],
  ["Primary Customer", "कनहाई", "कधंई", "पूरे काशीराम", "Master name mapping"],
  ["Driver", "बिन्धा", "विन्धा", "भट्ठा", "Driver name normalization"],
  ["Driver", "चिन्टू", "चिन्टू", "भट्ठा", "Driver name normalization"]
];

async function repairAndSetupSheets() {
  console.log(`📡 Connecting to Google Spreadsheet: ${SPREADSHEET_ID}...`);

  // 1. Fetch current sheets metadata
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existingSheetMap = new Map();
  meta.data.sheets.forEach(s => {
    existingSheetMap.set(s.properties.title, s.properties.sheetId);
  });

  // 2. Create any missing tabs
  const addSheetRequests = [];
  for (const tabName of Object.keys(SCHEMA)) {
    if (!existingSheetMap.has(tabName)) {
      addSheetRequests.push({
        addSheet: {
          properties: { title: tabName }
        }
      });
    }
  }

  if (addSheetRequests.length > 0) {
    console.log(`➕ Creating ${addSheetRequests.length} missing sheet tab(s)...`);
    const createRes = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: { requests: addSheetRequests }
    });
    createRes.data.replies.forEach(reply => {
      existingSheetMap.set(reply.addSheet.properties.title, reply.addSheet.properties.sheetId);
    });
  }

  // 3. Write Headers and Format (Bold, Underline, Size 12, Frozen Row 1)
  console.log(`🎨 Formatting headers and applying styles across all tabs...`);
  const formatRequests = [];

  for (const [tabName, headers] of Object.entries(SCHEMA)) {
    const sheetId = existingSheetMap.get(tabName);
    const endColIndex = headers.length;

    // Write Header Row Values
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tabName}!A1:${String.fromCharCode(64 + endColIndex)}1`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [headers] }
    });

    // Formatting: Bold, Underline, Font Size 12, Background Color
    formatRequests.push({
      repeatCell: {
        range: {
          sheetId: sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: endColIndex
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.91, green: 0.92, blue: 0.93 },
            textFormat: {
              bold: true,
              underline: true,
              fontSize: 12
            },
            horizontalAlignment: 'CENTER'
          }
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
      }
    });

    // Freeze Row 1
    formatRequests.push({
      updateSheetProperties: {
        properties: {
          sheetId: sheetId,
          gridProperties: {
            frozenRowCount: 1
          }
        },
        fields: 'gridProperties.frozenRowCount'
      }
    });

    // Auto-fit Column Widths
    formatRequests.push({
      autoResizeDimensions: {
        dimensions: {
          sheetId: sheetId,
          dimension: 'COLUMNS',
          startIndex: 0,
          endIndex: endColIndex
        }
      }
    });
  }

  if (formatRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: { requests: formatRequests }
    });
  }

  // 4. Seed Canonical Memory if Agent_Memory is empty
  const memCheck = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Agent_Memory!A2:E'
  });

  if (!memCheck.data.values || memCheck.data.values.length === 0) {
    console.log(`🧠 Seeding canonical customer memory into Agent_Memory...`);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Agent_Memory!A:E',
      valueInputOption: 'USER_ENTERED',
      resource: { values: SEED_MEMORY }
    });
  }

  console.log(`\n✅ Google Spreadsheet setup complete and repaired successfully!`);
}

repairAndSetupSheets().catch(err => {
  console.error('❌ Setup Failed:', err.message);
  process.exit(1);
});
