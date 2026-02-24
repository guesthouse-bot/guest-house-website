var crypto = require('crypto');

// Generate a Google access token from service account credentials
async function getAccessToken(serviceAccount) {
  var now = Math.floor(Date.now() / 1000);
  var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  var payload = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/datastore',
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

  var serviceAccount = JSON.parse(Buffer.from(saB64, 'base64').toString('utf-8'));

  var market = req.query.market;
  var period = req.query.period;
  var dateFrom = req.query.dateFrom;
  var dateTo = req.query.dateTo;

  // Calculate date range
  var now = new Date();
  var startDate, endDate;
  endDate = now.toISOString();

  switch (period) {
    case 'mtd':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      break;
    case 'last30':
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      break;
    case 'qtd':
      var qMonth = Math.floor(now.getMonth() / 3) * 3;
      startDate = new Date(now.getFullYear(), qMonth, 1).toISOString();
      break;
    case 'ytd':
      startDate = new Date(now.getFullYear(), 0, 1).toISOString();
      break;
    case 'last_month':
      startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
      endDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      break;
    case 'last_quarter':
      var cqMonth = Math.floor(now.getMonth() / 3) * 3;
      startDate = new Date(now.getFullYear(), cqMonth - 3, 1).toISOString();
      endDate = new Date(now.getFullYear(), cqMonth, 1).toISOString();
      break;
    case 'custom':
      if (dateFrom) startDate = new Date(dateFrom).toISOString();
      if (dateTo) endDate = new Date(dateTo + 'T23:59:59').toISOString();
      break;
    default:
      startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  }

  // Map market filter to activeRegion values
  var marketToRegions = {
    colorado: ['denver_boulder'],
    california: ['san_diego', 'orange_county', 'los_angeles'],
  };

  try {
    var accessToken = await getAccessToken(serviceAccount);

    // Query Firestore for users created in date range
    var allUsers = [];
    var pageToken = null;
    var hasMore = true;

    while (hasMore) {
      var query = {
        structuredQuery: {
          from: [{ collectionId: 'users' }],
          where: {
            compositeFilter: {
              op: 'AND',
              filters: [
                { fieldFilter: { field: { fieldPath: 'created' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: startDate } } },
                { fieldFilter: { field: { fieldPath: 'created' }, op: 'LESS_THAN_OR_EQUAL', value: { timestampValue: endDate } } },
              ]
            }
          },
          limit: 300,
        }
      };

      // Firestore runQuery doesn't support pagination the same way, so we use startAt with the last doc
      if (pageToken) {
        query.structuredQuery.startAt = { values: [{ timestampValue: pageToken }], before: false };
        query.structuredQuery.orderBy = [{ field: { fieldPath: 'created' }, direction: 'ASCENDING' }];
      }

      var response = await fetch(
        'https://firestore.googleapis.com/v1/projects/guesthouse-cms/databases/(default)/documents:runQuery',
        {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + accessToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(query),
        }
      );

      if (!response.ok) {
        var err = await response.json();
        return res.status(response.status).json({ error: err.error ? err.error.message : 'Firestore API error' });
      }

      var data = await response.json();
      var docs = data.filter(function(item) { return item.document; });
      allUsers = allUsers.concat(docs);

      if (docs.length >= 300) {
        var lastDoc = docs[docs.length - 1].document.fields;
        pageToken = lastDoc.created.timestampValue;
      } else {
        hasMore = false;
      }
    }

    // Filter by market using activeRegion field
    var filtered = allUsers;
    if (market && market !== 'all' && market !== 'nationwide') {
      var regions = marketToRegions[market.toLowerCase()] || [];
      filtered = allUsers.filter(function(item) {
        var fields = item.document.fields;
        var activeRegion = (fields.activeRegion && fields.activeRegion.stringValue || '').toLowerCase();
        return regions.some(function(r) { return activeRegion.indexOf(r) !== -1; });
      });
    }

    // Cross-reference with HubSpot contacts to only count Agent accounts
    var HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
    var agentEmails = new Set();

    if (HUBSPOT_TOKEN && filtered.length > 0) {
      // Extract emails from Firebase users
      var emails = [];
      filtered.forEach(function(item) {
        var fields = item.document.fields;
        if (fields.email && fields.email.stringValue) {
          emails.push(fields.email.stringValue.toLowerCase());
        }
      });

      var agentKeywords = ['agent', 'assistant', 'operations', 'coordinator', 'broker', 'office manager', 'builder', 'flipper', 'developer'];

      // Batch lookup emails in HubSpot (100 at a time)
      for (var i = 0; i < emails.length; i += 100) {
        var batch = emails.slice(i, i + 100);
        var batchBody = {
          properties: ['email', 'jobtitle', 'role'],
          idProperty: 'email',
          inputs: batch.map(function(email) { return { id: email }; })
        };

        var hsResponse = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/batch/read', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(batchBody),
        });

        if (hsResponse.ok) {
          var hsData = await hsResponse.json();
          (hsData.results || []).forEach(function(contact) {
            var props = contact.properties || {};
            var role = ((props.jobtitle || '') + ' ' + (props.role || '')).toLowerCase();
            var isAgent = agentKeywords.some(function(keyword) {
              return role.indexOf(keyword) !== -1;
            });
            if (isAgent) {
              agentEmails.add((props.email || '').toLowerCase());
            }
          });
        }
      }

      // Filter to only agent accounts
      filtered = filtered.filter(function(item) {
        var fields = item.document.fields;
        var email = (fields.email && fields.email.stringValue || '').toLowerCase();
        return agentEmails.has(email);
      });
    }

    var accountsCreated = filtered.length;

    return res.status(200).json({
      accounts_created: accountsCreated,
      period: { start: startDate, end: endDate },
      market: market || 'all',
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
