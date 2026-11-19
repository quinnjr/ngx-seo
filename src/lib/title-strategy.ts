import { Injectable } from '@angular/core';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';

/**
 * Stops the router writing `document.title` directly. ngx-seo reads each
 * route's `title` as a layer and owns the document title.
 */
@Injectable()
export class SeoTitleStrategy extends TitleStrategy {
  override updateTitle(_snapshot: RouterStateSnapshot): void {
    // Intentionally empty: the Seo service applies route titles.
  }
}
