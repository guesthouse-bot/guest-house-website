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
  if (!saB64) return res.status(500).json({ error: 'Service account not configured' });

  var SHEET_ID = process.env.RENEWAL_SHEET_ID;
  if (!SHEET_ID) return res.status(500).json({ error: 'Renewal sheet ID not configured' });

  var serviceAccount = JSON.parse(Buffer.from(saB64, 'base64').toString('utf-8'));

  try {
    var accessToken = await getAccessToken(serviceAccount);

    // Read Notable Payments tab
    var range = encodeURIComponent("'Notable Payments'!A1:E500");
    var url = 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID + '/values/' + range + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING';

    var response = await fetch(url, { headers: { 'Authorization': 'Bearer ' + accessToken } });
    if (!response.ok) {
      var err = await response.json();
      return res.status(response.status).json({ error: err.error ? err.error.message : 'Sheets API error' });
    }

    var data = await response.json();
    var rows = data.values || [];
    if (rows.length < 2) return res.status(200).json({ payments: [], total: 0 });

    // Parse header row to find column indices
    var header = rows[0].map(function(h) { return String(h).trim().toLowerCase(); });
    var dateIdx = header.indexOf('date');
    var clientIdx = header.indexOf('client');
    var addressIdx = header.indexOf('listing address');
    var amountIdx = header.indexOf('amount');
    var statusIdx = header.indexOf('status');

    if (dateIdx === -1 || amountIdx === -1) {
      return res.status(200).json({ payments: [], total: 0, error: 'Missing Date or Amount column' });
    }

    var payments = [];
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row || !row[dateIdx]) continue;

      var dateRaw = row[dateIdx];
      var amount = 0;
      if (amountIdx !== -1 && row[amountIdx] !== undefined) {
        var amtRaw = row[amountIdx];
        amount = typeof amtRaw === 'number' ? amtRaw : parseFloat(String(amtRaw).replace(/[$,]/g, '')) || 0;
      }
      if (amount === 0) continue;

      // Parse date - handles "March 6, 2026", "3/6/2026", serial numbers
      var parsedDate = null;
      if (typeof dateRaw === 'number') {
        // Google Sheets serial date (days since Dec 30, 1899)
        parsedDate = new Date((dateRaw - 25569) * 86400000);
      } else {
        parsedDate = new Date(String(dateRaw));
      }
      if (!parsedDate || isNaN(parsedDate.getTime())) continue;

      var status = statusIdx !== -1 && row[statusIdx] ? String(row[statusIdx]).trim().toLowerCase() : '';
      var address = addressIdx !== -1 && row[addressIdx] ? String(row[addressIdx]).trim() : '';

      // Extract state from address
      var state = '';
      var stateMatch = address.match(/,\s*([A-Z]{2})\s*\d{5}/);
      if (stateMatch) state = stateMatch[1];

      payments.push({
        date: parsedDate.toISOString().slice(0, 10),
        month: parsedDate.toISOString().slice(0, 7),
        client: clientIdx !== -1 && row[clientIdx] ? String(row[clientIdx]).trim() : '',
        address: address,
        state: state,
        amount: amount,
        status: status,
      });
    }

    // Filter by market if provided
    var market = req.query.market;
    var marketToStates = {
      colorado: ['CO'],
      california: ['CA'],
      arizona: ['AZ'],
    };

    if (market === 'nationwide') {
      payments = payments.filter(function(p) { return !p.state || ['CO', 'CA', 'AZ'].indexOf(p.state) === -1; });
    } else if (market && market !== 'all') {
      var states = marketToStates[market.toLowerCase()] || [];
      payments = payments.filter(function(p) { return states.indexOf(p.state) !== -1; });
    }

    // Filter by period
    var period = req.query.period;
    var dateFrom = req.query.dateFrom;
    var dateTo = req.query.dateTo;
    var now = new Date();
    var startDate, endDate;

    switch (period) {
      case 'mtd':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        endDate = now.toISOString().slice(0, 10);
        break;
      case 'last30':
        startDate = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
        endDate = now.toISOString().slice(0, 10);
        break;
      case 'qtd':
        var qMonth = Math.floor(now.getMonth() / 3) * 3;
        startDate = new Date(now.getFullYear(), qMonth, 1).toISOString().slice(0, 10);
        endDate = now.toISOString().slice(0, 10);
        break;
      case 'ytd':
        startDate = new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10);
        endDate = now.toISOString().slice(0, 10);
        break;
      case 'last_month':
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
        endDate = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);
        break;
      case 'last_quarter':
        var cqMonth = Math.floor(now.getMonth() / 3) * 3;
        startDate = new Date(now.getFullYear(), cqMonth - 3, 1).toISOString().slice(0, 10);
        endDate = new Date(now.getFullYear(), cqMonth, 0).toISOString().slice(0, 10);
        break;
      case 'custom':
        startDate = dateFrom || '2000-01-01';
        endDate = dateTo || '2099-12-31';
        break;
      default:
        startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        endDate = now.toISOString().slice(0, 10);
    }

    payments = payments.filter(function(p) { return p.date >= startDate && p.date <= endDate; });

    var total = payments.reduce(function(sum, p) { return sum + p.amount; }, 0);

    return res.status(200).json({
      payments: payments,
      total: total,
      count: payments.length,
      period: { start: startDate, end: endDate },
      market: market || 'all',
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
