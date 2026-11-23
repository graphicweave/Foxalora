import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RenderService } from './render.service';

/**
 * Policy for email content on the render origin (FOX-045, FOX-044). No scripts, no network
 * except data: images, no forms, no plugins; only the webmail may frame it. The `sandbox`
 * directive gives the document an opaque origin even if it is opened outside the frame.
 */
export function renderCsp(appOrigin: string): string {
  return [
    "default-src 'none'",
    'img-src data:',
    "style-src 'unsafe-inline'",
    'font-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${appOrigin}`,
    'sandbox allow-popups allow-popups-to-escape-sandbox',
  ].join('; ');
}

const STYLE = 'body{font:14px/1.5 system-ui,sans-serif;margin:16px 20px;color:#1a1a1a;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}a{color:#0b57d0}';

/** The HTML was sanitized by the server when the message was fetched (layer 1). */
export function renderPage(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="color-scheme" content="light">
<meta name="referrer" content="no-referrer">
<base target="_blank">
<style>${STYLE}</style>
</head><body>${html}</body></html>`;
}

const EXPIRED = `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}body{color:#555}</style></head>
<body><p>This view of the message has expired. Close the message and open it again.</p></body></html>`;

/**
 * Served only on the render host (enforced in http.ts). It reads no cookies and sets none:
 * the one-time token in the path is the only credential.
 */
@Controller('render')
export class RenderController {
  constructor(private readonly render: RenderService) {}

  @Get(':token')
  async show(@Param('token') token: string, @Res() res: Response) {
    const cfg = this.render.config;
    if (!cfg) throw new NotFoundException();
    const item = await this.render.consume(token);
    res.status(item ? 200 : 404);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', renderCsp(cfg.appOrigin));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.send(item ? renderPage(item.html) : EXPIRED);
  }
}
