import { defineMiddleware } from 'astro:middleware';

export const onRequest = defineMiddleware(async ({ request, redirect }, next) => {
  const url = new URL(request.url);

  // Skip API routes, files with extensions, and URLs that already have trailing slash
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/' ||
    url.pathname.endsWith('/') ||
    url.pathname.includes('.')
  ) {
    const response = await next();
    // Set short cache for HTML pages so deploys take effect quickly
    if (!url.pathname.includes('.') || url.pathname.endsWith('.html')) {
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'public, s-maxage=60, max-age=0, must-revalidate');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }
    return response;
  }

  // Redirect to trailing slash version
  return redirect(url.pathname + '/' + url.search, 301);
});
