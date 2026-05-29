// ─────────────────────────────────────────────────────────────────────────────
// engine.js — The brain + the pipe
//
// Handles one incoming WhatsApp message end to end:
//   1. Find which tenant's bot owns the receiving number
//   2. Load that conversation's history
//   3. Ask Claude (with the tenant's own system prompt)
//   4. Detect & log any lead, alert the manager
//   5. Send the reply back via Meta Cloud API
//
// Works in DEMO MODE with no Meta/Anthropic keys so you can show it off offline.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const { Bots, Conversations, Messages, Leads } = require("./db");
const { extractLead } = require("./templates");

const META_API_VERSION = process.env.META_API_VERSION || "v21.0";
const GLOBAL_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

const anthropic = GLOBAL_ANTHROPIC_KEY ? new Anthropic({ apiKey: GLOBAL_ANTHROPIC_KEY }) : null;

// ─── Send a text message back to the customer via Meta Cloud API ──────────────
async function sendWhatsApp(bot, toPhone, text) {
  const clean = String(toPhone).replace(/\D/g, "");
  if (!bot.meta_phone_id || !bot.meta_token) {
    console.log(`[DEMO SEND → ${clean}] ${text}`);
    return { demo: true };
  }
  const url = `https://graph.facebook.com/${META_API_VERSION}/${bot.meta_phone_id}/messages`;
  const res = await axios.post(
    url,
    { messaging_product: "whatsapp", recipient_type: "individual", to: clean, type: "text", text: { body: text } },
    { headers: { Authorization: `Bearer ${bot.meta_token}`, "Content-Type": "application/json" }, timeout: 30000 }
  );
  return res.data;
}

// ─── Ask Claude for a reply, scoped to this bot's prompt + this conversation ──
async function think(bot, history) {
  if (!anthropic) {
    // DEMO MODE — canned but contextual so demos work with zero keys.
    const last = history[history.length - 1]?.content?.toLowerCase() || "";
    if (/price|rate|kitna|cost|how much/.test(last))
      return `Thanks for asking! I'll get you the exact pricing. Could you tell me which item or service you're interested in?`;
    if (/book|appointment|order|chahiye|want/.test(last))
      return `Happy to help with that. Can I get your name and preferred time?\n[[LEAD type=inquiry detail=demo interest captured]]`;
    return `Hi! This is the ${bot.business_name} assistant. How can I help you today? (Demo mode — connect an Anthropic key for full AI replies.)`;
  }

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: [{ type: "text", text: bot.system_prompt, cache_control: { type: "ephemeral" } }],
    messages: history.map((m) => ({ role: m.role, content: m.content })),
  });
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

// ─── Alert the business owner when a real lead comes in ───────────────────────
async function alertManager(bot, customer, lead) {
  if (!bot.manager_phone) return;
  const txt = `🔔 ${bot.business_name} — new ${lead.type.toUpperCase()}\nFrom: ${customer}\n${lead.detail || ""}`.trim();
  try { await sendWhatsApp(bot, bot.manager_phone, txt); }
  catch (e) { console.error("manager alert failed:", e.message); }
}

// ─── Main entry: process one inbound message ──────────────────────────────────
// Returns the reply text (handy for the dashboard test console & demos).
async function handleInbound({ bot, customer, text }) {
  const conv = Conversations.getOrCreate(bot.id, bot.tenant_id, customer);
  Messages.add(conv.id, bot.id, "user", text);

  const history = Messages.history(conv.id, 20);
  let raw;
  try {
    raw = await think(bot, history);
  } catch (e) {
    console.error("Claude error:", e.message);
    raw = "Sorry, I hit a small technical issue — please try again in a moment!";
  }

  const { clean, lead } = extractLead(raw);

  if (lead) {
    Leads.create({ bot_id: bot.id, tenant_id: bot.tenant_id, customer, type: lead.type, detail: lead.detail });
    await alertManager(bot, customer, lead);
  }

  Messages.add(conv.id, bot.id, "assistant", clean);
  Conversations.touch(conv.id, clean.slice(0, 120));

  try { await sendWhatsApp(bot, customer, clean); }
  catch (e) { console.error("send failed:", e.response?.data || e.message); }

  return { reply: clean, lead };
}

// ─── Meta webhook payload → normalised messages ───────────────────────────────
function parseMetaWebhook(body) {
  const out = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneId = value.metadata?.phone_number_id;
      for (const m of value.messages || []) {
        if (m.type !== "text") continue;
        out.push({ phoneId, customer: m.from, text: m.text?.body || "" });
      }
    }
  }
  return out;
}

module.exports = { handleInbound, parseMetaWebhook, sendWhatsApp, Bots };
