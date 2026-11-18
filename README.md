# ngx-seo

Layered SEO and AEO (answer-engine optimisation) for Angular 21+, on the
server during SSR and in the browser as the SPA runs.

A page declares only what is unique to it. Site defaults, routes and
components each contribute a partial config; ngx-seo merges them, derives
everything that repeats (Open Graph, Twitter, canonical, absolute URLs) and
keeps `<head>` exactly in sync: complete in the server-rendered HTML, with no
duplicates after hydration and nothing stale after a client navigation.

- Zoneless and signal-based. No third-party runtime dependencies; only
  `tslib`, which every ng-packagr-built Angular library uses.
- Peer dependencies: `@angular/core`, `@angular/common`,
  `@angular/platform-browser` and `@angular/router`, all `^21.0.0`.

## Install

```sh
pnpm add ngx-seo
```

## Setup

```ts
// app.config.ts
import { provideSeo, organization, webSite } from 'ngx-seo';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideClientHydration(withEventReplay()),
    provideSeo({
      siteName: 'Lexmata AI',
      baseUrl: 'https://lexmata.ai',
      titleTemplate: '%s | Lexmata',
      defaultTitle: 'Lexmata AI',
      defaults: {
        image: { url: '/assets/images/og-default.jpg', width: 1200, height: 630 },
        twitter: { site: '@lexmata' },
        openGraph: { locale: 'en_US' },
        jsonLd: [
          organization({ '@id': '/#org', name: 'Lexmata AI', url: '/', logo: '/assets/logo.png' }),
          webSite({ '@id': '/#site', name: 'Lexmata AI', url: '/', publisher: { '@id': '/#org' } }),
        ],
      },
    }),
  ],
};
```

### Site options

| Option | Default | Meaning |
|---|---|---|
| `siteName` | none | Used for `og:site_name` and passed to title templates. |
| `baseUrl` | request origin (server), `location.origin` (browser) | Origin used to make URLs absolute. Set it in production: request hosts are client-supplied. In dev mode the server warns once if it is missing. |
| `titleTemplate` | none | `'%s | Site'` or `(title, ctx) => string`. |
| `defaultTitle` | none | Used when no layer sets a title. Not templated. |
| `canonical` | `{ trailingSlash: 'preserve', keepQueryParams: [] }` | How the canonical is derived from the router URL. |
| `defaults` | none | The lowest layer: a `SeoConfig`, or `(ctx) => SeoConfig`. |
| `routeDataKey` | `'seo'` | Route data key to read. |
| `diagnostics` | `'warn'` | Dev-mode console warnings. `'off'` silences them. Never active in production or on the server. |

`provideSeo()` also installs a router `TitleStrategy`. A plain route `title`
then becomes part of that route's SEO layer instead of being written straight
to `document.title`. When no layer sets a title, the document gets back its
original `index.html` title, even after hydration: the server records the
shell's title and `<html lang/dir>` for the browser.

If your app provides its own `TitleStrategy` after `provideSeo()`, that
strategy owns route titles: ngx-seo ignores route `title` and never resets
the document title. It still applies `seo.title` from layers.

### Move SEO tags out of `index.html`

ngx-seo owns these tag families outright: `meta` named `description`,
`keywords`, `author`, `robots` or `twitter:*`; `meta` properties `og:*`,
`article:*`, `profile:*`, `book:*`, `video:*` and `music:*`;
`link rel="canonical"`; and `link rel="alternate"` with `hreflang`. Any of
these left in `index.html` is adopted when a layer provides the same tag and
removed when none does. Put site-wide values in `defaults` instead.

Everything else in `<head>`, such as `viewport`, stylesheets and your own
scripts, is never touched unless a layer overrides it through `meta` or
`links`. An `index.html` tag taken over that way gets its original attributes
back once no page overrides it. Examples: `theme-color`; an icon,
`apple-touch-icon` or manifest link with the same `sizes`/`media`; any other
link with the same `rel` and `href`.

## Declaring SEO

### On a route

```ts
{
  path: 'products/extract',
  loadComponent: () => import('./extract.component'),
  data: {
    seo: {
      title: 'Lexmata Extract',
      description: 'See how Lexmata’s patented Extract OCR process …',
    } satisfies SeoConfig,
  },
}
```

That is the whole declaration. The document title, canonical, `og:*`,
`twitter:*` and site name are derived.

- **Parent routes** contribute beneath their children, which suits
  section-wide values such as `robots: { index: false }` for an admin area.
- **Functions** are called with the route snapshot in an injection context on
  every navigation:

  ```ts
  data: { seo: (route: ActivatedRouteSnapshot) => ({ title: `Case ${route.paramMap.get('id')}` }) }
  ```

  They run in the application's root injector, so services from a route's own
  `providers` are not available. Use a resolver when you need those.
- **Primary outlet only.** Only routes on the primary outlet chain are read.
  Named outlets do not contribute SEO data.
- **Resolvers** write into route data, so `resolve: { seo: postSeoResolver }`
  works with no extra API. This is the recommended path for CMS and blog
  pages, because the data is ready before the server renders the page.

### From a component or service

```ts
export class PostComponent {
  readonly post = input.required<Post>();

  // Re-evaluated whenever the signals it reads change; removed on destroy.
  readonly seo = injectSeo(() => ({
    title: this.post().title,
    description: this.post().excerpt,
    openGraph: { type: 'article', article: { publishedTime: this.post().publishedAt } },
    jsonLd: [blogPosting({ '@id': '#post', headline: this.post().title, author: this.post().author, publisher: { '@id': '/#org' } })],
  }));
}
```

```ts
// A component adding structured data alongside the page's own.
export class FaqSectionComponent {
  readonly items = input.required<FaqItem[]>();
  readonly seo = injectSeo(() => ({ jsonLd: [faqPage(this.items())] }));
}
```

`injectSeo(config, { priority })` returns an `SeoHandle`:

| Method | Effect |
|---|---|
| `set(config)` | Replace this contribution. |
| `patch(partial)` | Merge top-level fields into it. |
| `clear()` | Empty it, keeping the handle. |
| `destroy()` | Remove it. Later calls do nothing. |

Outside an injection context, use the service:
`inject(Seo).contribute(config, { priority, destroyRef, route })`.

A contribution from `injectSeo` belongs to the component's route. It applies
only while that route is attached, so a page kept alive by a
`RouteReuseStrategy` stops contributing when you navigate away, and
contributes again when it is reattached.
`inject(Seo).resolved` is a signal of the fully derived head, useful for
tests or a preview panel.

## How layers combine

Layers, from lowest to highest priority:

1. `defaults` from `provideSeo()`
2. each route on the primary chain, root to leaf: its `title`, then its `data.seo`
3. contributions, by `priority` (default `0`), then creation order

Merge rules:

| Kind | Rule |
|---|---|
| Scalars (`title`, `description`, `canonical`, …) | The highest layer that sets the field wins. |
| `undefined` or `''` | No opinion. |
| `null` | Remove what lower layers set. Works at any depth. |
| Objects (`openGraph`, `twitter`, `robots`, `bots`, `http`) | Merged field by field. A raw-string `robots` replaces the whole object. |
| Keyed lists | Items from all layers are combined; items with the same key collapse to the higher layer. Items without a key are all kept. See the key table below. |
| Plain lists (`keywords`, `article.tags`, …) | The highest layer that sets the list replaces it. |

Keyed lists come out lowest layer first, except `openGraph.images`, where
higher layers come first because platforms use the first `og:image`. The
`image` shorthand always comes before `openGraph.images`.

To drop one inherited item, put `removeItem(key)` in the list:

```ts
jsonLd: [removeItem('/#org')]
```

Item keys, as written in your config (before URLs are made absolute):

| List | Key |
|---|---|
| `jsonLd` | the node's `@id` |
| `alternates` | `hreflang` |
| `meta` | `key`, else `name`, `property` or `httpEquiv` |
| `links` | `key`, else `canonical` for the canonical link, `alternate\|<hreflang>` for a language alternate, otherwise `<rel>\|<href>` |
| `openGraph.images` | `url` |

For example, `links: [removeItem('preconnect|https://cdn.test')]` or
`links: [removeItem('canonical')]`.

## Derivation

Only where the merged config leaves a value unset:

- **Document title.** `titleTemplate` applied to `title`, else `defaultTitle`.
  A layer can set its own `titleTemplate`, or `false` to disable it.
- **Social titles and descriptions.** `og:title` and `twitter:title` come
  from the untemplated `title`; descriptions come from `description`.
  Twitter falls back to Open Graph before the base field.
- **Images.** `og:image` and `twitter:image` come from `image`.
  `twitter:card` is `summary_large_image` when there is an image, else
  `summary`.
- **Site.** `og:site_name` comes from `siteName`, and `og:type` defaults to
  `website`.
- **Canonical.** The origin, plus the path the app is served under, plus the
  router path. The fragment and every query parameter not in
  `keepQueryParams` are removed. `og:url` follows the canonical, and
  `canonical: false` emits neither.
  - The serving path comes from `APP_BASE_HREF` or `<base href>` when that
    is not `/`, otherwise from the path of `baseUrl`. For example,
    `baseUrl: 'https://x.test/docs/'` gives `https://x.test/docs/<route>`.
  - Other root-relative URLs, such as images, resolve against the origin.
- **Absolute URLs.** Every head URL is made absolute. A value that cannot be
  made absolute, or is not `http(s)`, is dropped and reported by
  diagnostics.

## SeoConfig reference

All fields are optional.

| Field | Notes |
|---|---|
| `title`, `titleTemplate` | See derivation. |
| `description`, `author` | |
| `keywords` | `string[]` or a comma-separated string. |
| `lang`, `dir` | Set on `<html>`; restored when no layer sets them. |
| `canonical` | URL, or `false`. |
| `robots` | `{ index, follow, noarchive, nosnippet, noimageindex, notranslate, maxSnippet, maxImagePreview, maxVideoPreview, unavailableAfter }` or a raw string. |
| `bots` | Per-crawler robots, e.g. `{ googlebot: { maxSnippet: 120 } }`. |
| `alternates` | `{ hreflang, href }[]`. |
| `image` | URL or `{ url, alt, width, height, type }`. |
| `openGraph` | `title`, `description`, `type`, `url`, `siteName`, `locale`, `alternateLocales`, `images`, `videos`, `audio`, `article`, `profile`, `book`. |
| `twitter` | `card`, `site`, `creator`, `title`, `description`, `image`, `imageAlt`. |
| `jsonLd` | `JsonLdNode[]`. |
| `meta` | Extra `{ name \| property \| httpEquiv, content, key? }[]`. An extra tag with the same identity as a derived one (for example `name: 'description'`) replaces it. |
| `links` | Extra `{ rel, href, hreflang?, type?, media?, sizes?, title?, key? }[]`. A `canonical` or `alternate`+`hreflang` link replaces the derived one. |
| `http` | `{ status, headers }`, applied to the server response. |

## Structured data (JSON-LD)

All nodes on a page render into one
`<script type="application/ld+json">` as a schema.org `@graph`. Text is
escaped so CMS content cannot close the script element. A node that cannot be
serialised is dropped and reported; the rest still render.

**Ids and URLs**

- `'#post'`: a page-level id, resolved against the page's canonical URL (or,
  with `canonical: false`, the current URL with the canonical query policy
  applied).
- `'/#org'`: a site-wide id, resolved against the site root, so it is the
  same on every page.
- Reference other nodes by id, for example `publisher: { '@id': '/#org' }`.
- Root-relative values of `url`, `item`, `image`, `logo`, `contentUrl`,
  `thumbnailUrl`, `mainEntityOfPage` and `target` are made absolute at every
  depth.

**Builders**

Builders return plain nodes, accept any extra schema.org property, and take
`'@type'` to refine the type:

| Group | Builders |
|---|---|
| Answer-shaped | `faqPage`, `qaPage`, `howTo`, `speakable` |
| Content | `article`, `blogPosting`, `webPage`, `breadcrumbList` |
| Entities | `organization`, `webSite`, `person` |
| Commercial | `product`, `offer`, `aggregateOffer` (computes the price range), `service` |

For anything else, write a plain object. Types from `schema-dts` are
compatible.

## Server response

On the server, `http.status` and `http.headers` are written to Angular's
`RESPONSE_INIT`. A status must be an integer from 200 to 599 that allows an
HTML body, so not 204, 205 or 304. Any other value is ignored and reported,
and the server's own status stands. Header names are case-insensitive, so
`'x-robots-tag': null` removes an inherited `X-Robots-Tag`.

```ts
// not-found route
data: { seo: { title: 'Page not found', robots: { index: false }, http: { status: 404 } } }
```

`RESPONSE_INIT` and `REQUEST` are provided by `AngularNodeAppEngine` and
`AngularAppEngine`. `CommonEngine` provides neither, so with `CommonEngine`
the `http` field does nothing and `baseUrl` must be set.

An invalid header name or value (for example one containing a line break)
is dropped and reported to `ErrorHandler`; the rest of the response and the
head still render. A header the server had already set is restored when no
page asks to override it any more.

## Hydration and navigation

- **Server.** The full head is serialised once the app is stable, including
  resolver data and component contributions.
- **Hydration.** The browser adopts the server's tags and leaves them alone
  until the initial navigation finishes and the app is first stable. Only
  then does it reconcile.
- **Navigation.** The outgoing page's contributions and the new route's
  layers are swapped in the same change-detection pass, so the head moves
  straight from one page's complete state to the next.
- **Errors.** An SEO error never fails a render; it is reported to
  `ErrorHandler`, after any signal computation has finished, so a handler may
  write signals. Errors are contained as narrowly as possible:
  - A malformed field from an untyped source (a CMS, say) drops only its own
    group of tags. A single string where a list is expected counts as a
    one-item list.
  - A JSON-LD node that cannot be serialised (for example a cycle), or that
    has no `@type`, is dropped on its own.
  - A throwing title template falls back to the plain title.
  - A throwing contribution or route function is skipped.
  - If the whole page still cannot be resolved, the head falls back to the
    site defaults, never to the previous page's tags.
  - A DOM failure affects only the tag it happened on. Every other tag is
    still applied.

## Diagnostics

In dev mode in the browser, once the initial navigation has finished,
ngx-seo warns once per page about:

- a missing title or description
- a URL it had to drop
- two JSON-LD nodes in one layer sharing an `@id`
- a `noindex` page whose canonical points elsewhere

## Migrating from a hand-written SEO service

Before, about 35 lines per page in a central service, plus a call from the
component:

```ts
public updateSeoForPricingPage(): void {
  this.applySeoData({
    title: 'Medical Record Review Pricing | Lexmata',
    description: '…',
    ogTitle: 'Medical Record Review Pricing | Lexmata',
    ogDescription: '…',
    ogImage: 'https://lexmata.ai/assets/images/og-default.jpg',
    ogUrl: 'https://lexmata.ai/pricing',
    twitterTitle: '…', twitterDescription: '…', twitterImage: '…',
    canonicalUrl: 'https://lexmata.ai/pricing',
    siteName: 'Lexmata AI',
    schemaOrg: { /* … */ },
  });
}
```

After, on the route:

```ts
{
  path: 'pricing',
  loadComponent: () => import('./pricing.component'),
  data: {
    seo: {
      title: 'Medical Record Review Pricing',
      description: 'See Lexmata’s per-page pricing …',
      jsonLd: [
        product({
          name: 'Lexmata',
          brand: 'Lexmata',
          offers: aggregateOffer({
            priceCurrency: 'USD',
            offers: [
              offer({ name: 'Explore', price: '0.12' }),
              offer({ name: 'Explain', price: '0.25' }),
              offer({ name: 'Examine', price: '0.35' }),
            ],
          }),
        }),
      ],
    } satisfies SeoConfig,
  },
}
```

## Development

```sh
pnpm install
pnpm test        # vitest
pnpm typecheck
pnpm build       # ng-packagr, partial compilation → dist/
pnpm release     # build, then publish from dist/
```

Publish from `dist/`, which holds the package.json ng-packagr generates. The
repository root is not a publishable package.

## Licence

MIT
