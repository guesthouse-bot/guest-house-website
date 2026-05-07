module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'HubSpot access token not configured' });

  const headers = {
    'Authorization': 'Bearer ' + TOKEN,
    'Content-Type': 'application/json',
  };

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

  // Target stage labels to match
  const TARGET_LABELS = ['Quote Finalized', 'Upside', 'Seller Approved (Commit)'];

  try {
    // Step 1: Fetch pipeline stages to resolve internal stage IDs by label
    const stagesResp = await fetchWithRetry(
      'https://api.hubapi.com/crm/v3/pipelines/deals/default/stages',
      { method: 'GET', headers: headers }
    );
    if (!stagesResp.ok) {
      const err = await stagesResp.json();
      return res.status(stagesResp.status).json({ error: err.message || 'Failed to fetch pipeline stages' });
    }

    const stagesData = await stagesResp.json();
    const stages = stagesData.results || stagesData;

    // Match target labels (case-insensitive)
    const targetStageIds = [];
    const matchedLabels = [];
    const stageProbabilities = {};
    stages.forEach(function(stage) {
      var label = (stage.label || '').trim();
      TARGET_LABELS.forEach(function(target) {
        if (label.toLowerCase() === target.toLowerCase()) {
          targetStageIds.push(stage.id);
          matchedLabels.push(label);
          stageProbabilities[stage.id] = parseFloat((stage.metadata || {}).probability || 0);
        }
      });
    });

    if (targetStageIds.length === 0) {
      return res.status(200).json({
        forecast_revenue: 0,
        matched_stages: [],
        deal_count: 0,
      });
    }

    // Step 2: Build date range for current month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).getTime();

    // Step 3: Query deals — one filterGroup per stage (OR'd together)
    // Each filterGroup ANDs: expected_close_date in current month + pipeline + dealstage
    const filterGroups = targetStageIds.map(function(stageId) {
      return {
        filters: [
          { propertyName: 'expected_close_date', operator: 'GTE', value: String(monthStart) },
          { propertyName: 'expected_close_date', operator: 'LTE', value: String(monthEnd) },
          { propertyName: 'pipeline', operator: 'EQ', value: 'default' },
          { propertyName: 'dealstage', operator: 'EQ', value: stageId },
        ]
      };
    });

    let allDeals = [];
    let after = 0;
    let hasMore = true;

    while (hasMore) {
      const body = {
        filterGroups: filterGroups,
        properties: ['dealname', 'dealstage', 'expected_close_date', 'amount'],
        limit: 100,
        after: after,
      };

      const response = await fetchWithRetry('https://api.hubapi.com/crm/v3/objects/deals/search', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.json();
        return res.status(response.status).json({ error: err.message || 'HubSpot deal search error' });
      }

      const data = await response.json();
      allDeals = allDeals.concat(data.results || []);
      if (data.paging && data.paging.next && data.paging.next.after) {
        after = data.paging.next.after;
      } else {
        hasMore = false;
      }
    }

    // Step 4: Sum weighted amounts (amount × stage probability)
    var totalForecast = 0;
    allDeals.forEach(function(deal) {
      var props = deal.properties || {};
      var amt = parseFloat(props.amount || 0);
      var prob = stageProbabilities[props.dealstage] || 0;
      if (!isNaN(amt)) totalForecast += amt * prob;
    });

    var result = {
      forecast_revenue: totalForecast,
      matched_stages: matchedLabels,
      deal_count: allDeals.length,
    };

    if (req.query.debug === 'true') {
      result.debug = {
        target_stage_ids: targetStageIds,
        all_pipeline_stages: stages.map(function(s) { return { id: s.id, label: s.label }; }),
        month_range: { start: new Date(monthStart).toISOString(), end: new Date(monthEnd).toISOString() },
        sample_deals: allDeals.slice(0, 5).map(function(d) {
          return { id: d.id, name: d.properties.dealname, stage: d.properties.dealstage, closedate: d.properties.closedate, amount: d.properties.amount, hs_weighted_amount: d.properties.hs_weighted_amount };
        }),
      };
    }

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
