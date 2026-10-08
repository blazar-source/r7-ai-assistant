# Data-only DEB

Build with `npm run build:deb`. The builder emits a plain Debian binary package with deterministic uncompressed `control.tar` and `data.tar` members. It contains only the plugin payload under `/usr/share/r7-ai-assistant/plugin/{7C91D48E-5F12-4B36-8A90-2DFA8467C013}` and the uninstall manifest under `/usr/share/doc/r7-ai-assistant/`.

## Verified activation mechanism

Read-only inspection on the R7 2026.1.2.1942 acceptance target found the vendor directory `/opt/r7-office/desktopeditors/editors/sdkjs-plugins`, but no configuration declaring an additional product system-wide search path and no behavior evidence that a product plugin placed there is loaded. The only behavior-verified product location remains:

`$HOME/.local/share/r7-office/editors/sdkjs-plugins/{7C91D48E-5F12-4B36-8A90-2DFA8467C013}`

Therefore the root-installed DEB does not guess a global activation directory. It owns an inert payload. After the separately required compatibility preflight succeeds, the target user activates it explicitly:

```sh
GUID='{7C91D48E-5F12-4B36-8A90-2DFA8467C013}'
TARGET="$HOME/.local/share/r7-office/editors/sdkjs-plugins/$GUID"
install -d -m 0755 "$TARGET"
cp -a "/usr/share/r7-ai-assistant/plugin/$GUID/." "$TARGET/"
```

This command is the documented per-user step; it has not been run on the stand in T5. Its destination is verified by the prior running-page byte/path evidence in the packaging contract. Lifecycle execution and fresh behavior confirmation remain T6.

The package has no maintainer scripts and cannot alter a user home during package installation or removal. User settings in the R7 profile remain outside package ownership.

## Reproducibility

The builder fixes member ordering, ownership (`root:root`), regular-file mode (`0644`), and timestamps (Unix epoch), and copies deterministic plugin bytes. On the same source commit and pinned Node/esbuild toolchain it is byte reproducible. The claim excludes differences caused by different source bytes or toolchain versions.
