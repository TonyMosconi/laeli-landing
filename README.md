# laeli-landing

Deploy-ready static site for **laeli.app** — the Laeli marketing landing
page **and** the legal pages, served from a single origin.

This is the public hosting bundle (no app source). It mirrors
`docs/landing-site/` in the private `Laeli` repo.

## Pages

| URL | File |
|---|---|
| `/` | `index.html` — marketing landing |
| `/privacy` | `privacy.html` — Privacy Policy |
| `/terms` | `terms.html` — Terms of Service |
| `/legal` | `legal.html` — legal hub |
| `/email-verify` | `email-verify.html` — email-confirmation page (deep-links `laeli://auth-callback`) |
| `/contact` | `contact.html` — contact form (posts to the `/api/contact` function) |

Clean URLs (`/privacy` → `privacy.html`) are served automatically by
Cloudflare Pages.

## Contact form (Resend)

`functions/api/contact.js` is a Cloudflare Pages Function that receives
the contact form and sends the message via [Resend](https://resend.com).

Setup:

1. In Resend, verify the `laeli.app` domain (add the DNS records to
   Cloudflare) so mail can be sent from `contact@laeli.app`.
2. Create a Resend API key.
3. In the Cloudflare Pages project → Settings → Environment variables,
   add `RESEND_API_KEY` (Production, encrypted) = the key. Redeploy.

The function emails `support@laeli.app` with the submitter's address as
`reply_to`. Until `RESEND_API_KEY` is set, the form returns a friendly
error and the page still offers the `support@laeli.app` mailto fallback.

## Hosting (Cloudflare Pages)

1. Cloudflare dashboard → Workers & Pages → Create application → Pages
2. Connect to Git → select `TonyMosconi/laeli-landing`
3. Build settings: framework preset = **None**, build command = blank,
   build output directory = `/` (root)
4. Deploy, then add the custom domain `laeli.app` to the Pages project.
5. Redirect the legacy `legal.laeli.app/*` → `laeli.app/*` so existing
   App Store and email-confirmation links keep working.

## Pre-launch

The legal pages derive from DRAFT markdown. Replace the `[Legal Entity
Name]` / `[Jurisdiction TBD]` placeholders and complete legal review
before App Store submission.
