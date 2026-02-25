var fb = require('./_firebase');

module.exports = async function handler(req, res) {
  fb.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);

    if (req.method === 'GET') {
      // Look up bid by token — returns job details for the bid form
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

      // Check if already submitted
      if (bid.submittedAt) {
        return res.status(200).json({ status: 'already_submitted', bid: { amount: bid.amount, submittedAt: bid.submittedAt } });
      }

      // Fetch the job
      var jobDoc = await fb.getDocument('jobs/' + bid.jobId, accessToken);
      var job = fb.fromFirestoreFields(jobDoc.fields);
      job.id = fb.docId(jobDoc.name);

      // Check deadline
      var now = new Date();
      if (job.status !== 'bidding' || now > new Date(job.biddingDeadline)) {
        return res.status(200).json({ status: 'deadline_passed', job: { address: job.address, biddingDeadline: job.biddingDeadline } });
      }

      return res.status(200).json({
        status: 'open',
        providerName: bid.providerName,
        job: {
          address: job.address,
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

      // Look up bid by token
      var bidDocs = await fb.runQuery('bids', [
        { field: { fieldPath: 'token' }, op: 'EQUAL', value: { stringValue: body.token } },
      ], accessToken);

      if (bidDocs.length === 0) {
        return res.status(404).json({ error: 'invalid_token' });
      }

      var bid = fb.fromFirestoreFields(bidDocs[0].document.fields);
      var bidId = fb.docId(bidDocs[0].document.name);

      // Already submitted?
      if (bid.submittedAt) {
        return res.status(409).json({ error: 'already_submitted', amount: bid.amount });
      }

      // Check job is still in bidding status and within deadline
      var jobDoc = await fb.getDocument('jobs/' + bid.jobId, accessToken);
      var job = fb.fromFirestoreFields(jobDoc.fields);

      var now = new Date();
      if (job.status !== 'bidding') {
        return res.status(409).json({ error: 'job_not_bidding' });
      }
      if (now > new Date(job.biddingDeadline)) {
        return res.status(409).json({ error: 'deadline_passed' });
      }

      // Update bid with amount and timestamp
      await fb.updateDocument('bids/' + bidId, {
        amount: amount,
        submittedAt: now.toISOString(),
      }, accessToken);

      // Send confirmation email
      await fb.sendEmail(
        bid.providerEmail,
        'Bid Confirmed — ' + job.address,
        '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
          '<div style="margin-bottom:32px;">' +
            '<strong style="font-size:18px;color:#080808;">Guest House</strong>' +
          '</div>' +
          '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">Bid received</h2>' +
          '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">Thanks ' + bid.providerName.split(' ')[0] + ', your bid has been submitted. We\'ll notify you when the job is awarded.</p>' +
          '<div style="background:#f7f7f7;border-radius:12px;padding:20px 24px;margin-bottom:24px;">' +
            '<div style="margin-bottom:8px;"><strong style="color:#343434;">Job:</strong> <span style="color:#666;">' + job.address + '</span></div>' +
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
};
