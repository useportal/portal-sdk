import type {
  HistoryResponse,
  PublishBody,
  SendAckWire,
} from "@portalsdk/wire-protocol";

/**
 * The HTTP seam.
 *
 * Persistent publishes, history paging, and gap-fill ranges all go over HTTP (§3). The
 * message plane programs against {@link HttpClient}; production supplies a `fetch`-backed
 * client, tests an in-memory mock.
 */

/** A publish either succeeds with the wire ack or is rejected with a code (§3.1). */
export type PublishOutcome =
  | { ok: true; ack: SendAckWire }
  | { ok: false; code: string; reason?: string };

/** History query — scroll-up paging (`before`/`limit`) or a gap-fill range (`from`/`to`). */
export interface HistoryQuery {
  before?: number;
  limit?: number;
  from?: number;
  to?: number;
}

export interface HttpClient {
  /** `POST /v1/channels/{id}/messages` (§3.1). Network errors reject; 4xx resolve `ok:false`. */
  publish(channelId: string, body: PublishBody): Promise<PublishOutcome>;
  /** `GET /v1/channels/{id}/history` (§3.2). */
  history(channelId: string, query: HistoryQuery): Promise<HistoryResponse>;
}

export interface HttpClientDeps {
  apiUrl: string;
  apiKey: string;
  token: import("../token.js").TokenSource;
}

/** Creates an {@link HttpClient} bound to a set of credentials and hosts. */
export type HttpClientFactory = (deps: HttpClientDeps) => HttpClient;
