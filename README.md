# Kanban App

Multi-project markdown-native kanban board with role-based access and project briefs.

## Security-first public repo defaults

This repository is safe to publish when secrets are supplied at runtime (never committed).

### Required environment variables

- `KANBAN_TOKEN` — legacy admin token (optional but recommended if legacy routes are still used)
- `OPENROUTER_API_KEY` — only needed if LLM endpoints are enabled

### Recommended environment variables

- `CORS_ORIGINS` — comma-separated allowlist, e.g. `https://kanban.repo.box`
- `ALLOW_QUERY_TOKEN_AUTH` — `false` in production (prevents `?token=` auth leakage)

See `.env.example` for a template.

## Agent workflow (public)

This project uses a project-brief driven workflow:

1. Each project has a markdown brief with a `## Resources` section.
2. Chat/topic bindings map conversations to a project brief.
3. Runtime prompt builder injects:
   - the brief pointer (`BRIEF: <path>`)
   - a compact `Resources` footer at end-of-context
4. This gives reliable “bookend” context: stable rules up top, critical project resources at bottom.

Why this helps:
- Lower token usage vs pasting full inventories repeatedly
- Fewer context misses when switching projects
- Deterministic project resource recall on every bound call

## Local run

```bash
pnpm install
pm2 start ecosystem.config.js --only kanban
```

## Notes

- Never commit tokens, API keys, or local `.env` files.
- Use `data/` and runtime env for mutable state/secrets.
