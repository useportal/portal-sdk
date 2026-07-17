/**
 * How the user's signed token is supplied (§1).
 *
 * A callback is re-invoked on every connect and reconnect, so a short-lived token stays
 * fresh; a plain string is used as-is and cannot be re-resolved.
 */
export type TokenSource = string | (() => Promise<string>);

/** A static string token cannot be refreshed — an expiry is immediately terminal. */
export const isStaticToken = (token: TokenSource): token is string =>
  typeof token === "string";

/** Resolve the current token, invoking the callback form afresh each call. */
export async function resolveToken(token: TokenSource): Promise<string> {
  return isStaticToken(token) ? token : token();
}
