# Third-party notices

This audit covers the direct third-party runtime dependencies bundled by the
WordConvert web application at `pnpm-lock.yaml` as reviewed on 16 July 2026.
Workspace packages are part of WordConvert; development-only dependencies are not
distributed in its browser bundle.

| Package | Reviewed version | Licence | Copyright / attribution | Source |
| --- | --- | --- | --- | --- |
| DOMPurify | 3.4.12 | Apache-2.0 OR MPL-2.0 | Cure53 and other contributors | <https://github.com/cure53/DOMPurify> |
| fflate | 0.8.3 | MIT | Copyright (c) 2026 Arjun Barrett | <https://github.com/101arrowz/fflate> |
| KaTeX | 0.16.47 | MIT | Copyright (c) 2013–2020 Khan Academy and other contributors | <https://github.com/KaTeX/KaTeX> |
| Mithril | 2.3.8 | MIT | Copyright (c) 2017 Leo Horie | <https://github.com/MithrilJS/mithril.js> |
| mithril-materialized | 3.16.0 | MIT | Erik Vullings and contributors | <https://github.com/erikvullings/mithril-materialized> |
| slimdown-js | 1.4.0 | MIT | Copyright (c) 2019 Erik Vullings | <https://github.com/erikvullings/slimdown-js> |

DOMPurify is used under the Apache License 2.0 option. Its installed package
contains the complete Apache-2.0 text in `LICENSE` and does not include a separate
`NOTICE` file. A copy of those terms is included in
[`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt).

The five MIT-licensed dependencies retain their upstream copyright and permission
notices from the table above under these common terms:

> Permission is hereby granted, free of charge, to any person obtaining a copy of
> this software and associated documentation files (the “Software”), to deal in
> the Software without restriction, including without limitation the rights to
> use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
> the Software, and to permit persons to whom the Software is furnished to do so,
> subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
> FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
> IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
> CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

KaTeX's bundled fonts are covered by the KaTeX distribution licence.

## Regenerating the audit

After changing runtime dependencies:

1. Run `pnpm install --frozen-lockfile` from a clean checkout.
2. Inspect every external package listed in the `dependencies` field of the root,
   app, and package manifests, following transitive runtime dependencies.
3. Read each installed package's `package.json`, `LICENSE*`, and `NOTICE*` files;
   do not infer a licence from a registry search result.
4. Update the table, preserve any required full notices, and review the production
   bundle for copied assets such as fonts or stylesheets.

This file is an attribution record, not legal advice.
