import { OAuth2Client } from "google-auth-library";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify", "openid", "email"];
export const GMAIL_DESTINATIONS = ["gmail.googleapis.com", "oauth2.googleapis.com"];

export interface ExchangeResult {
  refreshToken: string;
  email: string;
  scopes: string[];
}

export interface AccessToken {
  accessToken: string;
  expiresAt: number | null; // epoch ms, if the provider reports it
}

export interface GoogleOAuth {
  isConfigured(): boolean;
  authUrl(state: string): string;
  exchange(code: string): Promise<ExchangeResult>;
  revoke(refreshToken: string): Promise<void>;
  /** Mint a short-lived access token from a stored refresh token — the credential handed to the
   *  Guard per-run (Story 4.3). Kept short-lived so the Guard holds only a transient secret (AD-10). */
  accessTokenFromRefresh(refreshToken: string): Promise<AccessToken>;
}

export function googleOAuth(env: NodeJS.ProcessEnv = process.env): GoogleOAuth {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI ?? "http://localhost:8080/oauth/google/callback";
  const configured = Boolean(clientId && clientSecret);
  const client = () => new OAuth2Client({ clientId, clientSecret, redirectUri });

  return {
    isConfigured: () => configured,
    authUrl(state) {
      return client().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: GMAIL_SCOPES, state });
    },
    async exchange(code) {
      const c = client();
      const { tokens } = await c.getToken(code);
      let email = "";
      if (tokens.id_token) {
        const ticket = await c.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
        email = ticket.getPayload()?.email ?? "";
      }
      return { refreshToken: tokens.refresh_token ?? "", email, scopes: (tokens.scope ?? "").split(" ").filter(Boolean) };
    },
    async revoke(refreshToken) {
      await client().revokeToken(refreshToken).catch(() => {});
    },
    async accessTokenFromRefresh(refreshToken) {
      const c = client();
      c.setCredentials({ refresh_token: refreshToken });
      const { token } = await c.getAccessToken(); // refreshes against oauth2.googleapis.com
      if (!token) throw new Error("Google returned no access token.");
      return { accessToken: token, expiresAt: c.credentials.expiry_date ?? null };
    },
  };
}

export function fakeGoogleOAuth(opts: { configured?: boolean; email?: string; refreshToken?: string; mintFails?: boolean } = {}): GoogleOAuth & { revoked: string[]; minted: string[] } {
  const revoked: string[] = [];
  const minted: string[] = [];
  return {
    revoked,
    minted,
    isConfigured: () => opts.configured ?? true,
    authUrl: (state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    async exchange(code) {
      return { refreshToken: opts.refreshToken ?? `refresh-${code}`, email: opts.email ?? "user@gmail.com", scopes: GMAIL_SCOPES };
    },
    async revoke(t) {
      revoked.push(t);
    },
    async accessTokenFromRefresh(refreshToken) {
      if (opts.mintFails) throw new Error("mint failed");
      minted.push(refreshToken);
      return { accessToken: `access-for-${refreshToken}`, expiresAt: null };
    },
  };
}
