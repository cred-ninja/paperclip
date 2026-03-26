import http from 'node:http';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3401);
const paperclipApiBaseUrl = (process.env.PAPERCLIP_API_BASE_URL || 'http://127.0.0.1:3101').replace(/\/+$/, '');
const pluginId = process.env.PAPERCLIP_PLUGIN_ID || 'cred.paperclip';
const webhookSecret = process.env.PAPERCLIP_PLUGIN_WEBHOOK_SECRET;

if (!webhookSecret) {
  throw new Error('PAPERCLIP_PLUGIN_WEBHOOK_SECRET is required');
}

function html(statusCode, title, message) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
      h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
      code { background: #f4f4f5; padding: 0.15rem 0.3rem; border-radius: 0.25rem; }
      .status { color: ${statusCode >= 400 ? '#b91c1c' : '#166534'}; }
    </style>
  </head>
  <body>
    <h1 class="status">${title}</h1>
    <p>${message}</p>
  </body>
</html>`;
}

function send(res, statusCode, contentType, body) {
  res.writeHead(statusCode, { 'content-type': contentType });
  res.end(body);
}

async function forwardCallback(service, searchParams) {
  const response = await fetch(`${paperclipApiBaseUrl}/api/plugins/${pluginId}/webhooks/oauth-callback`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-paperclip-cred-callback-secret': webhookSecret,
    },
    body: JSON.stringify({
      service,
      state: searchParams.get('state'),
      code: searchParams.get('code'),
      error: searchParams.get('error'),
      error_description: searchParams.get('error_description'),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Paperclip webhook failed (${response.status})`);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      send(res, 400, 'text/plain; charset=utf-8', 'Missing request URL');
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
    if (url.pathname === '/health') {
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ status: 'ok' }));
      return;
    }

    const match = url.pathname.match(/^\/oauth\/([^/]+)\/callback$/);
    if (!match || req.method !== 'GET') {
      send(res, 404, 'text/plain; charset=utf-8', 'Not found');
      return;
    }

    const service = decodeURIComponent(match[1]);
    await forwardCallback(service, url.searchParams);

    send(
      res,
      200,
      'text/html; charset=utf-8',
      html(200, 'Authorization complete', `The ${service} authorization was stored successfully. You can close this tab.`),
    );
  } catch (error) {
    send(
      res,
      500,
      'text/html; charset=utf-8',
      html(500, 'Authorization failed', error instanceof Error ? error.message : String(error)),
    );
  }
});

server.listen(port, host, () => {
  console.log(`paperclip-plugin-cred embedded callback helper listening on http://${host}:${port}`);
});
