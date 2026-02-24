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

    // Filter by market if specified
    let filtered = allCharges;
    if (market && market !== 'all') {
      filtered = allCharges.filter(function(charge) {
        const meta = charge.metadata || {};
        const chargeMarket = (meta.market || meta.Market || meta.region || meta.Region || '').toLowerCase();
        return chargeMarket.indexOf(market.toLowerCase()) !== -1;
      });
    }

    // Calculate KPIs (subtract refunds to match Stripe dashboard net revenue)
    const totalRevenue = filtered.reduce(function(sum, c) { return sum + (c.amount - (c.amount_refunded || 0)); }, 0) / 100;
    const bookings = filtered.length;
    const aov = bookings > 0 ? totalRevenue / bookings : 0;

    // Get unique customers for ARPU and bookings per account
    const customerSet = new Set();
    filtered.forEach(function(c) {
      if (c.customer) customerSet.add(c.customer);
    });
    const uniqueAccounts = customerSet.size || 1;
    const arpu = totalRevenue / uniqueAccounts;
    const bookingsPerAccount = bookings / uniqueAccounts;

    return res.status(200).json({
      revenue: totalRevenue,
      bookings: bookings,
      aov: aov,
      arpu: arpu,
      bookings_per_account: bookingsPerAccount,
      unique_accounts: uniqueAccounts,
      period: { start: startDate, end: endDate },
      market: market || 'all',
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
