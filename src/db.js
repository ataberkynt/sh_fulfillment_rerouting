// Pure JS append-only audit log using newline-delimited JSON (ndjson)
// No native modules needed — works on any Node environment
// Stores at /data/audit.ndjson (Railway volume) or ./audit.ndjson locally

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const LOG_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const LOG_FILE = path.join(LOG_DIR, 'audit.ndjson');

function logReroute({ username, userLocationName, orderName, orderId, items, fromLocation, toLocation, fulfillmentOrderId, newFulfillmentOrderId }) {
  const timestamp = new Date().toISOString();
  const rows = items.map(item => JSON.stringify({
    id: Date.now() + Math.random(), // pseudo-ID
    timestamp,
    username,
    user_location_name: userLocationName,
    order_name: orderName,
    order_id: orderId,
    item_name: item.name,
    variant: item.variant || '',
    sku: item.sku || '',
    qty_rerouted: item.qty,
    from_location: fromLocation,
    to_location: toLocation,
    fulfillment_order_id: fulfillmentOrderId || '',
    new_fulfillment_order_id: newFulfillmentOrderId || '',
  }));
  fs.appendFileSync(LOG_FILE, rows.join('\n') + '\n', 'utf8');
}

function getLogs({ limit = 100, offset = 0, username = null, orderName = null } = {}) {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
  let rows = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  // Filter
  if (username) rows = rows.filter(r => r.username === username);
  if (orderName) rows = rows.filter(r => r.order_name?.toLowerCase().includes(orderName.toLowerCase()));

  // Sort newest first, paginate
  rows.reverse();
  return rows.slice(offset, offset + limit);
}

function getLogCount() {
  if (!fs.existsSync(LOG_FILE)) return 0;
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
  return lines.length;
}

module.exports = { logReroute, getLogs, getLogCount };
