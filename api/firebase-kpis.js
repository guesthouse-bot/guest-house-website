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

    // All CO and CA region values (for nationwide exclusion)
    var coAndCaRegions = ['denver_boulder', 'san_diego', 'orange_county', 'los_angeles'];

    // Filter by market using activeRegion field
    // "all" = everything, "nationwide" = only regions outside CO and CA
    var filtered = allUsers;
    if (market === 'nationwide') {
      filtered = allUsers.filter(function(item) {
        var fields = item.document.fields;
        var activeRegion = (fields.activeRegion && fields.activeRegion.stringValue || '').toLowerCase();
        return !coAndCaRegions.some(function(r) { return activeRegion.indexOf(r) !== -1; });
      });
    } else if (market && market !== 'all') {
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
    var agentKeywords = ['agent', 'assistant', 'operations', 'coordinator', 'broker', 'office manager', 'builder', 'flipper', 'developer'];

    if (HUBSPOT_TOKEN && filtered.length > 0) {
      // Extract emails from Firebase users
      var emails = [];
      filtered.forEach(function(item) {
        var fields = item.document.fields;
        if (fields.email && fields.email.stringValue) {
          emails.push(fields.email.stringValue.toLowerCase());
        }
      });

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

    // Daily bucketing
    var daily = {};
    if (req.query.daily === 'true') {
      filtered.forEach(function(item) {
        var fields = item.document.fields;
        if (fields.created && fields.created.timestampValue) {
          var day = new Date(fields.created.timestampValue).toISOString().slice(0, 10);
          if (!daily[day]) daily[day] = { accounts_created: 0 };
          daily[day].accounts_created++;
        }
      });
    }

    // Total Active Agents: distinct contacts associated with closedwon deals
    // in trailing 12 months (company-wide, ignores market filter)
    var activeAgents = 0;
    if (HUBSPOT_TOKEN) {
      // Retry helper for HubSpot rate limiting
      async function hsRetry(url, opts, retries) {
        retries = retries || 3;
        for (var attempt = 0; attempt <= retries; attempt++) {
          var resp = await fetch(url, opts);
          if (resp.ok) return resp;
          if (resp.status === 429 && attempt < retries) {
            await new Promise(function(r) { setTimeout(r, Math.pow(2, attempt) * 1000); });
            continue;
          }
          return resp;
        }
      }

      var t12Start = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()).getTime();
      var t12End = now.getTime();
      var activeContactIds = new Set();

      // Step 1: Collect ALL closedwon deal IDs in trailing 12 months (no market filter)
      var allDealIds = [];
      var aaAfter = null;
      var aaMore = true;

      while (aaMore) {
        var aaFilters = [
          { propertyName: 'closedate', operator: 'GTE', value: String(t12Start) },
          { propertyName: 'closedate', operator: 'LTE', value: String(t12End) },
          { propertyName: 'pipeline', operator: 'EQ', value: 'default' },
        ];
        var aaBody = {
          filterGroups: [
            { filters: aaFilters.concat([{ propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' }]) },
            { filters: aaFilters.concat([{ propertyName: 'dealstage', operator: 'EQ', value: '13174420' }]) },
          ],
          properties: ['dealname'],
          limit: 100,
        };
        if (aaAfter) aaBody.after = aaAfter;

        var aaRes = await hsRetry('https://api.hubapi.com/crm/v3/objects/deals/search', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(aaBody),
        });

        if (aaRes.ok) {
          var aaData = await aaRes.json();
          (aaData.results || []).forEach(function(deal) {
            allDealIds.push(deal.id);
          });
          if (aaData.paging && aaData.paging.next && aaData.paging.next.after) {
            aaAfter = aaData.paging.next.after;
          } else {
            aaMore = false;
          }
        } else {
          aaMore = false;
        }
      }

      // Step 2: Batch-fetch contact associations for all deals (v4 batch API)
      for (var bi = 0; bi < allDealIds.length; bi += 100) {
        var batchIds = allDealIds.slice(bi, bi + 100);
        var batchBody = { inputs: batchIds.map(function(id) { return { id: id }; }) };
        var assocRes = await hsRetry('https://api.hubapi.com/crm/v4/associations/deals/contacts/batch/read', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(batchBody),
        });
        if (assocRes.ok) {
          var assocData = await assocRes.json();
          (assocData.results || []).forEach(function(item) {
            (item.to || []).forEach(function(to) {
              activeContactIds.add(String(to.toObjectId));
            });
          });
        }
      }

      // Step 3: Exclude homeowners by checking HubSpot role field
      if (activeContactIds.size > 0) {
        var contactIdArr = Array.from(activeContactIds);
        var homeownerIds = new Set();

        for (var ci = 0; ci < contactIdArr.length; ci += 100) {
          var contactBatch = contactIdArr.slice(ci, ci + 100);
          var cRes = await hsRetry('https://api.hubapi.com/crm/v3/objects/contacts/batch/read', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              properties: ['role'],
              inputs: contactBatch.map(function(id) { return { id: id }; }),
            }),
          });

          if (cRes.ok) {
            var cData = await cRes.json();
            (cData.results || []).forEach(function(contact) {
              var role = ((contact.properties || {}).role || '').toLowerCase();
              if (role === 'homeowner') {
                homeownerIds.add(String(contact.id));
              }
            });
          }
        }

        activeAgents = activeContactIds.size - homeownerIds.size;
      }
    }

    var bookingsPerAgent = activeAgents > 0 ? Math.round((allDealIds.length / activeAgents) * 100) / 100 : null;

    var result = {
      accounts_created: accountsCreated,
      active_agents: activeAgents,
      bookings_per_agent: bookingsPerAgent,
      period: { start: startDate, end: endDate },
      market: market || 'all',
    };
    if (req.query.daily === 'true') result.daily = daily;
    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
