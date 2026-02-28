var crypto = require('crypto');

// Generate a Google access token from service account credentials
async function getAccessToken(serviceAccount) {
  var now = Math.floor(Date.now() / 1000);
  var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  var payload = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
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

// Compute date range from period filter
function getDateRange(period, dateFrom, dateTo) {
  var now = new Date();
  var start, end;
  end = now;
  switch (period) {
    case 'mtd':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'last30':
      start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case 'qtd':
      var qMonth = Math.floor(now.getMonth() / 3) * 3;
      start = new Date(now.getFullYear(), qMonth, 1);
      break;
    case 'ytd':
      start = new Date(now.getFullYear(), 0, 1);
      break;
    case 'last_month':
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end = new Date(now.getFullYear(), now.getMonth(), 0);
      break;
    case 'last_quarter':
      var cqMonth = Math.floor(now.getMonth() / 3) * 3;
      start = new Date(now.getFullYear(), cqMonth - 3, 1);
      end = new Date(now.getFullYear(), cqMonth, 0);
      break;
    case 'custom':
      if (dateFrom) start = new Date(dateFrom);
      if (dateTo) end = new Date(dateTo);
      break;
    default:
      start = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  function fmt(d) { return d.toISOString().slice(0, 10); }
  return { startDate: fmt(start), endDate: fmt(end) };
}

// Run a GA4 Data API report
async function runReport(accessToken, propertyId, body) {
  var url = 'https://analyticsdata.googleapis.com/v1beta/properties/' + propertyId + ':runReport';
  var response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    var err = await response.json();
    throw new Error(err.error ? err.error.message : 'GA4 API error (' + response.status + ')');
  }
  return response.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var saB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!saB64) return res.status(500).json({ error: 'Firebase service account not configured' });

  var propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId) return res.status(500).json({ error: 'GA4_PROPERTY_ID not configured' });

  var serviceAccount = JSON.parse(Buffer.from(saB64, 'base64').toString('utf-8'));

  var period = req.query.period || 'mtd';
  var dateFrom = req.query.dateFrom || '';
  var dateTo = req.query.dateTo || '';
  var wantDaily = req.query.daily === 'true';

  var range = getDateRange(period, dateFrom, dateTo);

  try {
    var accessToken = await getAccessToken(serviceAccount);

    // Run three reports in parallel:
    // 1. Main metrics (with optional daily breakdown)
    // 2. Quote start events (with optional daily breakdown)
    // 3. Traffic sources
    var mainBody = {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'bounceRate' },
        { name: 'averageSessionDuration' },
        { name: 'screenPageViewsPerSession' },
      ],
    };
    if (wantDaily) {
      mainBody.dimensions = [{ name: 'date' }];
      mainBody.orderBys = [{ dimension: { dimensionName: 'date' } }];
    }

    var quoteBody = {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          stringFilter: { matchType: 'EXACT', value: 'quote_start' },
        },
      },
    };
    if (wantDaily) {
      quoteBody.dimensions = [{ name: 'date' }];
      quoteBody.orderBys = [{ dimension: { dimensionName: 'date' } }];
    }

    var trafficBody = {
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    };

    var results = await Promise.all([
      runReport(accessToken, propertyId, mainBody),
      runReport(accessToken, propertyId, quoteBody),
      runReport(accessToken, propertyId, trafficBody),
    ]);

    var mainReport = results[0];
    var quoteReport = results[1];
    var trafficReport = results[2];

    // Parse main metrics
    var sessions = 0;
    var users = 0;
    var bounceRate = 0;
    var avgDuration = 0;
    var pagesPerSession = 0;
    var daily = null;

    if (wantDaily && mainReport.rows && mainReport.rows.length > 0) {
      // Daily breakdown: each row has date dimension + metrics
      daily = {};
      var totSessions = 0, totUsers = 0, totBounce = 0, totDuration = 0, totPages = 0;
      mainReport.rows.forEach(function(row) {
        var dateStr = row.dimensionValues[0].value; // YYYYMMDD
        var formattedDate = dateStr.slice(0, 4) + '-' + dateStr.slice(4, 6) + '-' + dateStr.slice(6, 8);
        var s = parseFloat(row.metricValues[0].value) || 0;
        var u = parseFloat(row.metricValues[1].value) || 0;
        var b = parseFloat(row.metricValues[2].value) || 0;
        var d = parseFloat(row.metricValues[3].value) || 0;
        var p = parseFloat(row.metricValues[4].value) || 0;
        daily[formattedDate] = {
          sessions: s,
          users: u,
          bounce_rate: b * 100,
          avg_duration: d,
          pages_per_session: p,
          quote_starts: 0,
        };
        totSessions += s;
        totUsers += u;
        totBounce += b * s; // weight by sessions
        totDuration += d * s;
        totPages += p * s;
      });
      sessions = totSessions;
      users = totUsers;
      bounceRate = totSessions > 0 ? (totBounce / totSessions) * 100 : 0;
      avgDuration = totSessions > 0 ? totDuration / totSessions : 0;
      pagesPerSession = totSessions > 0 ? totPages / totSessions : 0;
    } else if (mainReport.rows && mainReport.rows.length > 0) {
      // Aggregate (no daily)
      var row = mainReport.rows[0];
      sessions = parseFloat(row.metricValues[0].value) || 0;
      users = parseFloat(row.metricValues[1].value) || 0;
      bounceRate = (parseFloat(row.metricValues[2].value) || 0) * 100;
      avgDuration = parseFloat(row.metricValues[3].value) || 0;
      pagesPerSession = parseFloat(row.metricValues[4].value) || 0;
    }

    // Parse quote starts
    var quoteStarts = 0;
    if (wantDaily && quoteReport.rows) {
      quoteReport.rows.forEach(function(row) {
        var dateStr = row.dimensionValues[0].value;
        var formattedDate = dateStr.slice(0, 4) + '-' + dateStr.slice(4, 6) + '-' + dateStr.slice(6, 8);
        var count = parseInt(row.metricValues[0].value) || 0;
        quoteStarts += count;
        if (daily && daily[formattedDate]) {
          daily[formattedDate].quote_starts = count;
        }
      });
    } else if (quoteReport.rows && quoteReport.rows.length > 0) {
      quoteStarts = parseInt(quoteReport.rows[0].metricValues[0].value) || 0;
    }

    // Parse traffic sources
    var trafficSources = [];
    if (trafficReport.rows) {
      trafficReport.rows.forEach(function(row) {
        trafficSources.push({
          channel: row.dimensionValues[0].value,
          sessions: parseInt(row.metricValues[0].value) || 0,
        });
      });
    }

    var result = {
      sessions: sessions,
      users: users,
      bounce_rate: bounceRate,
      avg_duration: avgDuration,
      pages_per_session: pagesPerSession,
      quote_starts: quoteStarts,
      traffic_sources: trafficSources,
      period: { start: range.startDate, end: range.endDate },
    };

    if (daily) result.daily = daily;

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
