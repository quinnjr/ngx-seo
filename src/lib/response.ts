import type { ResolvedHead } from './types';

/** RFC 7230 header field name. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Header value: visible Latin-1 and tabs/spaces, no CR, LF or NUL. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** Statuses a `Response` with an HTML body can be built with. */
function isUsableStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 200 && status <= 599 && status !== 204 && status !== 205 && status !== 304;
}

type HeaderStore = { headers?: HeadersInit };
type Original = { name: string; value: string } | null;

/**
 * Writes the resolved status and headers to the server's `ResponseInit`.
 * Values it wrote earlier that are no longer wanted are undone, restoring
 * whatever the server had set before. Invalid headers are dropped and
 * reported, never thrown.
 */
export class ResponseWriter {
  private readonly originalStatus: number | undefined;
  private wroteStatus = false;
  /** Lower-cased names this writer has set, with the server's value before that. */
  private readonly originals = new Map<string, Original>();

  constructor(
    private readonly init: ResponseInit | null,
    private readonly onError: (error: unknown) => void,
  ) {
    this.originalStatus = init?.status;
  }

  write(http: ResolvedHead['http']): void {
    const init = this.init as (ResponseInit & HeaderStore & { status?: number }) | null;
    if (init === null) {
      return;
    }

    let status = http.status;
    if (status !== undefined && !isUsableStatus(status)) {
      this.onError(new Error(`ngx-seo: ignored unusable response status ${String(status)}`));
      status = undefined;
    }
    if (status !== undefined) {
      init.status = status;
      this.wroteStatus = true;
    } else if (this.wroteStatus) {
      if (this.originalStatus === undefined) {
        delete init.status;
      } else {
        init.status = this.originalStatus;
      }
      this.wroteStatus = false;
    }

    const valid = new Map<string, [string, string]>();
    for (const [name, value] of Object.entries(http.headers)) {
      if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(value)) {
        this.onError(new Error(`ngx-seo: dropped invalid response header ${JSON.stringify(name)}`));
        continue;
      }
      valid.set(name.toLowerCase(), [name, value]);
    }

    for (const [lower, original] of this.originals) {
      if (!valid.has(lower)) {
        this.remove(init, lower);
        if (original !== null) {
          this.set(init, original.name, original.value);
        }
        this.originals.delete(lower);
      }
    }
    for (const [lower, [name, value]] of valid) {
      if (!this.originals.has(lower)) {
        this.originals.set(lower, this.get(init, lower));
      }
      this.set(init, name, value);
    }
  }

  private get(init: HeaderStore, lower: string): Original {
    const headers = init.headers;
    if (headers instanceof Headers) {
      const value = headers.get(lower);
      return value === null ? null : { name: lower, value };
    }
    const entries = Array.isArray(headers) ? headers : Object.entries(headers ?? {});
    const found = entries.find(([key]) => key.toLowerCase() === lower);
    return found ? { name: found[0], value: found[1] } : null;
  }

  private set(init: HeaderStore, name: string, value: string): void {
    const lower = name.toLowerCase();
    const headers = init.headers;
    if (headers === undefined) {
      init.headers = { [name]: value };
    } else if (headers instanceof Headers) {
      headers.set(name, value);
    } else if (Array.isArray(headers)) {
      const at = headers.findIndex(([key]) => key.toLowerCase() === lower);
      if (at === -1) {
        headers.push([name, value]);
      } else {
        headers[at] = [name, value];
      }
    } else {
      this.remove(init, lower);
      (headers as Record<string, string>)[name] = value;
    }
  }

  private remove(init: HeaderStore, lower: string): void {
    const headers = init.headers;
    if (headers instanceof Headers) {
      headers.delete(lower);
    } else if (Array.isArray(headers)) {
      for (let i = headers.length - 1; i >= 0; i--) {
        if (headers[i][0].toLowerCase() === lower) {
          headers.splice(i, 1);
        }
      }
    } else if (headers !== undefined) {
      const record = headers as Record<string, string>;
      for (const key of Object.keys(record)) {
        if (key.toLowerCase() === lower) {
          delete record[key];
        }
      }
    }
  }
}
