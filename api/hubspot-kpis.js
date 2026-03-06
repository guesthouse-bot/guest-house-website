module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'HubSpot access token not configured' });

  const { market, period, dateFrom, dateTo, metric } = req.query;

  // --- Forecast sub-handler ---
  if (metric === 'forecast') {
    const headers = { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

    async function fetchRetry(url, options, retries) {
      retries = retries || 3;
      var lastResp;
      for (var attempt = 0; attempt <= retries; attempt++) {
        lastResp = await fetch(url, options);
        if (lastResp.ok) return lastResp;
        if ((lastResp.status === 429 || lastResp.status >= 500) && attempt < retries) {
          await new Promise(function(r) { setTimeout(r, Math.pow(2, attempt) * 1000); });
          continue;
        }
        return lastResp;
      }
      return lastResp;
    }

    const TARGET_LABELS = ['Quote Finalized', 'Upside', 'Seller Approved (Commit)'];
    try {
      const stagesResp = await fetchRetry('https://api.hubapi.com/crm/v3/pipelines/deals/default/stages', { method: 'GET', headers: headers });
      if (!stagesResp.ok) { const err = await stagesResp.json(); return res.status(stagesResp.status).json({ error: err.message || 'Failed to fetch pipeline stages' }); }
      const stagesData = await stagesResp.json();
      const stages = stagesData.results || stagesData;
      const targetStageIds = []; const matchedLabels = []; const stageProbabilities = {};
      stages.forEach(function(stage) {
        var label = (stage.label || '').trim();
        TARGET_LABELS.forEach(function(target) {
          if (label.toLowerCase() === target.toLowerCase()) { targetStageIds.push(stage.id); matchedLabels.push(label); stageProbabilities[stage.id] = parseFloat((stage.metadata || {}).probability || 0); }
        });
      });
      if (targetStageIds.length === 0) return res.status(200).json({ forecast_revenue: 0, matched_stages: [], deal_count: 0 });
      const now2 = new Date();
      const monthStart = new Date(now2.getFullYear(), now2.getMonth(), 1).getTime();
      const monthEnd = new Date(now2.getFullYear(), now2.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
      const filterGroups = targetStageIds.map(function(stageId) {
        return { filters: [
          { propertyName: 'expected_close_date', operator: 'GTE', value: String(monthStart) },
          { propertyName: 'expected_close_date', operator: 'LTE', value: String(monthEnd) },
          { propertyName: 'pipeline', operator: 'EQ', value: 'default' },
          { propertyName: 'dealstage', operator: 'EQ', value: stageId },
        ]};
      });
      let fDeals = []; let fAfter = 0; let fMore = true;
      while (fMore) {
        const body = { filterGroups: filterGroups, properties: ['dealname', 'dealstage', 'expected_close_date', 'amount'], limit: 100, after: fAfter };
        const response = await fetchRetry('https://api.hubapi.com/crm/v3/objects/deals/search', { method: 'POST', headers: headers, body: JSON.stringify(body) });
        if (!response.ok) { const err = await response.json(); return res.status(response.status).json({ error: err.message || 'HubSpot deal search error' }); }
        const data = await response.json();
        fDeals = fDeals.concat(data.results || []);
        if (data.paging && data.paging.next && data.paging.next.after) { fAfter = data.paging.next.after; } else { fMore = false; }
      }
      var totalForecast = 0;
      fDeals.forEach(function(deal) { var props = deal.properties || {}; var amt = parseFloat(props.amount || 0); var prob = stageProbabilities[props.dealstage] || 0; if (!isNaN(amt)) totalForecast += amt * prob; });
      var fResult = { forecast_revenue: totalForecast, matched_stages: matchedLabels, deal_count: fDeals.length };
      if (req.query.debug === 'true') {
        fResult.debug = { target_stage_ids: targetStageIds, all_pipeline_stages: stages.map(function(s) { return { id: s.id, label: s.label }; }), month_range: { start: new Date(monthStart).toISOString(), end: new Date(monthEnd).toISOString() }, sample_deals: fDeals.slice(0, 5).map(function(d) { return { id: d.id, name: d.properties.dealname, stage: d.properties.dealstage, amount: d.properties.amount }; }) };
      }
      return res.status(200).json(fResult);
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

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
    arizona: { states: ['AZ'], markets: ['phoenix', 'scottsdale', 'arizona', 'az'] },
  };

  // Helper: check if a deal belongs to a known market (CO, CA, AZ)
  function isDealInKnownMarket(deal) {
    var props = deal.properties || {};
    var dealMarket = (props.market || '').toLowerCase();
    var allMarketKeywords = ['denver', 'boulder', 'colorado', 'san diego', 'orange county', 'los angeles', 'california', 'la', 'oc', 'phoenix', 'scottsdale', 'arizona', 'az'];
    if (allMarketKeywords.some(function(m) { return dealMarket.indexOf(m) !== -1; })) return true;
    var name = props.dealname || '';
    var stateMatch = name.match(/,\s*([A-Z]{2})\s*(\(|$)/);
    if (stateMatch && ['CO', 'CA', 'AZ'].indexOf(stateMatch[1]) !== -1) return true;
    return false;
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

      const response = await fetchWithRetry('https://api.hubapi.com/crm/v3/objects/deals/search', {
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
    // "all" = everything, "nationwide" = only states outside CO, CA, AZ
    let filtered = allDeals;
    if (market === 'nationwide') {
      filtered = allDeals.filter(function(deal) { return !isDealInKnownMarket(deal); });
    } else if (market && market !== 'all') {
      const mapping = marketToValues[market.toLowerCase()];
      if (mapping) {
        filtered = allDeals.filter(function(deal) {
          var props = deal.properties || {};
          var dealMarket = (props.market || '').toLowerCase();
          if (mapping.markets.some(function(m) { return dealMarket.indexOf(m) !== -1; })) return true;
          var name = props.dealname || '';
          var stateMatch = name.match(/,\s*([A-Z]{2})\s*(\(|$)/);
          if (stateMatch && mapping.states.indexOf(stateMatch[1]) !== -1) return true;
          return false;
        });
      }
    }

    // Count quotes requested = all deals in the Sales Pipeline (they all start at Quote Requested)
    var quotesRequested = filtered.length;

    // Fetch booked deals in date range (closedwon + legacy stage 13174420)
    let closedWonDeals = [];
    let cwAfter = 0;
    let cwHasMore = true;

    while (cwHasMore) {
      var dateAndPipelineFilters = [
        { propertyName: 'closedate', operator: 'GTE', value: String(startDate) },
        { propertyName: 'closedate', operator: 'LTE', value: String(endDate) },
        { propertyName: 'pipeline', operator: 'EQ', value: 'default' },
      ];
      const cwBody = {
        filterGroups: [
          { filters: dateAndPipelineFilters.concat([{ propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' }]) },
          { filters: dateAndPipelineFilters.concat([{ propertyName: 'dealstage', operator: 'EQ', value: '13174420' }]) },
        ],
        properties: ['dealname', 'createdate', 'closedate', 'market', 'amount'],
        limit: 100,
        after: cwAfter,
      };

      const cwResponse = await fetchWithRetry('https://api.hubapi.com/crm/v3/objects/deals/search', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(cwBody),
      });

      if (cwResponse.ok) {
        const cwData = await cwResponse.json();
        closedWonDeals = closedWonDeals.concat(cwData.results);
        if (cwData.paging && cwData.paging.next && cwData.paging.next.after) {
          cwAfter = cwData.paging.next.after;
        } else {
          cwHasMore = false;
        }
      } else {
        cwHasMore = false;
      }
    }

    // Filter closed won deals by market
    let filteredCW = closedWonDeals;
    if (market === 'nationwide') {
      filteredCW = closedWonDeals.filter(function(deal) { return !isDealInKnownMarket(deal); });
    } else if (market && market !== 'all') {
      const mapping = marketToValues[market.toLowerCase()];
      if (mapping) {
        filteredCW = closedWonDeals.filter(function(deal) {
          var props = deal.properties || {};
          var dealMarket = (props.market || '').toLowerCase();
          if (mapping.markets.some(function(m) { return dealMarket.indexOf(m) !== -1; })) return true;
          var name = props.dealname || '';
          var stateMatch = name.match(/,\s*([A-Z]{2})\s*(\(|$)/);
          if (stateMatch && mapping.states.indexOf(stateMatch[1]) !== -1) return true;
          return false;
        });
      }
    }

    // Calculate average sales cycle (days between createdate and closedate)
    var totalDays = 0;
    var cycleCount = 0;
    filteredCW.forEach(function(deal) {
      var props = deal.properties || {};
      if (props.createdate && props.closedate) {
        var created = new Date(props.createdate).getTime();
        var closed = new Date(props.closedate).getTime();
        var days = (closed - created) / (1000 * 60 * 60 * 24);
        if (days >= 0) {
          totalDays += days;
          cycleCount++;
        }
      }
    });
    var avgSalesCycle = cycleCount > 0 ? totalDays / cycleCount : null;

    // Bookings = Closed Won deals count and revenue
    var bookings = filteredCW.length;
    var bookingRevenue = 0;
    filteredCW.forEach(function(deal) {
      var amt = parseFloat(deal.properties.amount || 0);
      if (!isNaN(amt)) bookingRevenue += amt;
    });
    var aovAtClose = bookings > 0 ? bookingRevenue / bookings : 0;

    // Daily bucketing
    var daily = {};
    if (req.query.daily === 'true') {
      filtered.forEach(function(deal) {
        var props = deal.properties || {};
        if (props.createdate) {
          var day = new Date(props.createdate).toISOString().slice(0, 10);
          if (!daily[day]) daily[day] = { quotes: 0, bookings: 0, booking_revenue: 0, sales_cycle_total: 0, sales_cycle_count: 0 };
          daily[day].quotes++;
        }
      });
      filteredCW.forEach(function(deal) {
        var props = deal.properties || {};
        if (props.closedate) {
          var day = new Date(props.closedate).toISOString().slice(0, 10);
          if (!daily[day]) daily[day] = { quotes: 0, bookings: 0, booking_revenue: 0, sales_cycle_total: 0, sales_cycle_count: 0 };
          daily[day].bookings++;
          var amt = parseFloat(props.amount || 0);
          if (!isNaN(amt)) daily[day].booking_revenue += amt;
          // Sales cycle per closed deal
          if (props.createdate) {
            var created = new Date(props.createdate).getTime();
            var closed = new Date(props.closedate).getTime();
            var days = (closed - created) / (1000 * 60 * 60 * 24);
            if (days >= 0) {
              daily[day].sales_cycle_total += days;
              daily[day].sales_cycle_count++;
            }
          }
        }
      });
    }

    var result = {
      quotes_requested: quotesRequested,
      bookings: bookings,
      booking_revenue: bookingRevenue,
      aov_at_close: aovAtClose,
      sales_cycle_days: avgSalesCycle,
      period: { start: startDate, end: endDate },
      market: market || 'all',
    };
    if (req.query.daily === 'true') result.daily = daily;
    if (req.query.debug === 'true') {
      // Show deal stage distribution and sample deals
      var stageCounts = {};
      allDeals.forEach(function(d) {
        var stage = d.properties.dealstage || 'unknown';
        stageCounts[stage] = (stageCounts[stage] || 0) + 1;
      });
      var dealsByStage = {};
      allDeals.forEach(function(d) {
        var s = d.properties.dealstage || 'unknown';
        if (!dealsByStage[s]) dealsByStage[s] = [];
        if (dealsByStage[s].length < 3) dealsByStage[s].push({
          id: d.id, name: d.properties.dealname,
          createdate: d.properties.createdate, closedate: d.properties.closedate,
          amount: d.properties.amount, market: d.properties.market,
        });
      });
      result.debug = {
        total_deals_in_pipeline: allDeals.length,
        deal_stages: stageCounts,
        deals_by_stage: dealsByStage,
        closed_won_count: filteredCW.length,
      };
    }
    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
