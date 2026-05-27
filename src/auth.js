// Parses USERS env var: "alice:pass123:locationId;bob:pass456:locationId2"
function parseUsers() {
  const raw = process.env.USERS || '';
  const users = {};
  for (const entry of raw.split(';')) {
    const parts = entry.trim().split(':');
    if (parts.length < 3) continue;
    const username = parts[0].trim();
    const password = parts[1].trim();
    // locationId may contain colons (gid://shopify/Location/xxx) so rejoin
    const locationId = parts.slice(2).join(':').trim();
    const normalised = normaliseLocationId(locationId);
    users[username] = { username, password, locationId: normalised };
  }
  return users;
}

function normaliseLocationId(id) {
  if (!id) return '';
  id = id.trim();
  return id.startsWith('gid://') ? id : `gid://shopify/Location/${id}`;
}

function authenticate(username, password) {
  const users = parseUsers();
  const user = users[username];
  if (!user) return null;
  if (user.password !== password) return null;
  return user;
}

function getWarehouseLocationId() {
  return normaliseLocationId(process.env.WAREHOUSE_LOCATION_ID || '');
}

function getAllowedLocationIds() {
  const raw = process.env.ALLOWED_LOCATION_IDS || '';
  return raw.split(',').map(s => normaliseLocationId(s)).filter(Boolean);
}

module.exports = { authenticate, getWarehouseLocationId, getAllowedLocationIds, normaliseLocationId };
