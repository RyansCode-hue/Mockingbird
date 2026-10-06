import { useSyncExternalStore } from "react";
import { isErr, type IpcResult } from "../shared/types";

/**
 * Main-process state mirrored in the renderer: one IPC subscription, any
 * number of readers. `connect` runs on first use; it reads the state and
 * subscribes to its changes, writing both through `set`.
 */
export function createIpcStore<T>(initial: T, connect: (store: { get: () => T; set: (next: T) => void }) => void) {
  let state = initial;
  let connected = false;
  const subs = new Set<() => void>();
  const get = () => state;
  const set = (next: T) => {
    state = next;
    subs.forEach((s) => s());
  };
  const ensureConnected = () => {
    if (connected) return;
    connected = true;
    connect({ get, set });
  };
  const subscribe = (cb: () => void) => {
    ensureConnected();
    subs.add(cb);
    return () => {
      subs.delete(cb);
    };
  };
  return { get, set, connect: ensureConnected, subscribe, use: () => useSyncExternalStore(subscribe, get) };
}

/**
 * A store's first read. When it fails ({ error } or a rejection) the store
 * keeps what it has and the console says what couldn't be read and why.
 */
export function loadInto<R>(what: string, reply: Promise<IpcResult<R>>, apply: (r: R) => void): void {
  reply.then(
    (r) => {
      if (isErr(r)) console.error(`Couldn't read ${what}: ${r.error}`);
      else apply(r as R);
    },
    (err: unknown) => console.error(`Couldn't read ${what}:`, err)
  );
}
