module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
  var STRIPE_KEY = process.env.STRIPE_API_KEY;

  if (!HUBSPOT_TOKEN) return res.status(500).json({ error: 'HubSpot not configured' });
  if (!STRIPE_KEY) return res.status(500).json({ error: 'Stripe not configured' });

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

  var startUnix = Math.floor(startMs / 1000);
  var endUnix = Math.floor(endMs / 1000);

  var marketToValues = {
    colorado: { states: ['CO'], markets: ['denver', 'boulder', 'colorado'] },
    california: { states: ['CA'], markets: ['san diego', 'orange county', 'los angeles', 'california', 'la', 'oc'] },
  };

  var agentKeywords = ['agent', 'assistant', 'operations', 'coordinator', 'broker', 'office manager', 'builder', 'flipper', 'developer'];

  // Helper: paginated HubSpot deal search
  async function searchDeals(filters) {
    var allDeals = [];
    var after = 0;
    var hasMore = true;

    while (hasMore) {
      var body = {
        filterGroups: [{ filters: filters }],
        properties: ['dealname', 'dealstage', 'createdate', 'closedate', 'amount', 'pipeline', 'market'],
        limit: 100,
        after: after,
      };

      var resp = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
          'Content-Type': 'application/json',
        },
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

  // Helper: filter deals by market
  function filterByMarket(deals) {
    if (!market || market === 'all' || market === 'nationwide') return deals;
    var mapping = marketToValues[market.toLowerCase()];
    if (!mapping) return deals;

    return deals.filter(function(deal) {
      var props = deal.properties || {};
      var dealMarket = (props.market || '').toLowerCase();
      if (mapping.markets.some(function(m) { return dealMarket.indexOf(m) !== -1; })) return true;
      var name = props.dealname || '';
      var stateMatch = name.match(/,\s*([A-Z]{2})\s*(\(|$)/);
      if (stateMatch && mapping.states.indexOf(stateMatch[1]) !== -1) return true;
      return false;
    });
  }

  try {
    // --- Step 1: Get Closed Won deals in the period (bookings) ---
    var rawBookingDeals = await searchDeals([
      { propertyName: 'closedate', operator: 'GTE', value: String(startMs) },
      { propertyName: 'closedate', operator: 'LTE', value: String(endMs) },
      { propertyName: 'pipeline', operator: 'EQ', value: 'default' },
      { propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' },
    ]);
    var bookingDeals = filterByMarket(rawBookingDeals);

    // --- Step 2: Get all deals created in the period (quotes) ---
    var rawQuoteDeals = await searchDeals([
      { propertyName: 'createdate', operator: 'GTE', value: String(startMs) },
      { propertyName: 'createdate', operator: 'LTE', value: String(endMs) },
      { propertyName: 'pipeline', operator: 'EQ', value: 'default' },
    ]);
    var quoteDeals = filterByMarket(rawQuoteDeals);

    // --- Step 3: Collect all unique deal IDs, get deal→contact associations ---
    var allDealIds = new Set();
    bookingDeals.forEach(function(d) { allDealIds.add(d.id); });
    quoteDeals.forEach(function(d) { allDealIds.add(d.id); });

    var dealIdArray = Array.from(allDealIds);
    var dealContactMap = {}; // dealId → [contactId, ...]
    var allContactIds = new Set();

    for (var i = 0; i < dealIdArray.length; i += 100) {
      var batch = dealIdArray.slice(i, i + 100);
      var assocResp = await fetch('https://api.hubapi.com/crm/v4/associations/deal/contact/batch/read', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: batch.map(function(id) { return { id: String(id) }; })
        }),
      });

      if (assocResp.ok) {
        var assocData = await assocResp.json();
        (assocData.results || []).forEach(function(result) {
          var dealId = String(result.from.id);
          if (!dealContactMap[dealId]) dealContactMap[dealId] = [];
          (result.to || []).forEach(function(to) {
            var contactId = String(to.toObjectId);
            dealContactMap[dealId].push(contactId);
            allContactIds.add(contactId);
          });
        });
      }
    }

    // --- Step 4: Batch read contacts → filter to agent roles ---
    var agentContactIds = new Set();
    var agentContactEmails = {}; // contactId → email
    var contactIdArray = Array.from(allContactIds);

    for (var i = 0; i < contactIdArray.length; i += 100) {
      var batch = contactIdArray.slice(i, i + 100);
      var contactResp = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/batch/read', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          properties: ['email', 'jobtitle', 'role'],
          inputs: batch.map(function(id) { return { id: id }; })
        }),
      });

      if (contactResp.ok) {
        var contactData = await contactResp.json();
        (contactData.results || []).forEach(function(contact) {
          var props = contact.properties || {};
          var role = ((props.jobtitle || '') + ' ' + (props.role || '')).toLowerCase();
          var isAgent = agentKeywords.some(function(keyword) {
            return role.indexOf(keyword) !== -1;
          });
          if (isAgent) {
            agentContactIds.add(String(contact.id));
            agentContactEmails[String(contact.id)] = (props.email || '').toLowerCase();
          }
        });
      }
    }

    // --- Step 5: Active Users = agents with at least 1 booking deal ---
    var activeAgentIds = new Set();

    bookingDeals.forEach(function(deal) {
      var contacts = dealContactMap[deal.id] || [];
      contacts.forEach(function(contactId) {
        if (agentContactIds.has(contactId)) {
          activeAgentIds.add(contactId);
        }
      });
    });

    var activeUsers = activeAgentIds.size;

    // Build set of active agent emails (for Stripe matching)
    var activeAgentEmails = new Set();
    activeAgentIds.forEach(function(contactId) {
      var email = agentContactEmails[contactId];
      if (email) activeAgentEmails.add(email);
    });

    // --- Step 6: Count bookings for active agents ---
    var agentBookings = 0;
    var agentBookingRevenue = 0;

    bookingDeals.forEach(function(deal) {
      var contacts = dealContactMap[deal.id] || [];
      var hasActiveAgent = contacts.some(function(c) { return activeAgentIds.has(c); });
      if (hasActiveAgent) {
        agentBookings++;
        var amt = parseFloat(deal.properties.amount || 0);
        if (!isNaN(amt)) agentBookingRevenue += amt;
      }
    });

    // --- Step 7: Count quotes for active agents (all deals created in period) ---
    var agentQuotes = 0;

    quoteDeals.forEach(function(deal) {
      var contacts = dealContactMap[deal.id] || [];
      var hasActiveAgent = contacts.some(function(c) { return activeAgentIds.has(c); });
      if (hasActiveAgent) agentQuotes++;
    });

    // --- Step 8: Stripe revenue for active agent emails ---
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

      var stripeResp = await fetch('https://api.stripe.com/v1/charges?' + stripeParams, {
        headers: { 'Authorization': 'Bearer ' + STRIPE_KEY },
      });

      if (!stripeResp.ok) break;

      var stripeData = await stripeResp.json();
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

    // --- Step 9: Compute per-user metrics ---
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
