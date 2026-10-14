# learn

Short animated explainers, hosted at https://learn.brajk.com. Each lesson is a folder under `public/`. `public/index.html` lists them.

To add a lesson, create `public/<name>/` with its own `index.html`, using relative paths for its files. Then add a card to `public/index.html`.

## Lessons

### effort (`/effort/`)

An animated explainer of AI effort levels. Same model, same task, five efforts, across Claude Fable 5.1, Opus 5.5 and Sonnet 5.5. Per-model differences (default level, thinking time, unrequested extras, check-ins) live in `MODELS` in `public/effort/app.js`.
