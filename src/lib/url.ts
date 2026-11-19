function parse(value: string, base?: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function isWebUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/**
 * Makes `value` absolute against `base`. Returns null when the result cannot
 * be parsed or is not an http(s) URL.
 */
export function absoluteUrl(value: string, base: string | null): string | null {
  const direct = parse(value);
  if (direct) {
    return isWebUrl(direct) && direct.host !== '' ? direct.href : null;
  }
  if (base === null) {
    return null;
  }
  const baseUrl = parse(base);
  if (!baseUrl || !isWebUrl(baseUrl)) {
    return null;
  }
  const resolved = parse(value, baseUrl.href);
  return resolved && isWebUrl(resolved) ? resolved.href : null;
}

/** The origin of `base`, or null when it is not an http(s) URL. */
export function originOf(base: string | null): string | null {
  if (base === null) {
    return null;
  }
  const url = parse(base);
  return url && isWebUrl(url) ? url.origin : null;
}

/** Derives the canonical URL for a router path under the given policy. */
export function canonicalFor(
  path: string,
  base: string | null,
  policy: { trailingSlash: 'preserve' | 'always' | 'never'; keepQueryParams: readonly string[] },
): string | null {
  const origin = originOf(base);
  if (origin === null) {
    return null;
  }
  // A leading "//" would otherwise be read as another host.
  const url = parse(`/${path.replace(/^[/\\]+/, '')}`, origin);
  if (!url || url.origin !== origin) {
    return null;
  }

  let pathname = url.pathname;
  if (policy.trailingSlash === 'always' && !pathname.endsWith('/')) {
    pathname = `${pathname}/`;
  } else if (policy.trailingSlash === 'never' && pathname !== '/') {
    pathname = pathname.replace(/\/+$/, '') || '/';
  }

  // Kept parameters follow keepQueryParams order, so one page has one canonical.
  const kept = new URLSearchParams();
  for (const name of policy.keepQueryParams) {
    for (const value of url.searchParams.getAll(name)) {
      kept.append(name, value);
    }
  }
  const query = kept.toString();

  return `${url.origin}${pathname}${query === '' ? '' : `?${query}`}`;
}
