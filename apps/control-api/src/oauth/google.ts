import { OAuth2Client } from "google-auth-library";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify", "openid", "email"];
export const GMAIL_DESTINATIONS = ["gmail.googleapis.com", "oauth2.googleapis.com"];

export interface ExchangeResult {
  refreshToken: string;
  email: string;
  scopes: string[];
}

export interface GoogleOAuth {
  isConfigured(): boolean;
  authUrl(state: string): string;
  exchange(code: string): Promise<ExchangeResult>;
  revoke(refreshToken: string): Promise<void>;
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
  };
}

export function fakeGoogleOAuth(opts: { configured?: boolean; email?: string; refreshToken?: string } = {}): GoogleOAuth & { revoked: string[] } {
  const revoked: string[] = [];
  return {
    revoked,
    isConfigured: () => opts.configured ?? true,
    authUrl: (state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    async exchange(code) {
      return { refreshToken: opts.refreshToken ?? `refresh-${code}`, email: opts.email ?? "user@gmail.com", scopes: GMAIL_SCOPES };
    },
    async revoke(t) {
      revoked.push(t);
    },
  };
}
