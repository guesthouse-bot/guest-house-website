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
      var docData = {
        email: body.email.toLowerCase(),
        name: body.name,
        businessName: body.businessName || '',
        role: body.role,
        market: body.market,
        status: body.status || 'active',
        created: now,
        source: body.source || 'manual',
      };
      if (body.firstName) docData.firstName = body.firstName;
      if (body.lastName) docData.lastName = body.lastName;
      if (body.phone) docData.phone = body.phone;
      if (body.city) docData.city = body.city;
      if (body.state) docData.state = body.state;
      if (body.website) docData.website = body.website;
      if (body.applicationData) docData.applicationData = JSON.stringify(body.applicationData);
      var doc = await fb.createDocument('providers', docData, accessToken);

      var provider = fb.fromFirestoreFields(doc.fields);
      provider.id = fb.docId(doc.name);
      return res.status(201).json({ provider: provider });

    } else if (req.method === 'PATCH') {
      var body = req.body;
      if (!body.id) return res.status(400).json({ error: 'Missing provider id' });

      var updates = {};
      if (body.status === 'approved') {
        updates.status = 'active';
      } else if (body.status) {
        updates.status = body.status;
      }
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

      // Send welcome email on approval
      if (body.status === 'approved' && result.email) {
        try {
          await fb.sendEmail(
            result.email,
            "You're Approved — Welcome to Guest House",
            '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
              '<div style="margin-bottom:32px;"><strong style="font-size:18px;color:#080808;">Guest House</strong></div>' +
              '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">Welcome to the Guest House network!</h2>' +
              '<p style="color:#444;font-size:15px;line-height:1.6;margin-bottom:24px;">' +
                'Hi ' + (result.firstName || result.name || 'there') + ', great news — your application has been approved. ' +
                'You\'re now part of the Guest House partner network.' +
              '</p>' +
              '<p style="color:#444;font-size:15px;line-height:1.6;margin-bottom:24px;">' +
                'Here\'s what happens next:' +
              '</p>' +
              '<ul style="color:#444;font-size:15px;line-height:1.8;margin-bottom:24px;padding-left:20px;">' +
                '<li>You\'ll receive job notifications for your market</li>' +
                '<li>Submit bids on available jobs</li>' +
                '<li>A member of our team will reach out with onboarding details</li>' +
              '</ul>' +
              '<p style="color:#666;font-size:14px;">If you have any questions, reply to this email and we\'ll be happy to help.</p>' +
            '</div>'
          );
        } catch (emailErr) {
          console.error('Failed to send approval email:', emailErr.message);
        }
      }

      // Send rejection email
      if (body.status === 'rejected' && result.email) {
        try {
          await fb.sendEmail(
            result.email,
            'Application Update — Guest House',
            '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
              '<div style="margin-bottom:32px;"><strong style="font-size:18px;color:#080808;">Guest House</strong></div>' +
              '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">Application update</h2>' +
              '<p style="color:#444;font-size:15px;line-height:1.6;margin-bottom:24px;">' +
                'Hi ' + (result.firstName || result.name || 'there') + ', thank you for your interest in joining the Guest House partner network. ' +
                'After reviewing your application, we\'re unable to move forward at this time.' +
              '</p>' +
              '<p style="color:#444;font-size:15px;line-height:1.6;margin-bottom:24px;">' +
                'This doesn\'t necessarily mean the door is closed — our needs change as we grow. ' +
                'We encourage you to apply again in the future.' +
              '</p>' +
              '<p style="color:#666;font-size:14px;">If you have any questions, feel free to reply to this email.</p>' +
            '</div>'
          );
        } catch (emailErr) {
          console.error('Failed to send rejection email:', emailErr.message);
        }
      }

      return res.status(200).json({ provider: result });

    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
