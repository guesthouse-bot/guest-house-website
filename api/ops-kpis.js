var crypto = require('crypto');
var fb = require('./_firebase');

// Generate a Google Sheets access token
async function getSheetsToken(serviceAccount) {
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

  try {
    // Get both Firestore and Sheets tokens in parallel
    var [firestoreToken, sheetsToken] = await Promise.all([
      fb.getAccessToken(serviceAccount),
      getSheetsToken(serviceAccount),
    ]);

    // Fetch homes from Firestore and cost/home from Sheets in parallel
    var SHEET_ID = process.env.FINANCIAL_MODEL_SHEET_ID;
    var costRanges = [
      "'Actuals (2026)'!B51:B51",  // CO cost/home (col1 = trailing month)
      "'Actuals (2026)'!B102:B102", // CA cost/home
      "'Actuals (2026)'!B149:B149", // AZ cost/home
    ];
    var encodedRanges = costRanges.map(function(r) { return 'ranges=' + encodeURIComponent(r); }).join('&');
    var sheetsUrl = 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID + '/values:batchGet?' + encodedRanges + '&valueRenderOption=UNFORMATTED_VALUE';

    // Query all homes from Firestore (no server-side date filter since Firestore
    // doesn't support OR queries on install_date and deinstall_date)
    var homesQuery = {
      structuredQuery: {
        from: [{ collectionId: 'homes' }],
        select: {
          fields: [
            { fieldPath: 'install_date' },
            { fieldPath: 'deinstall_date' },
            { fieldPath: 'address' },
            { fieldPath: 'status' },
          ],
        },
      },
    };

    // Also query providers for market count (distinct states)
    var providersQuery = {
      structuredQuery: {
        from: [{ collectionId: 'providers' }],
        select: {
          fields: [
            { fieldPath: 'market' },
            { fieldPath: 'state' },
          ],
        },
      },
    };

    var firestoreBase = fb.BASE_URL;

    var [sheetsRes, homesRes, providersRes] = await Promise.all([
      SHEET_ID ? fetch(sheetsUrl, { headers: { 'Authorization': 'Bearer ' + sheetsToken } }) : Promise.resolve(null),
      fetch(firestoreBase + ':runQuery', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + firestoreToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(homesQuery),
      }),
      fetch(firestoreBase + ':runQuery', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + firestoreToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(providersQuery),
      }),
    ]);

    // Parse cost/home from sheets
    var costPerHome = { co: null, ca: null, az: null };
    if (sheetsRes && sheetsRes.ok) {
      var sheetsData = await sheetsRes.json();
      var vr = sheetsData.valueRanges || [];
      var keys = ['co', 'ca', 'az'];
      for (var ci = 0; ci < 3; ci++) {
        if (vr[ci] && vr[ci].values && vr[ci].values[0] && typeof vr[ci].values[0][0] === 'number') {
          costPerHome[keys[ci]] = vr[ci].values[0][0];
        }
      }
    }

    // Parse homes
    var homesData = await homesRes.json();
    var homes = (homesData || []).filter(function(item) { return item.document; });

    var startMs = startDate.getTime();
    var endMs = endDate.getTime();

    // State extraction from address
    var stateRegex = /,\s*([A-Z]{2})\s*(?:\d|,|$)/;
    function extractState(address) {
      if (!address) return '';
      var match = address.match(stateRegex);
      return match ? match[1] : '';
    }

    // Market filter: map market name to state codes
    var marketToStates = {
      colorado: ['CO'],
      california: ['CA'],
      nationwide: null, // special: exclude CO and CA
    };

    function passesMarketFilter(state) {
      if (!market || market === 'all') return true;
      if (market === 'nationwide') return state && state !== 'CO' && state !== 'CA';
      var states = marketToStates[market.toLowerCase()];
      if (states) return states.indexOf(state) !== -1;
      return true;
    }

    var installs = 0;
    var deinstalls = 0;
    var renewals = 0;
    var installDaily = {};
    var deinstallDaily = {};
    var homeStates = {};

    // For installs/deinstalls/renewals, use the full month boundaries
    // (include future-scheduled dates within the period month)
    var periodMonthStart = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    var periodMonthEnd = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0, 23, 59, 59, 999);
    var periodMonthStartMs = periodMonthStart.getTime();
    var periodMonthEndMs = periodMonthEnd.getTime();

    homes.forEach(function(item) {
      var fields = item.document.fields || {};
      var address = fields.address ? (fields.address.stringValue || '') : '';
      var state = extractState(address);

      // Track states for markets count
      if (state) homeStates[state] = true;

      if (!passesMarketFilter(state)) return;

      // Parse dates
      var installDateStr = fields.install_date ? (fields.install_date.timestampValue || fields.install_date.stringValue || '') : '';
      var deinstallDateStr = fields.deinstall_date ? (fields.deinstall_date.timestampValue || fields.deinstall_date.stringValue || '') : '';

      var installDate = installDateStr ? new Date(installDateStr) : null;
      var deinstallDate = deinstallDateStr ? new Date(deinstallDateStr) : null;

      if (installDate && isNaN(installDate.getTime())) installDate = null;
      if (deinstallDate && isNaN(deinstallDate.getTime())) deinstallDate = null;

      var installInPeriod = installDate && installDate.getTime() >= periodMonthStartMs && installDate.getTime() <= periodMonthEndMs;
      var deinstallInPeriod = deinstallDate && deinstallDate.getTime() >= periodMonthStartMs && deinstallDate.getTime() <= periodMonthEndMs;

      // Installs: install_date in current month
      if (installInPeriod) {
        installs++;
        var day = installDate.toISOString().slice(0, 10);
        if (!installDaily[day]) installDaily[day] = { installs: 0 };
        installDaily[day].installs++;
      }

      // Deinstalls: deinstall_date scheduled in current month
      if (deinstallInPeriod) {
        deinstalls++;
        var dday = deinstallDate.toISOString().slice(0, 10);
        if (!deinstallDaily[dday]) deinstallDaily[dday] = { deinstalls: 0 };
        deinstallDaily[dday].deinstalls++;
      }

      // Renewals: install_date from a previous month AND no deinstall_date scheduled
      if (installDate && installDate.getTime() < periodMonthStartMs && !deinstallDate) {
        renewals++;
      }
    });

    // Parse providers for market/state count
    var providersData = await providersRes.json();
    var providers = (providersData || []).filter(function(item) { return item.document; });
    var providerStates = {};

    providers.forEach(function(item) {
      var fields = item.document.fields || {};
      var pState = fields.state ? (fields.state.stringValue || '') : '';
      var pMarket = fields.market ? (fields.market.stringValue || '') : '';
      if (pState) providerStates[pState.toUpperCase()] = true;
      // Also extract state from market name
      if (pMarket) {
        var marketUpper = pMarket.toLowerCase();
        if (marketUpper === 'colorado') providerStates['CO'] = true;
        else if (marketUpper === 'california') providerStates['CA'] = true;
        else if (marketUpper === 'arizona') providerStates['AZ'] = true;
      }
    });

    // Combine states from homes and providers
    var allStates = {};
    Object.keys(homeStates).forEach(function(s) { allStates[s] = true; });
    Object.keys(providerStates).forEach(function(s) { allStates[s] = true; });
    var marketsCount = Object.keys(allStates).length;

    // Compute blended cost/home based on market filter
    var costHome = null;
    if (market === 'colorado') {
      costHome = costPerHome.co;
    } else if (market === 'california') {
      costHome = costPerHome.ca;
    } else if (market === 'nationwide') {
      costHome = costPerHome.az;
    } else {
      // All markets: average of available values
      var costs = [costPerHome.co, costPerHome.ca, costPerHome.az].filter(function(v) { return v !== null; });
      if (costs.length > 0) {
        costHome = costs.reduce(function(a, b) { return a + b; }, 0) / costs.length;
      }
    }

    return res.status(200).json({
      installs: installs,
      deinstalls: deinstalls,
      renewals: renewals,
      markets: marketsCount,
      cost_per_home: costHome,
      cost_per_home_by_market: costPerHome,
      daily_installs: installDaily,
      daily_deinstalls: deinstallDaily,
      period: { start: startDate.toISOString(), end: endDate.toISOString() },
      market: market || 'all',
    });

  } catch (err) {
    console.error('Ops KPIs error:', err);
    return res.status(500).json({ error: err.message });
  }
};
