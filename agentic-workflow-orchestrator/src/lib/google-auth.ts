import { google } from "googleapis";

// ─────────────────────────────────────────────────────────────
// Google OAuth2 client — shared singleton used by Gmail and
// Drive tools. Uses refresh token for long-lived access.
// Uses google.auth.OAuth2 from googleapis directly to avoid
// type mismatches with the google-auth-library peer dependency.
// ─────────────────────────────────────────────────────────────

type GoogleAuth = InstanceType<typeof google.auth.OAuth2>;

let _client: GoogleAuth | null = null;

export const getGoogleAuthClient = (): GoogleAuth => {
  if (_client) return _client;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not set");
  if (!clientSecret) throw new Error("GOOGLE_CLIENT_SECRET is not set");
  if (!refreshToken) throw new Error("GOOGLE_REFRESH_TOKEN is not set");

  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });

  _client = client;
  return _client;
};
