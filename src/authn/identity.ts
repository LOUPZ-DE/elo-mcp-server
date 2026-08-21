/**
 * The result of a successful login — the one shape the OAuth half of the
 * server knows about.
 *
 * Replacement seam: anything that can produce an `AuthnIdentity` (the ELO login
 * form today; an existing app session, LDAP or an external IdP later) plugs in
 * by calling `completeAuthorization()` in src/oauth/complete.ts. Everything
 * after that point — codes, tokens, JWT, MCP — stays unchanged.
 */
export interface AuthnIdentity {
  /** ELO login name, exactly as typed and as IX accepted it. */
  userName: string;
  /** Human-readable name, resolved from IX at login time. */
  displayName: string;
  /** Where the identity came from. Only 'elo' exists today. */
  idp: string;
  /**
   * Handle into the server-side session vault (src/authn/eloLogin.ts), which
   * holds the live `EloClient` for this user.
   *
   * Deliberately opaque: the access token is signed but NOT encrypted, so
   * anything in it is readable by the MCP client. The credentials never leave
   * the server — only this handle travels.
   */
  eloSid: string;
}
