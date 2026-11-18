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
  signal,
  untracked,
} from '@angular/core';
import { isPlatformBrowser, isPlatformServer } from '@angular/common';
import { NavigationCancel, NavigationEnd, NavigationError, NavigationSkipped, ROUTES, Router } from '@angular/router';
import { resolveHead } from './derive';
import { mergeLayers } from './merge';
import { HeadReconciler } from './reconciler';
import { collectRouteLayers } from './route-layers';
import { SEO_SITE_CONFIG } from './tokens';
import type { ResolvedHead, SeoConfig, SeoContext, SeoHandle, SeoSiteConfig } from './types';
import { originOf } from './url';
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
    ? new ResponseWriter(inject(RESPONSE_INIT, { optional: true }))
    : null;
  private readonly router = inject(Router, { optional: true });
  /** Router is root-provided; only apps that registered routes will navigate. */
  private readonly routed = inject(ROUTES, { optional: true }) !== null;
  /** False while the browser waits to take over server-rendered tags. */
  private ready = !(isPlatformBrowser(this.platformId) && this.reconciler.hasServerRendered());

  private readonly routeLayers = signal<readonly SeoConfig[]>([]);
  private readonly routeTitle = signal<string | undefined>(undefined);
  private readonly path = signal<string>(this.initialPath());
  private readonly contributions = signal<readonly Contribution[]>([]);
  private nextOrder = 0;
  private lastGood: ResolvedHead = EMPTY_HEAD;

  /** The fully derived head for the current page. */
  readonly resolved: Signal<ResolvedHead> = computed(() => {
    try {
      this.lastGood = this.compute();
    } catch (error) {
      this.report(error);
    }
    return this.lastGood;
  });

  constructor() {
    effect(() => {
      const head = this.resolved();
      untracked(() => {
        this.response?.write(head.http);
        if (this.ready) {
          this.reconcile(head);
        }
      });
    });
    this.followRouter();
    if (!this.ready) {
      void this.takeOverAfterHydration();
    }
  }

  /** Adds a layer above routes and defaults. */
  contribute(config: Source, options: ContributeOptions = {}): SeoHandle {
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

    let alive = true;
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
          alive = false;
          this.contributions.update((list) => list.filter((item) => item !== contribution));
        }
      },
    };
    options.destroyRef?.onDestroy(() => handle.destroy());
    return handle;
  }

  /** @internal Route layers, root to leaf. */
  setRouteLayers(layers: readonly SeoConfig[]): void {
    this.routeLayers.set(layers);
  }

  /** @internal Title from the router's `title` property. */
  setRouteTitle(title: string | undefined): void {
    this.routeTitle.set(title);
  }

  /** @internal Current router path including query string. */
  setPath(path: string): void {
    this.path.set(path);
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
    const routeTitle = this.routeTitle();
    const layers: SeoConfig[] = [
      routeTitle === undefined ? {} : { title: routeTitle },
      ...this.routeLayers(),
      ...contributions,
    ];
    const env = { path: this.path(), origin: this.origin() };
    const merged = mergeLayers([this.defaultsLayer(layers, env), ...layers]);
    return resolveHead(merged, this.site, { ...env, onError: (error) => this.report(error) });
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
