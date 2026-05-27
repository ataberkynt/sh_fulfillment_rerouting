require('dotenv').config();

const express = require('express');
const path = require('path');
const { getOrderByName, getLocations, getInventoryLevels, moveFulfillmentItems } = require('./shopify');
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

app.post('/api/auth', (req, res) => {
  const { username, password } = req.body;
  const user = authenticate(username, password);
  if (!user) return res.status(401).json({ error: 'Wrong username or password' });
  res.json({ ok: true, username: user.username, locationId: user.locationId });
});

app.get('/api/locations', requireUser, async (req, res) => {
  try {
    const allowed = getAllowedLocationIds();
    const warehouse = getWarehouseLocationId();
    const userLocId = req.user.locationId;

    const destinations = allowed.filter(id => id !== warehouse && id !== userLocId);
    const locations = await getLocations(destinations);

    let stockByLocation = {};
    let stockByLocationItem = {};
    const rawIds = req.query.inventoryItemIds;
    if (rawIds) {
      const ids = rawIds.split(',').filter(Boolean);
      const inv = await getInventoryLevels(ids);
      for (const loc of locations) {
        const stocks = ids.map(id => inv[id]?.[loc.id] ?? 0);
        stockByLocation[loc.id] = stocks.length ? Math.min(...stocks) : 0;
        stockByLocationItem[loc.id] = {};
        for (const id of ids) {
          stockByLocationItem[loc.id][id] = inv[id]?.[loc.id] ?? 0;
        }
      }
    }

    res.json({ locations, stockByLocation, stockByLocationItem });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/order/:orderName', requireUser, async (req, res) => {
  try {
    const order = await getOrderByName(req.params.orderName);
    if (!order) return res.status(404).json({ error: `Order ${req.params.orderName} not found` });

    const userLocId = req.user.locationId;
    const fulfillmentOrders = order.fulfillmentOrders?.edges?.map(e => e.node) || [];

    // Filter out ghost FOs with 0 remaining quantity (Shopify split remnants)
    const nonEmptyFOs = fulfillmentOrders.filter(fo => {
      const items = fo.lineItems?.edges || [];
      return items.some(e => (e.node.remainingQuantity || 0) > 0);
    });

    const classified = nonEmptyFOs.map(fo => {
      const foLocId = fo.assignedLocation?.location?.id;
      return { ...fo, access: foLocId === userLocId ? 'actionable' : 'locked' };
    });

    const hasActionable = classified.some(fo => fo.access === 'actionable');
    if (!hasActionable) {
      return res.status(403).json({
        error: 'ACCESS_DENIED',
        message: 'This order has no items assigned to your store.',
      });
    }

    const inventoryItemIds = [];
    for (const fo of classified) {
      if (fo.access !== 'actionable') continue;
      for (const liEdge of fo.lineItems?.edges || []) {
        const invId = liEdge.node.variant?.inventoryItem?.id;
        if (invId) inventoryItemIds.push(invId);
      }
    }

    const inventoryByItem = await getInventoryLevels([...new Set(inventoryItemIds)]);
    const allowed = getAllowedLocationIds();
    const allLocations = await getLocations(allowed);

    res.json({
      order: { ...order, fulfillmentOrders: { edges: classified.map(fo => ({ node: fo })) } },
      inventoryByItem,
      allLocations,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Reroute endpoint — uses fulfillmentOrderMove with fulfillmentOrderLineItems
// for atomic move-with-split. Shopify handles the split internally.
app.post('/api/reroute', requireUser, async (req, res) => {
  const { fulfillmentOrderId, lineItems, locationId, orderName, fromLocationName, toLocationName, itemDetails } = req.body;

  if (!fulfillmentOrderId || !lineItems?.length || !locationId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const warehouse = getWarehouseLocationId();
  const allowed = getAllowedLocationIds();
  const userLocId = req.user.locationId;

  // Security checks
  if (!allowed.includes(locationId)) return res.status(403).json({ error: 'Destination location not allowed' });
  if (locationId === warehouse) return res.status(403).json({ error: 'Cannot reroute to warehouse' });
  if (locationId === userLocId) return res.status(403).json({ error: 'Cannot reroute to your own store' });

  try {
    // Re-fetch order to verify FO is assigned to user's store
    const orderNameClean = orderName?.replace('#', '') || '';
    const order = await getOrderByName(orderNameClean);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const fulfillmentOrders = order.fulfillmentOrders?.edges?.map(e => e.node) || [];
    const targetFO = fulfillmentOrders.find(fo => fo.id === fulfillmentOrderId);
    if (!targetFO) return res.status(403).json({ error: 'Fulfillment order not found on this order' });

    if (targetFO.assignedLocation?.location?.id !== userLocId) {
      return res.status(403).json({ error: 'You can only reroute fulfillment orders assigned to your store' });
    }

    // Determine if we're moving the whole FO or specific items
    const foLineItemEdges = targetFO.lineItems?.edges || [];
    const foLineItemCount = foLineItemEdges.length;
    const foQtyMap = {};
    for (const e of foLineItemEdges) {
      foQtyMap[e.node.id] = e.node.remainingQuantity || e.node.totalQuantity || 0;
    }

    const allSelected = lineItems.length >= foLineItemCount;
    const allFullQty = lineItems.every(li => li.quantity >= (foQtyMap[li.id] || 0));
    const moveWholeFO = allSelected && allFullQty;

    console.log(`Reroute request: foItems=${foLineItemCount} selected=${lineItems.length} allFullQty=${allFullQty} moveWholeFO=${moveWholeFO}`);

    // Pass null (no lineItems) for whole FO move, otherwise pass the specific items
    const itemsParam = moveWholeFO ? null : lineItems;
    const result = await moveFulfillmentItems(fulfillmentOrderId, itemsParam, locationId);

    // Log the action
    logReroute({
      username: req.user.username,
      userLocationName: targetFO.assignedLocation?.name || userLocId,
      orderName: order.name,
      orderId: order.id,
      items: itemDetails || lineItems.map(li => ({ name: li.id, qty: li.quantity })),
      fromLocation: fromLocationName || targetFO.assignedLocation?.name,
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

app.get('/api/order-history/:orderName', requireUser, (req, res) => {
  const logs = getLogs({ orderName: req.params.orderName, limit: 50 });
  res.json({ logs });
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Fulfillment rerouter v2 running on http://localhost:${PORT}`);
  console.log(`Store: ${process.env.SHOPIFY_STORE_DOMAIN}`);
  console.log(`Warehouse: ${getWarehouseLocationId()}`);
});
