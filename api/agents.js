var fb = require('./_firebase');

// Service → provider type mapping for auto-scheduling
var SERVICE_TYPES = {
  'Moving':      { providerType: 'mover',   offset: -7, label: 'Moving' },
  'Deep Clean':  { providerType: 'cleaner', offset: -3, label: 'Cleaning' },
  'Staging':     { providerType: 'stager',  offset: 0,  label: 'Staging' },
  'Photography': { providerType: 'media',   offset: 1,  label: 'Photos' },
};

// Branded email wrapper
function emailWrap(content) {
  return '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
    '<div style="margin-bottom:32px;"><strong style="font-size:18px;color:#080808;">Guest House</strong></div>' +
    content +
    '</div>';
}

// Validate agent magic link token
async function validateAgentToken(token, accessToken) {
  if (!token) return null;
  var docs = await fb.runQuery('agents', [
    { field: { fieldPath: 'magicLinkToken' }, op: 'EQUAL', value: { stringValue: token } },
  ], accessToken);
  if (docs.length === 0) return null;
  var agent = fb.fromFirestoreFields(docs[0].document.fields);
  agent.id = fb.docId(docs[0].document.name);
  return agent;
}

// Action router
module.exports = async function handler(req, res) {
  fb.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  var action = req.query.action;
  if (!action) return res.status(400).json({ error: 'Missing action parameter' });

  switch (action) {
    case 'register': return handleRegister(req, res);
    case 'login': return handleLogin(req, res);
    case 'auth': return handleAuth(req, res);
    case 'dashboard': return handleDashboard(req, res);
    case 'create-project': return handleCreateProject(req, res);
    case 'get-project': return handleGetProject(req, res);
    case 'update-project-stage': return handleUpdateProjectStage(req, res);
    default: return res.status(400).json({ error: 'Unknown action: ' + action });
  }
};

// === REGISTER ===
async function handleRegister(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var body = req.body;
    if (!body.email || !body.firstName || !body.lastName) {
      return res.status(400).json({ error: 'Missing required fields: email, firstName, lastName' });
    }

    var email = body.email.toLowerCase().trim();
    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);

    // Check if agent already exists
    var existing = await fb.runQuery('agents', [
      { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: email } },
    ], accessToken);

    if (existing.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists. Please use login instead.' });
    }

    var token = fb.generateToken();
    var now = new Date().toISOString();

    await fb.createDocument('agents', {
      email: email,
      name: body.firstName.trim() + ' ' + body.lastName.trim(),
      firstName: body.firstName.trim(),
      lastName: body.lastName.trim(),
      phone: body.phone || '',
      brokerage: body.brokerage || '',
      market: body.market || 'arizona',
      magicLinkToken: token,
      status: 'active',
      created: now,
      lastLoginAt: now,
    }, accessToken);

    var dashUrl = 'https://guesthouseprep.com/dashboard?token=' + token;

    await fb.sendEmail(email, 'Welcome to Guest House', emailWrap(
      '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">Welcome to Guest House</h2>' +
      '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">Hi ' + body.firstName.trim() + ', your account is all set. Click below to access your dashboard where you can create quotes, track your listings, and manage the entire listing prep process.</p>' +
      '<a href="' + dashUrl + '" style="display:inline-block;background:#080808;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:500;">Open My Dashboard</a>' +
      '<p style="color:#999;font-size:13px;margin-top:24px;">This link is unique to you. Do not share it.</p>'
    ));

    return res.status(201).json({ success: true, message: 'Account created. Check your email for your dashboard link.', token: token, dashUrl: dashUrl });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// === LOGIN ===
async function handleLogin(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var body = req.body;
    if (!body.email) return res.status(400).json({ error: 'Missing email' });

    var email = body.email.toLowerCase().trim();
    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);

    var docs = await fb.runQuery('agents', [
      { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: email } },
    ], accessToken);

    if (docs.length === 0) {
      return res.status(404).json({ error: 'No account found with this email. Please register first.' });
    }

    var agent = fb.fromFirestoreFields(docs[0].document.fields);
    var agentId = fb.docId(docs[0].document.name);
    var token = fb.generateToken();

    await fb.updateDocument('agents/' + agentId, {
      magicLinkToken: token,
      lastLoginAt: new Date().toISOString(),
    }, accessToken);

    var dashUrl = 'https://guesthouseprep.com/dashboard?token=' + token;
    var firstName = agent.firstName || agent.name.split(' ')[0];

    await fb.sendEmail(email, 'Sign in to Guest House', emailWrap(
      '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">Sign in to Guest House</h2>' +
      '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">Hi ' + firstName + ', click below to access your dashboard.</p>' +
      '<a href="' + dashUrl + '" style="display:inline-block;background:#080808;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:500;">Open My Dashboard</a>' +
      '<p style="color:#999;font-size:13px;margin-top:24px;">This link is unique to you. Do not share it.</p>'
    ));

    return res.status(200).json({ success: true, message: 'Magic link sent. Check your email.', token: token, dashUrl: dashUrl });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// === AUTH (validate token) ===
async function handleAuth(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);
    var agent = await validateAgentToken(token, accessToken);

    if (!agent) return res.status(401).json({ error: 'Invalid or expired token' });

    return res.status(200).json({
      agent: {
        id: agent.id,
        email: agent.email,
        name: agent.name,
        firstName: agent.firstName,
        lastName: agent.lastName,
        phone: agent.phone,
        brokerage: agent.brokerage,
        market: agent.market,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// === DASHBOARD (agent + all projects) ===
async function handleDashboard(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);
    var agent = await validateAgentToken(token, accessToken);

    if (!agent) return res.status(401).json({ error: 'Invalid or expired token' });

    var projectDocs = await fb.runQuery('projects', [
      { field: { fieldPath: 'agentEmail' }, op: 'EQUAL', value: { stringValue: agent.email } },
    ], accessToken);

    var projects = projectDocs.map(function(item) {
      var data = fb.fromFirestoreFields(item.document.fields);
      data.id = fb.docId(item.document.name);
      return data;
    });

    // Sort newest first
    projects.sort(function(a, b) {
      return (b.created || '') > (a.created || '') ? 1 : -1;
    });

    return res.status(200).json({
      agent: {
        id: agent.id,
        email: agent.email,
        name: agent.name,
        firstName: agent.firstName,
        lastName: agent.lastName,
        phone: agent.phone,
        brokerage: agent.brokerage,
        market: agent.market,
      },
      projects: projects,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// === CREATE PROJECT ===
async function handleCreateProject(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var token = req.query.token || (req.body && req.body.token);
    if (!token) return res.status(400).json({ error: 'Missing token' });

    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);
    var agent = await validateAgentToken(token, accessToken);

    if (!agent) return res.status(401).json({ error: 'Invalid or expired token' });

    var body = req.body;
    if (!body.address) return res.status(400).json({ error: 'Missing address' });

    var now = new Date().toISOString();

    // Build services JSON
    var services = body.services || '[]';
    if (typeof services !== 'string') services = JSON.stringify(services);

    var totalPrice = Number(body.totalPrice) || 0;

    var projectDoc = await fb.createDocument('projects', {
      agentEmail: agent.email,
      agentName: agent.name,
      address: body.address,
      market: body.market || agent.market || 'arizona',
      propertySize: body.propertySize || '',
      propertyStatus: body.propertyStatus || '',
      sqft: body.sqft || '',
      rooms: body.rooms || '',
      targetPrice: body.targetPrice || '',
      notes: body.notes || '',
      stagingPackage: body.stagingPackage || 'none',
      stagingPrice: Number(body.stagingPrice) || 0,
      services: services,
      totalPrice: totalPrice,
      stage: 'quote_received',
      installDate: body.installDate || '',
      schedule: '',
      jobIds: '[]',
      hubspotDealId: '',
      created: now,
      updatedAt: now,
    }, accessToken);

    var projectId = fb.docId(projectDoc.name);

    // Create HubSpot deal
    try {
      var hsToken = process.env.HUBSPOT_ACCESS_TOKEN;
      if (hsToken) {
        var hsHeaders = { 'Authorization': 'Bearer ' + hsToken, 'Content-Type': 'application/json' };

        var stagesResp = await fetch('https://api.hubapi.com/crm/v3/pipelines/deals/default/stages', { method: 'GET', headers: hsHeaders });
        var stageId = 'appointmentscheduled';
        if (stagesResp.ok) {
          var stagesData = await stagesResp.json();
          var stages = stagesData.results || stagesData;
          for (var i = 0; i < stages.length; i++) {
            var label = (stages[i].label || '').toLowerCase().trim();
            if (label === 'quote requested' || label === 'quotes requested') { stageId = stages[i].id; break; }
          }
        }

        var descParts = ['Address: ' + body.address];
        if (body.propertySize) descParts.push('Property Size: ' + body.propertySize);
        if (body.propertyStatus) descParts.push('Property Status: ' + body.propertyStatus);
        if (body.targetPrice) descParts.push('Target Price: $' + body.targetPrice);
        if (body.installDate) descParts.push('Install Date: ' + body.installDate);
        if (body.stagingPackage) descParts.push('Staging: ' + body.stagingPackage);
        descParts.push('Agent: ' + agent.name + ' (' + agent.email + ')');
        if (agent.brokerage) descParts.push('Brokerage: ' + agent.brokerage);

        var svcList = [];
        try { svcList = JSON.parse(services); } catch (e) {}
        if (svcList.length > 0) {
          descParts.push('');
          descParts.push('Services:');
          svcList.forEach(function(s) { descParts.push('  - ' + s.name + ': $' + s.price); });
        }

        var dealResp = await fetch('https://api.hubapi.com/crm/v3/objects/deals', {
          method: 'POST',
          headers: hsHeaders,
          body: JSON.stringify({
            properties: {
              dealname: 'Agent Quote — ' + body.address,
              pipeline: 'default',
              dealstage: stageId,
              amount: String(totalPrice),
              description: descParts.join('\n'),
            },
          }),
        });

        if (dealResp.ok) {
          var deal = await dealResp.json();
          await fb.updateDocument('projects/' + projectId, { hubspotDealId: deal.id }, accessToken);

          // Create line items
          if (svcList.length > 0) {
            for (var j = 0; j < svcList.length; j++) {
              var li = svcList[j];
              try {
                await fetch('https://api.hubapi.com/crm/v3/objects/line_items', {
                  method: 'POST',
                  headers: hsHeaders,
                  body: JSON.stringify({
                    properties: { name: li.name, price: String(li.price), quantity: '1' },
                    associations: [{ to: { id: deal.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 20 }] }],
                  }),
                });
              } catch (liErr) { console.log('Line item error:', liErr.message); }
            }
          }
        }
      }
    } catch (hsErr) { console.log('HubSpot deal creation skipped:', hsErr.message); }

    // Email agent confirmation
    var firstName = agent.firstName || agent.name.split(' ')[0];
    await fb.sendEmail(agent.email, 'Your Quote — ' + body.address, emailWrap(
      '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">Quote received</h2>' +
      '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">Hi ' + firstName + ', we\'ve received your quote request. Our team will review and get your vendors lined up.</p>' +
      '<div style="background:#f7f7f7;border-radius:12px;padding:20px 24px;margin-bottom:24px;">' +
        '<div style="margin-bottom:8px;"><strong style="color:#343434;">Property:</strong> <span style="color:#666;">' + body.address + '</span></div>' +
        (body.installDate ? '<div style="margin-bottom:8px;"><strong style="color:#343434;">Target date:</strong> <span style="color:#666;">' + body.installDate + '</span></div>' : '') +
        '<div><strong style="color:#343434;">Total:</strong> <span style="color:#080808;font-size:18px;font-weight:600;">$' + totalPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</span></div>' +
      '</div>' +
      '<p style="color:#666;font-size:14px;">You can track progress anytime from your dashboard.</p>'
    ));

    // Email admin notification
    var adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      await fb.sendEmail(adminEmail, 'New Agent Quote — ' + agent.name + ' — ' + body.address, emailWrap(
        '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">New agent quote submitted</h2>' +
        '<div style="background:#f7f7f7;border-radius:12px;padding:20px 24px;margin-bottom:24px;">' +
          '<div style="margin-bottom:8px;"><strong style="color:#343434;">Agent:</strong> <span style="color:#666;">' + agent.name + ' (' + agent.email + ')</span></div>' +
          (agent.brokerage ? '<div style="margin-bottom:8px;"><strong style="color:#343434;">Brokerage:</strong> <span style="color:#666;">' + agent.brokerage + '</span></div>' : '') +
          '<div style="margin-bottom:8px;"><strong style="color:#343434;">Property:</strong> <span style="color:#666;">' + body.address + '</span></div>' +
          '<div style="margin-bottom:8px;"><strong style="color:#343434;">Size:</strong> <span style="color:#666;">' + (body.propertySize || 'N/A') + '</span></div>' +
          '<div><strong style="color:#343434;">Total:</strong> <span style="color:#080808;font-weight:600;">$' + totalPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</span></div>' +
        '</div>'
      ));
    }

    return res.status(201).json({ success: true, projectId: projectId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// === GET PROJECT ===
async function handleGetProject(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var token = req.query.token;
    var projectId = req.query.projectId;
    if (!token || !projectId) return res.status(400).json({ error: 'Missing token or projectId' });

    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);
    var agent = await validateAgentToken(token, accessToken);

    if (!agent) return res.status(401).json({ error: 'Invalid or expired token' });

    var projectDoc = await fb.getDocument('projects/' + projectId, accessToken);
    var project = fb.fromFirestoreFields(projectDoc.fields);
    project.id = fb.docId(projectDoc.name);

    // Verify ownership
    if (project.agentEmail !== agent.email) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Fetch related jobs + bids
    var jobs = [];
    var jobIdList = [];
    try { jobIdList = JSON.parse(project.jobIds || '[]'); } catch (e) {}

    for (var i = 0; i < jobIdList.length; i++) {
      try {
        var jobDoc = await fb.getDocument('jobs/' + jobIdList[i], accessToken);
        var job = fb.fromFirestoreFields(jobDoc.fields);
        job.id = fb.docId(jobDoc.name);

        var bidDocs = await fb.runQuery('bids', [
          { field: { fieldPath: 'jobId' }, op: 'EQUAL', value: { stringValue: job.id } },
        ], accessToken);
        job.bids = bidDocs.map(function(item) {
          var bid = fb.fromFirestoreFields(item.document.fields);
          bid.id = fb.docId(item.document.name);
          return bid;
        });

        jobs.push(job);
      } catch (jobErr) { console.log('Job fetch error:', jobErr.message); }
    }

    return res.status(200).json({ project: project, jobs: jobs });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// === UPDATE PROJECT STAGE ===
async function handleUpdateProjectStage(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.query.secret !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    var body = req.body;
    if (!body.projectId || !body.stage) return res.status(400).json({ error: 'Missing projectId or stage' });

    var validStages = ['quote_received', 'vendors_scheduled', 'prep_in_progress', 'photos_ready', 'market_ready'];
    if (validStages.indexOf(body.stage) === -1) {
      return res.status(400).json({ error: 'Invalid stage: ' + body.stage });
    }

    var serviceAccount = fb.getServiceAccount();
    var accessToken = await fb.getAccessToken(serviceAccount);

    var projectDoc = await fb.getDocument('projects/' + body.projectId, accessToken);
    var project = fb.fromFirestoreFields(projectDoc.fields);
    project.id = fb.docId(projectDoc.name);

    var now = new Date().toISOString();
    var updates = { stage: body.stage, updatedAt: now };

    // Auto-scheduling when moving to vendors_scheduled
    if (body.stage === 'vendors_scheduled') {
      var scheduleResult = await runAutoScheduling(project, accessToken);
      if (scheduleResult.schedule) updates.schedule = JSON.stringify(scheduleResult.schedule);
      if (scheduleResult.jobIds) updates.jobIds = JSON.stringify(scheduleResult.jobIds);
    }

    await fb.updateDocument('projects/' + body.projectId, updates, accessToken);

    // Send stage notification email to agent
    await sendStageEmail(project, body.stage, updates, accessToken);

    return res.status(200).json({ success: true, projectId: body.projectId, stage: body.stage });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// === AUTO-SCHEDULING ===
async function runAutoScheduling(project, accessToken) {
  var services = [];
  try { services = JSON.parse(project.services || '[]'); } catch (e) {}

  if (services.length === 0 && project.stagingPackage && project.stagingPackage !== 'none') {
    services.push({ id: 'staging', name: 'Staging', price: project.stagingPrice || 0, category: 'Staging' });
  }

  var installDate = project.installDate;
  if (!installDate) {
    // Default to 14 days from now
    var d = new Date();
    d.setDate(d.getDate() + 14);
    installDate = d.toISOString().split('T')[0];
  }

  var baseDate = new Date(installDate + 'T12:00:00Z');
  var schedule = {};
  var jobIds = [];

  // Determine which service types are needed
  var neededTypes = {};

  services.forEach(function(svc) {
    var name = svc.name || '';
    // Map service name to provider type
    if (/mov/i.test(name)) neededTypes['Moving'] = true;
    if (/clean/i.test(name)) neededTypes['Deep Clean'] = true;
    if (/photo|video|mls|drone|matterport/i.test(name)) neededTypes['Photography'] = true;
  });

  // Always include staging if there's a staging package
  if (project.stagingPackage && project.stagingPackage !== 'none') {
    neededTypes['Staging'] = true;
  }

  // Create jobs for each needed service type
  var typeKeys = Object.keys(neededTypes);
  for (var i = 0; i < typeKeys.length; i++) {
    var serviceKey = typeKeys[i];
    var config = SERVICE_TYPES[serviceKey];
    if (!config) continue;

    var jobDate = new Date(baseDate);
    jobDate.setDate(jobDate.getDate() + config.offset);
    var dateStr = jobDate.toISOString().split('T')[0];

    // Create job using same pattern as bidding.js
    var deadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
    var jobDoc = await fb.createDocument('jobs', {
      address: project.address,
      sqft: project.sqft || '',
      rooms: project.rooms || '',
      timeline: dateStr,
      market: project.market || 'arizona',
      providerType: config.providerType,
      notes: 'Auto-scheduled for project. Service: ' + config.label,
      status: 'bidding',
      created: new Date().toISOString(),
      biddingDeadline: deadline.toISOString(),
      awardedBidId: null,
      awardedProvider: null,
      awardedAt: null,
      projectId: project.id,
    }, accessToken);

    var jobId = fb.docId(jobDoc.name);
    jobIds.push(jobId);

    schedule[config.providerType] = {
      date: dateStr,
      status: 'bidding',
      jobId: jobId,
      label: config.label,
    };

    // Send bid requests to matching providers
    var providerFilters = [
      { field: { fieldPath: 'market' }, op: 'EQUAL', value: { stringValue: project.market || 'arizona' } },
      { field: { fieldPath: 'role' }, op: 'EQUAL', value: { stringValue: config.providerType } },
      { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'active' } },
    ];
    var providerDocs = await fb.runQuery('providers', providerFilters, accessToken);
    var providers = providerDocs.map(function(d) { return fb.fromFirestoreFields(d.document.fields); });

    for (var p = 0; p < providers.length; p++) {
      var provider = providers[p];
      var bidToken = fb.generateToken();

      await fb.createDocument('bids', {
        jobId: jobId,
        providerEmail: provider.email,
        providerName: provider.name,
        amount: 0,
        token: bidToken,
        status: 'pending',
        submittedAt: null,
        created: new Date().toISOString(),
      }, accessToken);

      var bidUrl = 'https://guesthouseprep.com/provider-bid?token=' + bidToken;
      var redacted = fb.redactAddress(project.address);

      try {
        await fb.sendEmail(
          provider.email,
          'New Job Available — ' + redacted,
          emailWrap(
            '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">New ' + config.label.toLowerCase() + ' job available</h2>' +
            '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">Hi ' + provider.name.split(' ')[0] + ', a new ' + config.label.toLowerCase() + ' job is available for bidding.</p>' +
            '<div style="background:#f7f7f7;border-radius:12px;padding:20px 24px;margin-bottom:24px;">' +
              '<div style="margin-bottom:8px;"><strong style="color:#343434;">Location:</strong> <span style="color:#666;">' + redacted + '</span></div>' +
              '<div style="margin-bottom:8px;"><strong style="color:#343434;">Target date:</strong> <span style="color:#666;">' + dateStr + '</span></div>' +
              '<div><strong style="color:#343434;">Deadline:</strong> <span style="color:#666;">' + deadline.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '</span></div>' +
            '</div>' +
            '<a href="' + bidUrl + '" style="display:inline-block;background:#080808;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:500;">Submit Your Bid</a>' +
            '<p style="color:#999;font-size:13px;margin-top:24px;">This link is unique to you. Do not share it.</p>'
          )
        );
      } catch (emailErr) { console.log('Email skipped for', provider.email); }
    }
  }

  return { schedule: schedule, jobIds: jobIds };
}

// === STAGE EMAIL NOTIFICATIONS ===
async function sendStageEmail(project, stage, updates, accessToken) {
  var agentEmail = project.agentEmail;
  if (!agentEmail) return;

  var agentName = project.agentName || '';
  var firstName = agentName.split(' ')[0] || 'there';
  var address = project.address || 'your property';

  var stageLabels = {
    quote_received: 'Quote Received',
    vendors_scheduled: 'Vendors Scheduled',
    prep_in_progress: 'Listing Prep Underway',
    photos_ready: 'Photos Are Ready',
    market_ready: 'Market Ready!',
  };

  var subjects = {
    vendors_scheduled: 'Vendors Scheduled — ' + address,
    prep_in_progress: 'Listing Prep Underway — ' + address,
    photos_ready: 'Photos Are Ready — ' + address,
    market_ready: 'Market Ready! — ' + address,
  };

  var subject = subjects[stage];
  if (!subject) return; // No email for quote_received (sent separately on create)

  var stageMessages = {
    vendors_scheduled: 'Great news! Your vendors have been scheduled and everything is on track. Here\'s your timeline:',
    prep_in_progress: 'Your listing prep is underway. Our vendors are hard at work getting your property market-ready.',
    photos_ready: 'Your listing photos are ready! Your property is looking great and almost ready to hit the market.',
    market_ready: 'Congratulations! Your listing is fully prepped and market-ready. Time to go live!',
  };

  var content = '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">' + stageLabels[stage] + '</h2>' +
    '<p style="color:#666;font-size:15px;line-height:1.6;margin-bottom:24px;">Hi ' + firstName + ', ' + stageMessages[stage] + '</p>';

  // Property info box
  content += '<div style="background:#f7f7f7;border-radius:12px;padding:20px 24px;margin-bottom:24px;">' +
    '<div style="margin-bottom:8px;"><strong style="color:#343434;">Property:</strong> <span style="color:#666;">' + address + '</span></div>';

  if (project.installDate) {
    content += '<div style="margin-bottom:8px;"><strong style="color:#343434;">Install date:</strong> <span style="color:#666;">' + project.installDate + '</span></div>';
  }

  // Show schedule if available (for vendors_scheduled)
  if (stage === 'vendors_scheduled' && updates.schedule) {
    var schedule = {};
    try { schedule = JSON.parse(updates.schedule); } catch (e) {}
    var schedKeys = Object.keys(schedule);
    if (schedKeys.length > 0) {
      content += '<div style="margin-top:12px;padding-top:12px;border-top:1px solid #e0e0e0;">';
      content += '<strong style="color:#343434;display:block;margin-bottom:8px;">Schedule:</strong>';
      schedKeys.forEach(function(key) {
        var item = schedule[key];
        content += '<div style="margin-bottom:4px;color:#666;">' + item.label + ': ' + item.date + '</div>';
      });
      content += '</div>';
    }
  }

  content += '</div>';

  // Stage progress indicator
  var stages = ['quote_received', 'vendors_scheduled', 'prep_in_progress', 'photos_ready', 'market_ready'];
  var currentIdx = stages.indexOf(stage);
  content += '<div style="margin-bottom:24px;">';
  stages.forEach(function(s, idx) {
    var done = idx <= currentIdx;
    var color = done ? '#080808' : '#ddd';
    var textColor = done ? '#080808' : '#999';
    content += '<div style="display:inline-block;text-align:center;margin-right:8px;">';
    content += '<div style="width:24px;height:24px;border-radius:50%;background:' + color + ';display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:600;">' + (idx + 1) + '</div>';
    content += '<div style="font-size:10px;color:' + textColor + ';margin-top:2px;">' + stageLabels[s].split(' ')[0] + '</div>';
    content += '</div>';
    if (idx < stages.length - 1) {
      content += '<div style="display:inline-block;width:20px;height:2px;background:' + (idx < currentIdx ? '#080808' : '#ddd') + ';vertical-align:middle;margin:0 2px;"></div>';
    }
  });
  content += '</div>';

  // Market ready gets a green success box
  if (stage === 'market_ready') {
    content += '<div style="background:#ECFDF3;border-radius:12px;padding:20px 24px;margin-bottom:24px;">' +
      '<div style="color:#067647;font-weight:600;font-size:16px;margin-bottom:4px;">Your listing is market-ready!</div>' +
      '<div style="color:#343434;font-size:14px;">All prep work is complete. Your property is staged, cleaned, and photographed.</div>' +
    '</div>';
  }

  content += '<a href="https://guesthouseprep.com/dashboard" style="display:inline-block;background:#080808;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:500;">View Dashboard</a>';

  await fb.sendEmail(agentEmail, subject, emailWrap(content));
}
