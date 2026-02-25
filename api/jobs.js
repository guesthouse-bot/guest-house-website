var fb = require('./_firebase');

module.exports = async function handler(req, res) {
  fb.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);

    if (req.method === 'GET') {
      var filters = [];
      if (req.query.status) {
        filters.push({ field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: req.query.status } });
      }
      if (req.query.market) {
        filters.push({ field: { fieldPath: 'market' }, op: 'EQUAL', value: { stringValue: req.query.market } });
      }

      var docs = await fb.runQuery('jobs', filters, accessToken);
      var jobs = docs.map(function(item) {
        var data = fb.fromFirestoreFields(item.document.fields);
        data.id = fb.docId(item.document.name);
        return data;
      });

      return res.status(200).json({ jobs: jobs });

    } else if (req.method === 'POST') {
      var body = req.body;
      if (!body.address || !body.market || !body.providerType) {
        return res.status(400).json({ error: 'Missing required fields: address, market, providerType' });
      }

      var now = new Date();
      var deadline = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      // Create the job document
      var jobDoc = await fb.createDocument('jobs', {
        address: body.address,
        sqft: body.sqft || '',
        rooms: body.rooms || '',
        timeline: body.timeline || '',
        market: body.market,
        providerType: body.providerType,
        notes: body.notes || '',
        status: 'bidding',
        created: now.toISOString(),
        biddingDeadline: deadline.toISOString(),
        awardedBidId: null,
        awardedProvider: null,
        awardedAt: null,
      }, accessToken);

      var jobId = fb.docId(jobDoc.name);

      // Query active providers in this market with matching role
      var providerFilters = [
        { field: { fieldPath: 'market' }, op: 'EQUAL', value: { stringValue: body.market } },
        { field: { fieldPath: 'role' }, op: 'EQUAL', value: { stringValue: body.providerType } },
        { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'active' } },
      ];
      var providerDocs = await fb.runQuery('providers', providerFilters, accessToken);

      var bidsCreated = 0;
      var emailsSent = 0;

      for (var i = 0; i < providerDocs.length; i++) {
        var provider = fb.fromFirestoreFields(providerDocs[i].document.fields);
        var token = fb.generateToken();

        // Create bid document for this provider
        await fb.createDocument('bids', {
          jobId: jobId,
          providerEmail: provider.email,
          providerName: provider.name,
          amount: null,
          token: token,
          status: 'pending',
          submittedAt: null,
          created: now.toISOString(),
        }, accessToken);
        bidsCreated++;

        // Send bid request email
        var bidUrl = (req.headers['x-forwarded-proto'] || 'https') + '://' +
          (req.headers['x-forwarded-host'] || req.headers.host) +
          '/provider-bid?token=' + token;

        var deadlineStr = deadline.toLocaleDateString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
        });

        await fb.sendEmail(
          provider.email,
          'New Job Available — ' + body.address,
          '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
            '<div style="margin-bottom:32px;">' +
              '<strong style="font-size:18px;color:#080808;">Guest House</strong>' +
            '</div>' +
            '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">New job available in your market</h2>' +
            '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">Hi ' + provider.name.split(' ')[0] + ', a new staging job is available for bidding.</p>' +
            '<div style="background:#f7f7f7;border-radius:12px;padding:20px 24px;margin-bottom:24px;">' +
              '<div style="margin-bottom:8px;"><strong style="color:#343434;">Address:</strong> <span style="color:#666;">' + body.address + '</span></div>' +
              (body.sqft ? '<div style="margin-bottom:8px;"><strong style="color:#343434;">Size:</strong> <span style="color:#666;">' + body.sqft + ' sq ft</span></div>' : '') +
              (body.rooms ? '<div style="margin-bottom:8px;"><strong style="color:#343434;">Rooms:</strong> <span style="color:#666;">' + body.rooms + '</span></div>' : '') +
              (body.timeline ? '<div style="margin-bottom:8px;"><strong style="color:#343434;">Timeline:</strong> <span style="color:#666;">' + body.timeline + '</span></div>' : '') +
              '<div><strong style="color:#343434;">Deadline:</strong> <span style="color:#666;">' + deadlineStr + '</span></div>' +
            '</div>' +
            '<a href="' + bidUrl + '" style="display:inline-block;background:#080808;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:500;">Submit Your Bid</a>' +
            '<p style="color:#999;font-size:13px;margin-top:24px;">This link is unique to you. Do not share it.</p>' +
          '</div>'
        );
        emailsSent++;
      }

      var job = fb.fromFirestoreFields(jobDoc.fields);
      job.id = jobId;
      return res.status(201).json({ job: job, bidsCreated: bidsCreated, emailsSent: emailsSent });

    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
