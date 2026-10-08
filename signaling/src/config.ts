import { parseAllowedCreators, SIGNALING_FEATURES, SIGNALING_PROTOCOL, type SignalingHealth } from "../../src/shared/team/protocol";
import { turnDailyLimit } from "./room";

/**
 * The Worker's settings, read from its secrets and vars. Plain code, so the
 * Worker and the tests read them the same way.
 */

export interface WorkerConfigEnv {
  /** Fingerprints allowed to create rooms (`npx wrangler secret put ALLOWED_CREATORS`). */
  ALLOWED_CREATORS?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** TURN credentials minted per UTC day across all rooms (wrangler.toml [vars]). */
  TURN_DAILY_LIMIT?: string;
}

export function workerConfig(env: WorkerConfigEnv) {
  const creators = parseAllowedCreators(env.ALLOWED_CREATORS);
  return {
    allowedCreators: creators.ids,
    invalidCreators: creators.invalid,
    turn: env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN ? { keyId: env.TURN_KEY_ID, apiToken: env.TURN_KEY_API_TOKEN } : null,
    turnDailyLimit: turnDailyLimit(env.TURN_DAILY_LIMIT),
  };
}

/** /health: whether the Worker is set up (how many creators, whether TURN is), never who. */
export function healthBody(env: WorkerConfigEnv): SignalingHealth {
  const c = workerConfig(env);
  return {
    service: "mockingbird-signaling",
    protocol: SIGNALING_PROTOCOL,
    relay: !!c.turn,
    creators: c.allowedCreators.length,
    ...(c.invalidCreators.length ? { creatorsInvalid: c.invalidCreators.length } : {}),
    features: [...SIGNALING_FEATURES],
  };
}
