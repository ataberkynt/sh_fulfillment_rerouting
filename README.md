# Fulfillment Rerouter

Internal tool for store staff to reassign Shopify fulfillment orders at the line-item level — without needing admin access.

---

## What it does

- Staff enter an order number and see all line items grouped by fulfillment order
- Each item shows live stock at its currently assigned location
- Staff select items that can't be fulfilled, pick a new location, and hit **Reassign**
- The app calls `fulfillmentOrderSplit` + `fulfillmentOrderMove` via Shopify's Admin API
- No Shopify admin login required for store staff

---

## Setup

### 1. Create a Shopify custom app

1. Go to **Shopify Admin → Settings → Apps and sales channels → Develop apps**
2. Click **Create an app**, name it `Fulfillment Rerouter`
3. Under **Configuration → Admin API scopes**, enable:
   - `read_orders`
   - `write_fulfillments`
   - `read_fulfillments`
   - `read_inventory`
   - `read_locations`
4. Click **Install app**
5. Copy the **Admin API access token** (starts with `shpat_`)

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_API_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxx
SHOPIFY_API_VERSION=2024-10
ACCESS_PASSWORD=choose-a-strong-password
PORT=3000
```

> **Security note:** `ACCESS_PASSWORD` is what store staff enter to use the tool.
> Keep it secret. Rotate it if a staff member leaves.

### 3. Install dependencies and run

```bash
npm install
npm start
```

The app runs at `http://localhost:3000`

For development with auto-reload:
```bash
npm run dev
```

---

## Deployment options

### Option A — Railway (recommended, easiest)

1. Push this repo to GitHub (make sure `.env` is in `.gitignore`)
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add environment variables in the Railway dashboard (Settings → Variables)
4. Railway gives you a public HTTPS URL — share that with store staff

### Option B — Render

1. Push to GitHub
2. Go to [render.com](https://render.com) → New Web Service → connect repo
3. Set build command: `npm install`
4. Set start command: `node src/server.js`
5. Add environment variables in Render dashboard

### Option C — Your own server / VPS

```bash
# On the server:
git clone <your-repo>
cd fulfillment-rerouter
npm install
cp .env.example .env
# edit .env with your values

# Run with PM2 (keeps it alive after reboots)
npm install -g pm2
pm2 start src/server.js --name fulfillment-rerouter
pm2 save
pm2 startup
```

---

## Security

- The Shopify Admin API token lives only on the server — never sent to the browser
- Store staff authenticate with a shared `ACCESS_PASSWORD` sent as a header
- For stronger auth, replace the password check in `src/server.js` with your SSO/identity provider (Azure AD, Google Workspace, Okta, etc.)
- Restrict access by IP if your stores are on a fixed network

---

## Project structure

```
fulfillment-rerouter/
├── src/
│   ├── server.js       # Express server + API routes
│   └── shopify.js      # Shopify GraphQL queries & mutations
├── public/
│   └── index.html      # Frontend (login + rerouting UI)
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

---

## Shopify API calls used

| Operation | API call |
|-----------|----------|
| Look up order | `orders` query by name |
| Get locations | `locations` query |
| Get inventory levels | `inventoryLevels` via `InventoryItem` nodes |
| Split line items | `fulfillmentOrderSplit` mutation |
| Move to new location | `fulfillmentOrderMove` mutation |
