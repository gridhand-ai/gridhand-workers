# GRIDHAND Review Closer

Automated review generation worker for auto/trades shops.

Connects **Tekmetric** (shop management) + **Google Business Profile** + **Twilio SMS** to close the loop between completed repair orders and online reviews.

---

## What It Does

1. **Listens** for `repair_order.completed` webhook from Tekmetric
2. **Waits 2 hours** (Bull/Redis delayed queue), then sends a personalized SMS:
   > *"Hey John, hope the 2019 Toyota Camry is running smooth! If we earned it, a quick review means a lot → [link]"*
3. **Polls Google Business Profile every 15 minutes** for new reviews
4. **4–5 star review** → auto-replies with a personalized thank-you via Google Business API
5. **1–3 star review** → instant SMS alert to shop owner with review text and rating

---

## Architecture

```
Tekmetric Webhook
      │
      ▼
POST /webhook/tekmetric
      │
      ▼
review-closer worker         ← validates shop, extracts RO data
      │
      ▼
Bull Queue (Redis)           ← 2-hour delay
      │
      ▼
Twilio SMS → customer

─────────────────────────────

node-cron (every 15m)
      │
      ▼
Google Business API          ← listReviews()
      │
      ├─ 4–5 ★ → replyToReview() via GBP API
      └─ 1–3 ★ → Twilio SMS → shop owner
```

---

## Prerequisites

- **Node.js** 18+
- **Redis** (local or hosted — Railway, Upstash, etc.)
- **Supabase** project
- **Tekmetric** account with API access + webhook configuration
- **Google Cloud** service account with Google Business Profile API enabled
- **Twilio** account with a phone number

---

## Setup

### 1. Install dependencies

```bash
cd review-closer
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in all values in `.env`. See the comments in `.env.example` for guidance.

### 3. Set up the database

Run `src/db/schema.sql` in your Supabase SQL editor:

1. Go to your Supabase project → SQL Editor
2. Paste the contents of `src/db/schema.sql`
3. Click Run

### 4. Configure Google Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create or select a project
3. Enable the **Google My Business API** (also called Google Business Profile API)
4. Create a **Service Account** → generate a JSON key file
5. In **Google Business Profile Manager**, grant the service account access to your location
6. Either:
   - Set `GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./google-service-account.json` and place the key file there
   - OR base64-encode the JSON and set `GOOGLE_SERVICE_ACCOUNT_KEY_JSON=<base64>`

### 5. Configure Tekmetric Webhook

In your Tekmetric dashboard:
1. Go to Settings → API / Webhooks
2. Add a new webhook pointing to: `https://your-domain.com/webhook/tekmetric`
3. Select the `repair_order.completed` event (or `Repair Order Closed`)
4. Copy the webhook secret and set `TEKMETRIC_WEBHOOK_SECRET` in your `.env`

### 6. Onboard a shop

Insert a shop record into Supabase. Either via SQL or the Supabase dashboard:

```sql
INSERT INTO shops (
  name,
  tekmetric_shop_id,
  google_location_id,
  google_review_url,
  owner_phone,
  owner_name
) VALUES (
  'Acme Auto Repair',
  '12345',                                          -- from Tekmetric
  'accounts/123456789/locations/987654321',         -- from GBP dashboard URL
  'https://g.page/r/YOUR_REVIEW_SHORT_LINK/review', -- short review link
  '+15551234567',                                   -- owner E.164 phone
  'Mike'
);
```

To find your `google_location_id`: open Google Business Profile dashboard → the URL contains the account and location IDs.

To get your review short link: in Google Business Profile → Get more reviews → copy the link.

### 7. Run

```bash
# Development
npm run dev

# Production
npm start
```

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/webhook/tekmetric` | Signature | Receives Tekmetric RO events |
| `GET` | `/health` | None | Health check |
| `GET` | `/status` | API key | Queue + monitor stats |
| `POST` | `/admin/run-monitor` | API key | Manually trigger review check |

For admin endpoints, send `X-Api-Key: <GRIDHAND_API_KEY>` header.

---

## Environment Variables

See `.env.example` for the full list with descriptions.

| Variable | Required | Description |
|----------|----------|-------------|
| `TEKMETRIC_API_KEY` | ✅ | Tekmetric bearer token |
| `TEKMETRIC_BASE_URL` | ✅ | API base (sandbox vs production) |
| `TEKMETRIC_WEBHOOK_SECRET` | Recommended | HMAC signature validation |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | One of two | Path to GCP service account JSON |
| `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` | One of two | Base64-encoded service account JSON |
| `TWILIO_ACCOUNT_SID` | ✅ | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | ✅ | Twilio auth token |
| `TWILIO_FROM_NUMBER` | ✅ | Sending phone number (E.164) |
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service role key |
| `REDIS_URL` | ✅ | Redis connection URL |
| `REVIEW_REQUEST_DELAY_HOURS` | — | Hours before SMS (default: 2) |
| `REVIEW_MONITOR_INTERVAL_MINUTES` | — | Poll interval (default: 15) |
| `GRIDHAND_API_KEY` | Recommended | Admin endpoint protection |

---

## File Structure

```
review-closer/
├── src/
│   ├── index.js                  Express server + webhook + cron
│   ├── workers/
│   │   └── review-closer.js      Webhook handler — orchestrates the flow
│   ├── integrations/
│   │   ├── tekmetric.js          Tekmetric API client
│   │   ├── google-business.js    Google Business Profile API client
│   │   └── twilio-sms.js         Twilio SMS wrapper
│   ├── services/
│   │   ├── review-request.js     Bull queue + SMS sending logic
│   │   └── review-monitor.js     Google review polling + response/alert logic
│   ├── db/
│   │   ├── supabase.js           Supabase client + all DB operations
│   │   └── schema.sql            Table definitions (run once in Supabase)
│   ├── config/
│   │   └── index.js              Env var loading + validation
│   └── utils/
│       └── templates.js          SMS + review reply message templates
├── .env.example
├── package.json
└── README.md
```

---

## Deployment (Railway)

```bash
# Set environment variables in Railway dashboard, then:
railway up
```

Redis: add a Redis plugin in your Railway project and set `REDIS_URL` from the plugin's connection string.

---

## Testing

To test the full flow locally:

1. Start Redis: `docker run -p 6379:6379 redis:alpine`
2. Start the server: `npm run dev`
3. Simulate a Tekmetric webhook:

```bash
curl -X POST http://localhost:3001/webhook/tekmetric \
  -H "Content-Type: application/json" \
  -d '{
    "event": "repair_order.completed",
    "shopId": "12345",
    "id": "RO-99999",
    "customer": {
      "firstName": "John",
      "lastName": "Smith",
      "phone": "5551234567"
    },
    "vehicle": { "year": 2019, "make": "Toyota", "model": "Camry" },
    "jobs": [{ "name": "Oil Change" }, { "name": "Tire Rotation" }]
  }'
```

4. Check queue status: `curl http://localhost:3001/status -H "X-Api-Key: your_key"`
5. Manually run review monitor: `curl -X POST http://localhost:3001/admin/run-monitor -H "X-Api-Key: your_key"`
