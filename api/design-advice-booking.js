var fb = require('./_firebase');

function emailWrap(inner) {
  return '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;">' +
    '<div style="margin-bottom:32px;"><img src="https://guesthouseprep.com/favicon.svg" alt="Guest House" width="32" height="32"></div>' +
    inner +
    '<div style="margin-top:40px;padding-top:24px;border-top:1px solid #eee;font-size:12px;color:#999;">Guest House — guesthouseprep.com</div>' +
  '</div>';
}

// Map state abbreviations to HubSpot owner IDs
var OWNER_MAP = {
  CO: { name: 'Sarah', id: null },   // Populated at runtime from HubSpot
  CA: { name: 'Ashleigh', id: null },
};

async function resolveOwners(hsHeaders) {
  try {
    var resp = await fetch('https://api.hubapi.com/crm/v3/owners?limit=100', { method: 'GET', headers: hsHeaders });
    if (!resp.ok) return;
    var data = await resp.json();
    var owners = data.results || [];
    for (var i = 0; i < owners.length; i++) {
      var first = (owners[i].firstName || '').toLowerCase();
      if (first === 'sarah') OWNER_MAP.CO.id = owners[i].id;
      if (first === 'ashleigh') OWNER_MAP.CA.id = owners[i].id;
    }
  } catch (e) { console.log('Owner lookup failed:', e.message); }
}

function detectState(address) {
  if (!address) return null;
  var upper = address.toUpperCase();
  // Check for state abbreviations
  var coPattern = /\b(CO|COLORADO)\b/;
  var caPattern = /\b(CA|CALIFORNIA)\b/;
  // Check for known CO cities
  var coCities = ['DENVER', 'BOULDER', 'AURORA', 'LAKEWOOD', 'LITTLETON', 'FORT COLLINS', 'COLORADO SPRINGS', 'ARVADA', 'BROOMFIELD', 'LONGMONT', 'LOVELAND', 'THORNTON', 'WESTMINSTER', 'CASTLE ROCK', 'PARKER', 'HIGHLANDS RANCH', 'GOLDEN', 'ERIE', 'WARD'];
  // Check for known CA cities
  var caCities = ['SAN DIEGO', 'LA JOLLA', 'CARLSBAD', 'ENCINITAS', 'OCEANSIDE', 'ESCONDIDO', 'CHULA VISTA', 'ORANGE COUNTY', 'IRVINE', 'NEWPORT BEACH', 'HUNTINGTON BEACH', 'COSTA MESA', 'LAGUNA', 'ANAHEIM', 'SANTA ANA', 'LOS ANGELES', 'SAN FRANCISCO'];
  // Check for known AZ cities
  var azCities = ['PHOENIX', 'SCOTTSDALE', 'TEMPE', 'MESA', 'CHANDLER', 'GILBERT', 'GLENDALE', 'PEORIA'];

  if (coPattern.test(upper)) return 'CO';
  if (caPattern.test(upper)) return 'CA';
  for (var i = 0; i < coCities.length; i++) { if (upper.indexOf(coCities[i]) !== -1) return 'CO'; }
  for (var j = 0; j < caCities.length; j++) { if (upper.indexOf(caCities[j]) !== -1) return 'CA'; }
  for (var k = 0; k < azCities.length; k++) { if (upper.indexOf(azCities[k]) !== -1) return 'CA'; } // AZ assigned to Ashleigh/CA team
  return null;
}

module.exports = async function handler(req, res) {
  fb.setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var body = req.body || {};
  var name = (body.name || '').trim();
  var email = (body.email || '').trim();
  var phone = (body.phone || '').trim();
  var date = (body.date || '').trim();
  var time = (body.time || '').trim();
  var address = (body.address || '').trim();

  if (!name || !email || !address) {
    return res.status(400).json({ error: 'Name, email, and address are required.' });
  }

  var hsToken = process.env.HUBSPOT_ACCESS_TOKEN;
  var hsHeaders = hsToken ? { 'Authorization': 'Bearer ' + hsToken, 'Content-Type': 'application/json' } : null;

  // Resolve owners and deal stage
  var ownerId = null;
  var state = detectState(address);

  if (hsHeaders) {
    await resolveOwners(hsHeaders);
    if (state && OWNER_MAP[state] && OWNER_MAP[state].id) {
      ownerId = OWNER_MAP[state].id;
    }
  }

  // 1. Create or update HubSpot contact
  var contactId = null;
  if (hsHeaders) {
    try {
      var firstName = name.split(' ')[0];
      var lastName = name.split(' ').slice(1).join(' ') || '';
      var contactResp = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST',
        headers: hsHeaders,
        body: JSON.stringify({
          properties: {
            firstname: firstName,
            lastname: lastName,
            email: email,
            phone: phone,
            address: address,
          },
        }),
      });

      if (contactResp.ok) {
        var contact = await contactResp.json();
        contactId = contact.id;
      } else if (contactResp.status === 409) {
        // Contact exists — extract ID from conflict response
        var conflict = await contactResp.json();
        contactId = conflict.message && conflict.message.match(/ID: (\d+)/);
        contactId = contactId ? contactId[1] : null;
      }
    } catch (e) { console.log('HubSpot contact creation skipped:', e.message); }
  }

  // 2. Create HubSpot deal in "Lead Captured" stage
  var dealId = null;
  if (hsHeaders) {
    try {
      // Lookup "Lead Captured" stage
      var stagesResp = await fetch('https://api.hubapi.com/crm/v3/pipelines/deals/default/stages', { method: 'GET', headers: hsHeaders });
      var stageId = null;
      if (stagesResp.ok) {
        var stagesData = await stagesResp.json();
        var stages = stagesData.results || stagesData;
        for (var i = 0; i < stages.length; i++) {
          var label = (stages[i].label || '').toLowerCase().trim();
          if (label === 'lead captured') { stageId = stages[i].id; break; }
        }
      }

      var dealProps = {
        dealname: 'Design Advice — ' + address,
        pipeline: 'default',
        description: 'Name: ' + name + '\nEmail: ' + email + '\nPhone: ' + phone + '\nPreferred Date: ' + date + '\nPreferred Time: ' + time + '\nAddress: ' + address + '\nSource: Design Advice Page',
      };
      if (stageId) dealProps.dealstage = stageId;
      if (ownerId) dealProps.hubspot_owner_id = ownerId;

      var dealBody = { properties: dealProps };

      // Associate with contact if we have one
      if (contactId) {
        dealBody.associations = [{
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]
        }];
      }

      var dealResp = await fetch('https://api.hubapi.com/crm/v3/objects/deals', {
        method: 'POST',
        headers: hsHeaders,
        body: JSON.stringify(dealBody),
      });

      if (dealResp.ok) {
        var deal = await dealResp.json();
        dealId = deal.id;
      } else {
        var dealErr = await dealResp.text();
        console.log('HubSpot deal creation failed:', dealResp.status, dealErr);
      }
    } catch (e) { console.log('HubSpot deal creation skipped:', e.message); }
  }

  // 3. Send email notification to Ashley
  var ownerName = (state && OWNER_MAP[state]) ? OWNER_MAP[state].name : 'Team';
  try {
    await fb.sendEmail('ashley@guesthouseshop.com', 'New Design Advice Booking — ' + name, emailWrap(
      '<h2 style="font-size:22px;font-weight:600;color:#080808;margin-bottom:16px;">New design advice booking</h2>' +
      '<div style="background:#f7f7f7;border-radius:12px;padding:20px 24px;margin-bottom:24px;">' +
        '<div style="margin-bottom:8px;"><strong style="color:#343434;">Name:</strong> <span style="color:#666;">' + name + '</span></div>' +
        '<div style="margin-bottom:8px;"><strong style="color:#343434;">Email:</strong> <span style="color:#666;">' + email + '</span></div>' +
        '<div style="margin-bottom:8px;"><strong style="color:#343434;">Phone:</strong> <span style="color:#666;">' + phone + '</span></div>' +
        '<div style="margin-bottom:8px;"><strong style="color:#343434;">Preferred Date:</strong> <span style="color:#666;">' + date + '</span></div>' +
        '<div style="margin-bottom:8px;"><strong style="color:#343434;">Preferred Time:</strong> <span style="color:#666;">' + time + '</span></div>' +
        '<div style="margin-bottom:8px;"><strong style="color:#343434;">Address:</strong> <span style="color:#666;">' + address + '</span></div>' +
        '<div><strong style="color:#343434;">Assigned to:</strong> <span style="color:#666;">' + ownerName + '</span></div>' +
      '</div>' +
      (dealId ? '<p style="color:#999;font-size:13px;">HubSpot Deal ID: ' + dealId + '</p>' : '')
    ));
  } catch (e) { console.log('Email notification failed:', e.message); }

  return res.status(200).json({ ok: true, dealId: dealId });
};
