const fetch = require('node-fetch');

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

const ENDPOINT = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API error ${res.status}: ${text}`);
  }

  const json = await res.json();

  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

// Look up an order by order name (e.g. "#4521") and return
// its fulfillment orders, line items, and inventory per location
async function getOrderByName(orderName) {
  const name = orderName.startsWith('#') ? orderName : `#${orderName}`;

  const data = await shopifyGraphQL(`
    query GetOrder($query: String!) {
      orders(first: 1, query: $query) {
        edges {
          node {
            id
            name
            displayFinancialStatus
            displayFulfillmentStatus
            createdAt
            customer {
              displayName
              email
            }
            fulfillmentOrders(first: 10) {
              edges {
                node {
                  id
                  status
                  assignedLocation {
                    name
                    location {
                      id
                      name
                    }
                  }
                  lineItems(first: 50) {
                    edges {
                      node {
                        id
                        quantity
                        remainingQuantity
                        variant {
                          id
                          title
                          sku
                          product {
                            title
                            featuredImage {
                              url
                            }
                          }
                          inventoryItem {
                            id
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
    }
  `, { query: `name:${name}` });

  const orderEdge = data?.orders?.edges?.[0];
  if (!orderEdge) return null;

  return orderEdge.node;
}

// Get all active locations for the store
async function getLocations() {
  const data = await shopifyGraphQL(`
    query {
      locations(first: 50, includeInactive: false) {
        edges {
          node {
            id
            name
            isActive
            fulfillsOnlineOrders
            address {
              city
              countryCode
            }
          }
        }
      }
    }
  `);

  return data.locations.edges.map(e => e.node);
}

// Get inventory levels for a list of inventory item IDs across all locations
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
                location {
                  id
                  name
                }
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

  // Shape: { inventoryItemId: { locationId: availableQty } }
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

// Split specific line items out of a fulfillment order, then move
// the new fulfillment order to the chosen location.
//
// fulfillmentOrderId: gid://shopify/FulfillmentOrder/xxx
// lineItems: [{ id: "gid://shopify/FulfillmentOrderLineItem/xxx", quantity: N }]
// locationId: gid://shopify/Location/xxx
async function rerouteFulfillment(fulfillmentOrderId, lineItems, locationId) {
  // Step 1: Split
  const splitData = await shopifyGraphQL(`
    mutation FulfillmentOrderSplit($fulfillmentOrderId: ID!, $fulfillmentOrderLineItems: [FulfillmentOrderLineItemInput!]!) {
      fulfillmentOrderSplit(
        fulfillmentOrderId: $fulfillmentOrderId
        fulfillmentOrderLineItems: $fulfillmentOrderLineItems
      ) {
        fulfillmentOrders {
          id
          status
          lineItems(first: 50) {
            edges {
              node {
                id
                quantity
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `, {
    fulfillmentOrderId,
    fulfillmentOrderLineItems: lineItems,
  });

  const splitErrors = splitData.fulfillmentOrderSplit?.userErrors || [];
  if (splitErrors.length) {
    throw new Error(`Split failed: ${splitErrors.map(e => e.message).join(', ')}`);
  }

  // Find the newly created fulfillment order (the split-off one)
  // Shopify returns both the original (remainder) and new (split) orders.
  // The new one only contains our selected line items.
  const splitOrders = splitData.fulfillmentOrderSplit?.fulfillmentOrders || [];
  const selectedLineItemIds = new Set(lineItems.map(l => l.id));
  
  let newFulfillmentOrderId = null;
  for (const fo of splitOrders) {
    const foLineItemIds = fo.lineItems.edges.map(e => e.node.id);
    if (foLineItemIds.every(id => selectedLineItemIds.has(id))) {
      newFulfillmentOrderId = fo.id;
      break;
    }
  }

  // Fallback: just take the second order returned if heuristic fails
  if (!newFulfillmentOrderId && splitOrders.length >= 2) {
    newFulfillmentOrderId = splitOrders[splitOrders.length - 1].id;
  }

  if (!newFulfillmentOrderId) {
    throw new Error('Could not identify the split fulfillment order ID');
  }

  // Step 2: Move to new location
  const moveData = await shopifyGraphQL(`
    mutation FulfillmentOrderMove($id: ID!, $newLocationId: ID!) {
      fulfillmentOrderMove(
        id: $id
        newLocationId: $newLocationId
      ) {
        movedFulfillmentOrder {
          id
          status
          assignedLocation {
            name
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `, {
    id: newFulfillmentOrderId,
    newLocationId: locationId,
  });

  const moveErrors = moveData.fulfillmentOrderMove?.userErrors || [];
  if (moveErrors.length) {
    throw new Error(`Move failed: ${moveErrors.map(e => e.message).join(', ')}`);
  }

  return moveData.fulfillmentOrderMove?.movedFulfillmentOrder;
}

module.exports = { getOrderByName, getLocations, getInventoryLevels, rerouteFulfillment };
