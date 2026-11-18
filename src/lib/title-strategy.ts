import { Injectable, Injector, inject } from '@angular/core';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { Seo } from './seo.service';

/** Sends the router's `title` into the SEO route layer instead of writing `document.title`. */
@Injectable()
export class SeoTitleStrategy extends TitleStrategy {
  // Resolved lazily: Seo injects Router, which injects this strategy.
  private readonly injector = inject(Injector);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    this.injector.get(Seo).setRouteTitle(this.buildTitle(snapshot));
  }
}
