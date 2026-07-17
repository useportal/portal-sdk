import type { HistoryResponse, PublishBody } from "@portalsdk/wire-protocol";

import type {
  HttpClient,
  HttpClientFactory,
  HistoryQuery,
  PublishOutcome,
} from "../../src/http/types.js";

export interface MockHttpOptions {
  onPublish?: (channelId: string, body: PublishBody) => PublishOutcome;
  onHistory?: (channelId: string, query: HistoryQuery) => HistoryResponse;
}

/**
 * In-memory {@link HttpClient} for the message plane. It records every call and answers
 * from optional handlers, defaulting to an accepted publish and an empty history page. It
 * deliberately does not resolve the token, so socket-side token resolution can be asserted
 * in isolation.
 */
export class MockHttpClient implements HttpClient {
  readonly publishCalls: { channelId: string; body: PublishBody }[] = [];
  readonly historyCalls: { channelId: string; query: HistoryQuery }[] = [];

  readonly #options: MockHttpOptions;

  constructor(options: MockHttpOptions = {}) {
    this.#options = options;
  }

  publish(channelId: string, body: PublishBody): Promise<PublishOutcome> {
    this.publishCalls.push({ channelId, body });
    const outcome =
      this.#options.onPublish?.(channelId, body) ??
      ({
        ok: true,
        ack: { id: `srv_${this.publishCalls.length}`, seq: 0, timestamp: 0 },
      } satisfies PublishOutcome);
    return Promise.resolve(outcome);
  }

  history(channelId: string, query: HistoryQuery): Promise<HistoryResponse> {
    this.historyCalls.push({ channelId, query });
    const page = this.#options.onHistory?.(channelId, query) ?? { msgs: [], hasMore: false };
    return Promise.resolve(page);
  }

  /** A factory that always returns this instance, for `setHttpClientFactory`. */
  get factory(): HttpClientFactory {
    return () => this;
  }
}
