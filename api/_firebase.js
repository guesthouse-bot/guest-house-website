var crypto = require('crypto');

// Parse service account from env
function getServiceAccount() {
  var saB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!saB64) throw new Error('Firebase service account not configured');
  return JSON.parse(Buffer.from(saB64, 'base64').toString('utf-8'));
}

// Generate a Google access token from service account credentials
async function getAccessToken(serviceAccount) {
  var now = Math.floor(Date.now() / 1000);
  var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  var payload = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/datastore',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');

  var sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + payload);
  var signature = sign.sign(serviceAccount.private_key, 'base64url');
  var jwt = header + '.' + payload + '.' + signature;

  var response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
  });

  var data = await response.json();
  return data.access_token;
}

var PROJECT_ID = 'guesthouse-cms';
var BASE_URL = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents';

// Firestore REST helpers
async function firestoreRequest(method, path, body, accessToken) {
  var url = BASE_URL + path;
  var opts = {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  var response = await fetch(url, opts);
  if (!response.ok) {
    var err = await response.json();
    throw new Error(err.error ? err.error.message : 'Firestore API error (' + response.status + ')');
  }
  return response.json();
}

// Create a document in a collection
async function createDocument(collection, fields, accessToken) {
  var body = { fields: toFirestoreFields(fields) };
  return firestoreRequest('POST', '/' + collection, body, accessToken);
}

// Get a document by full path (e.g. "jobs/docId")
async function getDocument(path, accessToken) {
  return firestoreRequest('GET', '/' + path, null, accessToken);
}

// Update specific fields on a document
async function updateDocument(path, fields, accessToken) {
  var mask = Object.keys(fields).map(function(k) { return 'updateMask.fieldPaths=' + k; }).join('&');
  var url = BASE_URL + '/' + path + '?' + mask;
  var response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: toFirestoreFields(fields) }),
  });
  if (!response.ok) {
    var err = await response.json();
    throw new Error(err.error ? err.error.message : 'Firestore update error');
  }
  return response.json();
}

// Run a structured query
async function runQuery(collection, filters, accessToken, orderBy, limit) {
  var query = {
    structuredQuery: {
      from: [{ collectionId: collection }],
    },
  };

  if (filters && filters.length > 0) {
    if (filters.length === 1) {
      query.structuredQuery.where = { fieldFilter: filters[0] };
    } else {
      query.structuredQuery.where = {
        compositeFilter: {
          op: 'AND',
          filters: filters.map(function(f) { return { fieldFilter: f }; }),
        },
      };
    }
  }

  if (orderBy) {
    query.structuredQuery.orderBy = [{ field: { fieldPath: orderBy.field }, direction: orderBy.direction || 'ASCENDING' }];
  }

  if (limit) {
    query.structuredQuery.limit = limit;
  }

  var url = BASE_URL + ':runQuery';
  var response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(query),
  });

  if (!response.ok) {
    var err = await response.json();
    throw new Error(err.error ? err.error.message : 'Firestore query error');
  }

  var data = await response.json();
  return data.filter(function(item) { return item.document; });
}

// Generate a secure random token
function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

// Convert plain JS object to Firestore field format
function toFirestoreFields(obj) {
  var fields = {};
  Object.keys(obj).forEach(function(key) {
    var val = obj[key];
    if (val === null || val === undefined) {
      fields[key] = { nullValue: null };
    } else if (typeof val === 'number') {
      if (Number.isInteger(val)) {
        fields[key] = { integerValue: val };
      } else {
        fields[key] = { doubleValue: val };
      }
    } else if (typeof val === 'boolean') {
      fields[key] = { booleanValue: val };
    } else if (val instanceof Date) {
      fields[key] = { timestampValue: val.toISOString() };
    } else if (typeof val === 'string') {
      // Check if it looks like an ISO timestamp
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(val)) {
        fields[key] = { timestampValue: val };
      } else {
        fields[key] = { stringValue: val };
      }
    } else {
      fields[key] = { stringValue: String(val) };
    }
  });
  return fields;
}

// Convert Firestore document fields to plain JS object
function fromFirestoreFields(fields) {
  var obj = {};
  Object.keys(fields).forEach(function(key) {
    var val = fields[key];
    if ('stringValue' in val) obj[key] = val.stringValue;
    else if ('integerValue' in val) obj[key] = parseInt(val.integerValue, 10);
    else if ('doubleValue' in val) obj[key] = val.doubleValue;
    else if ('booleanValue' in val) obj[key] = val.booleanValue;
    else if ('timestampValue' in val) obj[key] = val.timestampValue;
    else if ('nullValue' in val) obj[key] = null;
    else obj[key] = null;
  });
  return obj;
}

// Extract document ID from full Firestore document name
function docId(docName) {
  return docName.split('/').pop();
}

// Redact street address — "123 Main St, Denver, CO 80202" → "Denver, CO 80202"
function redactAddress(address) {
  if (!address) return '';
  var parts = address.split(',');
  if (parts.length >= 2) {
    return parts.slice(1).join(',').trim();
  }
  return address;
}

// Send email via SendGrid
async function sendEmail(to, subject, htmlContent) {
  var apiKey = process.env.SENDGRID_API_KEY;
  var fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@guesthouseshop.com';
  if (!apiKey) {
    console.warn('SENDGRID_API_KEY not set — skipping email to ' + to);
    return;
  }

  var response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: fromEmail, name: 'Guest House' },
      subject: subject,
      content: [{ type: 'text/html', value: htmlContent }],
    }),
  });

  if (!response.ok) {
    var errText = await response.text();
    console.error('SendGrid error (' + response.status + '): ' + errText);
  }
}

// Standard CORS headers for API endpoints
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = {
  getServiceAccount: getServiceAccount,
  getAccessToken: getAccessToken,
  firestoreRequest: firestoreRequest,
  createDocument: createDocument,
  getDocument: getDocument,
  updateDocument: updateDocument,
  runQuery: runQuery,
  generateToken: generateToken,
  toFirestoreFields: toFirestoreFields,
  fromFirestoreFields: fromFirestoreFields,
  docId: docId,
  redactAddress: redactAddress,
  sendEmail: sendEmail,
  setCors: setCors,
  BASE_URL: BASE_URL,
};
