# Third-party notices

This audit covers the direct third-party runtime dependencies bundled by the
WordConvert web application at `pnpm-lock.yaml` as reviewed on 30 August 2026.
Workspace packages are part of WordConvert; development-only dependencies are not
distributed in its browser bundle.

| Package | Reviewed version | Licence | Copyright / attribution | Source |
| --- | --- | --- | --- | --- |
| DOMPurify | 3.4.12 | Apache-2.0 OR MPL-2.0 | Cure53 and other contributors | <https://github.com/cure53/DOMPurify> |
| fflate | 0.8.3 | MIT | Copyright (c) 2026 Arjun Barrett | <https://github.com/101arrowz/fflate> |
| KaTeX | 0.16.47 | MIT | Copyright (c) 2013–2020 Khan Academy and other contributors | <https://github.com/KaTeX/KaTeX> |
| Marked | 18.0.11 | MIT and BSD-3-Clause | Copyright (c) 2018+ MarkedJS; Copyright (c) 2011–2018 Christopher Jeffrey; Markdown copyright © 2004 John Gruber | <https://github.com/markedjs/marked> |
| Mithril | 2.3.8 | MIT | Copyright (c) 2017 Leo Horie | <https://github.com/MithrilJS/mithril.js> |
| mithril-materialized | 3.16.0 | MIT | Erik Vullings and contributors | <https://github.com/erikvullings/mithril-materialized> |
| PDF.js (`pdfjs-dist`) | 6.2.108 | Apache-2.0 | Mozilla Foundation and PDF.js contributors | <https://github.com/mozilla/pdf.js> |
| slimdown-js | 1.4.0 | MIT | Copyright (c) 2019 Erik Vullings | <https://github.com/erikvullings/slimdown-js> |

DOMPurify is used under the Apache License 2.0 option. PDF.js is also used under
Apache License 2.0. Their installed packages
contain the complete Apache-2.0 text in `LICENSE` and do not include separate
`NOTICE` file. A copy of those terms is included in
[`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt).

The six MIT-licensed dependencies retain their upstream copyright and permission
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

Marked also includes Markdown under the following terms:

> Copyright © 2004, John Gruber. All rights reserved.
>
> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
>
> - Redistributions of source code must retain the above copyright notice,
>   this list of conditions and the following disclaimer.
> - Redistributions in binary form must reproduce the above copyright notice,
>   this list of conditions and the following disclaimer in the documentation
>   and/or other materials provided with the distribution.
> - Neither the name “Markdown” nor the names of its contributors may be used to
>   endorse or promote products derived from this software without specific
>   prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS “AS IS”
> AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
> IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
> ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
> LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
> CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
> SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
> INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
> CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
> ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
> POSSIBILITY OF SUCH DAMAGE.

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
