# effort

An animated explainer of AI effort levels. Same agent, same task, five efforts.

Static site in `public/`, with no build step. Hosted on Cloudflare Workers (static assets only) at https://effort.brajk.com.

- Preview: `python -m http.server 8642 --directory public`, then open http://127.0.0.1:8642
- Deploy: `wrangler deploy` (needs `wrangler login` once)

`window.effort.seekRace(t)` and `window.effort.seekClose(t)` in the console freeze an animation at time `t`, which helps when checking a single moment.
