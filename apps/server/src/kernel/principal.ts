export type Role = 'owner' | 'member';
export type TokenScope = 'read' | 'write' | 'admin';

/** Who is making a request, once their credentials have been checked. */
export interface Principal {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: Role;
  /** A browser session (cookie) or an API token (bearer). */
  readonly via: 'session' | 'token';
  /** Id of the browser session or API token. */
  readonly credentialId: string;
  readonly scopes: readonly TokenScope[];
  /** When the user last proved their identity with a password or passkey (ms). */
  readonly authenticatedAt: number;
  /** For browser sessions: the anti-forgery token the client must echo on writes. */
  readonly csrfToken?: string;
}

export interface RequestMeta {
  readonly ip: string;
  readonly userAgent: string | null;
}

/** Implemented by the auth module; the HTTP kernel only knows this contract. */
export interface Authenticator {
  fromSessionCookie(token: string, meta: RequestMeta): Principal | null;
  fromBearerToken(token: string, meta: RequestMeta): Principal | null;
  /** Whether a credential is still valid — used to cut long-lived connections. */
  isCredentialLive(principal: Principal): boolean;
}

export const isOwner = (principal: Principal): boolean => principal.role === 'owner';
