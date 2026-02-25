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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var saB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!saB64) return res.status(500).json({ error: 'Firebase service account not configured' });

  var SHEET_ID = process.env.FINANCIAL_MODEL_SHEET_ID;
  if (!SHEET_ID) return res.status(500).json({ error: 'Financial model sheet ID not configured' });

  var serviceAccount = JSON.parse(Buffer.from(saB64, 'base64').toString('utf-8'));

  try {
    var accessToken = await getAccessToken(serviceAccount);

    // Batch read: expenses, cash on hand, and renewal forecaster data
    var ranges = [
      "'Financial Model (2026)'!AL62",
      "'Actuals (2026)'!Z179",
      "'Renewal Forecaster'!A1:F200",
    ];
    var encodedRanges = ranges.map(function(r) { return 'ranges=' + encodeURIComponent(r); }).join('&');
    var url = 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID + '/values:batchGet?' + encodedRanges + '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING';

    var response = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + accessToken },
    });

    if (!response.ok) {
      var err = await response.json();
      return res.status(response.status).json({ error: err.error ? err.error.message : 'Google Sheets API error' });
    }

    var data = await response.json();
    var valueRanges = data.valueRanges || [];

    // Parse expenses (Financial Model (2026)!AL62)
    var expenses = 0;
    if (valueRanges[0] && valueRanges[0].values && valueRanges[0].values[0]) {
      var raw = valueRanges[0].values[0][0];
      expenses = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[$,]/g, '')) || 0;
    }

    // Parse cash on hand (Actuals (2026)!Z179)
    var cashOnHand = 0;
    if (valueRanges[1] && valueRanges[1].values && valueRanges[1].values[0]) {
      var raw2 = valueRanges[1].values[0][0];
      cashOnHand = typeof raw2 === 'number' ? raw2 : parseFloat(String(raw2).replace(/[$,]/g, '')) || 0;
    }

    // Parse Renewal Forecaster and compute current month forecast
    var renewalForecast = 0;
    var now = new Date();
    var currentMonth = now.getMonth(); // 0-indexed
    var currentYear = now.getFullYear();

    if (valueRanges[2] && valueRanges[2].values) {
      var rows = valueRanges[2].values;
      // Find column indices from header row
      var header = rows[0] || [];
      var feeIdx = header.indexOf('Fee');
      var paidThruIdx = header.indexOf('Paid Thru');

      if (feeIdx !== -1 && paidThruIdx !== -1) {
        for (var i = 1; i < rows.length; i++) {
          var row = rows[i];
          var feeRaw = row[feeIdx];
          var paidThruRaw = row[paidThruIdx];
          if (!feeRaw || !paidThruRaw) continue;

          var fee = typeof feeRaw === 'number' ? feeRaw : parseFloat(String(feeRaw).replace(/[$,]/g, '')) || 0;
          if (fee === 0) continue;

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
            // If before the 15th, count fee twice
            if (ptDay < 15) {
              renewalForecast += fee * 2;
            } else {
              renewalForecast += fee;
            }
          }
        }
      }
    }

    return res.status(200).json({
      gross_margin_pct: 0.8,
      monthly_expenses: expenses,
      cash_on_hand: cashOnHand,
      renewal_forecast: renewalForecast,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
