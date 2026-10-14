# learn

Short animated explainers, hosted at https://learn.brajk.com. Each lesson is a folder under `public/`. `public/index.html` lists them.

Static site with no build step, hosted on Cloudflare Workers (static assets only, Worker name `learn`).

- Preview: `python -m http.server 8642 --directory public`, then open http://127.0.0.1:8642
- Deploy: `wrangler deploy` (needs `wrangler login` once)

To add a lesson, create `public/<name>/` with its own `index.html`, using relative paths for its files. Then add a card to `public/index.html`.

## Lessons

### effort (`/effort/`)

An animated explainer of AI effort levels. Same model, same task, five efforts, across Claude Fable 5.1, Opus 5.5 and Sonnet 5.5. Per-model differences (default level, thinking time, unrequested extras, check-ins) live in `MODELS` in `public/effort/app.js`.

`window.effort.seekRace(t)` and `window.effort.seekClose(t)` in the console freeze an animation at time `t`, which helps when checking a single moment. `window.effort.model('sonnet-5.5')` switches model.

## Link previews

Each page sets `og:image` to a 1200×630 PNG (`public/og.png`, `public/effort/og.png`). They're rendered from `tools/og-card.html` (`?k=effort` or `?k=learn`) with headless Chrome at 1200×630. Everything sits in the central 630×630 square, because Slack sometimes shows a square crop from the middle. Slack caches both the page preview and the image per URL: after changing a card, bump the `?v=` on the `og:image` URL, and share the page with a new query string (e.g. `?v=3`).
