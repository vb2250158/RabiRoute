/** Keep Manager credentials inside its configured API boundary, including remote proxies. */
export function managerAvatarUrl(value, resolveManagerResource, pageHref) {
  try {
    const page = new URL(pageHref), resource = new URL(value, page);
    if (!['http:', 'https:'].includes(resource.protocol) || resource.username || resource.password) return value;
    // Normalize absolute same-origin API URLs before applying the configured Manager prefix.
    if (resource.origin === page.origin && resource.pathname.startsWith('/api/')) {
      return resolveManagerResource(resource.pathname + resource.search + resource.hash);
    }
    const managerApi = new URL(resolveManagerResource('/api/'), page);
    if (resource.origin === managerApi.origin && resource.pathname.startsWith(managerApi.pathname)) {
      return resolveManagerResource(resource.href);
    }
  } catch { /* Invalid or unsupported image URLs retain the normal image-error fallback. */ }
  return value;
}
