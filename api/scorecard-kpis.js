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

  // TEMPORARY: Create Notable Payments tab and populate data
  if (req.query.metric === 'setup_notable') {
    var sa = JSON.parse(Buffer.from(saB64, 'base64').toString('utf-8'));
    // Get write-scoped token
    var nowT = Math.floor(Date.now() / 1000);
    var hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    var pld = Buffer.from(JSON.stringify({
      iss: sa.client_email, sub: sa.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      iat: nowT, exp: nowT + 3600,
    })).toString('base64url');
    var sgn = crypto.createSign('RSA-SHA256'); sgn.update(hdr + '.' + pld);
    var sig = sgn.sign(sa.private_key, 'base64url');
    var tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + hdr + '.' + pld + '.' + sig,
    });
    var tokData = await tokRes.json();
    var wToken = tokData.access_token;

    // Return SA email so user can grant access, then create tab
    if (req.query.debug === 'email') return res.status(200).json({ email: sa.client_email });
    // Step 1: Create the sheet tab
    var targetSheet = RENEWAL_SHEET_ID.trim();
    var addRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + targetSheet + ':batchUpdate', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + wToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: 'Notable Payments' } } }] }),
    });
    var addData = await addRes.json();
    if (!addRes.ok && !(addData.error && addData.error.message && addData.error.message.indexOf('already exists') !== -1)) {
      return res.status(addRes.status).json({ error: 'addSheet: ' + (addData.error ? addData.error.message : JSON.stringify(addData)), sheet_id: targetSheet });
    }

    // Step 2: Write header + data
    var rows = [
      ['Date', 'Client', 'Listing address', 'Amount', 'Status'],
      ['March 6, 2026', 'Manish Kumar', '3529 La Mirada Drive, San Marcos, CA 92078', 3050, 'Processing'],
      ['February 27, 2026', 'Martina Lewis', '1705 Valdes Drive, San Diego, CA 92037', 6608, 'Cleared'],
      ['February 3, 2026', 'Sarah Gilbert', '13070 Roundup Avenue, San Diego, CA 92129', 3450, 'Cleared'],
      ['January 26, 2026', 'Matthew Dart', '5330 Sweetwater Trails, San Diego, CA 92130', 6930, 'Cleared'],
      ['December 31, 2025', 'Jessica Erickson', '3804 Florentine Circle, Longmont, CO 80503', 2500, 'Cleared'],
      ['December 15, 2025', 'Jasmine Chen', '1601 San Remo Place Unit 10, Encinitas, CA 92024', 3780, 'Cleared'],
      ['December 10, 2025', 'Andrew Norman', '836 Carlsbad Street, San Diego, CA 92114', 1476, 'Cleared'],
      ['November 25, 2025', 'James Choi', '4310 East Gemini Place, Chandler, AZ 85249', 4800.60, 'Cleared'],
      ['November 4, 2025', 'Andrew Norman', '836 Carlsbad Street, San Diego, CA 92114', 2950, 'Cleared'],
    ];
    var writeRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + targetSheet + '/values/' + encodeURIComponent("'Notable Payments'!A1:E11") + '?valueInputOption=USER_ENTERED', {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + wToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: "'Notable Payments'!A1:E11", majorDimension: 'ROWS', values: rows }),
    });
    var writeData = await writeRes.json();
    if (!writeRes.ok) return res.status(writeRes.status).json({ error: writeData.error ? writeData.error.message : 'Write error' });
    return res.status(200).json({ success: true, updated: writeData.updatedCells });
  }

  // Plan KPIs: read monthly plan values from Financial Model (2026) tab
  if (req.query.metric === 'plan') {
    var serviceAccount2 = JSON.parse(Buffer.from(saB64, 'base64').toString('utf-8'));
    var token2 = await getAccessToken(serviceAccount2);
    // Column mapping: Z=Jan(1), AA=Feb(2), AB=Mar(3), ... AK=Dec(12)
    var month = req.query.month ? parseInt(req.query.month, 10) : (new Date().getMonth() + 1);
    var col = colToLetter(25 + month);
    var planRanges = [
      "'Financial Model (2026)'!" + col + "13",  // Quotes Created (total)
      "'Financial Model (2026)'!" + col + "14",  // Homes Booked (total)
      "'Financial Model (2026)'!" + col + "15",  // Staging Revenue (total)
      "'Financial Model (2026)'!" + col + "16",  // Total Revenue
      "'Financial Model (2026)'!" + col + "21",  // AOV Per Home
      "'Financial Model (2026)'!" + col + "27",  // CO Homes Booked
      "'Financial Model (2026)'!" + col + "28",  // CO Installs
      "'Financial Model (2026)'!" + col + "29",  // CO Deinstalls
      "'Financial Model (2026)'!" + col + "31",  // CO Bookings Revenue
      "'Financial Model (2026)'!" + col + "33",  // CO Total Staging Revenue
      "'Financial Model (2026)'!" + col + "80",  // CA Homes Booked
      "'Financial Model (2026)'!" + col + "81",  // CA Installs
      "'Financial Model (2026)'!" + col + "82",  // CA Deinstalls
      "'Financial Model (2026)'!" + col + "84",  // CA Bookings Revenue
      "'Financial Model (2026)'!" + col + "85",  // CA Total Staging Revenue
      "'Financial Model (2026)'!" + col + "172", // Total Corporate Expenses
      "'Financial Model (2026)'!" + col + "173", // Net Income
    ];
    var encodedPlan = planRanges.map(function(r) { return 'ranges=' + encodeURIComponent(r); }).join('&');
    var planUrl = 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID + '/values:batchGet?' + encodedPlan + '&valueRenderOption=UNFORMATTED_VALUE';
    try {
      var planRes = await fetch(planUrl, { headers: { 'Authorization': 'Bearer ' + token2 } });
      if (!planRes.ok) {
        var planErr = await planRes.json();
        return res.status(planRes.status).json({ error: planErr.error ? planErr.error.message : 'Sheets API error' });
      }
      var planData = await planRes.json();
      var vr = planData.valueRanges || [];
      function pv(idx) {
        if (vr[idx] && vr[idx].values && vr[idx].values[0]) {
          var raw = vr[idx].values[0][0];
          return typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[$,]/g, '')) || null;
        }
        return null;
      }
      return res.status(200).json({
        month: month,
        quotes_requested: pv(0),
        bookings: pv(1),
        staging_revenue: pv(2),
        total_revenue: pv(3),
        aov_at_close: pv(4),
        co_bookings: pv(5),
        co_installs: pv(6),
        co_deinstalls: pv(7),
        co_bookings_revenue: pv(8),
        co_total_revenue: pv(9),
        ca_bookings: pv(10),
        ca_installs: pv(11),
        ca_deinstalls: pv(12),
        ca_bookings_revenue: pv(13),
        ca_total_revenue: pv(14),
        corporate_expenses: pv(15),
        net_income: pv(16),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Notable Payments: read from "Notable Payments" tab in Renewal Tracker sheet
  if (req.query.metric === 'notable') {
    var serviceAccount3 = JSON.parse(Buffer.from(saB64, 'base64').toString('utf-8'));
    var token3 = await getAccessToken(serviceAccount3);
    var nRange = encodeURIComponent("'Notable Payments'!A1:E500");
    var nUrl = 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID.trim() + '/values/' + nRange + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING';
    try {
      var nRes = await fetch(nUrl, { headers: { 'Authorization': 'Bearer ' + token3 } });
      if (!nRes.ok) {
        var nErr = await nRes.json();
        return res.status(nRes.status).json({ error: nErr.error ? nErr.error.message : 'Sheets API error' });
      }
      var nData = await nRes.json();
      var nRows = nData.values || [];
      if (nRows.length < 2) return res.status(200).json({ payments: [], total: 0, count: 0 });

      var nHeader = nRows[0].map(function(h) { return String(h).trim().toLowerCase(); });
      var nDateIdx = nHeader.indexOf('date');
      var nAddrIdx = nHeader.indexOf('listing address');
      var nAmtIdx = nHeader.indexOf('amount');

      if (nDateIdx === -1 || nAmtIdx === -1) return res.status(200).json({ payments: [], total: 0, count: 0 });

      var payments = [];
      for (var ni = 1; ni < nRows.length; ni++) {
        var nRow = nRows[ni];
        if (!nRow || !nRow[nDateIdx]) continue;
        var nAmtRaw = nRow[nAmtIdx];
        var nAmt = typeof nAmtRaw === 'number' ? nAmtRaw : parseFloat(String(nAmtRaw).replace(/[$,]/g, '')) || 0;
        if (nAmt === 0) continue;
        var nDateRaw = nRow[nDateIdx];
        var nParsed = typeof nDateRaw === 'number' ? new Date((nDateRaw - 25569) * 86400000) : new Date(String(nDateRaw));
        if (!nParsed || isNaN(nParsed.getTime())) continue;
        var nAddr = nAddrIdx !== -1 && nRow[nAddrIdx] ? String(nRow[nAddrIdx]).trim() : '';
        var nState = '';
        var nSm = nAddr.match(/,\s*([A-Z]{2})\s*\d{5}/);
        if (nSm) nState = nSm[1];
        payments.push({ date: nParsed.toISOString().slice(0, 10), state: nState, amount: nAmt });
      }

      // Market filter
      var nMarket = req.query.market;
      var nMarketToStates = { colorado: ['CO'], california: ['CA'], arizona: ['AZ'] };
      if (nMarket === 'nationwide') {
        payments = payments.filter(function(p) { return !p.state || ['CO', 'CA', 'AZ'].indexOf(p.state) === -1; });
      } else if (nMarket && nMarket !== 'all') {
        var nStates = nMarketToStates[nMarket.toLowerCase()] || [];
        payments = payments.filter(function(p) { return nStates.indexOf(p.state) !== -1; });
      }

      // Period filter
      var nNow = new Date();
      var nStart, nEnd;
      switch (req.query.period) {
        case 'mtd': nStart = new Date(nNow.getFullYear(), nNow.getMonth(), 1).toISOString().slice(0, 10); nEnd = nNow.toISOString().slice(0, 10); break;
        case 'last30': nStart = new Date(nNow.getTime() - 30 * 86400000).toISOString().slice(0, 10); nEnd = nNow.toISOString().slice(0, 10); break;
        case 'qtd': nStart = new Date(nNow.getFullYear(), Math.floor(nNow.getMonth() / 3) * 3, 1).toISOString().slice(0, 10); nEnd = nNow.toISOString().slice(0, 10); break;
        case 'ytd': nStart = new Date(nNow.getFullYear(), 0, 1).toISOString().slice(0, 10); nEnd = nNow.toISOString().slice(0, 10); break;
        case 'last_month': nStart = new Date(nNow.getFullYear(), nNow.getMonth() - 1, 1).toISOString().slice(0, 10); nEnd = new Date(nNow.getFullYear(), nNow.getMonth(), 0).toISOString().slice(0, 10); break;
        case 'last_quarter': var ncq = Math.floor(nNow.getMonth() / 3) * 3; nStart = new Date(nNow.getFullYear(), ncq - 3, 1).toISOString().slice(0, 10); nEnd = new Date(nNow.getFullYear(), ncq, 0).toISOString().slice(0, 10); break;
        case 'custom': nStart = req.query.dateFrom || '2000-01-01'; nEnd = req.query.dateTo || '2099-12-31'; break;
        default: nStart = new Date(nNow.getFullYear(), nNow.getMonth(), 1).toISOString().slice(0, 10); nEnd = nNow.toISOString().slice(0, 10);
      }
      payments = payments.filter(function(p) { return p.date >= nStart && p.date <= nEnd; });
      var nTotal = payments.reduce(function(s, p) { return s + p.amount; }, 0);
      return res.status(200).json({ total: nTotal, count: payments.length, period: { start: nStart, end: nEnd }, market: nMarket || 'all' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
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

    var trail3Month = curMonth1 - 3;
    var trail3Year = now.getFullYear();
    if (trail3Month < 1) { trail3Month += 12; trail3Year--; }

    var trail1Cell = getNetIncomeCell(trail1Year, trail1Month);
    var trail2Cell = getNetIncomeCell(trail2Year, trail2Month);
    var trail3Cell = getNetIncomeCell(trail3Year, trail3Month);

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
    if (trail3Cell) ranges.push(trail3Cell);
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

    // Parse trailing net income from actuals (indexes 2, 3, 4 in valueRanges)
    var trailingNetIncome = [];
    for (var ti = 2; ti <= 4; ti++) {
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
