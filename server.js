require('dotenv').config();

const express = require('express');
const path = require('path');
const { getOrderByName, getLocations, getInventoryLevels, rerouteFulfillment } = require('./shopify');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── Simple password auth middleware ────────────────────────────────────────
// Staff send their password in every request header.
// This is lightweight but sufficient for an internal tool on a private URL.
// For stronger auth, swap this out for SSO/OAuth via your identity provider.

function requireAuth(req, res, next) {
  const password = req.headers['x-access-password'];
  if (!password || password !== process.env.ACCESS_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Health check (no auth)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, store: process.env.SHOPIFY_STORE_DOMAIN });
});

// Verify password
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ACCESS_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

// Get order details + inventory levels
app.get('/api/order/:orderName', requireAuth, async (req, res) => {
  try {
    const order = await getOrderByName(req.params.orderName);
    if (!order) {
      return res.status(404).json({ error: `Order ${req.params.orderName} not found` });
    }

    // Collect all inventory item IDs across all fulfillment order line items
    const inventoryItemIds = [];
    for (const foEdge of order.fulfillmentOrders?.edges || []) {
      for (const liEdge of foEdge.node.lineItems?.edges || []) {
        const invId = liEdge.node.variant?.inventoryItem?.id;
        if (invId) inventoryItemIds.push(invId);
      }
    }

    const inventoryByItem = await getInventoryLevels([...new Set(inventoryItemIds)]);

    res.json({ order, inventoryByItem });
  } catch (err) {
    console.error('GET /api/order error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all store locations
app.get('/api/locations', requireAuth, async (req, res) => {
  try {
    const locations = await getLocations();
    res.json({ locations });
  } catch (err) {
    console.error('GET /api/locations error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Reroute selected line items to a new location
app.post('/api/reroute', requireAuth, async (req, res) => {
  const { fulfillmentOrderId, lineItems, locationId } = req.body;

  if (!fulfillmentOrderId || !lineItems?.length || !locationId) {
    return res.status(400).json({ error: 'Missing required fields: fulfillmentOrderId, lineItems, locationId' });
  }

  try {
    const result = await rerouteFulfillment(fulfillmentOrderId, lineItems, locationId);
    res.json({ ok: true, fulfillmentOrder: result });
  } catch (err) {
    console.error('POST /api/reroute error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Catch-all: serve the frontend for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Fulfillment rerouter running on http://localhost:${PORT}`);
  console.log(`Store: ${process.env.SHOPIFY_STORE_DOMAIN}`);
});
