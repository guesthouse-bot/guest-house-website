var crypto = require('crypto');

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
  var HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
  var STRIPE_KEY = process.env.STRIPE_API_KEY;

  if (!saB64) return res.status(500).json({ error: 'Firebase not configured' });
  if (!HUBSPOT_TOKEN) return res.status(500).json({ error: 'HubSpot not configured' });
  if (!STRIPE_KEY) return res.status(500).json({ error: 'Stripe not configured' });

  var serviceAccount = JSON.parse(Buffer.from(saB64, 'base64').toString('utf-8'));
  var market = req.query.market;
  var period = req.query.period;
  var dateFrom = req.query.dateFrom;
  var dateTo = req.query.dateTo;

  // Calculate date range in milliseconds
  var now = new Date();
  var startMs, endMs;
  endMs = now.getTime();

  switch (period) {
    case 'mtd':
      startMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      break;
    case 'last30':
      startMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;
      break;
    case 'qtd':
      var qMonth = Math.floor(now.getMonth() / 3) * 3;
      startMs = new Date(now.getFullYear(), qMonth, 1).getTime();
      break;
    case 'ytd':
      startMs = new Date(now.getFullYear(), 0, 1).getTime();
      break;
    case 'last_month':
      startMs = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
      endMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      break;
    case 'last_quarter':
      var cqMonth = Math.floor(now.getMonth() / 3) * 3;
      startMs = new Date(now.getFullYear(), cqMonth - 3, 1).getTime();
      endMs = new Date(now.getFullYear(), cqMonth, 1).getTime();
      break;
    case 'custom':
      if (dateFrom) startMs = new Date(dateFrom).getTime();
      if (dateTo) endMs = new Date(dateTo + 'T23:59:59').getTime();
      break;
    default:
      startMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  }

  var startISO = new Date(startMs).toISOString();
  var endISO = new Date(endMs).toISOString();
  var startUnix = Math.floor(startMs / 1000);
  var endUnix = Math.floor(endMs / 1000);

  var marketToRegions = {
    colorado: ['denver_boulder'],
    california: ['san_diego', 'orange_county', 'los_angeles'],
  };

  try {
    // --- Step 1: Get Firebase users created in date range ---
    var accessToken = await getAccessToken(serviceAccount);
    var allUsers = [];
    var pageToken = null;
    var fbHasMore = true;

    while (fbHasMore) {
      var query = {
        structuredQuery: {
          from: [{ collectionId: 'users' }],
          where: {
            compositeFilter: {
              op: 'AND',
              filters: [
                { fieldFilter: { field: { fieldPath: 'created' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: startISO } } },
                { fieldFilter: { field: { fieldPath: 'created' }, op: 'LESS_THAN_OR_EQUAL', value: { timestampValue: endISO } } },
              ]
            }
          },
          limit: 300,
        }
      };

      if (pageToken) {
        query.structuredQuery.startAt = { values: [{ timestampValue: pageToken }], before: false };
        query.structuredQuery.orderBy = [{ field: { fieldPath: 'created' }, direction: 'ASCENDING' }];
      }

      var fbResponse = await fetch(
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

      if (!fbResponse.ok) {
        var fbErr = await fbResponse.json();
        return res.status(fbResponse.status).json({ error: fbErr.error ? fbErr.error.message : 'Firestore error' });
      }

      var fbData = await fbResponse.json();
      var docs = fbData.filter(function(item) { return item.document; });
      allUsers = allUsers.concat(docs);

      if (docs.length >= 300) {
        var lastDoc = docs[docs.length - 1].document.fields;
        pageToken = lastDoc.created.timestampValue;
      } else {
        fbHasMore = false;
      }
    }

    // --- Step 2: Filter by market ---
    var filtered = allUsers;
    if (market && market !== 'all' && market !== 'nationwide') {
      var regions = marketToRegions[market.toLowerCase()] || [];
      filtered = allUsers.filter(function(item) {
        var fields = item.document.fields;
        var activeRegion = (fields.activeRegion && fields.activeRegion.stringValue || '').toLowerCase();
        return regions.some(function(r) { return activeRegion.indexOf(r) !== -1; });
      });
    }

    // --- Step 3: Extract emails ---
    var emails = [];
    filtered.forEach(function(item) {
      var fields = item.document.fields;
      if (fields.email && fields.email.stringValue) {
        emails.push(fields.email.stringValue.toLowerCase());
      }
    });

    // --- Step 4: Batch lookup HubSpot contacts, filter to agent roles ---
    var agentKeywords = ['agent', 'assistant', 'operations', 'coordinator', 'broker', 'office manager', 'builder', 'flipper', 'developer'];
    var agentContactIds = [];
    var agentEmails = new Set();
    var agentContactMap = {}; // contactId → email

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
            agentContactIds.push(contact.id);
            agentEmails.add((props.email || '').toLowerCase());
            agentContactMap[contact.id] = (props.email || '').toLowerCase();
          }
        });
      }
    }

    // --- Step 5: Get deal associations — preserve contact→deals mapping ---
    var contactDealIds = {}; // contactId → [dealId, ...]
    var allDealIds = new Set();

    for (var i = 0; i < agentContactIds.length; i += 100) {
      var batch = agentContactIds.slice(i, i + 100);
      var assocResponse = await fetch('https://api.hubapi.com/crm/v4/associations/contact/deal/batch/read', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: batch.map(function(id) { return { id: String(id) }; })
        }),
      });

      if (assocResponse.ok) {
        var assocData = await assocResponse.json();
        (assocData.results || []).forEach(function(result) {
          var contactId = String(result.from.id);
          if (!contactDealIds[contactId]) contactDealIds[contactId] = [];
          (result.to || []).forEach(function(to) {
            var dealId = String(to.toObjectId);
            contactDealIds[contactId].push(dealId);
            allDealIds.add(dealId);
          });
        });
      }
    }

    // --- Step 6: Batch read all deal details ---
    var dealIdArray = Array.from(allDealIds);
    var dealMap = {}; // dealId → deal properties

    for (var i = 0; i < dealIdArray.length; i += 100) {
      var batch = dealIdArray.slice(i, i + 100);
      var dealResponse = await fetch('https://api.hubapi.com/crm/v3/objects/deals/batch/read', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          properties: ['dealname', 'dealstage', 'createdate', 'closedate', 'amount', 'pipeline'],
          inputs: batch.map(function(id) { return { id: id }; })
        }),
      });

      if (dealResponse.ok) {
        var dealData = await dealResponse.json();
        (dealData.results || []).forEach(function(deal) {
          dealMap[deal.id] = deal.properties || {};
        });
      }
    }

    // --- Step 7: Find "active users" = agents with at least 1 Closed Won deal in period ---
    var activeContactIds = new Set();

    Object.keys(contactDealIds).forEach(function(contactId) {
      var dealIds = contactDealIds[contactId];
      var hasBooking = dealIds.some(function(dealId) {
        var props = dealMap[dealId];
        if (!props || props.pipeline !== 'default') return false;
        if (props.dealstage !== 'closedwon' || !props.closedate) return false;
        var closeTime = new Date(props.closedate).getTime();
        return closeTime >= startMs && closeTime <= endMs;
      });
      if (hasBooking) activeContactIds.add(contactId);
    });

    var activeUsers = activeContactIds.size;

    // Build set of active agent emails (for Stripe matching)
    var activeAgentEmails = new Set();
    activeContactIds.forEach(function(contactId) {
      var email = agentContactMap[contactId];
      if (email) activeAgentEmails.add(email);
    });

    // --- Step 8: Count quotes + bookings only for active (paying) agents ---
    var agentQuotes = 0;
    var agentBookings = 0;
    var agentBookingRevenue = 0;

    activeContactIds.forEach(function(contactId) {
      var dealIds = contactDealIds[contactId] || [];
      dealIds.forEach(function(dealId) {
        var props = dealMap[dealId];
        if (!props || props.pipeline !== 'default') return;

        var createTime = new Date(props.createdate).getTime();
        if (createTime >= startMs && createTime <= endMs) {
          agentQuotes++;
        }

        if (props.dealstage === 'closedwon' && props.closedate) {
          var closeTime = new Date(props.closedate).getTime();
          if (closeTime >= startMs && closeTime <= endMs) {
            agentBookings++;
            var amt = parseFloat(props.amount || 0);
            if (!isNaN(amt)) agentBookingRevenue += amt;
          }
        }
      });
    });

    // --- Step 9: Stripe revenue only for active agent emails ---
    var agentRevenue = 0;
    var sHasMore = true;
    var startingAfter = null;

    while (sHasMore) {
      var stripeParams = new URLSearchParams({
        'created[gte]': String(startUnix),
        'created[lte]': String(endUnix),
        'limit': '100',
        'status': 'succeeded',
      });
      if (startingAfter) stripeParams.append('starting_after', startingAfter);

      var stripeResponse = await fetch('https://api.stripe.com/v1/charges?' + stripeParams, {
        headers: { 'Authorization': 'Bearer ' + STRIPE_KEY },
      });

      if (!stripeResponse.ok) break;

      var stripeData = await stripeResponse.json();
      stripeData.data.forEach(function(charge) {
        var billingEmail = (charge.billing_details && charge.billing_details.email || '').toLowerCase();
        var receiptEmail = (charge.receipt_email || '').toLowerCase();
        if (activeAgentEmails.has(billingEmail) || activeAgentEmails.has(receiptEmail)) {
          agentRevenue += (charge.amount_captured || 0);
        }
      });

      sHasMore = stripeData.has_more;
      if (sHasMore && stripeData.data.length > 0) {
        startingAfter = stripeData.data[stripeData.data.length - 1].id;
      }
    }

    agentRevenue = agentRevenue / 100;

    // --- Step 10: Compute per-user metrics ---
    var accts = activeUsers > 0 ? activeUsers : 1;

    return res.status(200).json({
      active_users: activeUsers,
      agent_quotes: agentQuotes,
      agent_bookings: agentBookings,
      agent_revenue: agentRevenue,
      quotes_per_user: agentQuotes / accts,
      bookings_per_user: agentBookings / accts,
      revenue_per_user: agentRevenue / accts,
      arpu: agentRevenue / accts,
      period: { start: startMs, end: endMs },
      market: market || 'all',
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
