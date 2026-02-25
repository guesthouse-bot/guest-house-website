var fb = require('./_firebase');

module.exports = async function handler(req, res) {
  fb.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);

    if (req.method === 'GET') {
      // Build filters from query params
      var filters = [];
      if (req.query.market) {
        filters.push({ field: { fieldPath: 'market' }, op: 'EQUAL', value: { stringValue: req.query.market } });
      }
      if (req.query.role) {
        filters.push({ field: { fieldPath: 'role' }, op: 'EQUAL', value: { stringValue: req.query.role } });
      }
      if (req.query.status) {
        filters.push({ field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: req.query.status } });
      }

      var docs = await fb.runQuery('providers', filters, accessToken);
      var providers = docs.map(function(item) {
        var data = fb.fromFirestoreFields(item.document.fields);
        data.id = fb.docId(item.document.name);
        return data;
      });

      return res.status(200).json({ providers: providers });

    } else if (req.method === 'POST') {
      var body = req.body;
      if (!body.email || !body.name || !body.role || !body.market) {
        return res.status(400).json({ error: 'Missing required fields: email, name, role, market' });
      }

      // Check for existing provider with same email
      var existing = await fb.runQuery('providers', [
        { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: body.email.toLowerCase() } },
      ], accessToken);

      if (existing.length > 0) {
        var existingData = fb.fromFirestoreFields(existing[0].document.fields);
        existingData.id = fb.docId(existing[0].document.name);
        return res.status(200).json({ provider: existingData, existing: true });
      }

      var now = new Date().toISOString();
      var doc = await fb.createDocument('providers', {
        email: body.email.toLowerCase(),
        name: body.name,
        businessName: body.businessName || '',
        role: body.role,
        market: body.market,
        status: body.status || 'active',
        created: now,
        source: body.source || 'manual',
      }, accessToken);

      var provider = fb.fromFirestoreFields(doc.fields);
      provider.id = fb.docId(doc.name);
      return res.status(201).json({ provider: provider });

    } else if (req.method === 'PATCH') {
      var body = req.body;
      if (!body.id) return res.status(400).json({ error: 'Missing provider id' });

      var updates = {};
      if (body.status) updates.status = body.status;
      if (body.name) updates.name = body.name;
      if (body.businessName !== undefined) updates.businessName = body.businessName;
      if (body.market) updates.market = body.market;
      if (body.role) updates.role = body.role;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      var updated = await fb.updateDocument('providers/' + body.id, updates, accessToken);
      var result = fb.fromFirestoreFields(updated.fields);
      result.id = fb.docId(updated.name);
      return res.status(200).json({ provider: result });

    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
