# Third-party notices

Production browser source has no runtime dependencies. Acorn 8.15.0 is pinned as development-only static audit tooling; it is not shipped in the plugin. No vendor R7 SDK source has been copied.

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

## Product and platform boundaries

Референс для исследования: https://github.com/blazar-source/dsh-r7-office . Node/OOXML/MCP архитектура не переносится в production. Если будет скопирован portable MIT-код, до его включения здесь должны появиться исходный copyright, полный MIT license, источник и перечень файлов.

Р7 Plugin SDK: способ подключения и условия перераспространения должны быть проверены на целевой установке. Наличие штатного SDK не означает право упаковать его копию.

Для Pilot RC требуется SBOM, охватывающий runtime, build dependencies и упакованные компоненты.
