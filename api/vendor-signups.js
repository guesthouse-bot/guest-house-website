var crypto = require('crypto');

// Generate a Google access token from service account credentials
async function getAccessToken(serviceAccount, scopes) {
  var now = Math.floor(Date.now() / 1000);
  var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  var payload = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    scope: scopes,
    iat: now,
    exp: now + 3600,
  })).toString('base64url');

  var sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + payload);
  var signature = sign.sign(serviceAccount.private_key, 'base64url');
  var jwt = header + '.' + payload + '.' + signature;

  var response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
  });

  var data = await response.json();
  if (!data.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(data));
  return data.access_token;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  var action = req.query.action;

  if (action === 'submit') return handleSubmit(req, res);
  return handleSignups(req, res);
};

// === GET: Read vendor signups from Google Sheets ===
async function handleSignups(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var saB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!saB64) return res.status(500).json({ error: 'Firebase service account not configured' });

  var SHEET_ID = process.env.VENDOR_SHEET_ID;
  if (!SHEET_ID) return res.status(500).json({ error: 'Vendor sheet ID not configured' });

  var serviceAccount = JSON.parse(Buffer.from(saB64, 'base64').toString('utf-8'));

  var market = req.query.market;
  var period = req.query.period;
  var dateFrom = req.query.dateFrom;
  var dateTo = req.query.dateTo;

  // Calculate date range
  var now = new Date();
  var startDate, endDate;
  endDate = now;

  switch (period) {
    case 'mtd':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'last30':
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case 'qtd':
      var qMonth = Math.floor(now.getMonth() / 3) * 3;
      startDate = new Date(now.getFullYear(), qMonth, 1);
      break;
    case 'ytd':
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
    case 'last_month':
      startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      endDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'last_quarter':
      var cqMonth = Math.floor(now.getMonth() / 3) * 3;
      startDate = new Date(now.getFullYear(), cqMonth - 3, 1);
      endDate = new Date(now.getFullYear(), cqMonth, 1);
      break;
    case 'custom':
      if (dateFrom) startDate = new Date(dateFrom);
      if (dateTo) endDate = new Date(dateTo + 'T23:59:59');
      break;
    default:
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  var startMs = startDate.getTime();
  var endMs = endDate.getTime();

  // Map market filter to state codes
  var marketToStates = {
    colorado: ['CO'],
    california: ['CA'],
  };

  try {
    var accessToken = await getAccessToken(serviceAccount, 'https://www.googleapis.com/auth/spreadsheets.readonly');

    // Read all rows from the sheet
    var url = 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID + '/values/Sheet1!A:Z';
    var response = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + accessToken },
    });

    if (!response.ok) {
      var err = await response.json();
      return res.status(response.status).json({ error: err.error ? err.error.message : 'Google Sheets API error' });
    }

    var data = await response.json();
    var rows = data.values || [];
    if (rows.length < 2) {
      return res.status(200).json({
        vendor_signups: 0,
        period: { start: startDate.toISOString(), end: endDate.toISOString() },
        market: market || 'all',
      });
    }

    // Parse header to find column indices
    var header = rows[0];
    var tsIdx = header.indexOf('timestamp');
    var stateIdx = header.indexOf('state');
    var roleIdx = header.indexOf('role');

    if (tsIdx === -1) {
      return res.status(500).json({ error: 'No timestamp column found in sheet' });
    }

    var vendorType = req.query.vendorType;

    // Filter rows by date range, market, and vendor type
    var coAndCaStates = ['CO', 'CA'];
    var filtered = [];

    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      var ts = row[tsIdx];
      if (!ts) continue;

      var rowDate = new Date(ts);
      if (isNaN(rowDate.getTime())) continue;
      if (rowDate.getTime() < startMs || rowDate.getTime() > endMs) continue;

      // Market filter
      var rowState = stateIdx !== -1 ? (row[stateIdx] || '').toUpperCase().trim() : '';

      if (market === 'nationwide') {
        if (rowState && coAndCaStates.indexOf(rowState) !== -1) continue;
      } else if (market && market !== 'all') {
        var states = marketToStates[market.toLowerCase()] || [];
        if (states.length > 0 && states.indexOf(rowState) === -1) continue;
      }

      // Vendor type filter
      var rowRole = roleIdx !== -1 ? (row[roleIdx] || '').toLowerCase().trim() : '';
      if (vendorType && vendorType !== 'all') {
        if (rowRole !== vendorType.toLowerCase()) continue;
      }

      filtered.push({ date: rowDate, role: rowRole, row: row });
    }

    var vendorApplications = filtered.length;

    // Daily bucketing
    var daily = {};
    if (req.query.daily === 'true') {
      filtered.forEach(function(item) {
        var day = item.date.toISOString().slice(0, 10);
        if (!daily[day]) daily[day] = { vendor_applications: 0 };
        daily[day].vendor_applications++;
      });
    }

    var result = {
      vendor_applications: vendorApplications,
      period: { start: startDate.toISOString(), end: endDate.toISOString() },
      market: market || 'all',
      vendor_type: vendorType || 'all',
    };
    if (req.query.daily === 'true') result.daily = daily;
    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// === POST: Submit vendor signup to Google Sheets + Drive ===

// Columns for the signups tab (order matters — matches the spreadsheet header row)
var COLUMNS = [
  'timestamp',
  'role',
  'business_name',
  'first_name',
  'last_name',
  'email',
  'market',
  'w9_filename',
  'insurance_filename',
  'agreement_accepted',
  'agreement_version',
  'esignature_name',
  'signed_at',
  'signer_ip',
  'user_agent',
];

// Keys to exclude from the "extra" dynamic columns
var SKIP_KEYS = {
  form_type: true,
  w9_data: true,
  w9_filetype: true,
  insurance_data: true,
  insurance_filetype: true,
  agreement_full_text: true,
};

async function handleSubmit(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var saB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!saB64) return res.status(500).json({ error: 'Service account not configured' });

  var SHEET_ID = process.env.VENDOR_SIGNUP_SHEET_ID;
  if (!SHEET_ID) return res.status(500).json({ error: 'Vendor signup sheet ID not configured' });

  var serviceAccount = JSON.parse(Buffer.from(saB64, 'base64').toString('utf-8'));

  var data;
  try {
    data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  try {
    var accessToken = await getAccessToken(serviceAccount, 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file');
    var sheetsBase = 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID;

    // 1. Ensure the "signups" sheet exists and has a header row
    var metaRes = await fetch(sheetsBase + '?fields=sheets.properties.title', {
      headers: { 'Authorization': 'Bearer ' + accessToken },
    });
    var meta = await metaRes.json();
    var sheetNames = (meta.sheets || []).map(function (s) { return s.properties.title; });

    if (sheetNames.indexOf('signups') === -1) {
      // Create the sheet
      await fetch(sheetsBase + ':batchUpdate', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title: 'signups' } } }],
        }),
      });

      // Write header row
      await fetch(sheetsBase + '/values/signups!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values: [COLUMNS] }),
      });
    } else {
      // Check if header row exists
      var headerRes = await fetch(sheetsBase + '/values/signups!1:1', {
        headers: { 'Authorization': 'Bearer ' + accessToken },
      });
      var headerData = await headerRes.json();
      if (!headerData.values || headerData.values.length === 0) {
        await fetch(sheetsBase + '/values/signups!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + accessToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ values: [COLUMNS] }),
        });
      }
    }

    // 2. Build the row values
    var row = COLUMNS.map(function (col) {
      return data[col] !== undefined ? String(data[col]) : '';
    });

    // Append any dynamic rate fields not in COLUMNS
    var knownKeys = {};
    COLUMNS.forEach(function (c) { knownKeys[c] = true; });
    Object.keys(data).forEach(function (key) {
      if (!knownKeys[key] && !SKIP_KEYS[key]) {
        row.push(String(data[key]));
      }
    });

    // 3. Append the row
    var appendRes = await fetch(sheetsBase + '/values/signups!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [row] }),
    });

    if (!appendRes.ok) {
      var appendErr = await appendRes.json();
      return res.status(500).json({ error: 'Sheets append failed', details: appendErr });
    }

    // 4. Save uploaded documents to Google Drive (non-blocking — don't fail the request)
    saveToDrive(accessToken, data).catch(function (err) {
      console.error('Drive upload error (non-blocking):', err.message);
    });

    return res.status(200).json({ status: 'ok' });

  } catch (err) {
    console.error('Vendor signup submit error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function saveToDrive(accessToken, data) {
  var folderName = 'Vendor Signups - Documents';

  // Search for existing folder
  var searchRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=name%3D'" + encodeURIComponent(folderName) + "'+and+mimeType%3D'application/vnd.google-apps.folder'+and+trashed%3Dfalse&fields=files(id,name)",
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  var searchData = await searchRes.json();
  var parentId;

  if (searchData.files && searchData.files.length > 0) {
    parentId = searchData.files[0].id;
  } else {
    // Create folder
    var createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });
    var created = await createRes.json();
    parentId = created.id;
  }

  // Create a subfolder for this vendor
  var vendorName = (data.business_name || 'Unknown') + ' - ' +
    (data.first_name || '') + ' ' + (data.last_name || '') +
    ' (' + (data.timestamp || '').slice(0, 10) + ')';

  var subRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: vendorName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  });
  var subFolder = await subRes.json();

  // Upload W-9
  if (data.w9_data && data.w9_filename) {
    await uploadFile(accessToken, subFolder.id, data.w9_filename, data.w9_filetype, data.w9_data);
  }

  // Upload COI / insurance
  if (data.insurance_data && data.insurance_filename) {
    await uploadFile(accessToken, subFolder.id, data.insurance_filename, data.insurance_filetype, data.insurance_data);
  }
}

async function uploadFile(accessToken, folderId, fileName, mimeType, base64Data) {
  var boundary = 'vendorsignup' + Date.now();
  var metadata = JSON.stringify({
    name: fileName,
    parents: [folderId],
  });

  var body = '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    metadata + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: ' + (mimeType || 'application/octet-stream') + '\r\n' +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    base64Data + '\r\n' +
    '--' + boundary + '--';

  await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'multipart/related; boundary=' + boundary,
    },
    body: body,
  });
}
