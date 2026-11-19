# ngx-seo design

Date: 2026-11-18

## Intent

Maintaining SEO in the Lexmata and Advita marketing apps is inefficient.
`ngx-seo` is an Angular library that lets a page say the few things that are
unique to it and derives the rest, on the server during SSR and in the browser
as the SPA runs. "AEO" here means answer-engine optimisation: making pages easy
for AI answer engines and rich-result crawlers to read, mainly through
structured data and snippet controls.

### What is inefficient today (from `lexmata-marketing`)

- `src/app/services/seo.service.ts` is 1,324 lines with about 70
  `updateSeoFor…Page()` methods, one per page, each called from its component.
- Every page restates the same value several times (title, OG title, Twitter
  title; description three times), plus a hardcoded absolute URL, site name
  and default image.
- Nothing is removed on navigation. `robots` and `keywords` are only set when
  present, so a `noindex` page leaves its tag in `<head>` for the next route.
- There is one JSON-LD slot per page, so `FaqSectionComponent`,
  `BreadcrumbComponent`, `NotFoundComponent`, the blog post page and the CMS
  page each inject their own `<script type="application/ld+json">`.

`advita-marketing` (`apps/web`) has no SEO layer beyond a route `title`.

## Goals

1. A page declares only what is unique to it. Everything else is derived or
   inherited.
2. SEO data can be created, changed and removed at any point: site config,
   route definition, route resolver, component creation, and later in response
   to data arriving or user action.
3. The server-rendered HTML contains the complete, final head for the page.
4. After hydration and after every client navigation the head matches the
   current page exactly: no duplicates, nothing stale.
5. Several parts of a page can each add structured data without knowing about
   each other.
6. Broad coverage of head data: title, description, keywords, robots (including
   snippet controls and per-crawler rules), canonical, hreflang alternates,
   Open Graph, Twitter cards, arbitrary extra meta and link tags, `<html lang>`,
   and JSON-LD.
7. Server response control from the same declarations: HTTP status and
   response headers (for example `X-Robots-Tag`).
8. Usable by both apps unchanged: Angular 21, zoneless, SSR with hydration and
   event replay.

## Non-goals

- Generating `sitemap.xml`, `robots.txt`, `llms.txt` or `llms-full.txt`. These
  are served by the apps' server side and stay there.
- Fetching SEO data. Apps fetch from their CMS and hand the result to the
  library.
- Loading analytics or tag-manager scripts (currently mixed into
  `SEOService`). That stays in the app.
- Migrating the two apps. That is separate work in their repos. The README
  carries a before/after migration example.
- `recordboss-marketing` (Angular 18, no SSR) is not a target.
- Publishing to a registry. The package is built and packable; where it is
  published and under what name is decided later.

## Anti-goals

- An SEO problem must never fail a server render. Bad input degrades to a
  missing tag and a logged error, never a 500.
- No stale tags after navigation and no duplicate tags after hydration.
- No app-specific content, brand names or URLs in the library.
- No HTML string building for head content. Values go through DOM attribute
  and text APIs. JSON-LD is escaped so CMS-supplied text cannot break out of
  the script element.

## Constraints

- Peer dependencies: `@angular/core`, `@angular/common`,
  `@angular/platform-browser`, `@angular/router` at `^21.0.0`. No runtime
  dependencies.
- Must not import `@angular/platform-server` or any Node API in library code.
  Server behaviour uses tokens exported from `@angular/core` (`REQUEST`,
  `RESPONSE_INIT`), which are `null` in the browser.
- Works without zone.js. State is held in signals.
- pnpm only. ESM. MIT licence.
- Code style: braces on every `if` / `else` / loop body.

## Approaches considered

**A. Layered declarations (chosen).** Pages contribute partial configs from
routes and components. The library merges layers, derives the repeated values,
and reconciles `<head>` to the merged result. Costs the most library code and
has merge rules to learn. It is the only option that removes both the
repetition and the stale-tag problem.

**B. Imperative toolkit.** A service with `setCanonical()`, `addJsonLd()` and
similar. Small and obvious, but every page still owns its own cleanup and
repetition, so maintenance barely improves.

**C. Central registry.** One file mapping route paths to SEO configs, applied
on navigation. Easy to audit, but dynamic pages (blog, CMS) and
component-supplied data (FAQ, breadcrumbs) do not fit, and it is still one big
file.

A was chosen by Claude after Joseph described the problem as maintenance
inefficiency and left the how open. Route-level declarations in A give most of
C's auditability.

## Design

Everything below is Claude's proposal unless marked otherwise.

### The model: layers in, one resolved head out

```
site defaults ─┐
route layers   ├─▶ merge ─▶ derive ─▶ resolved head ─▶ reconcile <head>
contributions ─┘                                    └▶ server response
```

- A **layer** is a partial `SeoConfig`.
- Layers are ordered lowest to highest priority:
  1. site defaults from `provideSeo()`
  2. route layers, root route to leaf route
  3. contributions from components and services, in the order they were
     created; an explicit `priority` number overrides creation order
- The merged config is passed through **derivation** to produce the
  **resolved head**: a flat, fully explicit description of every tag.
- A **reconciler** makes the document match the resolved head.

### Setup

```ts
// app.config.ts
provideSeo({
  siteName: 'Lexmata AI',
  baseUrl: 'https://lexmata.ai',
  titleTemplate: '%s | Lexmata',
  defaults: {
    image: '/assets/images/og-default.jpg',
    twitter: { card: 'summary_large_image', site: '@lexmata' },
    jsonLd: [organization({ '@id': '/#org', name: 'Lexmata AI', url: '/' })],
  },
});
```

`SeoSiteConfig`:

| Field | Meaning |
|---|---|
| `siteName` | Used for `og:site_name` and available to the title template. |
| `baseUrl` | Origin used to make URLs absolute. If omitted: the request origin on the server, `location.origin` in the browser. |
| `titleTemplate` | `'%s | Site'` string or `(title, ctx) => string`. Applied to page titles. |
| `defaultTitle` | Title used when no layer sets one. Not passed through the template. |
| `canonical` | `{ trailingSlash: 'preserve' \| 'always' \| 'never', keepQueryParams: string[] }`. Defaults: `preserve`, `[]`. |
| `defaults` | A `SeoConfig` forming the lowest layer. |
| `routeDataKey` | Route data key to read. Default `'seo'`. |
| `diagnostics` | `'warn' \| 'off'`. Default `'warn'` in dev mode, always off in production. |

`provideSeo()` also registers a `TitleStrategy`, so a plain route `title`
(static or resolved) feeds the title into the route layer instead of the
router writing `document.title` directly. An app that already provides its own
`TitleStrategy` after `provideSeo()` wins, and route `title` is then ignored by
the library.

### Declaring SEO on a route

```ts
{
  path: 'products/extract',
  loadComponent: …,
  data: {
    animation: 'ProductPage',
    seo: {
      title: 'Lexmata Extract',
      description: 'See how Lexmata’s patented Extract OCR process …',
    } satisfies SeoConfig,
  },
}
```

That is the whole declaration. Canonical, `og:url`, `og:title`,
`og:description`, `og:image`, `og:site_name`, `og:type`, the Twitter tags and
the document title are derived.

- The value at the route data key may be a `SeoConfig` or a function
  `(route: ActivatedRouteSnapshot) => SeoConfig`, called in an injection
  context on each navigation.
- Because resolvers write into route data, `resolve: { seo: postSeoResolver }`
  works with no extra API. This is the recommended path for CMS and blog
  pages, since the data is ready before the component renders on the server.
- Route layers are collected by walking the activated route tree from root to
  leaf after each successful navigation. A config object that Angular has
  inherited into a child snapshot is applied once, not twice.
- Parent routes can therefore set section-wide values (for example a section
  image, or `robots: { index: false }` for a whole admin area).

### Contributing from a component or service

```ts
// reactive: re-evaluated when signals it reads change
injectSeo(() => ({
  title: post()?.title,
  description: post()?.excerpt,
  jsonLd: [blogPosting({ … })],
}));

// static
injectSeo({ jsonLd: [faqPage(this.items)] });
```

- `injectSeo(config | () => config, options?)` must be called in an injection
  context. It returns an `SeoHandle` and removes the contribution
  automatically when the surrounding `DestroyRef` is destroyed.
- `SeoHandle`: `set(config)`, `patch(partial)`, `clear()`, `destroy()`.
- `options.priority`: number, default `0`. Higher wins. Ties resolve by
  creation order.
- The `Seo` service offers the same without the injection-context
  requirement: `seo.contribute(config, { priority, destroyRef })`.
- `seo.resolved` is a read-only signal of the resolved head, for debugging,
  tests and app features such as a preview panel.

This is what lets `FaqSectionComponent` and `BreadcrumbComponent` add their
structured data without touching the document.

### `SeoConfig`

All fields optional.

| Field | Notes |
|---|---|
| `title` | Page title before the template. |
| `titleTemplate` | Overrides the site template for this layer; `false` disables it. |
| `description` | |
| `keywords` | `string[]` or comma-separated string. |
| `author` | `<meta name="author">`. |
| `lang`, `dir` | Set on `<html>`. |
| `canonical` | Absolute or relative URL. `false` emits no canonical. Default: derived from the current URL. |
| `robots` | `RobotsDirectives` object or a raw string. |
| `bots` | `Record<string, RobotsDirectives \| string>` for per-crawler meta, e.g. `googlebot`. |
| `alternates` | `{ hreflang, href }[]`. Keyed by `hreflang`. |
| `image` | Shorthand: URL or `{ url, alt, width, height, type }`. Feeds Open Graph and Twitter. |
| `openGraph` | `title`, `description`, `type`, `url`, `siteName`, `locale`, `alternateLocales`, `images[]`, `videos[]`, `audio[]`, `article` (`publishedTime`, `modifiedTime`, `expirationTime`, `authors[]`, `section`, `tags[]`), `profile`, `book`. |
| `twitter` | `card`, `site`, `creator`, `title`, `description`, `image`, `imageAlt`. |
| `jsonLd` | `JsonLdNode[]`. See below. |
| `meta` | Extra `<meta>` tags: `{ name \| property \| httpEquiv, content, key? }[]`. |
| `links` | Extra `<link>` tags: `{ rel, href, hreflang?, type?, media?, sizes?, title?, key? }[]`. |
| `http` | Server response: `{ status?: number, headers?: Record<string, string> }`. |

`RobotsDirectives`: `index`, `follow`, `noarchive`, `nosnippet`,
`noimageindex`, `notranslate`, `maxSnippet`, `maxImagePreview`
(`'none' | 'standard' | 'large'`), `maxVideoPreview`, `unavailableAfter`
(`Date | string`). `index` and `follow` default to unset; a robots tag is only
emitted when at least one directive is set.

### Merge rules

- **Scalars** (`title`, `description`, `canonical`, …): the highest-priority
  layer that sets the field wins.
- `undefined` means "no opinion". `null` means "remove whatever a lower layer
  set". This applies at every depth.
- **Objects** (`openGraph`, `twitter`, `robots`, `http`, `bots`): merged
  field by field with the same rules. A raw-string `robots` replaces the whole
  object.
- **Keyed lists** (`jsonLd`, `alternates`, `meta`, `links`,
  `openGraph.images`): items from all layers are combined. Two items with the
  same key collapse to the higher-priority one. Items without a key are all
  kept. Keys:
  - `jsonLd`: the node's `@id`, if present
  - `alternates`: `hreflang`
  - `meta`: `key`, else the `name` / `property` / `httpEquiv` value
  - `links`: `key`, else `rel` + `href`
  - `openGraph.images`: `url`
- **Plain lists** (`keywords`, `article.tags`, `article.authors`,
  `alternateLocales`): the highest-priority layer that sets the list replaces
  it.
- A list set to `null` clears everything lower layers contributed to it.
- **Order.** Keyed lists come out lowest layer first, and a collapsed item
  keeps the position of the item it replaced. The exception is
  `openGraph.images`, where higher layers come first, because platforms use
  the first `og:image`. The top-level `image` shorthand always precedes
  `openGraph.images`.
- **Removing one inherited item.** A keyed list may contain
  `removeItem(key)` (the object `{ $remove: key }`), which drops the item with
  that key contributed by lower layers and emits nothing itself. For example
  `jsonLd: [removeItem('/#org')]`.
- Keys are compared as written, before URLs are made absolute, so `#org` and
  `/#org` are different keys.

### Derivation

Applied after merging, only where the merged config left a value unset:

- Document title: `titleTemplate` applied to `title`; `defaultTitle` if there
  is no `title`.
- `og:title`, `twitter:title` ← the *untemplated* `title`.
- `og:description`, `twitter:description` ← `description`.
- `og:image`, `twitter:image`, `twitter:image:alt` ← `image`.
- `og:site_name` ← `siteName`. `og:type` ← `'website'`.
- Canonical ← `baseUrl` + current router path, with query string and fragment
  removed except `keepQueryParams`, and the trailing-slash policy applied.
- `og:url` ← canonical.
- `twitter:card` ← `'summary_large_image'` when an image is present, else
  `'summary'`.
- Every URL-valued head field (canonical, alternates, images, `og:url`, link
  `href`) is made absolute against `baseUrl`. A value that cannot be made
  absolute, or whose scheme is not `http` or `https`, is dropped.
- JSON-LD URLs are made absolute at every nesting depth:
  - `@id` values starting with `#` resolve against the page URL (the
    canonical, or the current URL when `canonical: false`). Use these for
    page-level nodes.
  - `@id` values starting with `/` resolve against the site root. Use
    `'/#org'` for site-wide entities so they keep one id on every page.
  - String values starting with `/` under `url`, `item`, `image`, `logo`,
    `contentUrl`, `thumbnailUrl`, `mainEntityOfPage` and `target` resolve
    against the site root.
- `http.headers['X-Robots-Tag']` is *not* derived from `robots`. Headers are
  only sent when declared.

Twitter falls back to Open Graph for a field before falling back to the base
field, so setting `openGraph.title` alone changes both social titles.

### JSON-LD

- `JsonLdNode` is `{ '@type': string | string[]; '@id'?: string; [key: string]: unknown }`.
  Objects typed with `schema-dts` are structurally compatible; the library
  does not depend on it.
- All nodes on the page are rendered into **one**
  `<script type="application/ld+json">` as
  `{ "@context": "https://schema.org", "@graph": [...] }`. A single node is
  rendered the same way, for consistency.
- Nodes can reference each other by `@id` (`publisher: { '@id': '/#org' }`),
  which is how the site-level `Organization` and `WebSite` nodes connect to
  page-level nodes.
- Serialisation escapes `<`, `>`, `&`, U+2028 and U+2029 as `\uXXXX`.
- A node that fails to serialise (cycle, BigInt) is dropped and logged; other
  nodes still render.
- `undefined` properties are dropped. `Date` values serialise to ISO 8601.

**Builders.** Small pure functions that return a `JsonLdNode` with the right
`@type` and the nesting done for you. They exist for the shapes that are
tedious or easy to get wrong, with an AEO emphasis:

- Answer-shaped: `faqPage(items)`, `qaPage(...)`, `howTo(...)`,
  `speakable(...)`
- Content: `article(...)`, `blogPosting(...)`, `webPage(...)`,
  `breadcrumbList(items)`
- Entity: `organization(...)`, `webSite(...)`, `person(...)`
- Commercial: `product(...)`, `offer(...)`, `aggregateOffer(...)`,
  `service(...)`

Each builder takes a typed input object and passes unknown extra properties
through, so a builder never blocks a schema.org property it does not know.
Anything without a builder is written as a plain object.

No automatic `WebPage` node is generated. An app that wants one on every page
adds a function-valued layer in `defaults`. (To support that, `defaults` may
also be a function `(ctx) => SeoConfig`, where `ctx` has the current `url`,
`canonical` and the merged `title` / `description` of higher layers.)

### Reconciling the document

- The reconciler owns every element it creates and marks it with a
  `data-seo` attribute holding the item's key.
- For each item in the resolved head it finds the element by key, creates it
  if missing, and updates attributes that differ. Managed elements whose key
  is no longer in the resolved head are removed.
- **Claimed families.** The library owns these tag families outright, whether
  or not it created the element: `meta[name]` for `description`, `keywords`,
  `author`, `robots` and any `twitter:*`; `meta[property]` for `og:*`,
  `article:*`, `profile:*`, `book:*`, `video:*` and `music:*`;
  `link[rel=canonical]`; and `link[rel=alternate][hreflang]`. An unmarked
  element in a claimed family (for example from `index.html`) is adopted when
  a key matches it and removed when none does. Site-wide values that used to
  live in `index.html` therefore move into `defaults`. This is what stops a
  homepage's hardcoded hreflang or keywords leaking onto every page.
- Extra `meta` and `links` items outside those families adopt an unmarked
  element with the same identifying attributes instead of duplicating it.
- `<title>` is always adopted, never removed.
- Everything else is never touched, including JSON-LD scripts the library did
  not create.
- Reconciliation runs from a root effect on the resolved-head signal, so
  several changes in one change-detection pass produce one DOM update.
- All DOM work is wrapped so an exception is logged through Angular's
  `ErrorHandler` and leaves the previous head in place.

**Server.** The effect runs during the server render like any other. Because
Angular SSR serialises only once the app is stable, resolver data and
contributions made while rendering are in the serialised HTML. The
implementation must prove this with a real `renderApplication` test, and if
effect timing is not sufficient, flush synchronously whenever the resolved
head changes on the server.

**Hydration.** The server-rendered elements carry `data-seo` keys, so the
browser adopts them. The browser's first reconcile is deferred until the
initial navigation has finished and the app is first stable. This stops the
head being stripped and rebuilt while client-side data that the server already
had is still arriving. After that, reconciliation is immediate.

**Navigation.** The outgoing page's contributions disappear when its
components are destroyed; the route layers are replaced when navigation ends.
Both land in the same change-detection pass, so the head moves from one page's
complete state to the next without passing through a defaults-only state.

### Server response

On the server, after each change to the resolved head, `http.status` and
`http.headers` are written to `RESPONSE_INIT`. In the browser, and on a server
that does not provide `RESPONSE_INIT`, `http` is ignored silently.

`RESPONSE_INIT` and `REQUEST` are provided by `AngularNodeAppEngine` /
`AngularAppEngine`, which `lexmata-marketing` uses. `advita-marketing`
currently renders through `CommonEngine`, which provides neither, so there
`http` does nothing and `baseUrl` must be configured. Moving Advita to the
newer engine is part of its migration, not of this library.

This lets a not-found page declare `http: { status: 404 }` and
`robots: { index: false }` in one place. Redirects are out of scope; the
router already handles them during SSR.

### Diagnostics

In dev mode with `diagnostics: 'warn'`, after each reconcile the library logs
a `console.warn` (once per route and message) for:

- no title, or no description
- a URL-valued field that could not be made absolute
- two JSON-LD nodes of the same `@id` in the same layer
- `robots` containing `noindex` together with a canonical pointing at a
  different URL
- `injectSeo` reading no signals when given a function (probably meant to be
  static), not warned; listed here only to record that it is allowed

No warnings on the server, to keep SSR logs clean.

### Public API

```
provideSeo(config)
Seo                       service: contribute(), resolved
injectSeo(config, opts?)  → SeoHandle
SeoConfig, SeoSiteConfig, SeoHandle, ResolvedHead,
RobotsDirectives, OpenGraphConfig, TwitterConfig, JsonLdNode, …
faqPage, qaPage, howTo, speakable, article, blogPosting, webPage,
breadcrumbList, organization, webSite, person, product, offer,
aggregateOffer, service
removeItem
```

Single entry point, `ngx-seo`.

### What a migrated page looks like

Before, in `seo.service.ts` plus a call in the component: about 35 lines for
the pricing page. After, on the route:

```ts
seo: {
  title: 'Medical Record Review Pricing',
  description: 'See Lexmata’s per-page pricing …',
  jsonLd: [product({
    name: 'Lexmata',
    brand: 'Lexmata',
    offers: aggregateOffer({ priceCurrency: 'USD', offers: [
      offer({ name: 'Explore', price: '0.12' }),
      offer({ name: 'Explain', price: '0.25' }),
      offer({ name: 'Examine', price: '0.35' }),
    ]}),
  })],
}
```

## Project setup

Mirrors `@lexmata/marketing-wysiwyg`, which is already proven in-house:

- Single-package repo, no Angular CLI workspace.
- `ng-packagr` build from `src/public-api.ts` to `dist/`.
- `vitest` with `jsdom` for unit tests.
- SSR integration tests use `@angular/platform-server` as a dev dependency.
- Package name stays `ngx-seo` as in the existing `package.json`.
- README with setup, the layer model, merge rules, the full `SeoConfig`
  reference and the migration example.

## Testing

- **Merge and derivation** are pure functions and carry most of the tests:
  every merge rule, every derivation, `null` removal, key collisions.
- **Reconciler** against a jsdom document: create, update, remove, adopt,
  never touch unmanaged elements, survive a throwing DOM.
- **JSON-LD**: escaping (a `</script>` payload must not terminate the
  element), graph assembly, dropped bad node.
- **Router integration** with `RouterTestingHarness`: parent and child
  layers, function-valued data, resolver data, navigation A → B leaves no tag
  from A, route `title` flows through the template.
- **Contributions**: destroy removes, reactive function re-evaluates,
  priority ordering.
- **SSR**: `renderApplication` output contains the full head; `RESPONSE_INIT`
  receives status and headers; a throwing contribution does not fail the
  render.
- **Hydration**: boot a browser app over server-rendered HTML and assert no
  duplicate elements and no removal before first stable.

## Left to the builder

- Internal file layout and names of non-public symbols.
- Exact input types of each JSON-LD builder, following schema.org and
  Google's documented required properties for the corresponding rich result.
- Whether the server needs the synchronous flush, decided by the SSR test.
- Lint and formatting setup.
