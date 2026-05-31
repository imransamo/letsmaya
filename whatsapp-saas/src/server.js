// ─────────────────────────────────────────────────────────────────────────────
// server.js — Express app wiring everything together
//
//   • Landing page + signup/login            (public)
//   • Tenant dashboard API (JWT cookie auth)  (private, scoped per tenant)
//   • Meta WhatsApp webhook                    (verify + receive)
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");

const { Tenants, Bots, Conversations, Messages, Leads, flush } = require("./db");
const { buildPrompt, listIndustries } = require("./templates");
const { handleInbound, parseMetaWebhook } = require("./engine");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "..", "public")));

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function sign(tenant) {
  return jwt.sign({ id: tenant.id, email: tenant.email }, JWT_SECRET, { expiresIn: "30d" });
}
function auth(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "not logged in" });
  try {
    req.tenant = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "invalid session" });
  }
}
// Ensure a bot belongs to the logged-in tenant (prevents cross-tenant access).
function ownBot(req, res, next) {
  const bot = Bots.byId(req.params.botId);
  if (!bot || bot.tenant_id !== req.tenant.id) return res.status(404).json({ error: "not found" });
  req.bot = bot;
  next();
}


// ─── Public legal/compliance pages required by Meta ──────────────────────────
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://letsmaya.com";
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "support@letsmaya.com";
const META_API_VERSION = process.env.META_API_VERSION || "v21.0";
const META_APP_ID = process.env.META_APP_ID || "1540959850756893";
const META_CONFIG_ID = process.env.META_CONFIG_ID || "2301673067305775";
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const DEFAULT_VERIFY_TOKEN = process.env.GLOBAL_VERIFY_TOKEN || "letsmaya_verify_123";

async function graphFetch(pathname, { method = "GET", accessToken, body } = {}) {
  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}${pathname}`);
  if (accessToken) url.searchParams.set("access_token", accessToken);
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data?.error?.message || `Graph API request failed: ${response.status}`;
    throw new Error(msg);
  }
  return data;
}

function legalPage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | LetsMaya</title><style>body{font-family:Arial,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;line-height:1.65;color:#10211f}h1,h2{line-height:1.2}a{color:#0f4f47}</style></head><body><p><a href="/">← Back to LetsMaya</a></p>${body}</body></html>`;
}

app.get("/privacy", (_req, res) => {
  res.type("html").send(legalPage("Privacy Policy", `
    <h1>Privacy Policy</h1>
    <p>Last updated: 31 May 2026</p>
    <p>LetsMaya provides WhatsApp AI agent tools for businesses. We collect account details, business settings, WhatsApp connection details, messages, leads, and usage information needed to run the service.</p>
    <h2>How we use data</h2>
    <p>We use data to authenticate users, operate WhatsApp automation, display conversations and leads, improve the service, provide support, and meet legal or security requirements.</p>
    <h2>WhatsApp and Meta data</h2>
    <p>When a business connects WhatsApp, we process message data and WhatsApp business identifiers only to provide the service requested by that business.</p>
    <h2>Sharing</h2>
    <p>We do not sell user data. We may share data with service providers needed for hosting, messaging, AI processing, analytics, security, and legal compliance.</p>
    <h2>Data deletion</h2>
    <p>Users can request deletion by visiting <a href="/data-deletion">/data-deletion</a> or emailing ${CONTACT_EMAIL}.</p>
    <h2>Contact</h2>
    <p>For privacy questions, contact ${CONTACT_EMAIL}.</p>
  `));
});

app.get("/terms", (_req, res) => {
  res.type("html").send(legalPage("Terms of Service", `
    <h1>Terms of Service</h1>
    <p>Last updated: 31 May 2026</p>
    <p>LetsMaya is a WhatsApp AI agent platform for businesses. By using the service, you agree to use it lawfully and only for businesses you are authorised to manage.</p>
    <h2>Customer responsibility</h2>
    <p>You are responsible for your business content, WhatsApp templates, customer communications, and compliance with applicable laws and Meta/WhatsApp policies.</p>
    <h2>Service availability</h2>
    <p>We aim to keep the service available, but we do not guarantee uninterrupted operation. Third-party services such as Meta, WhatsApp, AI providers, hosting, and payment providers may affect availability.</p>
    <h2>AI replies</h2>
    <p>AI-generated replies may require review. Businesses should monitor important customer conversations and avoid using the service for emergency, medical, legal, or financial advice without proper human oversight.</p>
    <h2>Contact</h2>
    <p>For support, contact ${CONTACT_EMAIL}.</p>
  `));
});

app.get("/data-deletion", (_req, res) => {
  res.type("html").send(legalPage("Data Deletion", `
    <h1>Data Deletion Instructions</h1>
    <p>You can request deletion of your LetsMaya account and related data by emailing ${CONTACT_EMAIL} from your registered email address.</p>
    <p>Please include your business name and the WhatsApp number connected to your account. We will review and process valid requests as soon as reasonably possible.</p>
  `));
});

// Meta Data Deletion Callback. Meta may POST a signed_request here. We return a
// confirmation code and status URL, which is the response format Meta expects.
app.post("/data-deletion", (req, res) => {
  const confirmation = `delete-${Date.now().toString(36)}`;
  console.log("Meta data deletion request received", { hasSignedRequest: !!req.body?.signed_request, confirmation });
  res.json({ url: `${PUBLIC_BASE_URL}/data-deletion?code=${confirmation}`, confirmation_code: confirmation });
});

app.get("/auth/facebook/deauthorize", (_req, res) => {
  res.type("html").send(legalPage("Facebook Deauthorization", `
    <h1>Facebook Deauthorization</h1>
    <p>This endpoint is active. If you disconnect LetsMaya from Meta, related access may be removed and you can request deletion at <a href="/data-deletion">/data-deletion</a>.</p>
  `));
});

app.post("/auth/facebook/deauthorize", (req, res) => {
  console.log("Facebook deauthorize callback received", { hasSignedRequest: !!req.body?.signed_request });
  res.json({ ok: true });
});

app.get("/auth/facebook/callback", (req, res) => {
  // Placeholder route for Meta OAuth / Embedded Signup redirect. Full token
  // exchange should be added when Embedded Signup is wired into the dashboard.
  res.type("html").send(legalPage("Facebook Login Connected", `
    <h1>Facebook Login Connected</h1>
    <p>This callback endpoint is active for LetsMaya. Return to the LetsMaya dashboard to continue setup.</p>
  `));
});

// ─── Public: industries list (used by signup form) ────────────────────────────
app.get("/api/industries", (_req, res) => res.json(listIndustries()));

// ─── Auth: signup / login / logout / me ───────────────────────────────────────
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "all fields required" });
  if (Tenants.byEmail(email)) return res.status(409).json({ error: "email already registered" });
  const hash = await bcrypt.hash(password, 10);
  const tenant = Tenants.create({ name, email, password_hash: hash });
  res.cookie("token", sign(tenant), { httpOnly: true, sameSite: "lax", maxAge: 2592000000 });
  res.json({ ok: true, tenant: { id: tenant.id, name: tenant.name, email: tenant.email } });
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {};
  const tenant = email && Tenants.byEmail(email);
  if (!tenant || !(await bcrypt.compare(password || "", tenant.password_hash)))
    return res.status(401).json({ error: "wrong email or password" });
  res.cookie("token", sign(tenant), { httpOnly: true, sameSite: "lax", maxAge: 2592000000 });
  res.json({ ok: true, tenant: { id: tenant.id, name: tenant.name, email: tenant.email } });
});

app.post("/api/logout", (_req, res) => { res.clearCookie("token"); res.json({ ok: true }); });
app.get("/api/me", auth, (req, res) => {
  const t = Tenants.byId(req.tenant.id);
  res.json({ id: t.id, name: t.name, email: t.email, plan: t.plan });
});

// ─── Bots: create / list / read / update ──────────────────────────────────────
app.post("/api/bots", auth, (req, res) => {
  const { business_name, industry, greeting, language, manager_phone } = req.body || {};
  if (!business_name || !industry) return res.status(400).json({ error: "business_name and industry required" });
  const system_prompt = buildPrompt(industry, { business_name });
  const bot = Bots.create({
    tenant_id: req.tenant.id, business_name, industry, system_prompt,
    greeting: greeting || "", language: language || "auto", manager_phone: manager_phone || "",
  });
  res.json(bot);
});

app.get("/api/bots", auth, (req, res) => res.json(Bots.byTenant(req.tenant.id)));

app.get("/api/bots/:botId", auth, ownBot, (req, res) => res.json(req.bot));

app.put("/api/bots/:botId", auth, ownBot, (req, res) => {
  const updated = Bots.update(req.bot.id, req.body || {});
  res.json(updated);
});

// Regenerate the system prompt from the industry template (after editing name etc.)
app.post("/api/bots/:botId/reset-prompt", auth, ownBot, (req, res) => {
  const system_prompt = buildPrompt(req.bot.industry, { business_name: req.bot.business_name });
  res.json(Bots.update(req.bot.id, { system_prompt }));
});

// ─── Dashboard data: stats, conversations, leads ──────────────────────────────
app.get("/api/bots/:botId/stats", auth, ownBot, (req, res) => res.json(Leads.stats(req.bot.id)));
app.get("/api/bots/:botId/conversations", auth, ownBot, (req, res) => res.json(Conversations.byBot(req.bot.id)));
app.get("/api/bots/:botId/conversations/:convId", auth, ownBot, (req, res) => {
  const conv = Conversations.byId(req.params.convId);
  if (!conv || conv.bot_id !== req.bot.id) return res.status(404).json({ error: "not found" });
  res.json({ conversation: conv, messages: Messages.history(conv.id, 100) });
});
app.get("/api/bots/:botId/leads", auth, ownBot, (req, res) => res.json(Leads.byBot(req.bot.id)));
app.post("/api/leads/:id/handled", auth, (req, res) => { Leads.markHandled(req.params.id); res.json({ ok: true }); });


// ─── Meta Embedded Signup config for SaaS onboarding ─────────────────────────
app.get("/api/meta/app-config", auth, (_req, res) => {
  res.json({
    appId: META_APP_ID,
    configId: META_CONFIG_ID,
    apiVersion: META_API_VERSION,
    redirectUri: `${PUBLIC_BASE_URL}/auth/facebook/callback`,
    ready: Boolean(META_APP_ID && META_CONFIG_ID),
  });
});

app.post("/api/bots/:botId/embedded-signup", auth, ownBot, async (req, res) => {
  try {
    const { code, phone_number_id, waba_id, business_id, signup_payload } = req.body || {};
    if (!code) return res.status(400).json({ error: "Missing authorization code from Meta Embedded Signup." });
    if (!META_APP_SECRET) return res.status(500).json({ error: "META_APP_SECRET is not set in Railway variables." });

    const tokenParams = new URLSearchParams({
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      code,
    });
    const tokenRes = await fetch(`https://graph.facebook.com/${META_API_VERSION}/oauth/access_token?${tokenParams}`);
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token) {
      const msg = tokenData?.error?.message || "Could not exchange Meta code for access token.";
      return res.status(400).json({ error: msg });
    }

    const accessToken = tokenData.access_token;
    let wabaId = waba_id || signup_payload?.data?.waba_id || signup_payload?.waba_id || "";
    let phoneId = phone_number_id || signup_payload?.data?.phone_number_id || signup_payload?.phone_number_id || "";
    const businessId = business_id || signup_payload?.data?.business_id || signup_payload?.business_id || "";

    let subscribeStatus = "not_attempted";
    if (wabaId) {
      try {
        await graphFetch(`/${wabaId}/subscribed_apps`, { method: "POST", accessToken });
        subscribeStatus = "subscribed";
      } catch (e) {
        subscribeStatus = `subscribe_failed: ${e.message}`;
        console.warn("WABA subscribe failed", e.message);
      }
    }

    if (!phoneId && wabaId) {
      try {
        const phones = await graphFetch(`/${wabaId}/phone_numbers`, { accessToken });
        phoneId = phones?.data?.[0]?.id || "";
      } catch (e) {
        console.warn("Could not fetch phone numbers", e.message);
      }
    }

    const updated = Bots.update(req.bot.id, {
      meta_phone_id: phoneId || req.bot.meta_phone_id,
      meta_token: accessToken,
      meta_verify_token: req.bot.meta_verify_token || DEFAULT_VERIFY_TOKEN,
      meta_waba_id: wabaId,
      meta_business_id: businessId,
      meta_embedded_status: phoneId ? "connected" : "token_saved_no_phone_id",
      meta_onboarded_at: new Date().toISOString(),
      meta_subscribe_status: subscribeStatus,
    });

    res.json({
      ok: true,
      bot: updated,
      phone_number_id: phoneId,
      waba_id: wabaId,
      business_id: businessId,
      subscribeStatus,
    });
  } catch (e) {
    console.error("embedded signup error", e);
    res.status(500).json({ error: e.message || "Embedded signup failed." });
  }
});

// ─── Test console: simulate a customer message (no WhatsApp needed) ────────────
app.post("/api/bots/:botId/test", auth, ownBot, async (req, res) => {
  const { customer, text } = req.body || {};
  const result = await handleInbound({ bot: req.bot, customer: customer || "demo-customer", text: text || "Hi" });
  res.json(result);
});

// ─── Meta webhook: verification (GET) ─────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe") {
    // Accept if it matches ANY tenant's verify token, or the global fallback.
    const global = process.env.GLOBAL_VERIFY_TOKEN;
    const matchGlobal = global && token === global;
    const matchBot = !!Bots.byVerifyToken(token);
    if (matchGlobal || matchBot) return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── Meta webhook: incoming messages (POST) ───────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // ack immediately; process async
  try {
    const msgs = parseMetaWebhook(req.body);
    for (const { phoneId, customer, text } of msgs) {
      const bot = Bots.byPhoneId(phoneId);
      if (!bot) { console.warn("no bot for phoneId", phoneId); continue; }
      await handleInbound({ bot, customer, text });
    }
  } catch (e) {
    console.error("webhook processing error:", e.message);
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 WA Agent Platform on :${PORT}`));

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { flush(); } catch {} process.exit(0); });

module.exports = app;
