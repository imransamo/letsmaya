// Seeds a demo account so you can log in and show the product immediately.
// Run: npm run seed   →  login with demo@saalik.app / demo1234
const bcrypt = require("bcryptjs");
const { Tenants, Bots, flush } = require("./db");
const { buildPrompt } = require("./templates");

(async () => {
  const email = "demo@saalik.app";
  let t = Tenants.byEmail(email);
  if (!t) {
    t = Tenants.create({ name: "Demo Owner", email, password_hash: await bcrypt.hash("demo1234", 10) });
    console.log("Created tenant:", email, "/ demo1234");
  }
  if (!Bots.byTenant(t.id).length) {
    Bots.create({
      tenant_id: t.id, business_name: "Matka Chai Cafe", industry: "restaurant",
      system_prompt: buildPrompt("restaurant", { business_name: "Matka Chai Cafe" }),
      manager_phone: "923001234567",
    });
    Bots.create({
      tenant_id: t.id, business_name: "Al-Shifa Clinic", industry: "clinic",
      system_prompt: buildPrompt("clinic", { business_name: "Al-Shifa Clinic" }),
      manager_phone: "923009876543",
    });
    console.log("Seeded 2 demo bots.");
  }
  flush();
  process.exit(0);
})();
