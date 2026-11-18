import { describe, it, expect, vi } from 'vitest';
import { ResponseWriter } from '../src/lib/response';

describe('ResponseWriter', () => {
  it('writes status and headers', () => {
    const init: ResponseInit = {};
    new ResponseWriter(init, () => {}).write({ status: 404, headers: { 'X-Robots-Tag': 'noindex' } });
    expect(init.status).toBe(404);
    expect(new Headers(init.headers).get('x-robots-tag')).toBe('noindex');
  });

  it('drops and reports invalid header names and values instead of throwing', () => {
    const init: ResponseInit = { headers: new Headers() };
    const onError = vi.fn();
    const writer = new ResponseWriter(init, onError);
    expect(() =>
      writer.write({ headers: { 'X-Note': 'a\nb', 'Bad Name': 'x', 'X-Euro': '€', 'X-Ok': 'fine' } }),
    ).not.toThrow();
    const headers = init.headers as Headers;
    expect(headers.get('X-Ok')).toBe('fine');
    expect(headers.has('X-Note')).toBe(false);
    expect(headers.has('X-Euro')).toBe(false);
    expect(onError).toHaveBeenCalledTimes(3);
  });

  it('validates headers written to a plain record too', () => {
    const init: ResponseInit = { headers: {} };
    new ResponseWriter(init, () => {}).write({ headers: { 'X-Note': 'a\r\nSet-Cookie: x=1' } });
    expect(init.headers).toEqual({});
  });

  it('restores a server header it overrode once no longer wanted', () => {
    const init: ResponseInit = { headers: new Headers({ 'Cache-Control': 'public' }) };
    const writer = new ResponseWriter(init, () => {});
    writer.write({ headers: { 'cache-control': 'no-store' } });
    expect((init.headers as Headers).get('Cache-Control')).toBe('no-store');
    writer.write({ headers: {} });
    expect((init.headers as Headers).get('Cache-Control')).toBe('public');
  });

  it('edits a tuple-array header list in place', () => {
    const list: [string, string][] = [['Content-Type', 'text/html']];
    const init: ResponseInit = { headers: list };
    const writer = new ResponseWriter(init, () => {});
    writer.write({ headers: { 'X-A': '1' } });
    writer.write({ headers: {} });
    expect(init.headers).toBe(list);
    expect(list).toEqual([['Content-Type', 'text/html']]);
  });

  it('restores the original status', () => {
    const init: ResponseInit = { status: 200 };
    const writer = new ResponseWriter(init, () => {});
    writer.write({ status: 404, headers: {} });
    writer.write({ headers: {} });
    expect(init.status).toBe(200);
  });
});
