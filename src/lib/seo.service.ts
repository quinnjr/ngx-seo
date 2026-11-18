import {
  ApplicationRef,
  DestroyRef,
  DOCUMENT,
  EnvironmentInjector,
  ErrorHandler,
  Injectable,
  Injector,
  InjectionToken,
  TransferState,
  makeStateKey,
  PLATFORM_ID,
  REQUEST,
  RESPONSE_INIT,
  Signal,
  WritableSignal,
  afterNextRender,
  computed,
  effect,
  inject,
  isDevMode,
  signal,
  untracked,
} from '@angular/core';
import { APP_BASE_HREF, isPlatformBrowser, isPlatformServer } from '@angular/common';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  PRIMARY_OUTLET,
  ROUTES,
  type ActivatedRoute,
  type Route,
  Router,
  TitleStrategy,
} from '@angular/router';
import { diagnose } from './diagnostics';
import { resolveHead } from './derive';
import { mergeLayers } from './merge';
import { HeadReconciler } from './reconciler';
import { collectRouteLayers } from './route-layers';
import { SeoTitleStrategy } from './title-strategy';
import { SEO_SITE_CONFIG } from './tokens';
import type { ResolvedHead, SeoConfig, SeoContext, SeoHandle, SeoSiteConfig } from './types';
import { canonicalFor, originOf } from './url';
import { ResponseWriter } from './response';

export interface ContributeOptions {
  /** Higher wins. Ties resolve by creation order. Default 0. */
  priority?: number;
  /** Removes the contribution when this is destroyed. */
  destroyRef?: DestroyRef;
  /**
   * The route the contribution belongs to: an `ActivatedRoute`, or a `Route`
   * config. It only applies while that route is attached, so a page kept alive
   * by a `RouteReuseStrategy`, or a service from a route's `providers`, stops
   * contributing once you navigate away. `injectSeo` sets this for you.
   */
  route?: ActivatedRoute | Route | null;
  /**
   * The component host element. It carries the contribution across
   * hydration: until the component hydrates in the browser, the server's copy
   * of its SEO stands in for it. `injectSeo` sets this for you.
   */
  host?: Element | null;
}

/** Host attribute linking a server-rendered component to its server SEO copy. */
export const SEO_HOST_ATTR = 'data-seo-c';

interface ServerCopy {
  id: string;
  priority: number;
  order: number;
  config: SeoConfig;
}

/** Component contributions the server rendered, for the browser to use until they hydrate. */
const SERVER_COPIES = makeStateKey<ServerCopy[]>('ngx-seo:contributions');

type Source = SeoConfig | (() => SeoConfig);

interface Contribution {
  readonly hostId: string | null;
  readonly route: ActivatedRoute | Route | null;
  readonly priority: number;
  readonly order: number;
  readonly value: Signal<SeoConfig>;
}

/**
 * How long the browser waits for the app to become stable before taking over
 * server-rendered tags anyway. Internal; tests shorten it.
 */
export const SEO_TAKEOVER_TIMEOUT = new InjectionToken<number>('SEO_TAKEOVER_TIMEOUT', {
  providedIn: 'root',
  factory: () => 1000,
});

/** The value of a contribution that is waiting for a required input. */
const NOT_READY: SeoConfig = Object.freeze({});

/** True for Angular's "required input has no value yet" error (NG0950). */
function isInputNotReady(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === -950 || (typeof message === 'string' && message.includes('NG0950'));
}

/** The missing-baseUrl warning is printed once per server process, not per request. */
let warnedMissingBaseUrl = false;

const DEAD_HANDLE: SeoHandle = {
  set: () => {},
  patch: () => {},
  clear: () => {},
  destroy: () => {},
};

const EMPTY_HEAD: ResolvedHead = {
  title: null,
  htmlAttrs: {},
  tags: [],
  http: { headers: {} },
  canonical: null,
  robots: null,
  droppedUrls: [],
};

/**
 * Holds every SEO layer, resolves them into one head and keeps the document
 * in sync with it.
 */
@Injectable({ providedIn: 'root' })
export class Seo {
  private readonly site: SeoSiteConfig = inject(SEO_SITE_CONFIG, { optional: true }) ?? {};
  private readonly doc = inject(DOCUMENT);
  private readonly errorHandler = inject(ErrorHandler);
  private readonly injector = inject(Injector);
  private readonly platformId = inject(PLATFORM_ID);
  /** Route titles belong to ngx-seo only while its own TitleStrategy is the active one. */
  private readonly ownsTitles = inject(TitleStrategy, { optional: true }) instanceof SeoTitleStrategy;
  /** Router is root-provided; only apps that registered routes will navigate. */
  private readonly routed = inject(ROUTES, { optional: true }) !== null;
  private readonly reconciler = new HeadReconciler(this.doc, {
    persistOriginals: isPlatformServer(this.platformId),
    // With another TitleStrategy driving routes, a missing title is that strategy's to set.
    restoreTitle: this.ownsTitles || !this.routed,
  });
  private readonly basePath = this.resolveBasePath();
  /** The site config as applied: without `defaultTitle` while another TitleStrategy owns titles. */
  private readonly effectiveSite: SeoSiteConfig =
    this.ownsTitles || !this.routed ? this.site : { ...this.site, defaultTitle: undefined };
  private readonly request = inject(REQUEST, { optional: true });
  private readonly response = isPlatformServer(this.platformId)
    ? new ResponseWriter(inject(RESPONSE_INIT, { optional: true }), (error) => this.report(error))
    : null;
  private readonly router = inject(Router, { optional: true });
  /** False while the browser waits to take over server-rendered tags. */
  private ready = !(isPlatformBrowser(this.platformId) && this.reconciler.hasServerRendered());

  private readonly routeLayers = signal<readonly SeoConfig[]>([]);
  private readonly path = signal<string>(this.initialPath());
  private readonly contributions = signal<readonly Contribution[]>([]);
  /** Routes currently attached to the router state; null when no router is tracked. */
  private readonly attached = signal<ReadonlySet<ActivatedRoute | Route> | null>(null);
  private nextOrder = 0;
  /** Bumped to re-evaluate contributions that were waiting for a required input. */
  private readonly retry = signal(0);
  private retries = 0;
  private reconcileScheduled = false;
  /** Set while computing when a contribution is waiting for a required input. */
  private notReady = false;
  /** NavigationEnd events seen; the second is the first client navigation. */
  private navigations = 0;
  private nextHostId = 0;
  private readonly transferState = inject(TransferState);
  /**
   * Browser only: server copies of component contributions whose components
   * have not hydrated yet (for example inside `@defer (hydrate …)`).
   */
  private readonly serverCopies = signal<ReadonlyMap<string, ServerCopy>>(new Map());
  /** Browser only: the server's creation order of every hosted contribution, so both sides rank alike. */
  private serverOrders = new Map<string, number>();
  /** Contributions made so far per route key, for route-bound copy ids. */
  private readonly routeSeq = new Map<string, number>();
  /** Browser only: how many contributions each host has claimed so far. */
  private readonly hostClaims = new WeakMap<Element, number>();
  /** Browser only: the highest server order, reserved until takeover. */
  private maxServerOrder = -1;
  /** Depth of reactive computation; errors raised inside are delivered after it. */
  private computing = 0;
  private pendingErrors: unknown[] = [];
  private lastLayers: readonly SeoConfig[] = [];
  private readonly warned = new Set<string>();
  private readonly diagnostics =
    isDevMode() && isPlatformBrowser(this.platformId) && (this.site.diagnostics ?? 'warn') === 'warn';

  /** The fully derived head for the current page. */
  readonly resolved: Signal<ResolvedHead> = computed(() => {
    this.notReady = false;
    this.computing++;
    try {
      try {
        return this.compute();
      } catch (error) {
        this.report(error);
      }
      // Never keep the previous page's tags: fall back to the site defaults alone.
      try {
        return this.computeDefaultsOnly();
      } catch (error) {
        this.report(error);
        return EMPTY_HEAD;
      }
    } finally {
      this.computing--;
    }
  });

  constructor() {
    effect(() => {
      const head = this.resolved();
      untracked(() => {
        this.flushErrors();
        if (this.notReady) {
          this.retryNotReady();
        } else {
          this.retries = 0;
        }
        if (this.ready) {
          if (isPlatformBrowser(this.platformId)) {
            // Apply after the render pass: components created while rendering (children,
            // @if blocks) and inputs bound in it are then included, so the page goes
            // straight from one complete head to the next.
            this.scheduleReconcile();
          } else {
            this.reconcile(head);
          }
        }
        this.writeResponse(head);
        this.writeServerCopies();
        if (this.diagnostics && this.ready && (!this.routed || this.router?.navigated === true)) {
          // Check after the render pass, so contributors created while rendering count.
          afterNextRender(() => this.warnSafely(untracked(this.resolved)), { injector: this.injector });
        }
      });
    });
    this.followRouter();
    if (this.site.baseUrl !== undefined && originOf(this.site.baseUrl) === null) {
      this.report(
        new Error(
          `ngx-seo: baseUrl ${JSON.stringify(this.site.baseUrl)} is not an absolute http(s) URL; ` +
            'falling back to the request or page origin.',
        ),
      );
    }
    if (isPlatformServer(this.platformId) && !this.site.baseUrl && isDevMode() && !warnedMissingBaseUrl) {
      warnedMissingBaseUrl = true;
      console.warn(
        '[ngx-seo] No baseUrl is configured, so canonical and og:url URLs use the request host. ' +
          'Set baseUrl in provideSeo() for production: request hosts are client-supplied.',
      );
    }
    if (!this.ready) {
      const copies = this.transferState.get(SERVER_COPIES, null);
      this.transferState.remove(SERVER_COPIES);
      if (Array.isArray(copies)) {
        this.serverOrders = new Map(copies.map((copy) => [copy.id, copy.order]));
        this.maxServerOrder = Math.max(-1, ...copies.map((copy) => copy.order));
        this.serverCopies.set(new Map(copies.map((copy) => [copy.id, copy])));
      }
      void this.takeOverAfterHydration();
    }
  }

  /** Adds a layer above routes and defaults. */
  contribute(config: Source, options: ContributeOptions = {}): SeoHandle {
    let alive = true;
    let unregister: (() => void) | undefined;
    const kill = (): void => {
      alive = false;
      this.contributions.update((list) => list.filter((item) => item !== contribution));
    };
    if (options.destroyRef) {
      try {
        unregister = options.destroyRef.onDestroy(() => {
          if (alive) {
            kill();
          }
        });
      } catch {
        // The owner is already destroyed: contribute nothing.
        return DEAD_HANDLE;
      }
    }

    const source: WritableSignal<Source> = signal(config);
    const patches = signal<SeoConfig>({});
    const value = computed<SeoConfig>(() => {
      const current = source();
      if (typeof current === 'function') {
        this.retry();
      }
      let base: SeoConfig = {};
      if (typeof current === 'function') {
        try {
          base = current() ?? {};
        } catch (error) {
          if (isInputNotReady(error)) {
            // A required input is bound later in this render pass: not an error, just not ready.
            return NOT_READY;
          } else {
            this.report(error);
          }
        }
      } else {
        base = current;
      }
      return { ...base, ...patches() };
    });
    // The root ActivatedRoute is replaced on every navigation when routes are
    // never reused, but the root is always attached: treat it as no route.
    const route = options.route ?? null;
    const isRoot = route !== null && 'parent' in route && route.parent === null;
    const boundRoute = isRoot ? null : route;

    // A contribution travels from server to browser under a copy id: its host
    // element's, or, without a host, its route's (route-provided services).
    let hostId: string | null = null;
    let order: number | null = null;
    const host = options.host ?? null;
    const server = isPlatformServer(this.platformId);
    try {
      if (host !== null) {
        if (server) {
          // Several contributions can share a host (host directives, two injectSeo calls): list them all.
          hostId = String(this.nextHostId++);
          const existing = host.getAttribute(SEO_HOST_ATTR);
          host.setAttribute(SEO_HOST_ATTR, existing ? `${existing} ${hostId}` : hostId);
        } else {
          // The n-th contribution on a host claims the n-th server id, as created in the same order.
          const ids = (host.getAttribute(SEO_HOST_ATTR) ?? '').split(/\s+/).filter((id) => id !== '');
          const index = this.hostClaims.get(host) ?? 0;
          this.hostClaims.set(host, index + 1);
          hostId = ids[index] ?? null;
        }
      } else if (boundRoute !== null) {
        const key = this.routeKey(boundRoute);
        if (key !== null) {
          const seq = this.routeSeq.get(key) ?? 0;
          this.routeSeq.set(key, seq + 1);
          hostId = `r:${key}#${seq}`;
        }
      }
      if (!server && hostId !== null) {
        const claimed = hostId;
        const serverOrder = this.serverOrders.get(claimed);
        if (serverOrder !== undefined) {
          order = serverOrder;
          this.nextOrder = Math.max(this.nextOrder, serverOrder + 1);
        }
        if (untracked(this.serverCopies).has(claimed)) {
          // The contributor exists in the browser now: its own contribution replaces the server copy.
          this.serverCopies.update((copies) => {
            const next = new Map(copies);
            next.delete(claimed);
            return next;
          });
        }
      }
    } catch (error) {
      this.report(error);
    }

    const contribution: Contribution = {
      hostId,
      route: boundRoute,
      priority: options.priority ?? 0,
      order: order ?? this.nextOrder++,
      value,
    };
    this.contributions.update((list) => [...list, contribution]);

    const handle: SeoHandle = {
      set: (next) => {
        if (alive) {
          source.set(next);
          patches.set({});
        }
      },
      patch: (partial) => {
        if (alive) {
          const defined = Object.fromEntries(Object.entries(partial).filter(([, value]) => value !== undefined));
          patches.update((current) => ({ ...current, ...defined }));
        }
      },
      clear: () => {
        if (alive) {
          source.set({});
          patches.set({});
        }
      },
      destroy: () => {
        if (alive) {
          kill();
          unregister?.();
        }
      },
    };
    return handle;
  }

  /**
   * Waits for the initial navigation and the first stable app before touching
   * server-rendered tags, so client data that the server already had is not
   * stripped and rebuilt while it is still arriving.
   */
  private async takeOverAfterHydration(): Promise<void> {
    const appRef = inject(ApplicationRef);
    const timeout = inject(SEO_TAKEOVER_TIMEOUT);
    const router = this.router;
    try {
      if (router !== null && this.routed && !router.navigated) {
        await new Promise<void>((resolve) => {
          const subscription = router.events.subscribe((event) => {
            if (
              event instanceof NavigationEnd ||
              event instanceof NavigationCancel ||
              event instanceof NavigationError ||
              event instanceof NavigationSkipped
            ) {
              subscription.unsubscribe();
              resolve();
            }
          });
        });
      }
      // Take over at the first of: the app becoming stable, a timeout (apps with
      // recurring timers may never be stable), or the next navigation.
      let cleanup = (): void => {};
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeout);
        const subscription = router?.events.subscribe((event) => {
          if (event instanceof NavigationEnd) {
            resolve();
          }
        });
        cleanup = () => {
          clearTimeout(timer);
          subscription?.unsubscribe();
        };
        void appRef.whenStable().then(() => resolve());
      });
      cleanup();
    } finally {
      // Anything contributed from now on ranks above every server contribution,
      // including deferred ones that hydrate later and keep their server order.
      this.nextOrder = Math.max(this.nextOrder, this.maxServerOrder + 1);
      this.ready = true;
      const head = untracked(this.resolved);
      this.flushErrors();
      this.reconcile(head);
      if (this.diagnostics && (!this.routed || router?.navigated === true)) {
        this.warnSafely(head);
      }
    }
  }

  private followRouter(): void {
    const router = this.router;
    if (router === null) {
      return;
    }
    const injector = inject(EnvironmentInjector);
    const key = this.site.routeDataKey ?? 'seo';
    const trackAttached = (): void => {
      const routes = new Set<ActivatedRoute | Route>();
      // Only the primary chain: named outlets never contribute, from data or components.
      const visit = (route: ActivatedRoute): void => {
        routes.add(route);
        const config = route.snapshot?.routeConfig;
        if (config) {
          routes.add(config);
        }
        for (const child of route.children) {
          if (child.outlet === PRIMARY_OUTLET) {
            visit(child);
          }
        }
      };
      visit(router.routerState.root);
      this.attached.set(routes);
    };
    const sync = (): void => {
      trackAttached();
      this.path.set(this.withBasePath(router.url));
      this.routeLayers.set(
        collectRouteLayers(router.routerState.snapshot.root, key, injector, (error) => this.report(error), this.ownsTitles),
      );
    };
    const subscription = router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        this.navigations++;
        if (this.navigations === 2 && untracked(this.serverCopies).size > 0) {
          // The first client navigation: the server's page is gone, and so are its copies.
          this.serverCopies.set(new Map());
        }
        sync();
      }
    });
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
    if (router.navigated) {
      sync();
    } else {
      trackAttached();
    }
  }

  private compute(): ResolvedHead {
    const attached = this.attached();
    const live = this.contributions()
      .filter((item) => item.route === null || attached === null || attached.has(item.route))
      .map((item) => ({ priority: item.priority, order: item.order, value: item.value }));
    // Server copies stand in for components that have not hydrated, while their host is still in the page.
    const copies = [...this.serverCopies().values()]
      .filter((copy) => this.copyStillApplies(copy.id, attached))
      .map((copy) => ({ priority: copy.priority, order: copy.order, value: () => copy.config }));
    // Hosted contributions keep the server's creation order, so copies and live ones rank as on the server.
    const contributions = [...copies, ...live]
      .sort((a, b) => a.priority - b.priority || a.order - b.order)
      .map((item) => item.value())
      .filter((config) => {
        if (config === NOT_READY) {
          this.notReady = true;
          return false;
        }
        return true;
      });
    const layers: SeoConfig[] = [...this.routeLayers(), ...contributions];
    const env = { path: this.path(), origin: this.origin(), basePath: this.basePath };
    const all = [this.defaultsLayer(layers, env), ...layers];
    this.lastLayers = all;
    const merged = mergeLayers(all, (error) => this.report(error));
    return resolveHead(merged, this.effectiveSite, { ...env, onError: (error) => this.report(error) });
  }

  private computeDefaultsOnly(): ResolvedHead {
    const env = { path: this.path(), origin: this.origin(), basePath: this.basePath };
    this.lastLayers = [];
    return resolveHead(mergeLayers([this.defaultsLayer([], env)]), this.effectiveSite, env);
  }

  private defaultsLayer(layers: SeoConfig[], env: { path: string; origin: string | null; basePath?: string }): SeoConfig {
    const defaults = this.site.defaults;
    if (typeof defaults !== 'function') {
      return defaults ?? {};
    }
    const higher = mergeLayers(layers);
    const ctx: SeoContext = {
      url: env.path,
      canonical: resolveHead(higher, this.effectiveSite, env).canonical,
      title: higher.title ?? null,
      description: higher.description ?? null,
      siteName: this.site.siteName ?? null,
    };
    try {
      return defaults(ctx) ?? {};
    } catch (error) {
      this.report(error);
      return {};
    }
  }

  private warnSafely(head: ResolvedHead): void {
    try {
      this.warn(head);
    } catch (error) {
      this.report(error);
    }
  }

  private warn(head: ResolvedHead): void {
    const path = untracked(this.path);
    const current = canonicalFor(path, originOf(this.site.baseUrl ?? null) ?? this.origin(), {
      trailingSlash: this.site.canonical?.trailingSlash ?? 'preserve',
      keepQueryParams: this.site.canonical?.keepQueryParams ?? [],
    });
    for (const message of diagnose(head, this.lastLayers, current, { checkTitle: this.ownsTitles || !this.routed })) {
      const id = `${path.split('?')[0]}\n${message}`;
      if (!this.warned.has(id)) {
        this.warned.add(id);
        console.warn(`[ngx-seo] ${message} (${path})`);
      }
    }
  }

  /**
   * A stable key for a route config: its index path in the router config
   * (children and lazily loaded routes included), the same on server and browser.
   */
  private routeKey(route: ActivatedRoute | Route): string | null {
    const config = 'snapshot' in route ? route.snapshot?.routeConfig : route;
    if (!config || this.router === null) {
      return null;
    }
    type Loaded = Route & { _loadedRoutes?: Route[] };
    const search = (routes: readonly Route[] | undefined, prefix: string): string | null => {
      for (const [index, candidate] of (routes ?? []).entries()) {
        const here = `${prefix}${index}`;
        if (candidate === config) {
          return here;
        }
        const found =
          search(candidate.children, `${here}.`) ?? search((candidate as Loaded)._loadedRoutes, `${here}~`);
        if (found !== null) {
          return found;
        }
      }
      return null;
    };
    return search(this.router.config, '');
  }

  /** The route config at a key from `routeKey`. */
  private routeAt(key: string): Route | null {
    let routes: readonly Route[] | undefined = this.router?.config;
    let found: Route | null = null;
    for (const part of key.split(/(?=[.~])/)) {
      const lazy = part.startsWith('~');
      const index = Number(part.replace(/^[.~]/, ''));
      const list: readonly Route[] | undefined = lazy ? (found as (Route & { _loadedRoutes?: Route[] }) | null)?._loadedRoutes : found === null ? routes : found.children;
      found = list?.[index] ?? null;
      if (found === null) {
        return null;
      }
      routes = undefined;
    }
    return found;
  }

  /** Whether a server copy still stands in: its host is still in the page, or its route is still attached. */
  private copyStillApplies(id: string, attached: ReadonlySet<ActivatedRoute | Route> | null): boolean {
    const routeMatch = /^r:(.+)#\d+$/.exec(id);
    if (routeMatch !== null) {
      const config = this.routeAt(routeMatch[1]);
      return config !== null && (attached === null || attached.has(config));
    }
    return this.doc.querySelector?.(`[${SEO_HOST_ATTR}~="${id}"]`) != null;
  }

  /** Server only: records component contributions for the browser to use until they hydrate. */
  private writeServerCopies(): void {
    if (!isPlatformServer(this.platformId)) {
      return;
    }
    try {
      const copies: ServerCopy[] = [];
      const attached = this.attached();
      for (const item of this.contributions()) {
        // Only what applies on the server travels: hosted, and on an attached primary route.
        if (item.hostId === null || (item.route !== null && attached !== null && !attached.has(item.route))) {
          continue;
        }
        const config = untracked(item.value);
        if (config === NOT_READY) {
          continue;
        }
        try {
          // Only what survives JSON travels; functions (e.g. a title template) do not.
          copies.push({ id: item.hostId, priority: item.priority, order: item.order, config: JSON.parse(JSON.stringify(config)) });
        } catch (error) {
          this.report(error);
        }
      }
      if (copies.length > 0) {
        this.transferState.set(SERVER_COPIES, copies);
      } else {
        this.transferState.remove(SERVER_COPIES);
      }
    } catch (error) {
      this.report(error);
    }
  }

  private scheduleReconcile(): void {
    if (this.reconcileScheduled) {
      return;
    }
    this.reconcileScheduled = true;
    afterNextRender(
      () => {
        this.reconcileScheduled = false;
        const head = untracked(this.resolved);
        this.flushErrors();
        this.reconcile(head);
      },
      { injector: this.injector },
    );
  }

  /** Re-evaluates waiting contributions once the current render pass has bound inputs. */
  private retryNotReady(): void {
    if (this.retries >= 3) {
      return;
    }
    this.retries++;
    queueMicrotask(() => this.retry.update((n) => n + 1));
  }

  private writeResponse(head: ResolvedHead): void {
    try {
      this.response?.write(head.http);
    } catch (error) {
      this.report(error);
    }
  }

  private reconcile(head: ResolvedHead): void {
    try {
      this.reconciler.apply(head);
    } catch (error) {
      this.report(error);
    }
  }

  private origin(): string | null {
    return originOf(this.request?.url ?? null) ?? originOf(this.doc.location?.href ?? null);
  }

  private initialPath(): string {
    const location = this.doc.location;
    return location ? `${location.pathname}${location.search}` : '/';
  }

  /**
   * The path the app is served under: the router base href when it is not
   * the root, otherwise the path of `baseUrl`.
   */
  private resolveBasePath(): string {
    const fromHref = inject(APP_BASE_HREF, { optional: true }) ?? this.doc.querySelector?.('base')?.getAttribute('href') ?? null;
    const pathOf = (value: string | null | undefined): string => {
      if (!value) {
        return '/';
      }
      try {
        return new URL(value, 'http://base.invalid').pathname;
      } catch {
        return '/';
      }
    };
    const hrefPath = pathOf(fromHref);
    return hrefPath !== '/' ? hrefPath : originOf(this.site.baseUrl ?? null) === null ? '/' : pathOf(this.site.baseUrl);
  }

  /** Prefixes a router URL (which excludes the base href) with the base path. */
  private withBasePath(url: string): string {
    if (this.basePath === '/') {
      return url;
    }
    return `${this.basePath.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
  }

  /**
   * Reports an error to the app's ErrorHandler. Errors raised while signals
   * are being computed are held until the computation is over, so an
   * ErrorHandler that writes signals works.
   */
  private report(error: unknown): void {
    if (this.computing > 0) {
      this.pendingErrors.push(error);
      return;
    }
    this.deliver(error);
  }

  private flushErrors(): void {
    const errors = this.pendingErrors;
    this.pendingErrors = [];
    for (const error of errors) {
      this.deliver(error);
    }
  }

  private deliver(error: unknown): void {
    try {
      this.errorHandler.handleError(error);
    } catch {
      // Reporting must never break rendering.
    }
  }
}
