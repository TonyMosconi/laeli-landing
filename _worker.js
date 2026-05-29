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

// Escape user input before placing it in HTML (the visitor's name).
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Branded confirmation email (table + inline styles = email-client safe).
function confirmationHtml(name) {
  const safeName = esc(name);
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4ead6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4ead6;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fffaf0;border-radius:20px;overflow:hidden;border:1px solid #e7d6bd;">
        <tr><td style="background-color:#5179be;background-image:linear-gradient(135deg,#6f97d6,#4f7fc4);padding:26px 28px;text-align:center;">
          <img src="https://laeli.app/mascot-180.png" width="56" height="56" alt="Laeli" style="border-radius:16px;display:block;margin:0 auto 10px;">
          <div style="font-family:Georgia,'Times New Roman',serif;font-weight:bold;font-size:22px;color:#fff8ec;letter-spacing:0.3px;">Laeli</div>
        </td></tr>
        <tr><td style="padding:30px 30px 24px;">
          <h1 style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-weight:bold;font-size:24px;line-height:1.25;color:#1d3a32;">Thanks for reaching out&nbsp;🐾</h1>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#395049;">Hi ${safeName},</p>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#395049;">Your message landed safely — a real human on the Laeli team will get back to you as soon as we can.</p>
          <p style="margin:0;font-size:16px;line-height:1.6;color:#1d3a32;font-weight:bold;">— The Laeli team</p>
        </td></tr>
        <tr><td style="padding:0 30px;"><div style="border-top:1px solid #e7d6bd;height:1px;line-height:1px;font-size:1px;">&nbsp;</div></td></tr>
        <tr><td style="padding:18px 30px 28px;">
          <p style="margin:0;font-size:13px;line-height:1.55;color:#8a8275;">You're receiving this because you used the contact form at <a href="https://laeli.app" style="color:#c66a52;text-decoration:none;">laeli.app</a>. No need to reply unless you'd like to add something — or just reply to this email and it reaches us.</p>
        </td></tr>
      </table>
      <div style="font-size:12px;color:#9a9183;margin-top:16px;font-family:Arial,Helvetica,sans-serif;">Laeli — your AI dog training coach</div>
    </td></tr>
  </table>
</body>
</html>`;
}

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
        html: confirmationHtml(name),
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
