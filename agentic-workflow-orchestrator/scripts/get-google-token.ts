import { google } from "googleapis";
import { createServer } from "http";
import { parse } from "url";

// ─────────────────────────────────────────────────────────────
// Generates a Google OAuth2 refresh token via local redirect.
//
// Usage:
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... bun run scripts/get-google-token.ts
//
// Scopes cover Gmail (read/send) and Drive (read/write).
// Add or remove scopes as needed, then re-run to get a new token.
// ─────────────────────────────────────────────────────────────

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
];

const PORT = 3333;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId) throw new Error("GOOGLE_CLIENT_ID env var is required");
if (!clientSecret) throw new Error("GOOGLE_CLIENT_SECRET env var is required");

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES,
});

console.log("\nOpen this URL in your browser:\n");
console.log(authUrl);
console.log("\nWaiting for redirect on http://localhost:" + PORT + " ...\n");

const server = createServer(async (req, res) => {
  const { pathname, query } = parse(req.url ?? "", true);
  if (pathname !== "/oauth2callback") {
    res.end("Not found");
    return;
  }

  const code = query.code as string | undefined;
  if (!code) {
    res.writeHead(400);
    res.end("Missing code parameter");
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Token received. Check your terminal.");

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("Add this to your .env:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    if (!tokens.refresh_token) {
      console.warn(
        "WARNING: No refresh_token returned. This usually means the account\n" +
        "already has an active grant. Revoke access at https://myaccount.google.com/permissions\n" +
        "then re-run this script.\n"
      );
    }
  } catch (err) {
    res.writeHead(500);
    res.end("Token exchange failed. Check terminal.");
    console.error("Token exchange failed:", err);
  } finally {
    server.close();
  }
});

server.listen(PORT);
