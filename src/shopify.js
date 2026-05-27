const fetch = require('node-fetch');

function getEndpoint() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const version = process.env.SHOPIFY_API_VERSION || '2024-10';
  return `https://${domain}/admin/api/${version}/graphql.json`;
}

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(getEndpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API error ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function getOrderByName(orderName) {
  const name = orderName.startsWith('#') ? orderName : `#${orderName}`;
  const data = await shopifyGraphQL(`
    query GetOrder($query: String!) {
      orders(first: 1, query: $query) {
        edges {
          node {
            id
            name
            displayFulfillmentStatus
            createdAt
            customer { displayName email }
            fulfillmentOrders(first: 20, query: "status:open OR status:in_progress OR status:on_hold") {
              edges {
                node {
                  id
                  status
                  assignedLocation {
                    name
                    location { id name }
                  }
                  lineItems(first: 50) {
                    edges {
                      node {
                        id
                        totalQuantity
                        remainingQuantity
                        variant {
                          id
                          title
                          sku
                          product {
                            title
                            featuredImage { url }
                          }
                          inventoryItem { id }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `, { query: `name:${name}` });

  return data?.orders?.edges?.[0]?.node || null;
}

async function getLocations(allowedIds = []) {
  const data = await shopifyGraphQL(`
    query {
      locations(first: 50, includeInactive: false) {
        edges {
          node {
            id
            name
            isActive
            address { city countryCode }
          }
        }
      }
    }
  `);

  let locations = data.locations.edges.map(e => e.node);
  if (allowedIds.length) {
    locations = locations.filter(l => allowedIds.includes(l.id));
  }
  return locations;
}

async function getInventoryLevels(inventoryItemIds) {
  if (!inventoryItemIds.length) return {};

  const data = await shopifyGraphQL(`
    query GetInventory($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on InventoryItem {
          id
          inventoryLevels(first: 50) {
            edges {
              node {
                location { id name }
                quantities(names: ["available"]) {
                  name
                  quantity
                }
              }
            }
          }
        }
      }
    }
  `, { ids: inventoryItemIds });

  const result = {};
  for (const node of data.nodes || []) {
    if (!node) continue;
    result[node.id] = {};
    for (const edge of node.inventoryLevels?.edges || []) {
      const locId = edge.node.location.id;
      const avail = edge.node.quantities?.find(q => q.name === 'available')?.quantity ?? 0;
      result[node.id][locId] = avail;
    }
  }
  return result;
}

// Use fulfillmentOrderMove with fulfillmentOrderLineItems parameter
// This is Shopify's RECOMMENDED way to move specific items at specific quantities
// — it handles the split internally and atomically.
//
// When fulfillmentOrderLineItems is provided:
//   - Only those items at those quantities are moved
//   - Shopify auto-splits internally if needed
//   - Returns movedFulfillmentOrder (containing moved items)
//   - Returns originalFulfillmentOrder (containing the items that stayed behind)
//   - Returns remainingFulfillmentOrder (if any items couldn't be moved due to constraints)
//
// When fulfillmentOrderLineItems is omitted:
//   - Entire FO moves
async function moveFulfillmentItems(fulfillmentOrderId, lineItems, locationId) {
  // Build variables — only include fulfillmentOrderLineItems if we have specific items
  const variables = {
    id: fulfillmentOrderId,
    newLocationId: locationId,
  };

  if (lineItems && lineItems.length > 0) {
    variables.fulfillmentOrderLineItems = lineItems.map(li => ({
      id: li.id,
      quantity: li.quantity,
    }));
  }

  // Build query with conditional parameter
  const hasLineItems = lineItems && lineItems.length > 0;
  const query = `
    mutation FulfillmentOrderMove($id: ID!, $newLocationId: ID!${hasLineItems ? ', $fulfillmentOrderLineItems: [FulfillmentOrderLineItemInput!]' : ''}) {
      fulfillmentOrderMove(
        id: $id
        newLocationId: $newLocationId
        ${hasLineItems ? 'fulfillmentOrderLineItems: $fulfillmentOrderLineItems' : ''}
      ) {
        movedFulfillmentOrder {
          id
          status
          assignedLocation { name }
          lineItems(first: 50) {
            edges { node { id totalQuantity remainingQuantity } }
          }
        }
        originalFulfillmentOrder {
          id
          status
          assignedLocation { name }
          lineItems(first: 50) {
            edges { node { id totalQuantity remainingQuantity } }
          }
        }
        remainingFulfillmentOrder {
          id
          status
          assignedLocation { name }
          lineItems(first: 50) {
            edges { node { id totalQuantity remainingQuantity } }
          }
        }
        userErrors { field message }
      }
    }
  `;

  console.log(`MOVE call: foId=${fulfillmentOrderId} to=${locationId} items=${JSON.stringify(lineItems)}`);

  const data = await shopifyGraphQL(query, variables);

  const errors = data.fulfillmentOrderMove?.userErrors || [];
  if (errors.length) throw new Error(`Move failed: ${errors.map(e => e.message).join(', ')}`);

  const moved = data.fulfillmentOrderMove?.movedFulfillmentOrder;
  const original = data.fulfillmentOrderMove?.originalFulfillmentOrder;
  const remaining = data.fulfillmentOrderMove?.remainingFulfillmentOrder;

  console.log(`MOVE result:`);
  console.log(`  moved FO ${moved?.id} → ${moved?.assignedLocation?.name}, items: ${moved?.lineItems?.edges?.length || 0}`);
  if (original) console.log(`  original FO ${original?.id} → ${original?.assignedLocation?.name}, items: ${original?.lineItems?.edges?.length || 0}`);
  if (remaining) console.log(`  remaining FO ${remaining?.id} → ${remaining?.assignedLocation?.name}, items: ${remaining?.lineItems?.edges?.length || 0}`);

  return {
    movedFulfillmentOrder: moved,
    originalFulfillmentOrder: original,
    remainingFulfillmentOrder: remaining,
    newFulfillmentOrderId: moved?.id,
  };
}

module.exports = { getOrderByName, getLocations, getInventoryLevels, moveFulfillmentItems };
