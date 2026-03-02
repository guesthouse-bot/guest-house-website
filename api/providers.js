var fb = require('./_firebase');

module.exports = async function handler(req, res) {
  fb.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);
    var action = req.query.action;

    // Action router — if no action, fall through to legacy routing
    if (action) {
      switch (action) {
        case 'get-provider':
          return handleGetProvider(req, res, accessToken);
        case 'resend-signup':
          return handleResendSignup(req, res, accessToken);
        case 'profile':
          return handleProfile(req, res, accessToken);
        default:
          return res.status(400).json({ error: 'Unknown action: ' + action });
      }
    }

    // Legacy routing by HTTP method
    if (req.method === 'GET') {
      return handleList(req, res, accessToken);
    } else if (req.method === 'POST') {
      return handleCreate(req, res, accessToken);
    } else if (req.method === 'PATCH') {
      return handleUpdate(req, res, accessToken);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// GET — list providers with optional filters
async function handleList(req, res, accessToken) {
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
}

// POST — create a new provider
async function handleCreate(req, res, accessToken) {
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
}

// PATCH — update a provider
async function handleUpdate(req, res, accessToken) {
  var body = req.body;
  if (!body.id) return res.status(400).json({ error: 'Missing provider id' });

  var updates = {};

  // Status transitions
  if (body.status === 'approved' || body.status === 'accepted') {
    updates.status = 'accepted';
    updates.acceptedAt = new Date().toISOString();
    updates.magicLinkToken = fb.generateToken();
  } else if (body.status === 'rejected') {
    updates.status = 'rejected';
  } else if (body.status === 'hold') {
    updates.status = 'hold';
  } else if (body.status === 'active') {
    updates.status = 'active';
    updates.signedAt = new Date().toISOString();
  } else if (body.status === 'needs_review') {
    updates.status = 'needs_review';
  } else if (body.status) {
    updates.status = body.status;
  }

  if (body.name) updates.name = body.name;
  if (body.businessName !== undefined) updates.businessName = body.businessName;
  if (body.market) updates.market = body.market;
  if (body.role) updates.role = body.role;
  if (body.signedAgreementVersion) updates.signedAgreementVersion = body.signedAgreementVersion;
  if (body.w9Filename) updates.w9Filename = body.w9Filename;
  if (body.insuranceFilename) updates.insuranceFilename = body.insuranceFilename;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  var updated = await fb.updateDocument('providers/' + body.id, updates, accessToken);
  var result = fb.fromFirestoreFields(updated.fields);
  result.id = fb.docId(updated.name);

  // Send congrats email on acceptance with signup link
  if ((body.status === 'approved' || body.status === 'accepted') && result.email) {
    var signupUrl = 'https://guesthouseprep.com/vendor-signup?pid=' + result.id;
    try {
      await fb.sendEmail(
        result.email,
        "Congratulations — You're In!",
        '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
          '<div style="margin-bottom:32px;"><strong style="font-size:18px;color:#080808;">Guest House</strong></div>' +
          '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">Welcome to the Guest House network!</h2>' +
          '<p style="color:#444;font-size:15px;line-height:1.6;margin-bottom:24px;">' +
            'Hi ' + (result.firstName || result.name || 'there') + ', great news — your application has been approved. ' +
            'You\'re now part of the Guest House partner network.' +
          '</p>' +
          '<p style="color:#444;font-size:15px;line-height:1.6;margin-bottom:24px;">' +
            'To get started, please sign the partner agreement and upload your documents:' +
          '</p>' +
          '<div style="text-align:center;margin-bottom:32px;">' +
            '<a href="' + signupUrl + '" style="display:inline-block;padding:14px 32px;background:#080808;color:#fff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:500;">Sign Partner Agreement</a>' +
          '</div>' +
          '<p style="color:#444;font-size:15px;line-height:1.6;margin-bottom:24px;">' +
            'Here\'s what happens next:' +
          '</p>' +
          '<ul style="color:#444;font-size:15px;line-height:1.8;margin-bottom:24px;padding-left:20px;">' +
            '<li>Sign the partner agreement &amp; upload documents</li>' +
            '<li>You\'ll receive job notifications for your market</li>' +
            '<li>Submit bids on available jobs</li>' +
          '</ul>' +
          '<p style="color:#666;font-size:14px;">If you have any questions, reply to this email and we\'ll be happy to help.</p>' +
        '</div>'
      );
    } catch (emailErr) {
      console.error('Failed to send acceptance email:', emailErr.message);
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

  // Send welcome email with magic link on activation (after signing agreement)
  if (body.status === 'active' && result.email && result.magicLinkToken) {
    var profileUrl = 'https://guesthouseprep.com/partner-profile?token=' + result.magicLinkToken;
    try {
      await fb.sendEmail(
        result.email,
        'You\'re All Set — Welcome to Guest House',
        '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
          '<div style="margin-bottom:32px;"><strong style="font-size:18px;color:#080808;">Guest House</strong></div>' +
          '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">You\'re officially onboarded!</h2>' +
          '<p style="color:#444;font-size:15px;line-height:1.6;margin-bottom:24px;">' +
            'Hi ' + (result.firstName || result.name || 'there') + ', your partner agreement is signed and your account is active. ' +
            'You\'re ready to start receiving and bidding on jobs.' +
          '</p>' +
          '<p style="color:#444;font-size:15px;line-height:1.6;margin-bottom:24px;">' +
            'You can view your partner profile and job history anytime:' +
          '</p>' +
          '<div style="text-align:center;margin-bottom:32px;">' +
            '<a href="' + profileUrl + '" style="display:inline-block;padding:14px 32px;background:#080808;color:#fff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:500;">View My Profile</a>' +
          '</div>' +
          '<p style="color:#666;font-size:14px;">If you have any questions, reply to this email and we\'ll be happy to help.</p>' +
        '</div>'
      );
    } catch (emailErr) {
      console.error('Failed to send welcome email:', emailErr.message);
    }
  }

  return res.status(200).json({ provider: result });
}

// ACTION: get-provider — fetch provider detail + bids
async function handleGetProvider(req, res, accessToken) {
  var id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing provider id' });

  var doc = await fb.getDocument('providers/' + id, accessToken);
  var provider = fb.fromFirestoreFields(doc.fields);
  provider.id = fb.docId(doc.name);

  // Fetch bids for this provider's email
  var bids = [];
  if (provider.email) {
    var bidDocs = await fb.runQuery('bids', [
      { field: { fieldPath: 'providerEmail' }, op: 'EQUAL', value: { stringValue: provider.email } },
    ], accessToken);
    bids = bidDocs.map(function(item) {
      var b = fb.fromFirestoreFields(item.document.fields);
      b.id = fb.docId(item.document.name);
      return b;
    });
  }

  return res.status(200).json({ provider: provider, bids: bids });
}

// ACTION: resend-signup — re-send congrats email with signup link
async function handleResendSignup(req, res, accessToken) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  var body = req.body;
  if (!body.id) return res.status(400).json({ error: 'Missing provider id' });

  // Update acceptedAt timestamp
  var updated = await fb.updateDocument('providers/' + body.id, {
    acceptedAt: new Date().toISOString(),
  }, accessToken);
  var result = fb.fromFirestoreFields(updated.fields);
  result.id = fb.docId(updated.name);

  if (!result.email) return res.status(400).json({ error: 'Provider has no email' });

  var signupUrl = 'https://guesthouseprep.com/vendor-signup?pid=' + result.id;
  await fb.sendEmail(
    result.email,
    "Congratulations — You're In!",
    '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
      '<div style="margin-bottom:32px;"><strong style="font-size:18px;color:#080808;">Guest House</strong></div>' +
      '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">Welcome to the Guest House network!</h2>' +
      '<p style="color:#444;font-size:15px;line-height:1.6;margin-bottom:24px;">' +
        'Hi ' + (result.firstName || result.name || 'there') + ', great news — your application has been approved. ' +
        'You\'re now part of the Guest House partner network.' +
      '</p>' +
      '<p style="color:#444;font-size:15px;line-height:1.6;margin-bottom:24px;">' +
        'To get started, please sign the partner agreement and upload your documents:' +
      '</p>' +
      '<div style="text-align:center;margin-bottom:32px;">' +
        '<a href="' + signupUrl + '" style="display:inline-block;padding:14px 32px;background:#080808;color:#fff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:500;">Sign Partner Agreement</a>' +
      '</div>' +
      '<p style="color:#666;font-size:14px;">If you have any questions, reply to this email and we\'ll be happy to help.</p>' +
    '</div>'
  );

  return res.status(200).json({ ok: true, provider: result });
}

// ACTION: profile — magic-link auth for partner profile
async function handleProfile(req, res, accessToken) {
  var token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  var docs = await fb.runQuery('providers', [
    { field: { fieldPath: 'magicLinkToken' }, op: 'EQUAL', value: { stringValue: token } },
  ], accessToken);

  if (docs.length === 0) {
    return res.status(404).json({ error: 'Invalid or expired link' });
  }

  var provider = fb.fromFirestoreFields(docs[0].document.fields);
  provider.id = fb.docId(docs[0].document.name);

  // Fetch bids
  var bids = [];
  if (provider.email) {
    var bidDocs = await fb.runQuery('bids', [
      { field: { fieldPath: 'providerEmail' }, op: 'EQUAL', value: { stringValue: provider.email } },
    ], accessToken);
    bids = bidDocs.map(function(item) {
      var b = fb.fromFirestoreFields(item.document.fields);
      b.id = fb.docId(item.document.name);
      return b;
    });
  }

  return res.status(200).json({ provider: provider, bids: bids });
}
