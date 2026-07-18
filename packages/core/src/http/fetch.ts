import type {
  HistoryResponse,
  MembersResponse,
  PublishBody,
  SendAckWire,
} from "@portalsdk/wire-protocol";

import { resolveToken } from "../token.js";
import type {
  HttpClient,
  HttpClientDeps,
  HttpClientFactory,
  HistoryQuery,
  PublishOutcome,
} from "./types.js";

/** HTTP key header carrying the publishable `apiKey` (§3, credential transport). */
const API_KEY_HEADER = "x-portal-key";

function historyUrl(apiUrl: string, channelId: string, query: HistoryQuery): string {
  const url = new URL(`${apiUrl}/v1/channels/${encodeURIComponent(channelId)}/history`);
  const q = url.searchParams;
  if (query.before !== undefined) q.set("before", String(query.before));
  if (query.limit !== undefined) q.set("limit", String(query.limit));
  if (query.from !== undefined) q.set("from", String(query.from));
  if (query.to !== undefined) q.set("to", String(query.to));
  return url.toString();
}

/** Production {@link HttpClient}, backed by `fetch`. Credentials are resolved per request. */
export const createFetchHttpClient: HttpClientFactory = (
  deps: HttpClientDeps,
): HttpClient => {
  const authHeaders = async (): Promise<Record<string, string>> => ({
    authorization: `Bearer ${await resolveToken(deps.token)}`,
    [API_KEY_HEADER]: deps.apiKey,
  });

  return {
    async publish(channelId: string, body: PublishBody): Promise<PublishOutcome> {
      const response = await fetch(
        `${deps.apiUrl}/v1/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: "POST",
          headers: { ...(await authHeaders()), "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (response.ok) {
        const ack = (await response.json()) as SendAckWire;
        return { ok: true, ack };
      }
      let code = `http_${response.status}`;
      let reason: string | undefined;
      try {
        const errorBody = (await response.json()) as { code?: string; reason?: string };
        if (typeof errorBody.code === "string") code = errorBody.code;
        if (typeof errorBody.reason === "string") reason = errorBody.reason;
      } catch {
        /* keep the status-derived code */
      }
      return reason === undefined ? { ok: false, code } : { ok: false, code, reason };
    },

    async history(channelId: string, query: HistoryQuery): Promise<HistoryResponse> {
      const response = await fetch(historyUrl(deps.apiUrl, channelId, query), {
        method: "GET",
        headers: await authHeaders(),
      });
      if (!response.ok) {
        throw new Error(`history request failed with status ${response.status}`);
      }
      return (await response.json()) as HistoryResponse;
    },

    async members(channelId: string, cursor?: string): Promise<MembersResponse> {
      const url = new URL(
        `${deps.apiUrl}/v1/channels/${encodeURIComponent(channelId)}/members`,
      );
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: await authHeaders(),
      });
      if (!response.ok) {
        throw new Error(`members request failed with status ${response.status}`);
      }
      return (await response.json()) as MembersResponse;
    },
  };
};
