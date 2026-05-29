# Saalik — WhatsApp AI Agent Platform (Starter)

A **multi-tenant SaaS** that lets you sell WhatsApp AI agents to any business —
restaurants, clinics, retail/Shopify, real estate, maintenance/home services,
and more. One deployment serves all your clients.

This is the connected starter system: **landing page + signup/login + client
dashboard + multi-tenant AI engine + Meta WhatsApp webhook**, all in one
deployable Node.js app.

---

## What's inside

| Piece | File | What it does |
|------|------|--------------|
| Data layer | `src/db.js` | Multi-tenant store (pure JS, no native deps). Swap to Postgres later by editing only this file. |
| Industry presets | `src/templates.js` | Pre-built prompts per industry + lead-tag parsing. This is what makes onboarding take minutes. |
| AI + WhatsApp engine | `src/engine.js` | Claude reply + lead detection + manager alert + Meta Cloud API send. Works in demo mode with no keys. |
| Server | `src/server.js` | Auth (JWT cookie), tenant-scoped API, Meta webhook, serves the frontend. |
| Frontend | `public/index.html` | Landing page, auth modal, dashboard (test console, leads, conversations, settings). |
| Seed | `src/seed.js` | Creates a demo account to show the product instantly. |

---

## Run it locally

```bash
npm install
npm run seed     # optional: demo@saalik.app / demo1234
npm start        # http://localhost:3000
```

Open the site, sign up (or log in with the demo account), pick an industry,
and use the **Test** tab to chat with your agent — no WhatsApp needed.

### Demo mode vs live AI
With no `ANTHROPIC_API_KEY` set, the engine returns canned-but-contextual
replies so you can demo offline. Set the key for real Claude responses.

---

## Environment variables

| Var | Needed for | Notes |
|-----|-----------|-------|
| `ANTHROPIC_API_KEY` | Real AI replies | Without it, runs in demo mode. |
| `CLAUDE_MODEL` | — | Defaults to Haiku (cheapest, right for most bots). |
| `JWT_SECRET` | Production | Set a long random string. |
| `DB_PATH` | — | Where the JSON store lives. Use a persistent volume on Railway. |
| `META_API_VERSION` | — | Defaults to `v21.0`. |
| `GLOBAL_VERIFY_TOKEN` | Optional | A fallback webhook verify token across all bots. |

---

## Going live with WhatsApp (per client)

1. Client (or you) logs in → **Settings** tab on their agent.
2. Paste from the Meta Developer app: **Phone Number ID**, **Access Token**,
   and a **Verify Token** you choose.
3. In Meta, set the webhook URL to `https://YOUR-DOMAIN/webhook` and use the
   same Verify Token.
4. Messages to that number now route to that client's agent automatically —
   the platform routes by Phone Number ID, so every client is isolated.

---

## Deploy on Railway (recommended)

1. Push this folder to a Git repo.
2. New Railway project → deploy from repo.
3. Add the env vars above. Attach a **volume** and point `DB_PATH` into it so
   data survives restarts.
4. Set the Meta webhook to your Railway URL + `/webhook`.

---

## Honest next steps before charging real money

This starter gets you to a sellable demo and first paying clients. Before you
scale past ~20–30 clients, plan for:

- **Postgres** instead of the JSON store (only `db.js` changes).
- **Billing** (Stripe / local gateway) + plan enforcement (the `plan` field
  already exists on tenants).
- **Conversation limits / rate limiting** per plan.
- **Outbound templates & broadcasts** (currently inbound-conversational only).
- **Media** (menu images, catalogs) — your original Matka Chai bot already had
  image sending; port `sendMetaImage` into `engine.js` when needed.
- **GDPR / data handling** if you target UK/EU clients.

---

## Suggested pricing (from our earlier analysis)

- **Starter (free):** 1 agent, test console, capped conversations — for trials.
- **Growth ($49/mo):** 3 agents, unlimited conversations, live WhatsApp, alerts.
- **Agency ($199/mo):** unlimited agents, white-label, resell to your own clients.

In PKR terms, charging clients PKR 8,000–20,000/mo per agent with Haiku + Cloud
API direct keeps healthy margins. Gulf clients can be billed in USD/AED.
