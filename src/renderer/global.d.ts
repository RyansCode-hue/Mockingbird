import type { MbApi } from "../main/preload";

/**
 * The preload types subscription payloads as `unknown` and returns
 * removeListener's value from each `on…` call. Each listener here names the
 * payload it expects, and gets back an unsubscribe a React effect can return.
 */
type Payload<A> = { [I in keyof A]: unknown extends A[I] ? any : A[I] extends unknown[] ? (unknown extends A[I][number] ? any[] : A[I]) : A[I] };
type Subscription<F> = F extends (cb: (...args: infer A) => void) => unknown ? (cb: (...args: Payload<A>) => void) => () => void : F;
type RendererApi<T> = { [K in keyof T]: K extends `on${string}` ? Subscription<T[K]> : T[K] };

declare global {
  interface Window {
    /** The main process's API, as the preload script exposes it. */
    mb: RendererApi<MbApi>;
  }
}
