var crypto = require('crypto');

// Generate a Google access token from service account credentials
async function getAccessToken(serviceAccount) {
  var now = Math.floor(Date.now() / 1000);
  var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  var payload = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
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
  return data.access_token;
}

// Convert 1-based column number to spreadsheet letter (1=A, 26=Z, 27=AA, etc.)
function colToLetter(col) {
  var result = '';
  while (col > 0) {
    col--;
    result = String.fromCharCode(65 + (col % 26)) + result;
    col = Math.floor(col / 26);
  }
  return result;
}

// Get the cell reference for a given year/month's net income
// Actuals (2026): row 178, Z=Jan, AA=Feb, ... AK=Dec (column = 25 + month)
// Actuals (2023 - 2025): row 638, B=Jan 2023, ... AK=Dec 2025 (column = 2 + (year-2023)*12 + (month-1))
function getNetIncomeCell(year, month) {
  if (year === 2026) {
    var col = 25 + month;
    return "'Actuals (2026)'!" + colToLetter(col) + "178";
  } else if (year >= 2023 && year <= 2025) {
    var col = 2 + (year - 2023) * 12 + (month - 1);
    return "'Actuals (2023 - 2025)'!" + colToLetter(col) + "638";
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var saB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!saB64) return res.status(500).json({ error: 'Firebase service account not configured' });

  var SHEET_ID = process.env.FINANCIAL_MODEL_SHEET_ID;
  if (!SHEET_ID) return res.status(500).json({ error: 'Financial model sheet ID not configured' });

  var RENEWAL_SHEET_ID = process.env.RENEWAL_SHEET_ID;
  if (!RENEWAL_SHEET_ID) return res.status(500).json({ error: 'Renewal sheet ID not configured' });

  // Temporary debug: read sheet structure
  if (req.query.debug === 'sheet_layout') {
    var serviceAccount2 = JSON.parse(Buffer.from(saB64, 'base64').toString('utf-8'));
    var token2 = await getAccessToken(serviceAccount2);
    var debugRange = "'Financial Model (2026)'!" + (req.query.cells || "A1:B80");
    var debugUrl = 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID + '/values/' + encodeURIComponent(debugRange) + '?valueRenderOption=UNFORMATTED_VALUE';
    var debugRes = await fetch(debugUrl, { headers: { 'Authorization': 'Bearer ' + token2 } });
    var debugData = await debugRes.json();
    return res.status(200).json(debugData);
  }

  var serviceAccount = JSON.parse(Buffer.from(saB64, 'base64').toString('utf-8'));

  try {
    var accessToken = await getAccessToken(serviceAccount);

    // Determine trailing 2 months for runway calculation
    var now = new Date();
    var curMonth1 = now.getMonth() + 1; // current month, 1-indexed

    var trail1Month = curMonth1 - 1;
    var trail1Year = now.getFullYear();
    if (trail1Month < 1) { trail1Month += 12; trail1Year--; }

    var trail2Month = curMonth1 - 2;
    var trail2Year = now.getFullYear();
    if (trail2Month < 1) { trail2Month += 12; trail2Year--; }

    var trail1Cell = getNetIncomeCell(trail1Year, trail1Month);
    var trail2Cell = getNetIncomeCell(trail2Year, trail2Month);

    // Cash on hand: use most recent completed month's column in Actuals (2026) row 179
    // Column mapping: Z=Jan, AA=Feb, ... AK=Dec (column = 25 + month)
    var cashCol = colToLetter(25 + trail1Month);
    var cashOnHandRange = "'Actuals (2026)'!" + cashCol + "179";

    // Batch read from financial model: expenses, cash on hand, trailing net income
    var ranges = [
      "'Financial Model (2026)'!AL62",
      cashOnHandRange,
    ];
    if (trail1Cell) ranges.push(trail1Cell);
    if (trail2Cell) ranges.push(trail2Cell);
    var encodedRanges = ranges.map(function(r) { return 'ranges=' + encodeURIComponent(r); }).join('&');
    var url = 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID + '/values:batchGet?' + encodedRanges + '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING';

    // Fetch renewal data from separate spreadsheet
    var renewalUrl = 'https://sheets.googleapis.com/v4/spreadsheets/' + RENEWAL_SHEET_ID + '/values/' + encodeURIComponent("'Renewal Tracker'!A1:J500") + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING';

    var [response, renewalResponse] = await Promise.all([
      fetch(url, { headers: { 'Authorization': 'Bearer ' + accessToken } }),
      fetch(renewalUrl, { headers: { 'Authorization': 'Bearer ' + accessToken } }),
    ]);

    if (!response.ok) {
      var err = await response.json();
      return res.status(response.status).json({ error: err.error ? err.error.message : 'Google Sheets API error' });
    }
    if (!renewalResponse.ok) {
      var renewalErr = await renewalResponse.json();
      return res.status(renewalResponse.status).json({ error: renewalErr.error ? renewalErr.error.message : 'Renewal Sheets API error' });
    }

    var data = await response.json();
    var valueRanges = data.valueRanges || [];
    var renewalData = await renewalResponse.json();

    // Parse expenses (Financial Model (2026)!AL62)
    var expenses = 0;
    if (valueRanges[0] && valueRanges[0].values && valueRanges[0].values[0]) {
      var raw = valueRanges[0].values[0][0];
      expenses = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[$,]/g, '')) || 0;
    }

    // Parse cash on hand (Actuals (2026) row 179, most recent month)
    var cashOnHand = 0;
    if (valueRanges[1] && valueRanges[1].values && valueRanges[1].values[0]) {
      var raw2 = valueRanges[1].values[0][0];
      cashOnHand = typeof raw2 === 'number' ? raw2 : parseFloat(String(raw2).replace(/[$,]/g, '')) || 0;
    }

    // Parse trailing net income from actuals (indexes 2 and 3 in valueRanges)
    var trailingNetIncome = [];
    for (var ti = 2; ti <= 3; ti++) {
      if (valueRanges[ti] && valueRanges[ti].values && valueRanges[ti].values[0]) {
        var rawNI = valueRanges[ti].values[0][0];
        var ni = typeof rawNI === 'number' ? rawNI : parseFloat(String(rawNI).replace(/[$,]/g, '')) || 0;
        trailingNetIncome.push(ni);
      }
    }

    // Parse Renewal Tracker and compute current month forecast
    // Only count the active block at the top (stop at first row with no Address)
    var renewalForecast = 0;
    var currentMonth = now.getMonth(); // 0-indexed
    var currentYear = now.getFullYear();

    if (renewalData && renewalData.values) {
      var rows = renewalData.values;
      // Find column indices from header row
      var header = rows[0] || [];
      var feeIdx = header.indexOf('Fee');
      var paidThruIdx = header.indexOf('Paid Thru');
      var cadenceIdx = header.indexOf('Cadence');

      if (feeIdx !== -1 && paidThruIdx !== -1) {
        for (var i = 1; i < rows.length; i++) {
          var row = rows[i];
          // Stop at first empty row (no address in column A)
          if (!row || !row[0] || String(row[0]).trim() === '') break;

          var feeRaw = row[feeIdx];
          var paidThruRaw = row[paidThruIdx];
          if (!feeRaw || !paidThruRaw) continue;

          var fee = typeof feeRaw === 'number' ? feeRaw : parseFloat(String(feeRaw).replace(/[$,]/g, '')) || 0;
          if (fee === 0) continue;

          var cadence = cadenceIdx !== -1 && row[cadenceIdx] ? String(row[cadenceIdx]).trim().toLowerCase() : '';

          // Parse paid thru date - handles "3/28", "3/28/26", "2/28/26" formats
          var paidThruStr = String(paidThruRaw).trim();
          var parts = paidThruStr.split('/');
          if (parts.length < 2) continue;

          var ptMonth = parseInt(parts[0], 10) - 1; // 0-indexed
          var ptDay = parseInt(parts[1], 10);
          var ptYear = currentYear;
          if (parts.length >= 3) {
            var yr = parseInt(parts[2], 10);
            ptYear = yr < 100 ? 2000 + yr : yr;
          }

          // Check if paid thru date is in the current month
          if (ptMonth === currentMonth && ptYear === currentYear) {
            // Bi-weekly charges before the 15th will repeat, so count twice
            var multiplier = (cadence === 'bi-weekly' && ptDay < 15) ? 2 : 1;
            renewalForecast += fee * multiplier;
          }
        }
      }
    }

    return res.status(200).json({
      gross_margin_pct: 0.8,
      monthly_expenses: expenses,
      cash_on_hand: cashOnHand,
      renewal_forecast: renewalForecast,
      trailing_net_income: trailingNetIncome,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
