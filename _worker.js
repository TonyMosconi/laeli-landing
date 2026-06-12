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

// --- Abuse throttling -------------------------------------------------------
// Fixed-window rate limiting backed by the Cloudflare Cache API, so it needs no
// extra bindings or setup — it works the moment the Worker deploys. State is
// per-data-center (per-colo), which is plenty to throttle a scripted flood from
// a single source; a distributed attack is handled by the Cloudflare WAF /
// Turnstile escalation noted in the launch roadmap.
const clientIp = (request) =>
  request.headers.get("CF-Connecting-IP") ||
  request.headers.get("X-Forwarded-For") ||
  "";

// Returns true if `key` is still under `limit` within the rolling
// `windowSeconds`, and counts this hit. Never throws — on any cache error it
// allows the request, so a hiccup can never lock out real visitors.
async function underLimit(key, limit, windowSeconds) {
  try {
    const cache = caches.default;
    const cacheKey = new Request(`https://laeli.app/__rl?k=${encodeURIComponent(key)}`);
    const hit = await cache.match(cacheKey);
    const count = hit ? parseInt(await hit.text(), 10) || 0 : 0;
    if (count >= limit) return false;
    await cache.put(
      cacheKey,
      new Response(String(count + 1), { headers: { "Cache-Control": `max-age=${windowSeconds}` } })
    );
    return true;
  } catch {
    return true;
  }
}

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
          <img src="https://laeli.app/symbol-180.png" width="56" height="56" alt="Laeli" style="display:block;margin:0 auto 10px;">
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

  // Cap + flatten the name: it flows into the Resend email SUBJECT and both
  // bodies, so interior newlines/control chars must never survive (header-
  // injection class), and an uncapped name bloats the subject. Mirrors the
  // email-length cap below (2026-06-10 deep-dive, Lane 6 #6).
  const name = String(form.name || "").replace(/[\r\n\t\u0000-\u001f]+/g, " ").trim().slice(0, 100);
  const email = String(form.email || "").trim();
  const message = String(form.message || "").trim();

  if (!name || !email || !message) {
    return json({ success: false, message: "Please fill in all fields." }, 400);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    return json({ success: false, message: "Please enter a valid email address." }, 400);
  }
  if (message.length > 5000) {
    return json({ success: false, message: "Message is too long." }, 400);
  }

  // Throttle bursts per source IP so the endpoint can't be scripted to relay
  // mail or run up Resend cost. Generous for real visitors, strict on floods.
  const contactIp = clientIp(request);
  if (contactIp && !(await underLimit(`contact:ip:${contactIp}`, 10, 3600))) {
    return json({ success: false, message: "You've sent several messages recently — please try again later, or email support@laeli.app directly." }, 429);
  }

  // Attachments — optional, up to 3 small files (images / PDF). Re-validate
  // everything server-side (never trust the client): count, the content-type
  // allowlist, base64 shape, and per-file + total size. Nothing is stored;
  // valid files are handed straight to Resend as email attachments.
  const MAX_FILES = 3;
  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
  const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/heic", "application/pdf"]);
  const rawAttachments = Array.isArray(form.attachments) ? form.attachments : [];
  if (rawAttachments.length > MAX_FILES) {
    return json({ success: false, message: `Please attach no more than ${MAX_FILES} files.` }, 400);
  }
  const attachments = [];
  let totalBytes = 0;
  for (const a of rawAttachments) {
    const type = String((a && a.type) || "");
    const content = String((a && a.content) || "");
    const filename = String((a && a.name) || "attachment").slice(0, 120);
    if (!ALLOWED_TYPES.has(type)) {
      return json({ success: false, message: "Attachments must be images or PDF." }, 400);
    }
    if (content.length === 0 || !/^[A-Za-z0-9+/=\r\n]+$/.test(content)) {
      return json({ success: false, message: "An attachment couldn't be read. Please re-add it." }, 400);
    }
    const approxBytes = Math.floor((content.length * 3) / 4);
    if (approxBytes > MAX_FILE_BYTES) {
      return json({ success: false, message: `"${filename}" is over 5 MB.` }, 400);
    }
    totalBytes += approxBytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return json({ success: false, message: "Attachments are too large all together." }, 400);
    }
    attachments.push({ filename, content });
  }

  if (!env.RESEND_API_KEY) {
    return json({ success: false, message: "Email is not configured yet. Please email support@laeli.app." }, 500);
  }

  const supportEmail = {
    from: "Laeli Contact <contact@laeli.app>",
    to: [env.CONTACT_TO || "support@laeli.app"],
    reply_to: email,
    subject: `New contact message from ${name}`,
    text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
  };
  if (attachments.length > 0) {
    supportEmail.attachments = attachments;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(supportEmail),
  });

  if (!res.ok) {
    return json({ success: false, message: "Could not send your message. Please email support@laeli.app." }, 502);
  }

  // Best-effort confirmation back to the visitor. If this send fails, we still
  // return success — the support notification (above) already went through and
  // the page shows its own success state. Also cap how many times any single
  // address can be auto-emailed per day, so the form can't be abused to bomb an
  // arbitrary inbox (spam-relay). The support notification above always goes to
  // our own fixed address, so it is never a relay risk.
  if (await underLimit(`contact:rcpt:${email.toLowerCase()}`, 3, 86400)) try {
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

// Branded waitlist confirmation email.
function waitlistHtml() {
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4ead6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4ead6;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fffaf0;border-radius:20px;overflow:hidden;border:1px solid #e7d6bd;">
        <tr><td style="background-color:#5179be;background-image:linear-gradient(135deg,#6f97d6,#4f7fc4);padding:26px 28px;text-align:center;">
          <img src="https://laeli.app/symbol-180.png" width="56" height="56" alt="Laeli" style="display:block;margin:0 auto 10px;">
          <div style="font-family:Georgia,'Times New Roman',serif;font-weight:bold;font-size:22px;color:#fff8ec;letter-spacing:0.3px;">Laeli</div>
        </td></tr>
        <tr><td style="padding:30px 30px 24px;">
          <h1 style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-weight:bold;font-size:24px;line-height:1.25;color:#1d3a32;">You're on the list&nbsp;🐾</h1>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#395049;">We'll email you the <strong>moment Laeli launches.</strong></p>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#395049;">Download in the <strong>first 24 hours</strong> and you'll get <strong>1 month of Pro, free</strong> — no card, no auto-charge. It just expires on its own; you're never charged and there's nothing to cancel.</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#395049;background:#fdeee9;border:1px solid #f3cdc0;border-radius:12px;padding:13px 16px;">📨 <strong>One quick thing:</strong> <strong style="color:#c0392b;">if this email landed in your spam or Promotions folder, move it to your inbox or mark it as safe</strong> — that way our launch-day reminder reaches you too.</p>
          <p style="margin:0;font-size:16px;line-height:1.6;color:#1d3a32;font-weight:bold;">— The Laeli team</p>
        </td></tr>
        <tr><td style="padding:0 30px;"><div style="border-top:1px solid #e7d6bd;height:1px;line-height:1px;font-size:1px;">&nbsp;</div></td></tr>
        <tr><td style="padding:18px 30px 28px;">
          <p style="margin:0;font-size:13px;line-height:1.55;color:#8a8275;">You're receiving this because you joined the waitlist at <a href="https://laeli.app" style="color:#c66a52;text-decoration:none;">laeli.app</a>. We'll only email you about the launch.</p>
        </td></tr>
      </table>
      <div style="font-size:12px;color:#9a9183;margin-top:16px;font-family:Arial,Helvetica,sans-serif;">Laeli — your AI dog training coach</div>
    </td></tr>
  </table>
</body>
</html>`;
}

async function handleWaitlist(request, env) {
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

  const email = String(form.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    return json({ success: false, message: "Please enter a valid email address." }, 400);
  }

  // Source attribution: the front-end forwards ?ref= (e.g. "ig", "tiktok") so we
  // can see which channel drove each signup. The form collects no name, so we
  // park the source in the Resend contact's first_name field — filter the
  // audience by it in the Resend dashboard to count signups per source.
  // (Do NOT personalize launch emails with {{FIRST_NAME}} — it holds the source.)
  const ref = String(form.ref || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);

  // Per-IP burst throttle (mirrors the contact endpoint). Same-address re-sends
  // are already suppressed below via Resend's duplicate detection; this caps a
  // flood of distinct addresses from one source.
  const waitlistIp = clientIp(request);
  if (waitlistIp && !(await underLimit(`waitlist:ip:${waitlistIp}`, 12, 3600))) {
    return json({ success: false, message: "Too many requests — please try again in a little while." }, 429);
  }

  if (!env.RESEND_API_KEY || !env.RESEND_SEGMENT_ID) {
    return json({ success: false, message: "The waitlist isn't configured yet. Please email support@laeli.app." }, 500);
  }

  // Add the contact to Resend + place them in the launch-blast Segment.
  // (Resend renamed Audiences → Segments; current API is POST /contacts with a
  // `segments` array — verified against the live docs 2026-06-02.)
  const res = await fetch("https://api.resend.com/contacts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, unsubscribed: false, segments: [{ id: env.RESEND_SEGMENT_ID }], ...(ref ? { first_name: ref } : {}) }),
  });

  // Resend returns 201 on add. A duplicate email may 4xx — treat "already exists"
  // as success (the visitor is on the list either way; never tell them it failed).
  let already = false;
  if (!res.ok) {
    try {
      const body = await res.text();
      already = /exist|already|duplicate/i.test(body);
    } catch {
      // ignore
    }
    if (!already) {
      return json({ success: false, message: "Could not add you to the waitlist. Please try again or email support@laeli.app." }, 502);
    }
  }

  // Already on the list (duplicate submit) — return success WITHOUT re-sending the
  // confirmation, so the form can't be abused to repeatedly email-bomb one address
  // with "you're on the waitlist" mails. (A flood of DISTINCT addresses is covered
  // by the Cloudflare rate-limit rule on /api/waitlist.)
  if (already) {
    return json({ success: true });
  }

  // Best-effort branded confirmation. If it fails, we still return success —
  // the email is already on the list, which is what matters.
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
        subject: "You're on the Laeli waitlist 🐾",
        html: waitlistHtml(),
        text:
          "You're on the list!\n\n" +
          "We'll email you the moment Laeli launches. Download in the first 24 hours and you'll get 1 month of Pro, free — no card, no auto-charge; it just expires on its own. You're never charged and there's nothing to cancel.\n\n" +
          "One quick thing: if this email landed in your spam or Promotions folder, move it to your inbox or mark it as safe — that way our launch-day reminder reaches you too.\n\n" +
          "— The Laeli team\n\n" +
          "You're receiving this because you joined the waitlist at laeli.app.",
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
    // Canonical-host redirect: www + the bare pages.dev alias serve the exact
    // same content, which Google Search Console flags as "duplicate without
    // user-selected canonical" (2026-06-12 email). 301 GET/HEAD to the apex so
    // Google consolidates everything onto laeli.app. Exact-match only — hashed
    // preview deployments (<hash>.laeli-app.pages.dev) must keep serving so
    // previews stay usable — and non-GET passes through so a form POST that
    // somehow targets an alias host is never method-rewritten by the redirect.
    if (
      (url.hostname === "www.laeli.app" || url.hostname === "laeli-app.pages.dev") &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      url.hostname = "laeli.app";
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === "/api/contact") {
      return handleContact(request, env);
    }
    if (url.pathname === "/api/waitlist") {
      return handleWaitlist(request, env);
    }
    // Clean campaign links: /r/<source> serves the homepage DIRECTLY (HTTP 200,
    // no redirect) — Meta's classifiers treat redirect links as a spam signal
    // (the 2026-06-10 IG restriction), and the IG bio link is frozen until
    // 2026-07-10 so the URL itself can't change. The page JS reads the source
    // from the /r/<source> path for attribution.
    const refPath = url.pathname.match(/^\/r\/([a-z0-9_-]{1,32})\/?$/i);
    if (refPath) {
      return env.ASSETS.fetch(new Request(`${url.origin}/`, request));
    }
    // The homepage is served AT /r/<source>, so its relative asset URLs
    // ("assets/app/x.webp", "laeli-symbol.png") resolve to /r/<asset>. Strip
    // the /r prefix and serve the real file — otherwise Pages' fallback
    // returns index.html as the "image" and every mockup renders broken.
    if (url.pathname.startsWith("/r/")) {
      return env.ASSETS.fetch(new Request(url.origin + url.pathname.slice(2), request));
    }
    // Everything else: serve the static site.
    return env.ASSETS.fetch(request);
  },
};
