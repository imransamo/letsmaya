// ─────────────────────────────────────────────────────────────────────────────
// db.js — Multi-tenant data layer (pure JS, zero native deps)
//
// One store, many businesses (tenants). Everything is scoped by tenant_id so a
// single deployment serves 1 or 1,000 clients. Persists to a JSON file with
// debounced writes — fine for getting to first revenue. The exported API is the
// same shape you'd expose over Postgres, so swapping the storage engine later
// touches only this file.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data.json");

const blank = { tenants: [], bots: [], conversations: [], messages: [], leads: [] };
let store;
try {
  store = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  for (const k of Object.keys(blank)) if (!store[k]) store[k] = [];
} catch {
  store = JSON.parse(JSON.stringify(blank));
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_PATH, JSON.stringify(store), () => {});
  }, 50);
}
// Synchronous flush — used by seed scripts and graceful shutdown.
function flush() {
  clearTimeout(saveTimer);
  fs.writeFileSync(DB_PATH, JSON.stringify(store));
}

const uid = (p = "") => p + crypto.randomBytes(8).toString("hex");
const now = () => Date.now();

// ─── Tenants ──────────────────────────────────────────────────────────────────
const Tenants = {
  create({ name, email, password_hash }) {
    const t = { id: uid("ten_"), name, email: email.toLowerCase(), password_hash, plan: "trial", created_at: now() };
    store.tenants.push(t); save();
    return t;
  },
  byId: (id) => store.tenants.find((t) => t.id === id),
  byEmail: (email) => store.tenants.find((t) => t.email === email.toLowerCase()),
};

// ─── Bots ───────────────────────────────────────────────────────────────────
const BOT_DEFAULTS = {
  greeting: "", language: "auto", manager_phone: "",
  meta_phone_id: "", meta_token: "", meta_verify_token: "",
  meta_waba_id: "", meta_business_id: "", meta_embedded_status: "manual",
  meta_onboarded_at: "", meta_subscribe_status: "",
  active: 1
};
const Bots = {
  create(data) {
    const b = { id: uid("bot_"), created_at: now(), ...BOT_DEFAULTS, ...data };
    store.bots.push(b); save();
    return b;
  },
  byId: (id) => store.bots.find((b) => b.id === id),
  byTenant: (tenant_id) =>
    store.bots.filter((b) => b.tenant_id === tenant_id).sort((a, b) => b.created_at - a.created_at),
  byPhoneId: (meta_phone_id) =>
    store.bots.find((b) => b.meta_phone_id === meta_phone_id && b.active),
  byVerifyToken: (token) => store.bots.find((b) => b.meta_verify_token && b.meta_verify_token === token),
  update(id, fields) {
    const b = Bots.byId(id);
    if (!b) return null;
    const allowed = [
      "business_name","industry","system_prompt","greeting","language","manager_phone",
      "meta_phone_id","meta_token","meta_verify_token","meta_waba_id","meta_business_id",
      "meta_embedded_status","meta_onboarded_at","meta_subscribe_status","active"
    ];
    for (const k of allowed) if (k in fields) b[k] = fields[k];
    save();
    return b;
  },
};

// ─── Conversations & messages ─────────────────────────────────────────────────
const Conversations = {
  getOrCreate(bot_id, tenant_id, customer) {
    let c = store.conversations.find((c) => c.bot_id === bot_id && c.customer === customer);
    if (!c) {
      c = { id: uid("conv_"), bot_id, tenant_id, customer, last_msg: "", updated_at: now() };
      store.conversations.push(c); save();
    }
    return c;
  },
  byId: (id) => store.conversations.find((c) => c.id === id),
  byBot: (bot_id) =>
    store.conversations.filter((c) => c.bot_id === bot_id).sort((a, b) => b.updated_at - a.updated_at).slice(0, 200),
  touch(id, last_msg) {
    const c = Conversations.byId(id);
    if (c) { c.updated_at = now(); c.last_msg = last_msg; save(); }
  },
};

const Messages = {
  add(conv_id, bot_id, role, content) {
    const m = { id: uid("msg_"), conv_id, bot_id, role, content, created_at: now() };
    store.messages.push(m); save();
    return m.id;
  },
  history(conv_id, limit = 20) {
    return store.messages
      .filter((m) => m.conv_id === conv_id)
      .sort((a, b) => a.created_at - b.created_at)
      .slice(-limit)
      .map((m) => ({ role: m.role, content: m.content }));
  },
};

// ─── Leads ──────────────────────────────────────────────────────────────────
const Leads = {
  create({ bot_id, tenant_id, customer, type, detail }) {
    const l = { id: uid("lead_"), bot_id, tenant_id, customer, type, detail: detail || "", status: "new", created_at: now() };
    store.leads.push(l); save();
    return l.id;
  },
  byBot: (bot_id) =>
    store.leads.filter((l) => l.bot_id === bot_id).sort((a, b) => b.created_at - a.created_at).slice(0, 200),
  markHandled(id) {
    const l = store.leads.find((l) => l.id === id);
    if (l) { l.status = "handled"; save(); }
  },
  stats(bot_id) {
    const ls = store.leads.filter((l) => l.bot_id === bot_id);
    const today = ls.filter((l) => l.created_at > now() - 86400000).length;
    const convs = store.conversations.filter((c) => c.bot_id === bot_id).length;
    return { total: ls.length, today, conversations: convs };
  },
};

module.exports = { store, uid, now, flush, Tenants, Bots, Conversations, Messages, Leads };
