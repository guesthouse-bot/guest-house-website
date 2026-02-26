var fb = require('./_firebase');

// Consolidated bidding router — dispatches on ?action= parameter
module.exports = async function handler(req, res) {
  fb.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  var action = req.query.action;
  if (!action) return res.status(400).json({ error: 'Missing action parameter' });

  switch (action) {
    case 'jobs': return handleJobs(req, res);
    case 'job-details': return handleJobDetails(req, res);
    case 'submit-bid': return handleSubmitBid(req, res);
    case 'award-job': return handleAwardJob(req, res);
    case 'check-deadlines': return handleCheckDeadlines(req, res);
    case 'dashboard-stats': return handleDashboardStats(req, res);
    case 'delete-job': return handleDeleteJob(req, res);
    case 'delete-bid': return handleDeleteBid(req, res);
    case 'hubspot-webhook': return handleHubspotWebhook(req, res);
    case 'hubspot-poll': return handleHubspotPoll(req, res);
    case 'hubspot-debug': return handleHubspotDebug(req, res);
    default: return res.status(400).json({ error: 'Unknown action: ' + action });
  }
};

// === JOBS ===
async function handleJobs(req, res) {
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

        var bidUrl = (req.headers['x-forwarded-proto'] || 'https') + '://' +
          (req.headers['x-forwarded-host'] || req.headers.host) +
          '/provider-bid?token=' + token;

        var deadlineStr = deadline.toLocaleDateString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
        });

        var redacted = fb.redactAddress(body.address);
        await fb.sendEmail(
          provider.email,
          'New Job Available — ' + redacted,
          '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
            '<div style="margin-bottom:32px;"><strong style="font-size:18px;color:#080808;">Guest House</strong></div>' +
            '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">New job available in your market</h2>' +
            '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">Hi ' + provider.name.split(' ')[0] + ', a new staging job is available for bidding.</p>' +
            '<div style="background:#f7f7f7;border-radius:12px;padding:20px 24px;margin-bottom:24px;">' +
              '<div style="margin-bottom:8px;"><strong style="color:#343434;">Location:</strong> <span style="color:#666;">' + redacted + '</span></div>' +
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
}

// === JOB DETAILS ===
async function handleJobDetails(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var jobId = req.query.jobId;
    if (!jobId) return res.status(400).json({ error: 'Missing jobId' });

    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);

    var jobDoc = await fb.getDocument('jobs/' + jobId, accessToken);
    var job = fb.fromFirestoreFields(jobDoc.fields);
    job.id = fb.docId(jobDoc.name);

    var bidDocs = await fb.runQuery('bids', [
      { field: { fieldPath: 'jobId' }, op: 'EQUAL', value: { stringValue: jobId } },
    ], accessToken);

    var bids = bidDocs.map(function(item) {
      var bid = fb.fromFirestoreFields(item.document.fields);
      bid.id = fb.docId(item.document.name);
      return bid;
    });

    bids.sort(function(a, b) {
      if (a.submittedAt && !b.submittedAt) return -1;
      if (!a.submittedAt && b.submittedAt) return 1;
      if (a.submittedAt && b.submittedAt) return (a.amount || 0) - (b.amount || 0);
      return 0;
    });

    return res.status(200).json({ job: job, bids: bids });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// === SUBMIT BID ===
async function handleSubmitBid(req, res) {
  try {
    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);

    if (req.method === 'GET') {
      var token = req.query.token;
      if (!token) return res.status(400).json({ error: 'Missing token' });

      var bidDocs = await fb.runQuery('bids', [
        { field: { fieldPath: 'token' }, op: 'EQUAL', value: { stringValue: token } },
      ], accessToken);

      if (bidDocs.length === 0) {
        return res.status(404).json({ error: 'invalid_token' });
      }

      var bid = fb.fromFirestoreFields(bidDocs[0].document.fields);
      bid.id = fb.docId(bidDocs[0].document.name);

      if (bid.submittedAt) {
        return res.status(200).json({ status: 'already_submitted', bid: { amount: bid.amount, submittedAt: bid.submittedAt } });
      }

      var jobDoc = await fb.getDocument('jobs/' + bid.jobId, accessToken);
      var job = fb.fromFirestoreFields(jobDoc.fields);
      job.id = fb.docId(jobDoc.name);

      var now = new Date();
      if (job.status !== 'bidding' || now > new Date(job.biddingDeadline)) {
        return res.status(200).json({ status: 'deadline_passed', job: { address: fb.redactAddress(job.address), biddingDeadline: job.biddingDeadline } });
      }

      return res.status(200).json({
        status: 'open',
        providerName: bid.providerName,
        job: {
          address: fb.redactAddress(job.address),
          sqft: job.sqft,
          rooms: job.rooms,
          timeline: job.timeline,
          notes: job.notes,
          biddingDeadline: job.biddingDeadline,
        },
      });

    } else if (req.method === 'POST') {
      var body = req.body;
      if (!body.token) return res.status(400).json({ error: 'Missing token' });

      var amount = parseFloat(body.amount);
      if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid bid amount' });

      var bidDocs = await fb.runQuery('bids', [
        { field: { fieldPath: 'token' }, op: 'EQUAL', value: { stringValue: body.token } },
      ], accessToken);

      if (bidDocs.length === 0) {
        return res.status(404).json({ error: 'invalid_token' });
      }

      var bid = fb.fromFirestoreFields(bidDocs[0].document.fields);
      var bidId = fb.docId(bidDocs[0].document.name);

      if (bid.submittedAt) {
        return res.status(409).json({ error: 'already_submitted', amount: bid.amount });
      }

      var jobDoc = await fb.getDocument('jobs/' + bid.jobId, accessToken);
      var job = fb.fromFirestoreFields(jobDoc.fields);

      var now = new Date();
      if (job.status !== 'bidding') {
        return res.status(409).json({ error: 'job_not_bidding' });
      }
      if (now > new Date(job.biddingDeadline)) {
        return res.status(409).json({ error: 'deadline_passed' });
      }

      await fb.updateDocument('bids/' + bidId, {
        amount: amount,
        submittedAt: now.toISOString(),
      }, accessToken);

      var redactedAddr = fb.redactAddress(job.address);
      await fb.sendEmail(
        bid.providerEmail,
        'Bid Confirmed — ' + redactedAddr,
        '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
          '<div style="margin-bottom:32px;"><strong style="font-size:18px;color:#080808;">Guest House</strong></div>' +
          '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">Bid received</h2>' +
          '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">Thanks ' + bid.providerName.split(' ')[0] + ', your bid has been submitted. We\'ll notify you when the job is awarded.</p>' +
          '<div style="background:#f7f7f7;border-radius:12px;padding:20px 24px;margin-bottom:24px;">' +
            '<div style="margin-bottom:8px;"><strong style="color:#343434;">Location:</strong> <span style="color:#666;">' + redactedAddr + '</span></div>' +
            '<div style="margin-bottom:8px;"><strong style="color:#343434;">Your bid:</strong> <span style="color:#080808;font-size:20px;font-weight:600;">$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</span></div>' +
            '<div><strong style="color:#343434;">Deadline:</strong> <span style="color:#666;">' + new Date(job.biddingDeadline).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '</span></div>' +
          '</div>' +
          '<p style="color:#999;font-size:13px;">You\'ll receive an email when the job is awarded.</p>' +
        '</div>'
      );

      return res.status(200).json({ success: true, amount: amount });

    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// === AWARD JOB ===
async function handleAwardJob(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var body = req.body;
    if (!body.jobId) return res.status(400).json({ error: 'Missing jobId' });

    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);

    var jobDoc = await fb.getDocument('jobs/' + body.jobId, accessToken);
    var job = fb.fromFirestoreFields(jobDoc.fields);

    if (job.status !== 'bidding') {
      return res.status(409).json({ error: 'Job is not in bidding status (current: ' + job.status + ')' });
    }

    var bidDocs = await fb.runQuery('bids', [
      { field: { fieldPath: 'jobId' }, op: 'EQUAL', value: { stringValue: body.jobId } },
    ], accessToken);

    var bids = bidDocs.map(function(item) {
      var bid = fb.fromFirestoreFields(item.document.fields);
      bid.id = fb.docId(item.document.name);
      return bid;
    });

    var submittedBids = bids.filter(function(b) { return b.submittedAt && b.amount; });

    if (submittedBids.length === 0) {
      return res.status(400).json({ error: 'No submitted bids to award' });
    }

    var winningBidId;

    if (body.auto) {
      submittedBids.sort(function(a, b) { return a.amount - b.amount; });
      winningBidId = submittedBids[0].id;
    } else if (body.bidId) {
      var found = submittedBids.find(function(b) { return b.id === body.bidId; });
      if (!found) return res.status(404).json({ error: 'Bid not found or not submitted' });
      winningBidId = body.bidId;
    } else {
      return res.status(400).json({ error: 'Must provide bidId or auto: true' });
    }

    var winningBid = bids.find(function(b) { return b.id === winningBidId; });
    var now = new Date().toISOString();

    await fb.updateDocument('jobs/' + body.jobId, {
      status: 'awarded',
      awardedBidId: winningBidId,
      awardedProvider: winningBid.providerEmail,
      awardedAt: now,
    }, accessToken);

    var redactedAddr = fb.redactAddress(job.address);
    for (var i = 0; i < bids.length; i++) {
      var bid = bids[i];
      var newStatus = bid.id === winningBidId ? 'won' : 'lost';
      await fb.updateDocument('bids/' + bid.id, { status: newStatus }, accessToken);

      if (bid.id === winningBidId) {
        await fb.sendEmail(
          bid.providerEmail,
          'You Won the Job! — ' + redactedAddr,
          '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
            '<div style="margin-bottom:32px;"><strong style="font-size:18px;color:#080808;">Guest House</strong></div>' +
            '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">Congratulations! You\'ve been awarded the job</h2>' +
            '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">Hi ' + bid.providerName.split(' ')[0] + ', great news! Your bid of $' + Number(bid.amount).toFixed(2) + ' was selected.</p>' +
            '<div style="background:#ECFDF3;border-radius:12px;padding:20px 24px;margin-bottom:24px;">' +
              '<div style="margin-bottom:8px;"><strong style="color:#067647;">Location:</strong> <span style="color:#343434;">' + redactedAddr + '</span></div>' +
              '<div style="margin-bottom:8px;"><strong style="color:#067647;">Your bid:</strong> <span style="color:#080808;font-size:20px;font-weight:600;">$' + Number(bid.amount).toFixed(2) + '</span></div>' +
              (job.timeline ? '<div><strong style="color:#067647;">Timeline:</strong> <span style="color:#343434;">' + job.timeline + '</span></div>' : '') +
            '</div>' +
            '<p style="color:#666;font-size:14px;">A member of the Guest House team will reach out with next steps.</p>' +
          '</div>'
        );
      } else if (bid.submittedAt) {
        await fb.sendEmail(
          bid.providerEmail,
          'Job Update — ' + redactedAddr,
          '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
            '<div style="margin-bottom:32px;"><strong style="font-size:18px;color:#080808;">Guest House</strong></div>' +
            '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">Job awarded to another provider</h2>' +
            '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">Hi ' + bid.providerName.split(' ')[0] + ', thanks for submitting your bid for a job in ' + redactedAddr + '. This job has been awarded to another provider.</p>' +
            '<p style="color:#666;font-size:14px;">We\'ll notify you when new jobs become available in your market. Thanks for being a Guest House partner!</p>' +
          '</div>'
        );
      }
    }

    return res.status(200).json({
      success: true,
      awardedTo: winningBid.providerEmail,
      amount: winningBid.amount,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// === CHECK DEADLINES ===
async function handleCheckDeadlines(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.query.secret !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);

    var now = new Date();

    var jobDocs = await fb.runQuery('jobs', [
      { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'bidding' } },
      { field: { fieldPath: 'biddingDeadline' }, op: 'LESS_THAN', value: { timestampValue: now.toISOString() } },
    ], accessToken);

    var results = [];

    for (var i = 0; i < jobDocs.length; i++) {
      var job = fb.fromFirestoreFields(jobDocs[i].document.fields);
      var jobId = fb.docId(jobDocs[i].document.name);

      var bidDocs = await fb.runQuery('bids', [
        { field: { fieldPath: 'jobId' }, op: 'EQUAL', value: { stringValue: jobId } },
      ], accessToken);

      var bids = bidDocs.map(function(item) {
        var bid = fb.fromFirestoreFields(item.document.fields);
        bid.id = fb.docId(item.document.name);
        return bid;
      });

      var submittedBids = bids.filter(function(b) { return b.submittedAt && b.amount; });

      if (submittedBids.length === 0) {
        await fb.updateDocument('jobs/' + jobId, { status: 'no_bids' }, accessToken);

        var adminEmail = process.env.ADMIN_EMAIL;
        if (adminEmail) {
          await fb.sendEmail(
            adminEmail,
            'No Bids Received — ' + job.address,
            '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
              '<div style="margin-bottom:32px;"><strong style="font-size:18px;color:#080808;">Guest House</strong></div>' +
              '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">No bids received</h2>' +
              '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">The bidding deadline for the following job has passed with zero bids submitted.</p>' +
              '<div style="background:#FEF3F2;border-radius:12px;padding:20px 24px;">' +
                '<div style="margin-bottom:8px;"><strong style="color:#343434;">Address:</strong> <span style="color:#666;">' + job.address + '</span></div>' +
                '<div style="margin-bottom:8px;"><strong style="color:#343434;">Market:</strong> <span style="color:#666;">' + job.market + '</span></div>' +
                '<div><strong style="color:#343434;">Provider Type:</strong> <span style="color:#666;">' + job.providerType + '</span></div>' +
              '</div>' +
            '</div>'
          );
        }

        results.push({ jobId: jobId, address: job.address, action: 'no_bids' });
      } else {
        submittedBids.sort(function(a, b) { return a.amount - b.amount; });
        var winner = submittedBids[0];

        await fb.updateDocument('jobs/' + jobId, {
          status: 'awarded',
          awardedBidId: winner.id,
          awardedProvider: winner.providerEmail,
          awardedAt: now.toISOString(),
        }, accessToken);

        var cronRedacted = fb.redactAddress(job.address);
        for (var j = 0; j < bids.length; j++) {
          var bid = bids[j];
          var newStatus = bid.id === winner.id ? 'won' : 'lost';
          await fb.updateDocument('bids/' + bid.id, { status: newStatus }, accessToken);

          if (bid.id === winner.id) {
            await fb.sendEmail(
              bid.providerEmail,
              'You Won the Job! — ' + cronRedacted,
              '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
                '<div style="margin-bottom:32px;"><strong style="font-size:18px;color:#080808;">Guest House</strong></div>' +
                '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">Congratulations! You\'ve been awarded the job</h2>' +
                '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">Hi ' + bid.providerName.split(' ')[0] + ', your bid of $' + Number(bid.amount).toFixed(2) + ' was the winning bid.</p>' +
                '<div style="background:#ECFDF3;border-radius:12px;padding:20px 24px;">' +
                  '<div style="margin-bottom:8px;"><strong style="color:#067647;">Location:</strong> <span style="color:#343434;">' + cronRedacted + '</span></div>' +
                  '<div><strong style="color:#067647;">Your bid:</strong> <span style="color:#080808;font-size:20px;font-weight:600;">$' + Number(bid.amount).toFixed(2) + '</span></div>' +
                '</div>' +
                '<p style="color:#666;font-size:14px;margin-top:24px;">A member of the Guest House team will reach out with next steps.</p>' +
              '</div>'
            );
          } else if (bid.submittedAt) {
            await fb.sendEmail(
              bid.providerEmail,
              'Job Update — ' + cronRedacted,
              '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
                '<div style="margin-bottom:32px;"><strong style="font-size:18px;color:#080808;">Guest House</strong></div>' +
                '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">Job awarded to another provider</h2>' +
                '<p style="color:#666;font-size:15px;line-height:1.6;">Hi ' + bid.providerName.split(' ')[0] + ', thanks for your bid on a job in ' + cronRedacted + '. This job has been awarded to another provider. We\'ll notify you when new jobs become available.</p>' +
              '</div>'
            );
          }
        }

        results.push({ jobId: jobId, address: job.address, action: 'auto_awarded', winner: winner.providerEmail, amount: winner.amount });
      }
    }

    return res.status(200).json({ processed: results.length, results: results });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// === DASHBOARD STATS ===
async function handleDashboardStats(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);

    // Fetch all jobs, bids, and active stager providers in parallel
    var jobDocs = await fb.runQuery('jobs', [], accessToken);
    var bidDocs = await fb.runQuery('bids', [], accessToken);
    var stagerDocs = await fb.runQuery('providers', [
      { field: { fieldPath: 'role' }, op: 'EQUAL', value: { stringValue: 'stager' } },
      { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'active' } },
    ], accessToken);

    var allJobs = jobDocs.map(function(item) {
      var data = fb.fromFirestoreFields(item.document.fields);
      data.id = fb.docId(item.document.name);
      return data;
    });

    var allBids = bidDocs.map(function(item) {
      var data = fb.fromFirestoreFields(item.document.fields);
      data.id = fb.docId(item.document.name);
      return data;
    });

    // KPIs
    var activeHomes = allJobs.filter(function(j) { return j.status === 'bidding'; }).length;
    var awardedHomes = allJobs.filter(function(j) { return j.status === 'awarded'; }).length;
    var totalStagers = stagerDocs.length;

    var submittedBids = allBids.filter(function(b) { return b.submittedAt && b.amount; });
    var avgBidPrice = 0;
    if (submittedBids.length > 0) {
      var total = submittedBids.reduce(function(sum, b) { return sum + Number(b.amount); }, 0);
      avgBidPrice = Math.round((total / submittedBids.length) * 100) / 100;
    }

    // Alerts
    var now = new Date();
    var twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    var alerts = [];

    var biddingJobs = allJobs.filter(function(j) { return j.status === 'bidding'; });
    biddingJobs.forEach(function(job) {
      var deadline = new Date(job.biddingDeadline);
      var jobBids = allBids.filter(function(b) { return b.jobId === job.id && b.submittedAt && b.amount; });

      if (deadline < now) {
        alerts.push({ type: 'expired', jobId: job.id, address: job.address, message: 'Bidding expired \u2014 no auto-award yet' });
      } else if (deadline < twoHoursFromNow && jobBids.length === 0) {
        alerts.push({ type: 'low_response', jobId: job.id, address: job.address, message: '0 bids with <2h remaining' });
      }
    });

    // Stager stats
    var stagerStats = {};
    allBids.forEach(function(bid) {
      if (!bid.providerEmail) return;
      if (!stagerStats[bid.providerEmail]) {
        stagerStats[bid.providerEmail] = { jobsWon: 0, totalBids: 0, bidSum: 0, avgBid: 0, winRate: 0 };
      }
      if (bid.submittedAt && bid.amount) {
        stagerStats[bid.providerEmail].totalBids++;
        stagerStats[bid.providerEmail].bidSum += Number(bid.amount);
      }
      if (bid.status === 'won') {
        stagerStats[bid.providerEmail].jobsWon++;
      }
    });

    Object.keys(stagerStats).forEach(function(email) {
      var s = stagerStats[email];
      s.avgBid = s.totalBids > 0 ? Math.round((s.bidSum / s.totalBids) * 100) / 100 : 0;
      s.winRate = s.totalBids > 0 ? Math.round((s.jobsWon / s.totalBids) * 100) : 0;
      delete s.bidSum;
    });

    return res.status(200).json({
      kpis: {
        activeHomes: activeHomes,
        awardedHomes: awardedHomes,
        totalStagers: totalStagers,
        avgBidPrice: avgBidPrice,
      },
      alerts: alerts,
      stagerStats: stagerStats,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// === DELETE JOB ===
async function handleDeleteJob(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var jobId = req.body && req.body.jobId;
    if (!jobId) return res.status(400).json({ error: 'Missing jobId' });

    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);

    // Delete all bids for this job
    var bidDocs = await fb.runQuery('bids', [
      { field: { fieldPath: 'jobId' }, op: 'EQUAL', value: { stringValue: jobId } },
    ], accessToken);

    var bidsDeleted = 0;
    for (var i = 0; i < bidDocs.length; i++) {
      var bidId = fb.docId(bidDocs[i].document.name);
      await fetch(fb.BASE_URL + '/bids/' + bidId, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + accessToken },
      });
      bidsDeleted++;
    }

    // Delete the job
    await fetch(fb.BASE_URL + '/jobs/' + jobId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + accessToken },
    });

    return res.status(200).json({ success: true, jobId: jobId, bidsDeleted: bidsDeleted });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function handleDeleteBid(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var bidId = req.body && req.body.bidId;
    if (!bidId) return res.status(400).json({ error: 'Missing bidId' });

    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);

    await fetch(fb.BASE_URL + '/bids/' + bidId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + accessToken },
    });

    return res.status(200).json({ success: true, bidId: bidId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// =============================================================
// HUBSPOT WEBHOOK — Auto-Create Bid for Arizona Properties
// =============================================================

var HUBSPOT_TOKEN = function() { return process.env.HUBSPOT_ACCESS_TOKEN; };
var HS_HEADERS = function() {
  return { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN(), 'Content-Type': 'application/json' };
};

function isArizonaDeal(dealName) {
  if (!dealName) return false;
  return /\bAZ\b/i.test(dealName);
}

function extractDealId(body) {
  if (!body) return null;
  // Custom body with objectId key
  if (body.objectId) return String(body.objectId);
  // Nested object format
  if (body.object && body.object.objectId) return String(body.object.objectId);
  // Array of subscription events
  if (Array.isArray(body) && body.length > 0) {
    var first = body[0];
    if (first.objectId) return String(first.objectId);
  }
  // "Include all triggered deal properties" sends hs_object_id at top level or in properties
  if (body.hs_object_id) return String(body.hs_object_id);
  if (body.properties && body.properties.hs_object_id) return String(body.properties.hs_object_id);
  // HubSpot v3 object format
  if (body.id) return String(body.id);
  // Last resort: look for vid or canonical-vid
  if (body.vid) return String(body.vid);
  return null;
}

async function fetchWithRetry(url, options, retries) {
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

// POST /api/bidding?action=hubspot-webhook
async function handleHubspotWebhook(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  console.log('HubSpot webhook received. Body:', JSON.stringify(req.body), 'Body keys:', Object.keys(req.body || {}));

  var secret = process.env.HUBSPOT_WEBHOOK_SECRET;
  if (secret) {
    var provided = req.headers['x-hubspot-webhook-secret'] || req.query.secret;
    if (provided !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  var dealId = extractDealId(req.body);
  if (!dealId) {
    return res.status(400).json({ error: 'Could not extract deal ID', received: req.body });
  }

  try {
    var result = await processHubspotDeal(dealId);
    console.log('Result:', JSON.stringify(result));
    return res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// GET /api/bidding?action=hubspot-poll&secret=CRON_SECRET
async function handleHubspotPoll(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.query.secret !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    var stageIds = await resolveCommitStageIds();
    if (stageIds.length === 0) {
      return res.status(200).json({ processed: 0, message: 'No commit stages found' });
    }

    var allDeals = [];
    for (var s = 0; s < stageIds.length; s++) {
      var stageDeals = await searchDealsByStage(stageIds[s]);
      allDeals = allDeals.concat(stageDeals);
    }

    var results = [];
    for (var i = 0; i < allDeals.length; i++) {
      try {
        var result = await processHubspotDeal(allDeals[i].id);
        results.push({ dealId: allDeals[i].id, result: result });
      } catch (err) {
        results.push({ dealId: allDeals[i].id, error: err.message });
      }
    }

    return res.status(200).json({ processed: results.length, results: results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// GET /api/bidding?action=hubspot-debug&secret=CRON_SECRET
async function handleHubspotDebug(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.query.secret !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    var stagesResp = await fetchWithRetry(
      'https://api.hubapi.com/crm/v3/pipelines/deals/default/stages',
      { method: 'GET', headers: HS_HEADERS() }
    );
    var stagesData = stagesResp.ok ? await stagesResp.json() : {};
    var stages = (stagesData.results || []).map(function(s) { return { id: s.id, label: s.label }; });

    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);
    var jobDocs = await fb.runQuery('jobs', [
      { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'bidding' } },
    ], accessToken);
    var jobs = jobDocs.map(function(item) {
      var data = fb.fromFirestoreFields(item.document.fields);
      data.id = fb.docId(item.document.name);
      return data;
    });

    return res.status(200).json({ pipeline_stages: stages, active_jobs: jobs });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function processHubspotDeal(dealId) {
  var dealResp = await fetchWithRetry(
    'https://api.hubapi.com/crm/v3/objects/deals/' + dealId + '?properties=dealname,dealstage,amount',
    { method: 'GET', headers: HS_HEADERS() }
  );
  if (!dealResp.ok) {
    var errData = await dealResp.json();
    throw new Error('HubSpot API error: ' + (errData.message || dealResp.status));
  }
  var deal = await dealResp.json();
  var props = deal.properties || {};

  console.log('Deal:', dealId, '| name:', props.dealname, '| stage:', props.dealstage);

  if (!isArizonaDeal(props.dealname)) {
    return { skipped: true, reason: 'not_arizona', dealName: props.dealname };
  }

  var serviceAccount = fb.getServiceAccount();
  var accessToken = await fb.getAccessToken(serviceAccount);

  var existing = await fb.runQuery('jobs', [
    { field: { fieldPath: 'hubspotDealId' }, op: 'EQUAL', value: { stringValue: dealId } },
  ], accessToken);

  if (existing.length > 0) {
    return { skipped: true, reason: 'duplicate', jobId: fb.docId(existing[0].document.name) };
  }

  var now = new Date();
  var deadline = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  var jobDoc = await fb.createDocument('jobs', {
    address: props.dealname || '',
    sqft: '',
    rooms: '',
    timeline: '',
    market: 'arizona',
    providerType: 'stager',
    notes: 'Auto-created from HubSpot deal ' + dealId,
    status: 'bidding',
    created: now.toISOString(),
    biddingDeadline: deadline.toISOString(),
    awardedBidId: null,
    awardedProvider: null,
    awardedAt: null,
    hubspotDealId: dealId,
    hubspotAmount: props.amount || '',
  }, accessToken);

  var jobId = fb.docId(jobDoc.name);
  console.log('Job created:', jobId);

  var providerDocs = await fb.runQuery('providers', [
    { field: { fieldPath: 'market' }, op: 'EQUAL', value: { stringValue: 'arizona' } },
    { field: { fieldPath: 'role' }, op: 'EQUAL', value: { stringValue: 'stager' } },
    { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'active' } },
  ], accessToken);

  var bidsCreated = 0;
  var emailsSent = 0;

  for (var i = 0; i < providerDocs.length; i++) {
    var provider = fb.fromFirestoreFields(providerDocs[i].document.fields);
    var token = fb.generateToken();

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

    var bidUrl = 'https://guesthouseprep.com/provider-bid?token=' + token;
    var deadlineStr = deadline.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    var redacted = fb.redactAddress(props.dealname || '');

    await fb.sendEmail(
      provider.email,
      'New Job Available \u2014 ' + redacted,
      '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
        '<div style="margin-bottom:32px;"><strong style="font-size:18px;color:#080808;">Guest House</strong></div>' +
        '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">New job available in your market</h2>' +
        '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">Hi ' + provider.name.split(' ')[0] + ', a new staging job is available for bidding.</p>' +
        '<div style="background:#f7f7f7;border-radius:12px;padding:20px 24px;margin-bottom:24px;">' +
          '<div style="margin-bottom:8px;"><strong style="color:#343434;">Location:</strong> <span style="color:#666;">' + redacted + '</span></div>' +
          '<div><strong style="color:#343434;">Deadline:</strong> <span style="color:#666;">' + deadlineStr + '</span></div>' +
        '</div>' +
        '<a href="' + bidUrl + '" style="display:inline-block;background:#080808;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:500;">Submit Your Bid</a>' +
        '<p style="color:#999;font-size:13px;margin-top:24px;">This link is unique to you. Do not share it.</p>' +
      '</div>'
    );
    emailsSent++;
  }

  return { created: true, jobId: jobId, dealId: dealId, dealName: props.dealname, market: 'arizona', bidsCreated: bidsCreated, emailsSent: emailsSent };
}

async function resolveCommitStageIds() {
  var resp = await fetchWithRetry(
    'https://api.hubapi.com/crm/v3/pipelines/deals/default/stages',
    { method: 'GET', headers: HS_HEADERS() }
  );
  if (!resp.ok) return [];
  var data = await resp.json();
  var ids = [];
  (data.results || data).forEach(function(s) {
    var label = (s.label || '').toLowerCase();
    if (label.indexOf('commit') !== -1 || label.indexOf('seller approved') !== -1) ids.push(s.id);
  });
  return ids;
}

async function searchDealsByStage(stageId) {
  var allDeals = [];
  var after = 0;
  var hasMore = true;
  while (hasMore) {
    var resp = await fetchWithRetry('https://api.hubapi.com/crm/v3/objects/deals/search', {
      method: 'POST', headers: HS_HEADERS(),
      body: JSON.stringify({
        filterGroups: [{ filters: [
          { propertyName: 'pipeline', operator: 'EQ', value: 'default' },
          { propertyName: 'dealstage', operator: 'EQ', value: stageId },
        ]}],
        properties: ['dealname', 'dealstage', 'amount'],
        limit: 100, after: after,
      }),
    });
    if (!resp.ok) break;
    var data = await resp.json();
    allDeals = allDeals.concat(data.results || []);
    after = (data.paging && data.paging.next) ? data.paging.next.after : null;
    if (!after) hasMore = false;
  }
  return allDeals;
}
