// Security headers shared by the backend's static-file fallback and the Caddy
// config the backend generates, so both paths serve the UI with the same policy.
//
// The UI has no inline <script> (Vite emits module bundles), so script-src can
// stay strict. Inline *styles* are still used (style attributes in the HTML and
// element.style assignments), hence 'unsafe-inline' for style-src only. Google
// Fonts is pulled in via @import in styles.css, so its stylesheet + font hosts
// must be allowed.

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  // Translator pages record the mic; everything else is unused.
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(self)",
};

/** Set headers on a Fastify reply unless the route already chose a value. */
export function applySecurityHeaders(reply: {
  getHeader: (name: string) => unknown;
  header: (name: string, value: string) => unknown;
}): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (reply.getHeader(name) === undefined) reply.header(name, value);
  }
}
