/**
 * FOX-045: the separate origin that shows email content (CLAUDE.md rule 5, layer 3).
 *
 * Production: FOXALORA_RENDER_DOMAIN (e.g. content.webmail.example.com) plus FOXALORA_APP_ORIGIN
 * (https://webmail.example.com). Development may set FOXALORA_RENDER_ORIGIN directly
 * (http://127.0.0.1:3000 while the app runs on http://localhost:5173).
 * Not configured: the viewer falls back to a sandboxed srcdoc frame on the app origin, and the
 * setup check reports it.
 */
export interface RenderConfig {
  /** e.g. https://content.webmail.example.com */
  renderOrigin: string;
  renderHost: string;
  /** The webmail origin, the only page allowed to frame the content. */
  appOrigin: string;
}

export const RENDER_PATH = '/api/v1/render/';

export function renderConfig(env: NodeJS.ProcessEnv = process.env): RenderConfig | null {
  const domain = env.FOXALORA_RENDER_DOMAIN?.trim();
  const origin = env.FOXALORA_RENDER_ORIGIN?.trim() || (domain ? `https://${domain}` : '');
  if (!origin) return null;
  const app = env.FOXALORA_APP_ORIGIN?.trim();
  if (!app) throw new Error('FOXALORA_APP_ORIGIN is required when the render origin is set');

  const r = new URL(origin);
  const a = new URL(app);
  // A different host name, not only a different port: browsers share cookies across ports.
  if (r.hostname.toLowerCase() === a.hostname.toLowerCase()) {
    throw new Error('The render origin must use a different host name than the webmail');
  }
  if (env.NODE_ENV === 'production' && (r.protocol !== 'https:' || a.protocol !== 'https:')) {
    throw new Error('The render and app origins must use https in production');
  }
  return { renderOrigin: r.origin, renderHost: r.hostname.toLowerCase(), appOrigin: a.origin };
}
