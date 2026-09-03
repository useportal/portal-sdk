import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type {
  ChannelHandle,
  ChannelStatus,
  SendAck,
  ThreadHandle,
  ThreadSendInput,
  ThreadSnapshot,
} from "@portalsdk/core";

import { usePortal } from "./context.js";
import { isServerEnvironment } from "./ssr.js";
import type { UseThreadParams, UseThreadResult } from "./types.js";
import { useLatest } from "./use-latest.js";

/** Inert snapshot for "nothing selected" and for server rendering — no lens exists. */
const INERT_SNAPSHOT: ThreadSnapshot<never> = Object.freeze({
  messages: Object.freeze([]) as readonly never[],
  isLoadingPrevious: false,
  hasPrevious: false,
});

/**
 * Subscribe to one thread of a channel. A selector over core's {@link ThreadHandle}: it
 * resolves the channel handle from the registry, holds the channel's refcount for as long as
 * it is mounted (so a thread view shares the channel's socket, and opens it if nothing else
 * has), and mirrors the lens's snapshot through `useSyncExternalStore`. The lens hands back
 * the same snapshot while this thread is unchanged, so an unrelated channel change — another
 * thread's reply, presence, typing — does not re-render this hook.
 *
 * Unmounting releases the lens subscription and this hook's hold on the channel; the
 * connection itself stays up for as long as anything else (a `useChannel`, another thread)
 * holds it.
 *
 * Inert during server rendering and while `channelId` is `undefined`, like `useChannel`.
 */
export function useThread<M = unknown>(params: UseThreadParams<M>): UseThreadResult<M> {
  const portal = usePortal();
  const { channelId, threadId, history, metadata, where, onMention, onMessage, onError } =
    params;

  // Same handle object per id (core's registry); `history`/`metadata` are connect-time,
  // first-creation-wins options and deliberately not dependencies (see useChannel).
  const handle = useMemo<ChannelHandle<M> | undefined>(
    () =>
      channelId === undefined || isServerEnvironment()
        ? undefined
        : portal.channel<M>(channelId, {
            ...(history !== undefined && { history }),
            ...(metadata !== undefined && { metadata }),
          }),
    [portal, channelId],
  );
  // Same lens object per thread id, from the handle.
  const thread = useMemo<ThreadHandle<M> | undefined>(
    () => handle?.thread(threadId),
    [handle, threadId],
  );

  // Reserved surface: core's view() rejects it at runtime, loudly.
  useMemo(() => {
    if (thread && where !== undefined) thread.view(where);
  }, [thread, where]);

  const onMentionRef = useLatest(onMention);
  const onMessageRef = useLatest(onMessage);
  const onErrorRef = useLatest(onError);

  // The channel's refcount: this hook holds the connection while mounted, sharing it with
  // every other hook on the same channel. Core's grace period absorbs StrictMode remounts.
  useEffect(() => {
    if (!handle) return;
    handle.acquire();
    return () => handle.release();
  }, [handle]);

  // Thread-scoped callbacks. `status` is the channel's; its error argument carries in-session
  // errors, as in useChannel.
  useEffect(() => {
    if (!thread) return;
    const offMessage = thread.on("message", (msg) => onMessageRef.current?.(msg));
    const offMention = thread.on("mention", (msg) => onMentionRef.current?.(msg));
    const offStatus = thread.on("status", (_status, err) => {
      if (err) onErrorRef.current?.(err);
    });
    return () => {
      offMessage();
      offMention();
      offStatus();
    };
  }, [thread, onMessageRef, onMentionRef, onErrorRef]);

  // The lens: subscribing is what triggers its lazy initial fetch.
  const subscribe = useCallback(
    (listener: () => void) => (thread ? thread.subscribe(listener) : () => {}),
    [thread],
  );
  const getSnapshot = useCallback(
    (): ThreadSnapshot<M> => (thread ? thread.getSnapshot() : INERT_SNAPSHOT),
    [thread],
  );
  const getServerSnapshot = useCallback((): ThreadSnapshot<M> => INERT_SNAPSHOT, []);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Connection status, selected from the channel store so only a status change re-renders.
  const subscribeStatus = useCallback(
    (listener: () => void) => (handle ? handle.subscribe(listener) : () => {}),
    [handle],
  );
  const getStatus = useCallback(
    (): ChannelStatus => (handle ? handle.getSnapshot().status : "idle"),
    [handle],
  );
  const getServerStatus = useCallback((): ChannelStatus => "idle", []);
  const status = useSyncExternalStore(subscribeStatus, getStatus, getServerStatus);

  const send = useCallback(
    (input: ThreadSendInput<M>): Promise<SendAck> =>
      thread
        ? thread.send(input)
        : Promise.reject(new Error("Cannot send: no channel selected (channelId is undefined).")),
    [thread],
  );
  const loadPrevious = useCallback(
    (): Promise<boolean> => (thread ? thread.loadPrevious() : Promise.resolve(false)),
    [thread],
  );

  return {
    messages: snapshot.messages,
    send,
    loadPrevious,
    hasPrevious: snapshot.hasPrevious,
    isLoadingPrevious: snapshot.isLoadingPrevious,
    status,
  };
}
