# blackbook-content

Server-delivered playbook content for the **Black Book** app (Phase 2a).
Served as static files over GitHub Pages: <https://btran2026.github.io/blackbook-content/>

- `manifest.json` — the index the app polls. Bump `manifestVersion` on every change.
- `playbooks/playbook-<id>.json` — one published playbook (the app's `Playbook` shape).

Publish from the app repo with:

```sh
node scripts/publish-playbook.mjs <approved-playbook.json> --repo ../blackbook-content
```

The app imports new/updated playbooks on launch (Pro-gated, throttled). Content here is
public-readable; the app unlocks it for Pro members (client-side gate, MVP).
