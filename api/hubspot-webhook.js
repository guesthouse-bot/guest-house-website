var fb = require('./_firebase');

// HubSpot → Auto-Create Bid for Arizona Properties
// POST /api/hubspot-webhook — real-time webhook from HubSpot workflow
// GET  /api/hubspot-webhook?action=poll&secret=CRON_SECRET — cron fallback every 4h

module.exports = async function handler(req, res) {
  fb.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET' && req.query.action === 'poll') {
    return handlePoll(req, res);
  }
  if (req.method === 'POST') {
    return handleWebhook(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

var HUBSPOT_TOKEN = function() { return process.env.HUBSPOT_ACCESS_TOKEN; };
var HUBSPOT_HEADERS = function() {
  return {
    'Authorization': 'Bearer ' + HUBSPOT_TOKEN(),
    'Content-Type': 'application/json',
  };
};

// AZ zip regex — matches 85000–86599
var AZ_ZIP_REGEX = /\b(8[56]\d{3})\b/;

function parseArizonaZip(dealName) {
  if (!dealName) return null;
  var match = dealName.match(AZ_ZIP_REGEX);
  if (!match) return null;
  var zip = parseInt(match[1], 10);
  if (zip >= 85000 && zip <= 86599) return match[1];
  return null;
}

// Retry helper for HubSpot rate limiting and transient errors
async function fetchWithRetry(url, options, retries) {
  retries = retries || 3;
  var lastResp;
  for (var attempt = 0; attempt <= retries; attempt++) {
    lastResp = await fetch(url, options);
    if (lastResp.ok) return lastResp;
    var retryable = lastResp.status === 429 || lastResp.status >= 500;
    if (retryable && attempt < retries) {
      var delay = Math.pow(2, attempt) * 1000;
      await new Promise(function(r) { setTimeout(r, delay); });
      continue;
    }
    return lastResp;
  }
  return lastResp;
}

// ========== WEBHOOK (POST) ==========
async function handleWebhook(req, res) {
  // Validate secret
  var secret = process.env.HUBSPOT_WEBHOOK_SECRET;
  if (secret) {
    var provided = req.headers['x-hubspot-webhook-secret'] || req.query.secret;
    if (provided !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  var dealId = req.body && req.body.objectId;
  if (!dealId) {
    return res.status(400).json({ error: 'Missing objectId in request body' });
  }

  try {
    var result = await processDeal(String(dealId), req);
    if (result.skipped) {
      return res.status(200).json(result);
    }
    return res.status(201).json(result);
  } catch (err) {
    console.error('Webhook error for deal ' + dealId + ':', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ========== POLL (GET, cron) ==========
async function handlePoll(req, res) {
  var cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.query.secret !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Step 1: Resolve "Seller Approved (Commit)" stage ID
    var stageId = await resolveStageId('Seller Approved (Commit)');
    if (!stageId) {
      return res.status(200).json({ processed: 0, message: 'Stage not found in pipeline' });
    }

    // Step 2: Search HubSpot for all deals in that stage
    var deals = await searchDealsByStage(stageId);

    // Step 3: Process each deal
    var results = [];
    for (var i = 0; i < deals.length; i++) {
      var deal = deals[i];
      try {
        var result = await processDeal(deal.id, req);
        results.push({ dealId: deal.id, result: result });
      } catch (err) {
        results.push({ dealId: deal.id, error: err.message });
      }
    }

    return res.status(200).json({ processed: results.length, results: results });
  } catch (err) {
    console.error('Poll error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ========== CORE: Process a single deal ==========
async function processDeal(dealId, req) {
  // 1. Fetch deal from HubSpot
  var dealResp = await fetchWithRetry(
    'https://api.hubapi.com/crm/v3/objects/deals/' + dealId + '?properties=dealname,dealstage,amount',
    { method: 'GET', headers: HUBSPOT_HEADERS() }
  );
  if (!dealResp.ok) {
    var err = await dealResp.json();
    throw new Error('HubSpot API error: ' + (err.message || dealResp.status));
  }
  var deal = await dealResp.json();
  var props = deal.properties || {};

  // 2. Parse AZ zip from deal name
  var zip = parseArizonaZip(props.dealname);
  if (!zip) {
    return { skipped: true, reason: 'not_arizona', dealName: props.dealname };
  }

  // 3. Verify deal is in "Seller Approved (Commit)" stage
  var stageId = await resolveStageId('Seller Approved (Commit)');
  if (props.dealstage !== stageId) {
    return { skipped: true, reason: 'wrong_stage', dealStage: props.dealstage };
  }

  // 4. Check Firestore for duplicate
  var serviceAccount = fb.getServiceAccount();
  var accessToken = await fb.getAccessToken(serviceAccount);

  var existing = await fb.runQuery('jobs', [
    { field: { fieldPath: 'hubspotDealId' }, op: 'EQUAL', value: { stringValue: dealId } },
  ], accessToken);

  if (existing.length > 0) {
    return { skipped: true, reason: 'duplicate', jobId: fb.docId(existing[0].document.name) };
  }

  // 5. Create job doc
  var now = new Date();
  var deadline = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  var jobDoc = await fb.createDocument('jobs', {
    address: props.dealname || '',
    sqft: '',
    rooms: '',
    timeline: '',
    market: 'arizona',
    providerType: 'stager',
    notes: 'Auto-created from HubSpot deal ' + dealId,
    status: 'bidding',
    created: now.toISOString(),
    biddingDeadline: deadline.toISOString(),
    awardedBidId: null,
    awardedProvider: null,
    awardedAt: null,
    hubspotDealId: dealId,
    hubspotAmount: props.amount || '',
  }, accessToken);

  var jobId = fb.docId(jobDoc.name);

  // 6. Query active AZ stagers
  var providerDocs = await fb.runQuery('providers', [
    { field: { fieldPath: 'market' }, op: 'EQUAL', value: { stringValue: 'arizona' } },
    { field: { fieldPath: 'role' }, op: 'EQUAL', value: { stringValue: 'stager' } },
    { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'active' } },
  ], accessToken);

  // 7. Create bids and send emails
  var bidsCreated = 0;
  var emailsSent = 0;

  for (var i = 0; i < providerDocs.length; i++) {
    var provider = fb.fromFirestoreFields(providerDocs[i].document.fields);
    var token = fb.generateToken();

    await fb.createDocument('bids', {
      jobId: jobId,
      providerEmail: provider.email,
      providerName: provider.name,
      amount: null,
      token: token,
      status: 'pending',
      submittedAt: null,
      created: now.toISOString(),
    }, accessToken);
    bidsCreated++;

    var bidUrl = (req.headers['x-forwarded-proto'] || 'https') + '://' +
      (req.headers['x-forwarded-host'] || req.headers.host) +
      '/provider-bid?token=' + token;

    var deadlineStr = deadline.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });

    var redacted = fb.redactAddress(props.dealname || '');
    await fb.sendEmail(
      provider.email,
      'New Job Available \u2014 ' + redacted,
      '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
        '<div style="margin-bottom:32px;"><strong style="font-size:18px;color:#080808;">Guest House</strong></div>' +
        '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">New job available in your market</h2>' +
        '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">Hi ' + provider.name.split(' ')[0] + ', a new staging job is available for bidding.</p>' +
        '<div style="background:#f7f7f7;border-radius:12px;padding:20px 24px;margin-bottom:24px;">' +
          '<div style="margin-bottom:8px;"><strong style="color:#343434;">Location:</strong> <span style="color:#666;">' + redacted + '</span></div>' +
          '<div><strong style="color:#343434;">Deadline:</strong> <span style="color:#666;">' + deadlineStr + '</span></div>' +
        '</div>' +
        '<a href="' + bidUrl + '" style="display:inline-block;background:#080808;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:500;">Submit Your Bid</a>' +
        '<p style="color:#999;font-size:13px;margin-top:24px;">This link is unique to you. Do not share it.</p>' +
      '</div>'
    );
    emailsSent++;
  }

  return {
    created: true,
    jobId: jobId,
    dealId: dealId,
    zip: zip,
    bidsCreated: bidsCreated,
    emailsSent: emailsSent,
  };
}

// ========== HubSpot Helpers ==========

// Cache stage ID to avoid repeated pipeline lookups
var _stageCache = {};

async function resolveStageId(label) {
  if (_stageCache[label]) return _stageCache[label];

  var resp = await fetchWithRetry(
    'https://api.hubapi.com/crm/v3/pipelines/deals/default/stages',
    { method: 'GET', headers: HUBSPOT_HEADERS() }
  );
  if (!resp.ok) return null;

  var data = await resp.json();
  var stages = data.results || data;
  for (var i = 0; i < stages.length; i++) {
    var stageLabel = (stages[i].label || '').trim();
    if (stageLabel.toLowerCase() === label.toLowerCase()) {
      _stageCache[label] = stages[i].id;
      return stages[i].id;
    }
  }
  return null;
}

async function searchDealsByStage(stageId) {
  var allDeals = [];
  var after = 0;
  var hasMore = true;

  while (hasMore) {
    var body = {
      filterGroups: [{
        filters: [
          { propertyName: 'pipeline', operator: 'EQ', value: 'default' },
          { propertyName: 'dealstage', operator: 'EQ', value: stageId },
        ],
      }],
      properties: ['dealname', 'dealstage', 'amount'],
      limit: 100,
      after: after,
    };

    var resp = await fetchWithRetry('https://api.hubapi.com/crm/v3/objects/deals/search', {
      method: 'POST',
      headers: HUBSPOT_HEADERS(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) break;

    var data = await resp.json();
    allDeals = allDeals.concat(data.results || []);
    if (data.paging && data.paging.next && data.paging.next.after) {
      after = data.paging.next.after;
    } else {
      hasMore = false;
    }
  }

  return allDeals;
}
