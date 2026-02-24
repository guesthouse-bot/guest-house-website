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
    // Fetch all charges in the date range (paginated), expanding invoice data inline
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
      // Try to expand invoice so we can check line items for renewal labels
      params.append('expand[]', 'data.invoice.lines');
      if (startingAfter) params.append('starting_after', startingAfter);

      const response = await fetch(`https://api.stripe.com/v1/charges?${params}`, {
        headers: {
          'Authorization': `Bearer ${STRIPE_KEY}`,
        },
      });

      if (!response.ok) {
        // If expand fails due to permissions, retry without expand
        if (response.status === 403 || response.status === 400) {
          const retryParams = new URLSearchParams({
            'created[gte]': startDate,
            'created[lte]': endDate,
            'limit': '100',
            'status': 'succeeded',
          });
          if (startingAfter) retryParams.append('starting_after', startingAfter);

          const retryResponse = await fetch(`https://api.stripe.com/v1/charges?${retryParams}`, {
            headers: { 'Authorization': `Bearer ${STRIPE_KEY}` },
          });

          if (!retryResponse.ok) {
            const err = await retryResponse.json();
            return res.status(retryResponse.status).json({ error: err.error?.message || 'Stripe API error' });
          }

          const retryData = await retryResponse.json();
          allCharges = allCharges.concat(retryData.data);
          hasMore = retryData.has_more;
          if (hasMore && retryData.data.length > 0) {
            startingAfter = retryData.data[retryData.data.length - 1].id;
          }
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

    // Filter by market if specified (checks billing/shipping address state)
    let filtered = allCharges;
    if (market && market !== 'all' && market !== 'nationwide') {
      const stateCodes = marketToStates[market.toLowerCase()] || [];
      filtered = allCharges.filter(function(charge) {
        const billingState = (charge.billing_details && charge.billing_details.address && charge.billing_details.address.state || '').toUpperCase();
        const shippingState = (charge.shipping && charge.shipping.address && charge.shipping.address.state || '').toUpperCase();
        const meta = charge.metadata || {};
        const metaState = (meta.state || meta.State || meta.market || meta.Market || meta.region || meta.Region || '').toUpperCase();

        return stateCodes.indexOf(billingState) !== -1 ||
               stateCodes.indexOf(shippingState) !== -1 ||
               stateCodes.indexOf(metaState) !== -1;
      });
    }

    // Use amount_captured to match Stripe's Gross volume
    const totalRevenue = filtered.reduce(function(sum, c) { return sum + (c.amount_captured || 0); }, 0) / 100;

    // --- Renewal detection ---
    // Check charge description, invoice description, and invoice line items for "renewal"
    var renewalChargeIds = new Set();
    filtered.forEach(function(c) {
      // Check charge description
      if (c.description && c.description.toLowerCase().indexOf('renewal') !== -1) {
        renewalChargeIds.add(c.id);
        return;
      }
      // Check expanded invoice data (if available from expand[])
      if (c.invoice && typeof c.invoice === 'object') {
        var inv = c.invoice;
        // Check invoice description
        if (inv.description && inv.description.toLowerCase().indexOf('renewal') !== -1) {
          renewalChargeIds.add(c.id);
          return;
        }
        // Check invoice line items
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

    // Calculate renewal revenue
    var renewalRevenue = 0;
    filtered.forEach(function(c) {
      if (renewalChargeIds.has(c.id)) {
        renewalRevenue += (c.amount_captured || 0) / 100;
      }
    });
    const bookingsRevenue = totalRevenue - renewalRevenue;

    // Get unique customers for ARPU
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

    // Debug mode
    if (req.query.debug === 'descriptions') {
      var descMap = {};
      filtered.forEach(function(c) {
        var desc = c.description || '(no description)';
        var key = desc + (isRenewalCharge(c) ? ' [RENEWAL]' : '');
        if (!descMap[key]) descMap[key] = { count: 0, total: 0 };
        descMap[key].count++;
        descMap[key].total += (c.amount_captured || 0) / 100;
      });

      // Show invoice line items if expanded
      var invoiceLineItems = {};
      filtered.forEach(function(c) {
        if (c.invoice && typeof c.invoice === 'object') {
          var lines = (c.invoice.lines && c.invoice.lines.data) || [];
          invoiceLineItems[c.description || c.id] = {
            amount: (c.amount_captured || 0) / 100,
            is_renewal: isRenewalCharge(c),
            line_items: lines.map(function(l) { return l.description || ''; }),
          };
        }
      });

      result._debug_descriptions = descMap;
      result._debug_renewal_count = renewalChargeIds.size;
      result._debug_total_charges = filtered.length;
      result._debug_invoice_line_items = invoiceLineItems;
      result._debug_invoices_expanded = Object.keys(invoiceLineItems).length > 0;
    }

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
