require('dotenv').config();

const express = require('express');
const path = require('path');
const { getOrderByName, getLocations, getInventoryLevels, rerouteFulfillment } = require('./shopify');
const { authenticate, getWarehouseLocationId, getAllowedLocationIds } = require('./auth');
const { logReroute, getLogs, getLogCount } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ──────────────────────────────────────────────────────────

function requireUser(req, res, next) {
  const username = req.headers['x-username'];
  const password = req.headers['x-password'];
  if (!username || !password) return res.status(401).json({ error: 'Unauthorized' });
  const user = authenticate(username, password);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (!pw || pw !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ ok: true, store: process.env.SHOPIFY_STORE_DOMAIN });
});

// Login — returns user info including their assigned location
app.post('/api/auth', (req, res) => {
  const { username, password } = req.body;
  const user = authenticate(username, password);
  if (!user) return res.status(401).json({ error: 'Wrong username or password' });
  res.json({ ok: true, username: user.username, locationId: user.locationId });
});

// Get allowed destination locations (excluding warehouse and user's own store)
// Optionally accepts ?inventoryItemIds=id1,id2 to return stock per location
app.get('/api/locations', requireUser, async (req, res) => {
  try {
    const allowed = getAllowedLocationIds();
    const warehouse = getWarehouseLocationId();
    const userLocId = req.user.locationId;

    const destinations = allowed.filter(id => id !== warehouse && id !== userLocId);
    const locations = await getLocations(destinations);

    // If inventory item IDs are provided, fetch stock at each destination
    let stockByLocation = {}; // { locationId: minStockAcrossItems }
    const rawIds = req.query.inventoryItemIds;
    if (rawIds) {
      const ids = rawIds.split(',').filter(Boolean);
      const inv = await getInventoryLevels(ids);
      for (const loc of locations) {
        // Use minimum stock across all requested items (limiting factor)
        const stocks = ids.map(id => inv[id]?.[loc.id] ?? 0);
        stockByLocation[loc.id] = stocks.length ? Math.min(...stocks) : 0;
      }
    }

    res.json({ locations, stockByLocation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get order — applies visibility rules based on user's location
app.get('/api/order/:orderName', requireUser, async (req, res) => {
  try {
    const order = await getOrderByName(req.params.orderName);
    if (!order) return res.status(404).json({ error: `Order ${req.params.orderName} not found` });

    const warehouse = getWarehouseLocationId();
    const userLocId = req.user.locationId;
    const fulfillmentOrders = order.fulfillmentOrders?.edges?.map(e => e.node) || [];

    // Classify each fulfillment order
    // actionable = assigned to user's store
    // locked = assigned to another store OR warehouse (visible but not editable)
    const classified = fulfillmentOrders.map(fo => {
      const foLocId = fo.assignedLocation?.location?.id;
      let access = 'locked'; // default: locked (other store or warehouse)
      if (foLocId === userLocId) access = 'actionable';
      return { ...fo, access };
    });

    // If NO fulfillment orders are actionable → block entirely
    const hasActionable = classified.some(fo => fo.access === 'actionable');
    if (!hasActionable) {
      return res.status(403).json({
        error: 'ACCESS_DENIED',
        message: 'This order has no items assigned to your store.',
      });
    }

    // Collect inventory item IDs only for actionable FOs
    const inventoryItemIds = [];
    for (const fo of classified) {
      if (fo.access !== 'actionable') continue;
      for (const liEdge of fo.lineItems?.edges || []) {
        const invId = liEdge.node.variant?.inventoryItem?.id;
        if (invId) inventoryItemIds.push(invId);
      }
    }

    const inventoryByItem = await getInventoryLevels([...new Set(inventoryItemIds)]);

    // Also fetch allowed location names for inventory display
    const allowed = getAllowedLocationIds();
    const allLocations = await getLocations(allowed);

    res.json({ order: { ...order, fulfillmentOrders: { edges: classified.map(fo => ({ node: fo })) } }, inventoryByItem, allLocations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Reroute — validates permissions then calls Shopify API
app.post('/api/reroute', requireUser, async (req, res) => {
  const { fulfillmentOrderId, lineItems, locationId, orderName, orderId, fromLocationName, toLocationName, itemDetails } = req.body;

  if (!fulfillmentOrderId || !lineItems?.length || !locationId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const warehouse = getWarehouseLocationId();
  const allowed = getAllowedLocationIds();
  const userLocId = req.user.locationId;

  // Security: destination must be in allowed list and not warehouse or user's own store
  if (!allowed.includes(locationId)) {
    return res.status(403).json({ error: 'Destination location not allowed' });
  }
  if (locationId === warehouse) {
    return res.status(403).json({ error: 'Cannot reroute to warehouse' });
  }
  if (locationId === userLocId) {
    return res.status(403).json({ error: 'Cannot reroute to your own store' });
  }

  // Security: verify the fulfillment order is actually assigned to user's store
  // We re-fetch the order to confirm — don't trust client
  try {
    const orderNameClean = orderName?.replace('#', '') || '';
    const order = await getOrderByName(orderNameClean);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const fulfillmentOrders = order.fulfillmentOrders?.edges?.map(e => e.node) || [];
    const targetFO = fulfillmentOrders.find(fo => fo.id === fulfillmentOrderId);
    if (!targetFO) return res.status(403).json({ error: 'Fulfillment order not found on this order' });

    const foLocId = targetFO.assignedLocation?.location?.id;
    if (foLocId !== userLocId) {
      return res.status(403).json({ error: 'You can only reroute fulfillment orders assigned to your store' });
    }

    // Pass FO totals so rerouteFulfillment can skip split when moving all items
    const foLineItemCount = targetFO.lineItems?.edges?.length || 0;
    const foTotalQty = (targetFO.lineItems?.edges || []).reduce((s, e) => s + (e.node.remainingQuantity || e.node.totalQuantity || 0), 0);
    const selectedQtyTotal = lineItems.reduce((s, li) => s + (li.quantity || 0), 0);
    // Only skip split when ALL line items are selected AND at their full remaining quantity
    // Any partial qty selection requires a split even if all line items are included
    const allLineItemsSelected = lineItems.length >= foLineItemCount;
    const fullQtySelected = selectedQtyTotal >= foTotalQty;
    const skipSplit = allLineItemsSelected && fullQtySelected;
    console.log(`Reroute: foItems=${foLineItemCount} selected=${lineItems.length} foQty=${foTotalQty} selectedQty=${selectedQtyTotal} skipSplit=${skipSplit}`);
    const result = await rerouteFulfillment(fulfillmentOrderId, lineItems, locationId, skipSplit ? foLineItemCount : null, skipSplit ? foTotalQty : null);

    // Log the action
    logReroute({
      username: req.user.username,
      userLocationName: targetFO.assignedLocation?.name || userLocId,
      orderName: order.name,
      orderId: order.id,
      items: itemDetails || lineItems.map(li => ({ name: li.id, qty: li.quantity })),
      fromLocation: fromLocationName || foLocId,
      toLocation: toLocationName || locationId,
      fulfillmentOrderId,
      newFulfillmentOrderId: result.newFulfillmentOrderId,
    });

    res.json({ ok: true, fulfillmentOrder: result.movedFulfillmentOrder });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Order reroute history — visible to any logged-in user for their order lookup
app.get('/api/order-history/:orderName', requireUser, (req, res) => {
  const logs = getLogs({ orderName: req.params.orderName, limit: 50 });
  res.json({ logs });
});

// ── Admin routes ─────────────────────────────────────────────────────────────

app.get('/api/admin/logs', requireAdmin, (req, res) => {
  const { limit = 100, offset = 0, username, orderName } = req.query;
  const logs = getLogs({ limit: Number(limit), offset: Number(offset), username, orderName });
  const total = getLogCount();
  res.json({ logs, total });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Fulfillment rerouter v2 running on http://localhost:${PORT}`);
  console.log(`Store: ${process.env.SHOPIFY_STORE_DOMAIN}`);
  console.log(`Warehouse: ${getWarehouseLocationId()}`);
});
