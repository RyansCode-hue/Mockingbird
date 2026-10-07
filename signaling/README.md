# Mockingbird signaling

The Cloudflare Worker that introduces team-room members to each other (see
`docs/team-rooms.md`). One Durable Object per room keeps who's a member and
relays signed connection details between them; after that, Mockingbirds talk
laptop to laptop over WebRTC. The Worker never sees what's in a room, nor an
invite's token. It also hands members short-lived Cloudflare TURN credentials,
so traffic can fall back to a relay where a direct connection is blocked; the
TURN API token stays here as a secret.

Free plan: Workers + SQLite-backed Durable Objects (100,000 requests a day) and
Cloudflare TURN (1,000 GB a month) are far more than a small team uses. Idle
rooms cost nothing (hibernating WebSockets; the keep-alive is answered
without waking the room).

## Deploy (once)

```bash
cd signaling
npx wrangler login       # opens the browser to sign in to Cloudflare
npx wrangler deploy      # prints https://mockingbird-signaling.<you>.workers.dev
```

Paste the printed `https://…workers.dev` URL into Mockingbird → Settings → Team
→ Signaling URL. Teammates don't need it: invite codes carry it.

### TURN relay (recommended)

Without it, members behind strict firewalls or some hotspots can't connect
(STUN alone handles most home and office networks).

1. Cloudflare dashboard → Realtime → TURN Server → Create. Copy the **Turn
   Token ID** and the **API Token**.
2. Store them in the Worker:

   ```bash
   cd signaling
   npx wrangler secret put TURN_KEY_ID          # paste the Turn Token ID
   npx wrangler secret put TURN_KEY_API_TOKEN   # paste the API Token
   ```

`https://mockingbird-signaling.<you>.workers.dev/health` then answers
`"relay": true`.

## Updating

`npx wrangler deploy` again after the Worker's code changes. Its protocol
version is in `/health`; Mockingbird says when the Worker needs redeploying.

## What's here

- `src/room.ts` — the room logic: membership, join tokens, relay, presence,
  TURN credentials, rate limits. Plain TypeScript, no Cloudflare APIs: unit
  tested in the app's Vitest suite (`test/teamSignaling.test.ts`).
- `src/worker.ts` — the Worker and Durable Object around it.
- `src/local/` — the same room logic served from Node for tests and for two
  dev instances on one Mac: `npm run team:signaling` (from the repo root).

`npx wrangler tail` streams the Worker's logs.
