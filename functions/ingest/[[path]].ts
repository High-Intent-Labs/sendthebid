const POSTHOG_HOST = "https://eu.i.posthog.com";

export const onRequest: PagesFunction = async ({ request }) => {
  const url = new URL(request.url);
  const pathSuffix = url.pathname.replace(/^\/ingest/, "");
  const search = url.search;
  const posthogUrl = `${POSTHOG_HOST}${pathSuffix}${search}`;

  const headers = new Headers(request.headers);
  headers.set("host", "eu.i.posthog.com");
  headers.delete("cookie");

  const response = await fetch(posthogUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "follow",
  });

  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  responseHeaders.set("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: responseHeaders });
  }

  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders,
  });
};
