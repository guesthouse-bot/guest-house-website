module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const STRIPE_KEY = process.env.STRIPE_API_KEY;
  if (!STRIPE_KEY) return res.status(500).json({ error: 'Stripe API key not configured' });

  const { market, period, dateFrom, dateTo } = req.query;

  // Calculate date range
  const now = new Date();
  let startDate, endDate;
  endDate = Math.floor(now.getTime() / 1000);

  switch (period) {
    case 'mtd':
      startDate = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
      break;
    case 'last30':
      startDate = Math.floor(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).getTime() / 1000);
      break;
    case 'qtd':
      const qMonth = Math.floor(now.getMonth() / 3) * 3;
      startDate = Math.floor(new Date(now.getFullYear(), qMonth, 1).getTime() / 1000);
      break;
    case 'ytd':
      startDate = Math.floor(new Date(now.getFullYear(), 0, 1).getTime() / 1000);
      break;
    case 'last_month':
      startDate = Math.floor(new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime() / 1000);
      endDate = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
      break;
    case 'last_quarter':
      const cqMonth = Math.floor(now.getMonth() / 3) * 3;
      startDate = Math.floor(new Date(now.getFullYear(), cqMonth - 3, 1).getTime() / 1000);
      endDate = Math.floor(new Date(now.getFullYear(), cqMonth, 1).getTime() / 1000);
      break;
    case 'custom':
      if (dateFrom) startDate = Math.floor(new Date(dateFrom).getTime() / 1000);
      if (dateTo) endDate = Math.floor(new Date(dateTo + 'T23:59:59').getTime() / 1000);
      break;
    default:
      startDate = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
  }

  try {
    // Fetch all charges in the date range (paginated)
    // Try expanding invoice.lines to check for renewal labels in invoice line items
    let allCharges = [];
    let hasMore = true;
    let startingAfter = null;
    let useExpand = true;

    while (hasMore) {
      const params = new URLSearchParams({
        'created[gte]': startDate,
        'created[lte]': endDate,
        'limit': '100',
        'status': 'succeeded',
      });
      if (useExpand) params.append('expand[]', 'data.invoice.lines');
      if (startingAfter) params.append('starting_after', startingAfter);

      const response = await fetch(`https://api.stripe.com/v1/charges?${params}`, {
        headers: { 'Authorization': `Bearer ${STRIPE_KEY}` },
      });

      if (!response.ok) {
        // If expand fails (key lacks invoice permissions), retry without expand
        if (useExpand && (response.status === 403 || response.status === 400)) {
          useExpand = false;
          continue;
        }
        const err = await response.json();
        return res.status(response.status).json({ error: err.error?.message || 'Stripe API error' });
      }

      const data = await response.json();
      allCharges = allCharges.concat(data.data);
      hasMore = data.has_more;
      if (hasMore && data.data.length > 0) {
        startingAfter = data.data[data.data.length - 1].id;
      }
    }

    // Map market filter to state codes
    const marketToStates = {
      colorado: ['CO'],
      california: ['CA'],
    };

    // Known addresses without state in description → state code
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

    // Helper: extract state from a text string (description or invoice line item)
    function extractState(text) {
      if (!text) return '';
      // Match ", ST," or ", ST " or ", ST XXXXX" patterns (US state codes)
      var stateMatch = text.match(/,\s*([A-Z]{2})\s*(?:\d{5}|,|$|\s)/);
      if (stateMatch) return stateMatch[1];
      // Check known address lookup table
      var lower = text.toLowerCase();
      var keys = Object.keys(addressToState);
      for (var i = 0; i < keys.length; i++) {
        if (lower.indexOf(keys[i]) !== -1) return addressToState[keys[i]];
      }
      return '';
    }

    // Helper: get all text sources for a charge (description + invoice lines)
    function getChargeTexts(charge) {
      var texts = [];
      if (charge.description) texts.push(charge.description);
      if (charge.invoice && typeof charge.invoice === 'object') {
        var inv = charge.invoice;
        if (inv.description) texts.push(inv.description);
        var lines = (inv.lines && inv.lines.data) || [];
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].description) texts.push(lines[i].description);
        }
      }
      return texts;
    }

    // Helper: detect the state code for a charge
    // Priority: description/invoice text (property location) > billing > shipping > metadata
    function getChargeState(charge) {
      var texts = getChargeTexts(charge);
      for (var i = 0; i < texts.length; i++) {
        var parsed = extractState(texts[i]);
        if (parsed) return parsed;
      }
      var billingState = (charge.billing_details && charge.billing_details.address && charge.billing_details.address.state || '').toUpperCase();
      if (billingState) return billingState;
      var shippingState = (charge.shipping && charge.shipping.address && charge.shipping.address.state || '').toUpperCase();
      if (shippingState) return shippingState;
      var meta = charge.metadata || {};
      var metaState = (meta.state || meta.State || meta.market || meta.Market || meta.region || meta.Region || '').toUpperCase();
      if (metaState) return metaState;
      return '';
    }

    // Filter by market
    // "all" = everything, "nationwide" = only states outside CO and CA,
    // "colorado"/"california" = only that state
    let filtered = allCharges;
    if (market === 'nationwide') {
      var excludeStates = ['CO', 'CA'];
      filtered = allCharges.filter(function(charge) {
        var state = getChargeState(charge);
        return !state || excludeStates.indexOf(state) === -1;
      });
    } else if (market && market !== 'all') {
      var stateCodes = marketToStates[market.toLowerCase()] || [];
      filtered = allCharges.filter(function(charge) {
        var state = getChargeState(charge);
        return state && stateCodes.indexOf(state) !== -1;
      });
    }

    const totalRevenue = filtered.reduce(function(sum, c) { return sum + (c.amount_captured || 0); }, 0) / 100;

    // --- Renewal detection ---
    // Matches any charge or invoice line item containing "renewal" (case-insensitive)
    var renewalChargeIds = new Set();
    filtered.forEach(function(c) {
      // Check charge description
      if (c.description && c.description.toLowerCase().indexOf('renewal') !== -1) {
        renewalChargeIds.add(c.id);
        return;
      }
      // Check expanded invoice data (available when Stripe key has invoice read permission)
      if (c.invoice && typeof c.invoice === 'object') {
        var inv = c.invoice;
        if (inv.description && inv.description.toLowerCase().indexOf('renewal') !== -1) {
          renewalChargeIds.add(c.id);
          return;
        }
        var lines = (inv.lines && inv.lines.data) || [];
        for (var j = 0; j < lines.length; j++) {
          var lineDesc = (lines[j].description || '').toLowerCase();
          if (lineDesc.indexOf('renewal') !== -1) {
            renewalChargeIds.add(c.id);
            return;
          }
        }
      }
    });

    var renewalRevenue = 0;
    var renewalCount = 0;
    filtered.forEach(function(c) {
      if (renewalChargeIds.has(c.id)) {
        renewalRevenue += (c.amount_captured || 0) / 100;
        renewalCount++;
      }
    });
    const bookingsRevenue = totalRevenue - renewalRevenue;

    const customerSet = new Set();
    filtered.forEach(function(c) {
      if (c.customer) customerSet.add(c.customer);
    });
    const uniqueAccounts = customerSet.size || 1;
    const arpu = totalRevenue / uniqueAccounts;

    function isRenewalCharge(c) {
      return renewalChargeIds.has(c.id);
    }

    // Daily bucketing
    var daily = {};
    if (req.query.daily === 'true') {
      filtered.forEach(function(c) {
        var day = new Date(c.created * 1000).toISOString().slice(0, 10);
        if (!daily[day]) daily[day] = { revenue: 0, bookings_revenue: 0, renewal_revenue: 0, renewal_count: 0 };
        var amt = (c.amount_captured || 0) / 100;
        daily[day].revenue += amt;
        if (isRenewalCharge(c)) {
          daily[day].renewal_revenue += amt;
          daily[day].renewal_count++;
        } else {
          daily[day].bookings_revenue += amt;
        }
      });
    }

    // --- Affirm revenue ---
    var affirmRevenue = 0;
    var affirmBookingsRevenue = 0;
    var affirmRenewalRevenue = 0;

    const AFFIRM_PUBLIC_KEY = process.env.AFFIRM_PUBLIC_KEY;
    const AFFIRM_PRIVATE_KEY = process.env.AFFIRM_PRIVATE_KEY;

    if (AFFIRM_PUBLIC_KEY && AFFIRM_PRIVATE_KEY) {
      try {
        var affirmAuth = Buffer.from(AFFIRM_PUBLIC_KEY + ':' + AFFIRM_PRIVATE_KEY).toString('base64');
        var affirmStartISO = new Date(startDate * 1000).toISOString();
        var affirmEndISO = new Date(endDate * 1000).toISOString();

        var affirmCharges = [];
        var affirmCursor = null;
        var affirmHasMore = true;
        var affirmDebugInfo = null;

        while (affirmHasMore) {
          var affirmParams = new URLSearchParams({
            'created[gte]': affirmStartISO,
            'created[lte]': affirmEndISO,
            limit: '100',
          });
          if (affirmCursor) affirmParams.set('cursor', affirmCursor);

          var affirmRes = await fetch('https://api.affirm.com/api/v2/charges?' + affirmParams, {
            headers: { 'Authorization': 'Basic ' + affirmAuth },
          });

          var affirmRawBody = await affirmRes.text();
          if (affirmRes.ok) {
            var affirmData = JSON.parse(affirmRawBody);
            var affirmItems = affirmData.entries || affirmData.data || affirmData.items || [];
            affirmCharges = affirmCharges.concat(affirmItems);
            if (req.query.debug === 'true') affirmDebugInfo = { status: affirmRes.status, all_keys: Object.keys(affirmData), item_count: affirmItems.length, sample: affirmItems.slice(0, 1), pagination_keys: { next_page_token: affirmData.next_page_token, cursor: affirmData.cursor, paging: affirmData.paging } };
            var nextCursor = affirmData.next_page_token || affirmData.cursor || (affirmData.paging && affirmData.paging.cursor);
            affirmHasMore = !!(nextCursor && affirmItems.length > 0);
            affirmCursor = nextCursor || null;
          } else {
            if (req.query.debug === 'true') affirmDebugInfo = { status: affirmRes.status, error: affirmRawBody };
            affirmHasMore = false;
          }
        }

        // Include authorized and captured charges (Affirm may not settle immediately)
        var affirmCaptured = affirmCharges.filter(function(c) {
          return c.status === 'captured' || c.status === 'authorized' || c.status === 'charge.succeeded';
        });

        // State detection for Affirm: metadata values, order_id, item names, then address fields
        // Note: Affirm nests items/metadata under charge.details
        function getAffirmState(charge) {
          var details = charge.details || {};
          var meta = details.metadata || charge.metadata || {};
          var metaTexts = Object.values(meta).filter(function(v) { return typeof v === 'string'; });
          var refs = [charge.order_id || '', charge.merchant_external_reference || ''];
          // items is an object keyed by sku in Affirm, not an array
          var detailItems = details.items || charge.items || {};
          var itemTexts = Object.values(detailItems).map(function(i) { return (i.display_name || '') + ' ' + (i.sku || ''); });
          var allTexts = metaTexts.concat(refs).concat(itemTexts);
          for (var i = 0; i < allTexts.length; i++) {
            var parsed = extractState(allTexts[i]);
            if (parsed) return parsed;
          }
          var metaState = (meta.state || meta.State || meta.market || meta.Market || '').toUpperCase();
          if (metaState) return metaState;
          var ship = charge.shipping_address || {};
          var shipState = (ship.state || ship.region || '').toUpperCase();
          if (shipState) return shipState;
          var bill = charge.billing_address || {};
          return (bill.state || bill.region || '').toUpperCase();
        }

        // Apply same market filter
        var affirmFiltered = affirmCaptured;
        if (market === 'nationwide') {
          affirmFiltered = affirmCaptured.filter(function(c) {
            var s = getAffirmState(c);
            return !s || (s !== 'CO' && s !== 'CA');
          });
        } else if (market && market !== 'all') {
          var affirmStateCodes = marketToStates[market.toLowerCase()] || [];
          affirmFiltered = affirmCaptured.filter(function(c) {
            var s = getAffirmState(c);
            return s && affirmStateCodes.indexOf(s) !== -1;
          });
        }

        affirmFiltered.forEach(function(c) {
          var amt = (c.amount || c.amount_cents || 0) / 100;
          affirmRevenue += amt;
          var detailsMeta = ((c.details || {}).metadata || c.metadata || {});
          var ref = [
            c.order_id || '',
            c.merchant_external_reference || '',
            detailsMeta.type || '',
            detailsMeta.order_type || '',
          ].join(' ').toLowerCase();
          if (ref.indexOf('renewal') !== -1) {
            affirmRenewalRevenue += amt;
          } else {
            affirmBookingsRevenue += amt;
          }
        });
      } catch (affirmErr) {
        console.error('Affirm fetch error:', affirmErr.message);
        if (req.query.debug === 'true') affirmDebugInfo = Object.assign(affirmDebugInfo || {}, { caught_error: affirmErr.message, stack: affirmErr.stack });
      }
    }

    var result = {
      revenue: totalRevenue + affirmRevenue,
      bookings_revenue: bookingsRevenue + affirmBookingsRevenue,
      renewal_revenue: renewalRevenue + affirmRenewalRevenue,
      renewal_count: renewalCount,
      arpu: arpu,
      unique_accounts: uniqueAccounts,
      affirm_revenue: affirmRevenue,
      period: { start: startDate, end: endDate },
      market: market || 'all',
    };
    if (req.query.daily === 'true') result.daily = daily;
    if (req.query.debug === 'true') {
      result.affirm_debug = affirmDebugInfo;
      result.charges = filtered.map(function(c) {
        return {
          id: c.id,
          amount: (c.amount_captured || 0) / 100,
          description: c.description || '',
          state: getChargeState(c),
          is_renewal: renewalChargeIds.has(c.id),
          customer: c.customer || '',
          billing_email: (c.billing_details && c.billing_details.email || ''),
          created: new Date(c.created * 1000).toISOString().slice(0, 10),
        };
      });
    }
    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
