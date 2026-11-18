import type { ResolvedHead } from './types';

/**
 * Writes the resolved status and headers to the server's `ResponseInit`,
 * undoing values it wrote earlier that are no longer wanted.
 */
export class ResponseWriter {
  private readonly originalStatus: number | undefined;
  private wroteStatus = false;
  private readonly written = new Set<string>();

  constructor(private readonly init: ResponseInit | null) {
    this.originalStatus = init?.status;
  }

  write(http: ResolvedHead['http']): void {
    const init = this.init;
    if (init === null) {
      return;
    }
    const mutable = init as { status?: number; headers?: HeadersInit };

    if (http.status !== undefined) {
      mutable.status = http.status;
      this.wroteStatus = true;
    } else if (this.wroteStatus) {
      mutable.status = this.originalStatus;
      this.wroteStatus = false;
    }

    const wanted = new Set(Object.keys(http.headers).map((name) => name.toLowerCase()));
    for (const name of this.written) {
      if (!wanted.has(name)) {
        this.remove(mutable, name);
        this.written.delete(name);
      }
    }
    for (const [name, value] of Object.entries(http.headers)) {
      this.set(mutable, name, value);
      this.written.add(name.toLowerCase());
    }
  }

  private set(init: { headers?: HeadersInit }, name: string, value: string): void {
    const headers = init.headers;
    if (headers === undefined) {
      init.headers = { [name]: value };
    } else if (headers instanceof Headers) {
      headers.set(name, value);
    } else if (Array.isArray(headers)) {
      const at = headers.findIndex(([key]) => key.toLowerCase() === name.toLowerCase());
      if (at === -1) {
        headers.push([name, value]);
      } else {
        headers[at] = [name, value];
      }
    } else {
      const record = headers as Record<string, string>;
      for (const key of Object.keys(record)) {
        if (key.toLowerCase() === name.toLowerCase()) {
          delete record[key];
        }
      }
      record[name] = value;
    }
  }

  private remove(init: { headers?: HeadersInit }, name: string): void {
    const headers = init.headers;
    if (headers instanceof Headers) {
      headers.delete(name);
    } else if (Array.isArray(headers)) {
      init.headers = headers.filter(([key]) => key.toLowerCase() !== name);
    } else if (headers !== undefined) {
      const record = headers as Record<string, string>;
      for (const key of Object.keys(record)) {
        if (key.toLowerCase() === name) {
          delete record[key];
        }
      }
    }
  }
}
