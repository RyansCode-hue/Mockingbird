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

1. **Your fingerprints.** Each person who will *create* rooms (share a group)
   needs their install's fingerprint. From this repo, on each of your Macs:

   ```bash
   npm run team:fingerprint
   ```

   It prints the fingerprint (creating `~/.mockingbird/team/identity.json`
   exactly as the app would, if it isn't there yet) — Settings → Team shows the
   same. Collect Ryan's and Nick's.

2. **Deploy and allow the creators:**

   ```bash
   cd signaling
   npx wrangler login       # opens the browser to sign in to Cloudflare
   npx wrangler deploy      # prints https://mockingbird-signaling.<you>.workers.dev
   echo "<Ryan's fingerprint>, <Nick's fingerprint>" | npx wrangler secret put ALLOWED_CREATORS
   ```

   The secret is replaced each time you set it, so always list everyone.
   Fingerprints can be written as Settings shows them (`a1b2 c3d4 …`).

3. Paste the printed `https://…workers.dev` URL into Mockingbird → Settings →
   Team → Signaling URL and press **Check**. Teammates who only join rooms
   don't need it: invite codes carry it.

**Why the allowlist:** a room's id is made from its creator's key, so without
a list anyone who learned the Worker's URL — it's in every invite code, and the
name is guessable — could make a room of their own, become its member, and
mint TURN credentials on your account (billed past 1,000 GB a month). With
`ALLOWED_CREATORS` unset or empty the Worker creates no rooms at all, and
Mockingbird says so when you share a group. Joining an existing room with an
invite code, and members reconnecting, never need the list.

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
`"relay": true`, and `"creators"` counts the allowed fingerprints (never which).

The Worker mints at most `TURN_DAILY_LIMIT` credentials a day across all rooms
(200 by default, in `wrangler.toml`; each member's app asks about twice a day).
Past it, members get STUN only until midnight UTC and the Worker logs it
(`npx wrangler tail`), so even a member's app gone wrong can't run up the bill.

## Updating

`npx wrangler deploy` again after the Worker's code changes. Its protocol
version is in `/health`; Mockingbird says when the Worker needs redeploying.
Features added without a protocol change are listed there too (`features`):
a Worker deployed before `revoke` still works, but can't cut off a member who
left or was removed — Mockingbird says to redeploy it when that matters.

## What's here

- `src/room.ts` — the room logic: membership, the creator allowlist, join
  tokens, revoking members (oneself, or by the room's admin), relay, presence,
  TURN credentials and their daily budget, rate limits. Plain TypeScript, no Cloudflare APIs: unit tested in the app's Vitest
  suite (`test/teamSignaling.test.ts`).
- `src/config.ts` — the Worker's secrets and vars, and `/health`.
- `src/worker.ts` — the Worker and Durable Objects around them.
- `src/local/` — the same room logic served from Node for tests and for two
  dev instances on one Mac: `npm run team:signaling` (from the repo root). It
  lets any key create rooms: it only listens on this Mac.

`npx wrangler tail` streams the Worker's logs.
