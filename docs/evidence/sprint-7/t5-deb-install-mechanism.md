# T5 DEB install-mechanism measurement

All acceptance-target commands below were read-only over the SSH host-key-pinned connection. T5 performed no install, copy, delete, launch, UI action, or stand write and did not touch snapshot `02-astra-r7-clean`.

Target identity:

```text
$ /opt/r7-office/desktopeditors/DesktopEditors --version
Р7-Офис ver. 2026.1.2.1942
$ dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' r7-office
r7-office  2026.1.2-1942~astra-signed  amd64
```

Installed-tree inspection:

```text
$ find /opt/r7-office/desktopeditors -maxdepth 5 -type d -iname '*plugin*' -print | sort
/opt/r7-office/desktopeditors/editors/sdkjs-plugins
$ find ~/.local/share/r7-office -maxdepth 6 -type d -iname '*plugin*' -print | sort
/home/r7dev/.local/share/r7-office/editors/data/sdkjs-plugins
/home/r7dev/.local/share/r7-office/editors/sdkjs-plugins
```

The system directory contains ten vendor plugin `config.json` files plus `v1/plugins.js` and `v1/plugins-ui.js`. Bounded searches produced no path declaration:

```text
$ grep -RIna 'sdkjs-plugins' /opt/r7-office/desktopeditors/editors/sdkjs-plugins/v1 /opt/r7-office/desktopeditors/editors/*/sdkjs-plugins 2>/dev/null | head -n 200
<no output>
$ find /opt/r7-office/desktopeditors -maxdepth 3 -type f -size -2M -print0 | xargs -0 grep -Il 'sdkjs-plugins' 2>/dev/null | sort
<no output>
$ find /home/r7dev/.config/r7-office /home/r7dev/.local/share/r7-office -maxdepth 4 -type f \( -name '*.json' -o -name '*.conf' \) -print0 2>/dev/null | xargs -0 grep -Il 'sdkjs-plugins' 2>/dev/null | sort
<no output>
```

Passive CDP `/json/list` showed only the existing editor API page and launcher, no open plugin frame. Thus T5 obtained no behavior evidence that an independently installed product plugin is loaded from a system-wide location. Directory existence is insufficient under the contract.

**Ruling:** only the per-user product path has load-behavior evidence (the recorded running-page path and matching `panel.js` bytes in the T1 contract). The DEB therefore owns an inert payload under `/usr/share/r7-ai-assistant/plugin/{GUID}`. A documented explicit user command copies those files onto the behavior-verified `$HOME/.local/share/r7-office/editors/sdkjs-plugins/{GUID}` path after compatibility preflight. The package itself is data-only and has no maintainer scripts. T6, under separate authorization, must execute lifecycle and repeat loaded-byte behavior verification.
