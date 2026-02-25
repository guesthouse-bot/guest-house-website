var fb = require('./_firebase');

module.exports = async function handler(req, res) {
  fb.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var body = req.body;
    if (!body.jobId) return res.status(400).json({ error: 'Missing jobId' });

    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);

    // Fetch the job
    var jobDoc = await fb.getDocument('jobs/' + body.jobId, accessToken);
    var job = fb.fromFirestoreFields(jobDoc.fields);

    if (job.status !== 'bidding') {
      return res.status(409).json({ error: 'Job is not in bidding status (current: ' + job.status + ')' });
    }

    // Fetch all bids for this job
    var bidDocs = await fb.runQuery('bids', [
      { field: { fieldPath: 'jobId' }, op: 'EQUAL', value: { stringValue: body.jobId } },
    ], accessToken);

    var bids = bidDocs.map(function(item) {
      var bid = fb.fromFirestoreFields(item.document.fields);
      bid.id = fb.docId(item.document.name);
      return bid;
    });

    // Filter to submitted bids only
    var submittedBids = bids.filter(function(b) { return b.submittedAt && b.amount; });

    if (submittedBids.length === 0) {
      return res.status(400).json({ error: 'No submitted bids to award' });
    }

    var winningBidId;

    if (body.auto) {
      // Auto-award to lowest bidder
      submittedBids.sort(function(a, b) { return a.amount - b.amount; });
      winningBidId = submittedBids[0].id;
    } else if (body.bidId) {
      // Manual award to specific bid
      var found = submittedBids.find(function(b) { return b.id === body.bidId; });
      if (!found) return res.status(404).json({ error: 'Bid not found or not submitted' });
      winningBidId = body.bidId;
    } else {
      return res.status(400).json({ error: 'Must provide bidId or auto: true' });
    }

    var winningBid = bids.find(function(b) { return b.id === winningBidId; });
    var now = new Date().toISOString();

    // Update job as awarded
    await fb.updateDocument('jobs/' + body.jobId, {
      status: 'awarded',
      awardedBidId: winningBidId,
      awardedProvider: winningBid.providerEmail,
      awardedAt: now,
    }, accessToken);

    // Update all bid statuses
    for (var i = 0; i < bids.length; i++) {
      var bid = bids[i];
      var newStatus = bid.id === winningBidId ? 'won' : 'lost';
      await fb.updateDocument('bids/' + bid.id, { status: newStatus }, accessToken);

      // Send emails
      if (bid.id === winningBidId) {
        // Award email to winner
        await fb.sendEmail(
          bid.providerEmail,
          'You Won the Job! — ' + job.address,
          '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
            '<div style="margin-bottom:32px;">' +
              '<strong style="font-size:18px;color:#080808;">Guest House</strong>' +
            '</div>' +
            '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">Congratulations! You\'ve been awarded the job</h2>' +
            '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">Hi ' + bid.providerName.split(' ')[0] + ', great news! Your bid of $' + Number(bid.amount).toFixed(2) + ' was selected.</p>' +
            '<div style="background:#ECFDF3;border-radius:12px;padding:20px 24px;margin-bottom:24px;">' +
              '<div style="margin-bottom:8px;"><strong style="color:#067647;">Address:</strong> <span style="color:#343434;">' + job.address + '</span></div>' +
              '<div style="margin-bottom:8px;"><strong style="color:#067647;">Your bid:</strong> <span style="color:#080808;font-size:20px;font-weight:600;">$' + Number(bid.amount).toFixed(2) + '</span></div>' +
              (job.timeline ? '<div><strong style="color:#067647;">Timeline:</strong> <span style="color:#343434;">' + job.timeline + '</span></div>' : '') +
            '</div>' +
            '<p style="color:#666;font-size:14px;">A member of the Guest House team will reach out with next steps.</p>' +
          '</div>'
        );
      } else if (bid.submittedAt) {
        // Rejection email to losing bidders who actually submitted
        await fb.sendEmail(
          bid.providerEmail,
          'Job Update — ' + job.address,
          '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
            '<div style="margin-bottom:32px;">' +
              '<strong style="font-size:18px;color:#080808;">Guest House</strong>' +
            '</div>' +
            '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">Job awarded to another provider</h2>' +
            '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">Hi ' + bid.providerName.split(' ')[0] + ', thanks for submitting your bid for ' + job.address + '. This job has been awarded to another provider.</p>' +
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
};
