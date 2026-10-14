# effort

An animated explainer of AI effort levels. Same model, same task, five efforts, across Claude Fable 5.1, Opus 5.5 and Sonnet 5.5. Per-model differences (default level, thinking time, unrequested extras, check-ins) live in `MODELS` in `public/app.js`.

Static site in `public/`, with no build step. Hosted on Cloudflare Workers (static assets only) at https://effort.brajk.com.

- Preview: `python -m http.server 8642 --directory public`, then open http://127.0.0.1:8642
- Deploy: `wrangler deploy` (needs `wrangler login` once)

`window.effort.seekRace(t)` and `window.effort.seekClose(t)` in the console freeze an animation at time `t`, which helps when checking a single moment. `window.effort.model('sonnet-5.5')` switches model.
