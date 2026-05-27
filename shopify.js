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

async function rerouteFulfillment(fulfillmentOrderId, lineItems, locationId, skipSplit) {
  // skipSplit = true when ALL line items at FULL qty are selected — no split needed, just move
  // lineItems = [] also means just move the FO directly (used for remaining FO after split)
  let finalFulfillmentOrderId = fulfillmentOrderId;
  let remainingFulfillmentOrderId = null;

  if (!skipSplit && lineItems.length > 0) {
    // Separate partial-qty items from full-qty items
    // Partial qty items need to be split off first
    // Full qty items that aren't the only items in the FO also need splitting
    const splitData = await shopifyGraphQL(`
      mutation FulfillmentOrderSplit($splits: [FulfillmentOrderSplitInput!]!) {
        fulfillmentOrderSplit(fulfillmentOrderSplits: $splits) {
          fulfillmentOrderSplits {
            fulfillmentOrder {
              id
              status
              lineItems(first: 50) {
                edges { node { id totalQuantity } }
              }
            }
            remainingFulfillmentOrder { id status }
          }
          userErrors { field message }
        }
      }
    `, {
      splits: [{ fulfillmentOrderId, fulfillmentOrderLineItems: lineItems }],
    });

    const splitErrors = splitData.fulfillmentOrderSplit?.userErrors || [];
    if (splitErrors.length) throw new Error(`Split failed: ${splitErrors.map(e => e.message).join(', ')}`);

    const splitResult = splitData.fulfillmentOrderSplit?.fulfillmentOrderSplits?.[0];
    finalFulfillmentOrderId = splitResult?.fulfillmentOrder?.id;
    remainingFulfillmentOrderId = splitResult?.remainingFulfillmentOrder?.id;

    if (!finalFulfillmentOrderId) throw new Error('Could not identify the split fulfillment order ID');
  }

  // Move the split (or whole) FO to the new location
  const moveData = await shopifyGraphQL(`
    mutation FulfillmentOrderMove($id: ID!, $newLocationId: ID!) {
      fulfillmentOrderMove(id: $id, newLocationId: $newLocationId) {
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
        userErrors { field message }
      }
    }
  `, { id: finalFulfillmentOrderId, newLocationId: locationId });

  const moveErrors = moveData.fulfillmentOrderMove?.userErrors || [];
  if (moveErrors.length) throw new Error(`Move failed: ${moveErrors.map(e => e.message).join(', ')}`);

  const moved = moveData.fulfillmentOrderMove?.movedFulfillmentOrder;
  const original = moveData.fulfillmentOrderMove?.originalFulfillmentOrder;
  
  console.log(`Move result - moved FO: ${moved?.id} at ${moved?.assignedLocation?.name}, items: ${moved?.lineItems?.edges?.length}`);
  if (original) console.log(`Original FO remaining: ${original?.id} at ${original?.assignedLocation?.name}, items: ${original?.lineItems?.edges?.length}`);

  // If Shopify returned an originalFulfillmentOrder, it means not all items could move
  // (e.g. inventory not stocked at destination for some items). We need to flag this.
  if (original && original.lineItems?.edges?.length > 0) {
    const movedCount = moved?.lineItems?.edges?.length || 0;
    const stuckCount = original.lineItems.edges.length;
    console.warn(`WARNING: ${stuckCount} line item(s) could not move and remain in original FO`);
  }

  return {
    movedFulfillmentOrder: moved,
    newFulfillmentOrderId: finalFulfillmentOrderId,
    remainingFulfillmentOrderId,
    originalFulfillmentOrder: original,
  };
}


module.exports = { getOrderByName, getLocations, getInventoryLevels, rerouteFulfillment };
