# Laroz V2 — fresh clean deployment

This repository contains the Laroz storefront and its Cloudflare Worker API. No database is used.

## What happens in the temporary test phase

1. A customer opens the public Laroz website and adds products to the cart.
2. The customer enters their name, mobile number, pickup/delivery choice, delivery address when needed, and optional notes.
3. When the customer presses **تأكيد الطلب**, the site sends the order payload to `POST /api/orders-test` on the Cloudflare Worker.
4. The Worker validates the submitted fields and sends Meta's fixed `hello_world` WhatsApp template (`en_US`) to the verified test recipient in `WHATSAPP_TO`.
5. The site shows a test confirmation after Meta accepts the message.

**Important limitation:** Meta's `hello_world` template is fixed and has no variables. It does not contain the customer's name, phone, products, address, notes, or total. The Worker validates the submitted order but does not store it or forward it elsewhere. This is only a connectivity/checkout-flow test until Meta approves the custom `laroz_new_order` template. The project intentionally has no database.

## Files

- `index.html` — Arabic storefront, search, cart, checkout, and confirmation screen.
- `worker.js` — Cloudflare Worker API and WhatsApp Cloud API integration.
- `wrangler.jsonc` — Worker entry point and non-secret configuration.
- `package.json` — Wrangler dependency and deployment scripts.
- `.gitignore` — excludes local secrets and generated files.
- `.env.example` — names/placeholders only; do not put real tokens here.

## Fresh deployment names

- GitHub repository: `hosnii0/laroz-v2`
- GitHub Pages URL: `https://hosnii0.github.io/laroz-v2/`
- Cloudflare Worker name: `laroz-api-v2`

The old `laroz` repository and old `laroz` Worker are intentionally left untouched as a backup.

## Cloudflare Worker

Worker URL:

`https://laroz-api-v2.hosniimohamed00.workers.dev`

Repository/build configuration:

- GitHub repository: `hosnii0/laroz-v2`
- Branch: `main`
- Root directory: `/`
- Build command: none
- Deploy command: `npx wrangler deploy`

Runtime variables in Production:

- `PHONE_NUMBER_ID` — Meta test sender Phone Number ID.
- `WHATSAPP_TO` — verified test recipient, digits only with country code.
- `META_API_VERSION` — `v25.0`.
- `ALLOWED_ORIGINS` — `https://hosnii0.github.io`.
- `ENABLE_ORDER_SENDING` — `false` until the custom order template is approved and checked.
- Optional `TEST_ORDER_COOLDOWN_MS` — temporary per-isolate throttle; defaults to 20000.

Runtime Secret in Production:

- `WHATSAPP_TOKEN` — fresh Meta access token. Never commit it to GitHub or place it in `index.html`.

This clean project does not use `TEST_ENDPOINT_KEY`; it is not needed for the checkout test flow.

## Test endpoints

- `GET /health` — returns Worker health only; never sends WhatsApp.
- `POST /api/orders-test` — receives checkout fields, validates them, then sends the fixed `hello_world` template to `WHATSAPP_TO`.
- `POST /api/orders` — remains disabled until Meta approves `laroz_new_order` and the real-order implementation is verified.

The temporary test route is for controlled checkout testing only, not real public ordering. It has a best-effort per-IP in-memory cooldown, which is not a durable abuse-prevention system. Do not promote this hello_world test flow as a live ordering channel.

## After Meta approves `laroz_new_order`

1. Verify the approved template's language and seven body placeholders against the Worker payload mapping.
2. Switch the storefront to real-order mode only after the Worker real-order route is implemented and tested.
3. Enable `ENABLE_ORDER_SENDING=true` in Cloudflare Production variables.
4. Confirm the intended business recipient and WhatsApp sender configuration with the cafe owner.
5. Test a deliberate order before advertising the public link.

No customer order is considered delivered merely because the browser submitted the form. The UI confirms only after Meta accepts the API request.
