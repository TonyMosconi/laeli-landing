// Cloudflare Pages advanced-mode Worker.
// Handles POST /api/contact (sends the contact form via Resend) and
// serves all static assets for everything else. RESEND_API_KEY is read
// from the project's environment variables (encrypted secret) — never
// hard-coded.

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function handleContact(request, env) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let form;
  try {
    form = await request.json();
  } catch {
    return json({ success: false, message: "Invalid request." }, 400);
  }

  // Honeypot: bots tick this hidden field — silently accept and drop.
  if (form.botcheck) return json({ success: true });

  const name = String(form.name || "").trim();
  const email = String(form.email || "").trim();
  const message = String(form.message || "").trim();

  if (!name || !email || !message) {
    return json({ success: false, message: "Please fill in all fields." }, 400);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ success: false, message: "Please enter a valid email address." }, 400);
  }
  if (message.length > 5000) {
    return json({ success: false, message: "Message is too long." }, 400);
  }

  if (!env.RESEND_API_KEY) {
    return json({ success: false, message: "Email is not configured yet. Please email support@laeli.app." }, 500);
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Laeli Contact <contact@laeli.app>",
      to: [env.CONTACT_TO || "support@laeli.app"],
      reply_to: email,
      subject: `New contact message from ${name}`,
      text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
    }),
  });

  if (!res.ok) {
    return json({ success: false, message: "Could not send your message. Please email support@laeli.app." }, 502);
  }

  // Best-effort confirmation back to the visitor. If this send fails, we still
  // return success — the support notification (above) already went through and
  // the page shows its own success state.
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Laeli <contact@laeli.app>",
        to: [email],
        reply_to: "support@laeli.app",
        subject: "Thanks for reaching out to Laeli 🐾",
        text:
          `Hi ${name},\n\n` +
          `Thanks for contacting Laeli — your message landed safely and a real human will get back to you as soon as we can.\n\n` +
          `— The Laeli team\n\n` +
          `You're receiving this because you used the contact form at laeli.app. No need to reply unless you'd like to add something.`,
      }),
    });
  } catch {
    // ignore — confirmation is a courtesy, not required for success
  }

  return json({ success: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/contact") {
      return handleContact(request, env);
    }
    // Everything else: serve the static site.
    return env.ASSETS.fetch(request);
  },
};
