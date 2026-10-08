# Third-party notices

The packaged payload was checked against `package.json`, `package-lock.json`, the built `panel.js`, and the generated SPDX 2.3 SBOM. It contains compiled first-party source and first-party static assets only: there are zero runtime dependency packages, no external module imports or CommonJS `require` calls in the browser bundle, and no copied R7 SDK source. The notice file itself carries the required MIT notices below, but no Acorn, esbuild, Node.js, platform binary, or R7 SDK code is shipped in the plugin.

## Acorn 8.15.0 (development tooling only)

Source: https://github.com/acornjs/acorn (npm package `acorn@8.15.0`).
License as provided by the pinned package:

```text
MIT License

Copyright (C) 2012-2022 by various contributors (see AUTHORS)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## esbuild 0.25.10 (development tooling only)

Source: https://github.com/evanw/esbuild (npm package `esbuild@0.25.10` and its pinned platform binary build dependency). No esbuild code or binary is part of the browser bundle or plugin archive.

```text
MIT License

Copyright (c) 2020 Evan Wallace

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

## Product and platform boundaries

Референс для исследования: https://github.com/blazar-source/dsh-r7-office . Node/OOXML/MCP архитектура не переносится в production. Если будет скопирован portable MIT-код, до его включения здесь должны появиться исходный copyright, полный MIT license, источник и перечень файлов.

Р7 Plugin SDK: способ подключения и условия перераспространения должны быть проверены на целевой установке. Наличие штатного SDK не означает право упаковать его копию.

## Node.js (build tooling only)

Node.js executes the deterministic packaging and SBOM scripts and is recorded at its exact build-time version in `provenance.json` and the SPDX SBOM. Node.js is MIT-licensed and is not shipped in the plugin. Source and license: https://github.com/nodejs/node/blob/main/LICENSE .

## Reconciliation result

The generated SPDX 2.3 SBOM covers the application archive, every packaged file with a SHA-256 verified from the real ZIP bytes, and the byte-determining Node.js/esbuild toolchain. Acorn remains development-only audit tooling: it is listed here because it is used by `npm run audit`, but it does not determine or enter the packaged bytes and therefore is not represented as a build tool in the artifact SBOM. No third-party runtime component is bundled.
