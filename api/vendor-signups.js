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
    var accessToken = await getAccessToken(serviceAccount);

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

    if (tsIdx === -1) {
      return res.status(500).json({ error: 'No timestamp column found in sheet' });
    }

    // Filter rows by date range and market
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

      filtered.push({ date: rowDate, row: row });
    }

    var vendorSignups = filtered.length;

    // Daily bucketing
    var daily = {};
    if (req.query.daily === 'true') {
      filtered.forEach(function(item) {
        var day = item.date.toISOString().slice(0, 10);
        if (!daily[day]) daily[day] = { vendor_signups: 0 };
        daily[day].vendor_signups++;
      });
    }

    var result = {
      vendor_signups: vendorSignups,
      period: { start: startDate.toISOString(), end: endDate.toISOString() },
      market: market || 'all',
    };
    if (req.query.daily === 'true') result.daily = daily;
    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
