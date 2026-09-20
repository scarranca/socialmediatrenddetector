# Security

- **Secrets** live only in `.env` (gitignored). The server never sends them to the browser; the dashboard talks to `/api/*` on localhost.
- **The dashboard server is for local use.** It has no authentication and `POST /api/run` spends Apify/Anthropic credit. Do not expose it to a network you don't control.
- If you find a vulnerability, please open a private security advisory on GitHub (Security → Advisories → Report a vulnerability) rather than a public issue.
- If you ever paste a token somewhere it shouldn't be, rotate it: [Apify → Settings → API & Integrations](https://console.apify.com/settings/integrations), [Anthropic Console → API keys](https://console.anthropic.com/settings/keys).
