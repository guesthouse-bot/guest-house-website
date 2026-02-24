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
    let allCharges = [];
    let hasMore = true;
    let startingAfter = null;

    while (hasMore) {
      const params = new URLSearchParams({
        'created[gte]': startDate,
        'created[lte]': endDate,
        'limit': '100',
        'status': 'succeeded',
      });
      if (startingAfter) params.append('starting_after', startingAfter);

      const response = await fetch(`https://api.stripe.com/v1/charges?${params}`, {
        headers: {
          'Authorization': `Bearer ${STRIPE_KEY}`,
        },
      });

      if (!response.ok) {
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

    // Filter by market if specified (checks billing/shipping address state)
    // "nationwide" and "all" return all charges unfiltered
    let filtered = allCharges;
    if (market && market !== 'all' && market !== 'nationwide') {
      const stateCodes = marketToStates[market.toLowerCase()] || [];
      filtered = allCharges.filter(function(charge) {
        // Check billing address state
        const billingState = (charge.billing_details && charge.billing_details.address && charge.billing_details.address.state || '').toUpperCase();
        // Check shipping address state
        const shippingState = (charge.shipping && charge.shipping.address && charge.shipping.address.state || '').toUpperCase();
        // Check metadata as fallback
        const meta = charge.metadata || {};
        const metaState = (meta.state || meta.State || meta.market || meta.Market || meta.region || meta.Region || '').toUpperCase();

        return stateCodes.indexOf(billingState) !== -1 ||
               stateCodes.indexOf(shippingState) !== -1 ||
               stateCodes.indexOf(metaState) !== -1;
      });
    }

    // Use amount_captured to match Stripe's Gross volume (excludes uncaptured authorizations)
    const totalRevenue = filtered.reduce(function(sum, c) { return sum + (c.amount_captured || 0); }, 0) / 100;

    // --- Renewal detection ---
    // Step 1: Check charge description for "renewal" (case-insensitive)
    var renewalChargeIds = new Set();
    filtered.forEach(function(c) {
      if (c.description && c.description.toLowerCase().indexOf('renewal') !== -1) {
        renewalChargeIds.add(c.id);
      }
    });

    // Step 2: For charges linked to invoices that aren't already flagged as renewal,
    // fetch the invoice line items and check for "renewal" in line item descriptions
    var invoiceCharges = filtered.filter(function(c) {
      return c.invoice && !renewalChargeIds.has(c.id);
    });

    // Fetch invoices in batches (Stripe allows fetching one at a time)
    for (var i = 0; i < invoiceCharges.length; i++) {
      var invoiceId = invoiceCharges[i].invoice;
      try {
        var invResp = await fetch('https://api.stripe.com/v1/invoices/' + invoiceId, {
          headers: { 'Authorization': 'Bearer ' + STRIPE_KEY },
        });
        if (invResp.ok) {
          var inv = await invResp.json();
          // Check invoice-level description
          var invDesc = ((inv.description || '') + ' ' + (inv.memo || '')).toLowerCase();
          if (invDesc.indexOf('renewal') !== -1) {
            renewalChargeIds.add(invoiceCharges[i].id);
            continue;
          }
          // Check each line item description
          var lines = (inv.lines && inv.lines.data) || [];
          for (var j = 0; j < lines.length; j++) {
            var lineDesc = (lines[j].description || '').toLowerCase();
            if (lineDesc.indexOf('renewal') !== -1) {
              renewalChargeIds.add(invoiceCharges[i].id);
              break;
            }
          }
        }
      } catch (e) {
        // Skip invoice lookup failures silently
      }
    }

    // Calculate renewal revenue from all identified renewal charges
    var renewalRevenue = 0;
    filtered.forEach(function(c) {
      if (renewalChargeIds.has(c.id)) {
        renewalRevenue += (c.amount_captured || 0) / 100;
      }
    });
    const bookingsRevenue = totalRevenue - renewalRevenue;

    // Get unique customers for ARPU and bookings per account
    const customerSet = new Set();
    filtered.forEach(function(c) {
      if (c.customer) customerSet.add(c.customer);
    });
    const uniqueAccounts = customerSet.size || 1;
    const arpu = totalRevenue / uniqueAccounts;

    // Helper: check if a charge is renewal
    function isRenewalCharge(c) {
      return renewalChargeIds.has(c.id);
    }

    // Daily bucketing
    var daily = {};
    if (req.query.daily === 'true') {
      filtered.forEach(function(c) {
        var day = new Date(c.created * 1000).toISOString().slice(0, 10);
        if (!daily[day]) daily[day] = { revenue: 0, bookings_revenue: 0, renewal_revenue: 0 };
        var amt = (c.amount_captured || 0) / 100;
        daily[day].revenue += amt;
        if (isRenewalCharge(c)) {
          daily[day].renewal_revenue += amt;
        } else {
          daily[day].bookings_revenue += amt;
        }
      });
    }

    var result = {
      revenue: totalRevenue,
      bookings_revenue: bookingsRevenue,
      renewal_revenue: renewalRevenue,
      arpu: arpu,
      unique_accounts: uniqueAccounts,
      period: { start: startDate, end: endDate },
      market: market || 'all',
    };
    if (req.query.daily === 'true') result.daily = daily;

    // Debug mode: show all charge descriptions grouped and renewal classification
    if (req.query.debug === 'descriptions') {
      var descMap = {};
      filtered.forEach(function(c) {
        var desc = c.description || '(no description)';
        var key = desc + (isRenewalCharge(c) ? ' [RENEWAL]' : '');
        if (!descMap[key]) descMap[key] = { count: 0, total: 0 };
        descMap[key].count++;
        descMap[key].total += (c.amount_captured || 0) / 100;
      });
      result._debug_descriptions = descMap;
      result._debug_renewal_count = renewalChargeIds.size;
      result._debug_total_charges = filtered.length;
    }

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
