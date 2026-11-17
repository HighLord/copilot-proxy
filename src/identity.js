'use strict';

const HTTP_UNAUTHORIZED = 401;

class SessionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionError';
    this.status = HTTP_UNAUTHORIZED;
  }
}

// Claims are read only to build the URL and check expiry. The signature is NOT verified;
// Copilot itself is the authority on whether the token is valid.
function parseClaims(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) {
    throw new SessionError('Token is not a JWT');
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new SessionError('Token payload could not be decoded');
  }
  if (!claims.oid || !claims.tid || !claims.exp) {
    throw new SessionError('Token is missing oid, tid or exp claims');
  }
  return claims;
}

// The Chathub access token carries oid/tid/exp plus, usually, upn or email. Fall back to the
// address typed at sign-in when the token does not carry an email-ish claim.
function identityFromClaims(claims, fallbackEmail) {
  const email = String(claims.upn || claims.email || claims.preferred_username || fallbackEmail || '').toLowerCase();
  const name = claims.name
    || (claims.given_name && claims.family_name ? `${claims.given_name} ${claims.family_name}` : '')
    || (email ? email.split('@')[0] : '');
  return { oid: claims.oid, tid: claims.tid, exp: claims.exp, email, name };
}

module.exports = { parseClaims, identityFromClaims, SessionError };
