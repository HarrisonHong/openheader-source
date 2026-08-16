# Third-party licences

The extension bundles two runtime dependencies, and substantial portions of both
ship inside `background.js` and the shared UI chunk — minified, with their
comments stripped. Both are MIT, and MIT requires their copyright and permission
notices to travel with those copies. Those notices are reproduced here in full.

This file is the answer to "you tell everyone not to strip *your* notices — where
are theirs?" It is not a formality: the whole reason this source is published is
so that claims about it can be checked, and a claim you cannot check because the
evidence was minified away is not worth much.

Build and development dependencies are not covered here. They are not
redistributed — nothing from `devDependencies` ends up in the shipped artefact —
and the full set with licences is recoverable from `package-lock.json` at any
time.

| Package | Version | Licence |
| --- | --- | --- |
| [preact](https://github.com/preactjs/preact) | 10.29.7 | MIT |
| [zod](https://github.com/colinhacks/zod) | 4.4.3 | MIT |

Versions are exactly pinned in `package.json`; see [docs/security.md](docs/security.md)
for why the runtime dependency list is this short and how it is kept that way.

---

## preact 10.29.7

```
The MIT License (MIT)

Copyright (c) 2015-present Jason Miller

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## zod 4.4.3

```
MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

The licence covering this project's own source is in [LICENSE](LICENSE) and is
separate from the two above.
