import { startLocalSignaling } from "./server";
import { PUBLIC_STUN } from "../room";

// `npm run team:signaling [-- --port 8787] [--stun]`: the local signaling
// server, for two Mockingbird dev instances on one Mac. Put the printed URL in
// both instances' Settings → Team.

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const port = Number(arg("--port") ?? 8787);
startLocalSignaling({ port, stun: process.argv.includes("--stun") ? PUBLIC_STUN : [] }).then(
  (s) => console.log(`Local signaling: ${s.url}  (rooms in memory; Ctrl-C to stop)`),
  (err) => {
    console.error(`Local signaling couldn't start on port ${port}: ${err.message}`);
    process.exit(1);
  }
);
