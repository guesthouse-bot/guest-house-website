module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var TOKEN = process.env.TYPEFORM_TOKEN;
  var FORM_ID = process.env.TYPEFORM_FORM_ID;
  if (!TOKEN || !FORM_ID) return res.status(500).json({ error: 'Typeform credentials not configured' });

  var period = req.query.period;
  var dateFrom = req.query.dateFrom;
  var dateTo = req.query.dateTo;

  // Calculate date range (ISO 8601 strings for Typeform API)
  var now = new Date();
  var startDate, endDate;
  endDate = now.toISOString();

  switch (period) {
    case 'mtd':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      break;
    case 'last30':
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      break;
    case 'qtd':
      var qMonth = Math.floor(now.getMonth() / 3) * 3;
      startDate = new Date(now.getFullYear(), qMonth, 1).toISOString();
      break;
    case 'ytd':
      startDate = new Date(now.getFullYear(), 0, 1).toISOString();
      break;
    case 'last_month':
      startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
      endDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      break;
    case 'last_quarter':
      var cqMonth = Math.floor(now.getMonth() / 3) * 3;
      startDate = new Date(now.getFullYear(), cqMonth - 3, 1).toISOString();
      endDate = new Date(now.getFullYear(), cqMonth, 1).toISOString();
      break;
    case 'custom':
      if (dateFrom) startDate = new Date(dateFrom).toISOString();
      if (dateTo) endDate = new Date(dateTo + 'T23:59:59').toISOString();
      break;
    default:
      startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  }

  try {
    // Fetch all responses (paginated, up to 1000 per page)
    var allResponses = [];
    var pageToken = null;
    var hasMore = true;

    while (hasMore) {
      var params = new URLSearchParams({
        since: startDate,
        until: endDate,
        page_size: '1000',
      });
      if (pageToken) params.append('before', pageToken);

      var url = 'https://api.typeform.com/forms/' + FORM_ID + '/responses?' + params.toString();
      var response = await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + TOKEN },
      });

      if (!response.ok) {
        var err = await response.json();
        return res.status(response.status).json({ error: err.description || 'Typeform API error' });
      }

      var data = await response.json();
      allResponses = allResponses.concat(data.items || []);

      // Typeform pagination: if we got fewer than page_size, we're done
      if (!data.items || data.items.length < 1000) {
        hasMore = false;
      } else {
        // Use the last item's token for pagination
        var lastItem = data.items[data.items.length - 1];
        pageToken = lastItem.token;
      }
    }

    // Extract NPS scores from responses
    // Typeform NPS questions use type "opinion_scale" or "number" with 0-10 range
    var scores = [];
    allResponses.forEach(function(item) {
      var answers = item.answers || [];
      for (var i = 0; i < answers.length; i++) {
        var answer = answers[i];
        // NPS is typically an opinion_scale or number type with 0-10 range
        if (answer.type === 'number' && typeof answer.number === 'number') {
          if (answer.number >= 0 && answer.number <= 10) {
            scores.push({
              score: answer.number,
              submitted_at: item.submitted_at || item.landed_at,
            });
            break; // Take first NPS-like answer per response
          }
        }
        if (answer.type === 'opinion_scale' && typeof answer.number === 'number') {
          scores.push({
            score: answer.number,
            submitted_at: item.submitted_at || item.landed_at,
          });
          break;
        }
      }
    });

    // Classify and compute NPS
    function computeNPS(scoresList) {
      if (scoresList.length === 0) return { nps_score: null, promoters: 0, passives: 0, detractors: 0, total: 0 };
      var promoters = 0, passives = 0, detractors = 0;
      scoresList.forEach(function(s) {
        if (s.score >= 9) promoters++;
        else if (s.score >= 7) passives++;
        else detractors++;
      });
      var total = scoresList.length;
      var nps = Math.round((promoters / total - detractors / total) * 100);
      return { nps_score: nps, promoters: promoters, passives: passives, detractors: detractors, total: total };
    }

    var overall = computeNPS(scores);

    var result = {
      nps_score: overall.nps_score,
      promoters: overall.promoters,
      passives: overall.passives,
      detractors: overall.detractors,
      total_responses: overall.total,
      period: { start: startDate, end: endDate },
      market: req.query.market || 'all',
    };

    // Daily bucketing
    if (req.query.daily === 'true') {
      var dailyBuckets = {};
      scores.forEach(function(s) {
        var day = s.submitted_at ? s.submitted_at.slice(0, 10) : null;
        if (!day) return;
        if (!dailyBuckets[day]) dailyBuckets[day] = [];
        dailyBuckets[day].push(s);
      });

      var daily = {};
      Object.keys(dailyBuckets).forEach(function(day) {
        var dayNPS = computeNPS(dailyBuckets[day]);
        daily[day] = {
          nps_score: dayNPS.nps_score,
          count: dayNPS.total,
          promoters: dayNPS.promoters,
          passives: dayNPS.passives,
          detractors: dayNPS.detractors,
        };
      });
      result.daily = daily;
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
