var fb = require('./_firebase');

module.exports = async function handler(req, res) {
  fb.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Verify cron secret
  var cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.query.secret !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);

    var now = new Date();

    // Find all jobs in "bidding" status with expired deadlines
    var jobDocs = await fb.runQuery('jobs', [
      { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'bidding' } },
      { field: { fieldPath: 'biddingDeadline' }, op: 'LESS_THAN', value: { timestampValue: now.toISOString() } },
    ], accessToken);

    var results = [];

    for (var i = 0; i < jobDocs.length; i++) {
      var job = fb.fromFirestoreFields(jobDocs[i].document.fields);
      var jobId = fb.docId(jobDocs[i].document.name);

      // Fetch bids for this job
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
        // No bids — mark job as no_bids
        await fb.updateDocument('jobs/' + jobId, { status: 'no_bids' }, accessToken);

        // Notify admin
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
        // Auto-award to lowest bidder
        submittedBids.sort(function(a, b) { return a.amount - b.amount; });
        var winner = submittedBids[0];

        await fb.updateDocument('jobs/' + jobId, {
          status: 'awarded',
          awardedBidId: winner.id,
          awardedProvider: winner.providerEmail,
          awardedAt: now.toISOString(),
        }, accessToken);

        // Update all bid statuses and send emails
        for (var j = 0; j < bids.length; j++) {
          var bid = bids[j];
          var newStatus = bid.id === winner.id ? 'won' : 'lost';
          await fb.updateDocument('bids/' + bid.id, { status: newStatus }, accessToken);

          if (bid.id === winner.id) {
            await fb.sendEmail(
              bid.providerEmail,
              'You Won the Job! — ' + job.address,
              '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
                '<div style="margin-bottom:32px;"><strong style="font-size:18px;color:#080808;">Guest House</strong></div>' +
                '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">Congratulations! You\'ve been awarded the job</h2>' +
                '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">Hi ' + bid.providerName.split(' ')[0] + ', your bid of $' + Number(bid.amount).toFixed(2) + ' was the winning bid.</p>' +
                '<div style="background:#ECFDF3;border-radius:12px;padding:20px 24px;">' +
                  '<div style="margin-bottom:8px;"><strong style="color:#067647;">Address:</strong> <span style="color:#343434;">' + job.address + '</span></div>' +
                  '<div><strong style="color:#067647;">Your bid:</strong> <span style="color:#080808;font-size:20px;font-weight:600;">$' + Number(bid.amount).toFixed(2) + '</span></div>' +
                '</div>' +
                '<p style="color:#666;font-size:14px;margin-top:24px;">A member of the Guest House team will reach out with next steps.</p>' +
              '</div>'
            );
          } else if (bid.submittedAt) {
            await fb.sendEmail(
              bid.providerEmail,
              'Job Update — ' + job.address,
              '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
                '<div style="margin-bottom:32px;"><strong style="font-size:18px;color:#080808;">Guest House</strong></div>' +
                '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">Job awarded to another provider</h2>' +
                '<p style="color:#666;font-size:15px;line-height:1.6;">Hi ' + bid.providerName.split(' ')[0] + ', thanks for your bid on ' + job.address + '. This job has been awarded to another provider. We\'ll notify you when new jobs become available.</p>' +
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
};
