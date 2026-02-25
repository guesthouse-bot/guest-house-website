var fb = require('./_firebase');

module.exports = async function handler(req, res) {
  fb.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var jobId = req.query.jobId;
    if (!jobId) return res.status(400).json({ error: 'Missing jobId' });

    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);

    // Fetch the job
    var jobDoc = await fb.getDocument('jobs/' + jobId, accessToken);
    var job = fb.fromFirestoreFields(jobDoc.fields);
    job.id = fb.docId(jobDoc.name);

    // Fetch all bids for this job
    var bidDocs = await fb.runQuery('bids', [
      { field: { fieldPath: 'jobId' }, op: 'EQUAL', value: { stringValue: jobId } },
    ], accessToken);

    var bids = bidDocs.map(function(item) {
      var bid = fb.fromFirestoreFields(item.document.fields);
      bid.id = fb.docId(item.document.name);
      return bid;
    });

    // Sort: submitted bids first (by amount ascending), then pending
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
};
