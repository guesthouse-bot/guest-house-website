module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const PUBLIC_KEY = process.env.AFFIRM_PUBLIC_KEY;
  const PRIVATE_KEY = process.env.AFFIRM_PRIVATE_KEY;
  if (!PUBLIC_KEY || !PRIVATE_KEY) return res.status(500).json({ error: 'Affirm API keys not configured' });

  const { market, period, dateFrom, dateTo } = req.query;

  const now = new Date();
  let startDate, endDate;
  endDate = now;

  switch (period) {
    case 'mtd':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'last30':
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case 'qtd':
      startDate = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
      break;
    case 'ytd':
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
    case 'last_month':
      startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      endDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'last_quarter': {
      const cqMonth = Math.floor(now.getMonth() / 3) * 3;
      startDate = new Date(now.getFullYear(), cqMonth - 3, 1);
      endDate = new Date(now.getFullYear(), cqMonth, 1);
      break;
    }
    case 'custom':
      if (dateFrom) startDate = new Date(dateFrom);
      if (dateTo) endDate = new Date(dateTo + 'T23:59:59');
      break;
    default:
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  const auth = Buffer.from(`${PUBLIC_KEY}:${PRIVATE_KEY}`).toString('base64');

  try {
    // Fetch all captured charges in the date range (paginated)
    let allCharges = [];
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        created_after: startDate.toISOString(),
        created_before: endDate.toISOString(),
        limit: '100',
      });
      if (cursor) params.set('cursor', cursor);

      const response = await fetch(`https://api.affirm.com/api/v2/charges?${params}`, {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return res.status(response.status).json({ error: err.message || 'Affirm API error' });
      }

      const data = await response.json();
      const items = data.data || data.items || [];
      allCharges = allCharges.concat(items);

      // Affirm pagination: next cursor or next_page_token
      const nextCursor = data.next_page_token || data.cursor || (data.paging && data.paging.cursor);
      hasMore = !!(nextCursor && items.length > 0);
      cursor = nextCursor || null;
    }

    // Only count captured (completed) charges
    const captured = allCharges.filter(function(c) {
      return c.status === 'captured' || c.status === 'charge.succeeded';
    });

    // Market filtering
    const marketToStates = { colorado: ['CO'], california: ['CA'] };

    // Same known-address table as stripe-kpis for consistency
    var addressToState = {
      '1885 diamond st': 'CA',
      '4224 tonopah ave': 'CA',
      '5851 box canyon': 'CA',
      '864 iris ave': 'CO',
      '358 arapahoe ave': 'CO',
      '4861 iran st': 'CO',
      '1772 garrison way': 'CA',
      '3530 fenton st': 'CO',
      '10151 w 38th': 'CO',
      '20682 falcon wing': 'CO',
      '2198 s sherman': 'CO',
      '1501 front st': 'CA',
      '1028 daisy ave': 'CA',
      '1913 alga rd': 'CA',
    };

    function extractState(text) {
      if (!text) return '';
      var stateMatch = text.match(/,\s*([A-Z]{2})\s*(?:\d{5}|,|$|\s)/);
      if (stateMatch) return stateMatch[1];
      var lower = text.toLowerCase();
      var keys = Object.keys(addressToState);
      for (var i = 0; i < keys.length; i++) {
        if (lower.indexOf(keys[i]) !== -1) return addressToState[keys[i]];
      }
      return '';
    }

    // Collect all text fields from an Affirm charge that might encode the property state:
    // metadata values, order_id, merchant_external_reference, item names/skus, address fields
    function getAffirmTexts(charge) {
      var texts = [];
      // Metadata values (merchant-defined — most likely to have property address)
      var meta = charge.metadata || {};
      Object.values(meta).forEach(function(v) { if (typeof v === 'string') texts.push(v); });
      // Order references
      if (charge.order_id) texts.push(charge.order_id);
      if (charge.merchant_external_reference) texts.push(charge.merchant_external_reference);
      // Line items
      var items = charge.items || [];
      items.forEach(function(item) {
        if (item.display_name) texts.push(item.display_name);
        if (item.sku) texts.push(item.sku);
      });
      return texts;
    }

    function getAffirmState(charge) {
      // 1. Parse state code from text fields (property address is most authoritative)
      var texts = getAffirmTexts(charge);
      for (var i = 0; i < texts.length; i++) {
        var parsed = extractState(texts[i]);
        if (parsed) return parsed;
      }
      // 2. Explicit state/market in metadata
      var meta = charge.metadata || {};
      var metaState = (meta.state || meta.State || meta.market || meta.Market || meta.region || '').toUpperCase();
      if (metaState) return metaState;
      // 3. Shipping address (property location if merchant sets it correctly)
      var shipping = charge.shipping_address || {};
      var shipState = (shipping.state || shipping.region || '').toUpperCase();
      if (shipState) return shipState;
      // 4. Billing address as last resort
      var billing = charge.billing_address || {};
      var billState = (billing.state || billing.region || '').toUpperCase();
      return billState;
    }

    let filtered = captured;
    if (market === 'nationwide') {
      filtered = captured.filter(function(c) {
        var s = getAffirmState(c);
        return !s || (s !== 'CO' && s !== 'CA');
      });
    } else if (market && market !== 'all') {
      var stateCodes = marketToStates[market.toLowerCase()] || [];
      filtered = captured.filter(function(c) {
        var s = getAffirmState(c);
        return s && stateCodes.indexOf(s) !== -1;
      });
    }

    // Affirm amounts are in cents
    const totalRevenue = filtered.reduce(function(sum, c) {
      return sum + ((c.amount || c.amount_cents || 0) / 100);
    }, 0);

    // Renewal detection via order_id / merchant_external_reference / metadata
    var renewalRevenue = 0;
    var renewalCount = 0;
    filtered.forEach(function(c) {
      var ref = [
        c.order_id || '',
        c.merchant_external_reference || '',
        (c.metadata && c.metadata.type) || '',
        (c.metadata && c.metadata.order_type) || '',
      ].join(' ').toLowerCase();
      if (ref.indexOf('renewal') !== -1) {
        renewalRevenue += (c.amount || c.amount_cents || 0) / 100;
        renewalCount++;
      }
    });
    const bookingsRevenue = totalRevenue - renewalRevenue;

    return res.status(200).json({
      revenue: totalRevenue,
      bookings_revenue: bookingsRevenue,
      renewal_revenue: renewalRevenue,
      renewal_count: renewalCount,
      charge_count: filtered.length,
      period: { start: startDate.toISOString(), end: endDate.toISOString() },
      market: market || 'all',
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
