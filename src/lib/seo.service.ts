import {
  ApplicationRef,
  DestroyRef,
  DOCUMENT,
  EnvironmentInjector,
  ErrorHandler,
  Injectable,
  PLATFORM_ID,
  REQUEST,
  RESPONSE_INIT,
  Signal,
  WritableSignal,
  computed,
  effect,
  inject,
  isDevMode,
  signal,
  untracked,
} from '@angular/core';
import { isPlatformBrowser, isPlatformServer } from '@angular/common';
import { NavigationCancel, NavigationEnd, NavigationError, NavigationSkipped, ROUTES, Router } from '@angular/router';
import { diagnose } from './diagnostics';
import { resolveHead } from './derive';
import { mergeLayers } from './merge';
import { HeadReconciler } from './reconciler';
import { collectRouteLayers } from './route-layers';
import { SEO_SITE_CONFIG } from './tokens';
import type { ResolvedHead, SeoConfig, SeoContext, SeoHandle, SeoSiteConfig } from './types';
import { canonicalFor, originOf } from './url';
import { ResponseWriter } from './response';

export interface ContributeOptions {
  /** Higher wins. Ties resolve by creation order. Default 0. */
  priority?: number;
  /** Removes the contribution when this is destroyed. */
  destroyRef?: DestroyRef;
}

type Source = SeoConfig | (() => SeoConfig);

interface Contribution {
  readonly priority: number;
  readonly order: number;
  readonly value: Signal<SeoConfig>;
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
  private readonly reconciler = new HeadReconciler(this.doc);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly request = inject(REQUEST, { optional: true });
  private readonly response = isPlatformServer(this.platformId)
    ? new ResponseWriter(inject(RESPONSE_INIT, { optional: true }), (error) => this.report(error))
    : null;
  private readonly router = inject(Router, { optional: true });
  /** Router is root-provided; only apps that registered routes will navigate. */
  private readonly routed = inject(ROUTES, { optional: true }) !== null;
  /** False while the browser waits to take over server-rendered tags. */
  private ready = !(isPlatformBrowser(this.platformId) && this.reconciler.hasServerRendered());

  private readonly routeLayers = signal<readonly SeoConfig[]>([]);
  private readonly path = signal<string>(this.initialPath());
  private readonly contributions = signal<readonly Contribution[]>([]);
  private nextOrder = 0;
  private lastLayers: readonly SeoConfig[] = [];
  private readonly warned = new Set<string>();
  private readonly diagnostics =
    isDevMode() && isPlatformBrowser(this.platformId) && (this.site.diagnostics ?? 'warn') === 'warn';

  /** The fully derived head for the current page. */
  readonly resolved: Signal<ResolvedHead> = computed(() => {
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
  });

  constructor() {
    effect(() => {
      const head = this.resolved();
      untracked(() => {
        if (this.ready) {
          this.reconcile(head);
        }
        this.writeResponse(head);
        if (this.diagnostics && this.ready && (!this.routed || this.router?.navigated === true)) {
          this.warn(head);
        }
      });
    });
    this.followRouter();
    if (isPlatformServer(this.platformId) && !this.site.baseUrl && isDevMode() && !warnedMissingBaseUrl) {
      warnedMissingBaseUrl = true;
      console.warn(
        '[ngx-seo] No baseUrl is configured, so canonical and og:url URLs use the request host. ' +
          'Set baseUrl in provideSeo() for production: request hosts are client-supplied.',
      );
    }
    if (!this.ready) {
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
      let base: SeoConfig = {};
      if (typeof current === 'function') {
        try {
          base = current() ?? {};
        } catch (error) {
          this.report(error);
        }
      } else {
        base = current;
      }
      return { ...base, ...patches() };
    });
    const contribution: Contribution = { priority: options.priority ?? 0, order: this.nextOrder++, value };
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
          patches.update((current) => ({ ...current, ...partial }));
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
      await appRef.whenStable();
    } finally {
      this.ready = true;
      this.reconcile(untracked(this.resolved));
    }
  }

  private followRouter(): void {
    const router = this.router;
    if (router === null) {
      return;
    }
    const injector = inject(EnvironmentInjector);
    const key = this.site.routeDataKey ?? 'seo';
    const sync = (): void => {
      this.path.set(router.url);
      this.routeLayers.set(
        collectRouteLayers(router.routerState.snapshot.root, key, injector, (error) => this.report(error)),
      );
    };
    const subscription = router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        sync();
      }
    });
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
    if (router.navigated) {
      sync();
    }
  }

  private compute(): ResolvedHead {
    const contributions = [...this.contributions()]
      .sort((a, b) => a.priority - b.priority || a.order - b.order)
      .map((item) => item.value());
    const layers: SeoConfig[] = [...this.routeLayers(), ...contributions];
    const env = { path: this.path(), origin: this.origin() };
    const all = [this.defaultsLayer(layers, env), ...layers];
    this.lastLayers = all;
    const merged = mergeLayers(all);
    return resolveHead(merged, this.site, { ...env, onError: (error) => this.report(error) });
  }

  private computeDefaultsOnly(): ResolvedHead {
    const env = { path: this.path(), origin: this.origin() };
    this.lastLayers = [];
    return resolveHead(mergeLayers([this.defaultsLayer([], env)]), this.site, env);
  }

  private defaultsLayer(layers: SeoConfig[], env: { path: string; origin: string | null }): SeoConfig {
    const defaults = this.site.defaults;
    if (typeof defaults !== 'function') {
      return defaults ?? {};
    }
    const higher = mergeLayers(layers);
    const ctx: SeoContext = {
      url: env.path,
      canonical: resolveHead(higher, this.site, env).canonical,
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

  private warn(head: ResolvedHead): void {
    const path = untracked(this.path);
    const current = canonicalFor(path, originOf(this.site.baseUrl ?? null) ?? this.origin(), {
      trailingSlash: this.site.canonical?.trailingSlash ?? 'preserve',
      keepQueryParams: this.site.canonical?.keepQueryParams ?? [],
    });
    for (const message of diagnose(head, this.lastLayers, current)) {
      const id = `${path.split('?')[0]}\n${message}`;
      if (!this.warned.has(id)) {
        this.warned.add(id);
        console.warn(`[ngx-seo] ${message} (${path})`);
      }
    }
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

  private report(error: unknown): void {
    try {
      this.errorHandler.handleError(error);
    } catch {
      // Reporting must never break rendering.
    }
  }
}
