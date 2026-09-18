import { NextResponse } from "next/server";

/**
 * The small HTML page shown for the two browser-facing Slack routes
 * (`/api/slack/install`, `/api/slack/oauth`). A human clicked something to
 * get here — a blank response or a framework default error page is a dead
 * end; this always says what happened in plain words.
 */
export function htmlPage(status: number, title: string, body: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${title}</title>
     <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
     background:#f6f7f9;color:#111827;display:grid;place-items:center;height:100vh;margin:0}
     div{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:32px;max-width:420px;text-align:center}
     </style></head><body><div><h1>${title}</h1><p>${body}</p></div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
