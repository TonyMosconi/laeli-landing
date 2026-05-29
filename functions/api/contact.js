// Cloudflare Pages Function — handles POST /api/contact and sends the
// message via Resend. The Resend API key is read from the
// RESEND_API_KEY environment variable (set in the Cloudflare Pages
// project settings as an encrypted/secret variable — never in code).

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function onRequestPost({ request, env }) {
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
      to: ["support@laeli.app"],
      reply_to: email,
      subject: `New contact message from ${name}`,
      text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
    }),
  });

  if (!res.ok) {
    return json(
      { success: false, message: "Could not send your message. Please email support@laeli.app." },
      502
    );
  }

  return json({ success: true });
}
