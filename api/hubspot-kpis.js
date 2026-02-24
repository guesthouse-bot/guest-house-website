module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'HubSpot access token not configured' });

  const { market, period, dateFrom, dateTo } = req.query;

  // Calculate date range (milliseconds for HubSpot)
  const now = new Date();
  let startDate, endDate;
  endDate = now.getTime();

  switch (period) {
    case 'mtd':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      break;
    case 'last30':
      startDate = now.getTime() - 30 * 24 * 60 * 60 * 1000;
      break;
    case 'qtd':
      var qMonth = Math.floor(now.getMonth() / 3) * 3;
      startDate = new Date(now.getFullYear(), qMonth, 1).getTime();
      break;
    case 'ytd':
      startDate = new Date(now.getFullYear(), 0, 1).getTime();
      break;
    case 'last_month':
      startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
      endDate = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      break;
    case 'last_quarter':
      var cqMonth = Math.floor(now.getMonth() / 3) * 3;
      startDate = new Date(now.getFullYear(), cqMonth - 3, 1).getTime();
      endDate = new Date(now.getFullYear(), cqMonth, 1).getTime();
      break;
    case 'custom':
      if (dateFrom) startDate = new Date(dateFrom).getTime();
      if (dateTo) endDate = new Date(dateTo + 'T23:59:59').getTime();
      break;
    default:
      startDate = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  }

  // Map markets to HubSpot market values and state codes
  const marketToValues = {
    colorado: { states: ['CO'], markets: ['denver', 'boulder', 'colorado'] },
    california: { states: ['CA'], markets: ['san diego', 'orange county', 'los angeles', 'california', 'la', 'oc'] },
  };

  try {
    // Search for deals in Sales Pipeline created in date range
    let allDeals = [];
    let after = 0;
    let hasMore = true;

    while (hasMore) {
      const body = {
        filterGroups: [{
          filters: [
            { propertyName: 'createdate', operator: 'GTE', value: String(startDate) },
            { propertyName: 'createdate', operator: 'LTE', value: String(endDate) },
            { propertyName: 'pipeline', operator: 'EQ', value: 'default' },
          ]
        }],
        properties: ['dealname', 'dealstage', 'createdate', 'amount', 'market'],
        limit: 100,
        after: after,
      };

      const response = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.json();
        return res.status(response.status).json({ error: err.message || 'HubSpot API error' });
      }

      const data = await response.json();
      allDeals = allDeals.concat(data.results);
      if (data.paging && data.paging.next && data.paging.next.after) {
        after = data.paging.next.after;
      } else {
        hasMore = false;
      }
    }

    // Filter by market
    let filtered = allDeals;
    if (market && market !== 'all' && market !== 'nationwide') {
      const mapping = marketToValues[market.toLowerCase()];
      if (mapping) {
        filtered = allDeals.filter(function(deal) {
          var props = deal.properties || {};
          // Check market property
          var dealMarket = (props.market || '').toLowerCase();
          if (mapping.markets.some(function(m) { return dealMarket.indexOf(m) !== -1; })) return true;
          // Fallback: parse state from deal name (e.g. "123 Main St, Denver, CO")
          var name = props.dealname || '';
          var stateMatch = name.match(/,\s*([A-Z]{2})\s*(\(|$)/);
          if (stateMatch && mapping.states.indexOf(stateMatch[1]) !== -1) return true;
          return false;
        });
      }
    }

    // Count quotes requested = all deals in the Sales Pipeline (they all start at Quote Requested)
    var quotesRequested = filtered.length;

    return res.status(200).json({
      quotes_requested: quotesRequested,
      period: { start: startDate, end: endDate },
      market: market || 'all',
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
