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
