import { createR7Bridge } from '../plugin/bridge.js';
import { createController } from './controller.js';
import { mountPanel } from './view.js';

// Standard SDK init and two existing package-evidenced plugin event channels.
// Neither event is an exhaustive, runtime-proved document/selection notification.
export function bindPanel(plugin, root, { bridgeFactory = createR7Bridge, controllerFactory = createController, viewFactory = mountPanel, platform = null } = {}) {
  let bridge = null;
  let controller = null;
  let view = null;
  let initialized = false;
  let disposed = false;
  let initializedEditorType = 'unknown';
  function changed() { if (!disposed) controller?.contextChanged(); }
  function knownEditor() {
    const info = Object.getOwnPropertyDescriptor(plugin, 'info');
    if (!info || !Object.hasOwn(info, 'value') || !info.value || typeof info.value !== 'object') return 'unknown';
    const type = Object.getOwnPropertyDescriptor(info.value, 'editorType');
    return type && Object.hasOwn(type, 'value') && ['word', 'cell', 'slide'].includes(type.value) ? type.value : 'unknown';
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    // SDK/resource failures must not strand later cleanup or reveal raw errors.
    try { plugin.detachEvent?.('onTargetPositionChanged'); } catch {}
    try { plugin.detachEvent?.('onDocumentContentReady'); } catch {}
    try { view?.dispose(); } catch {}
    try { controller?.dispose(); } catch {}
    // Also covers controller factory failure or an interrupted controller teardown.
    // Bridge disposal is idempotent; it does not release the callback-owned lease.
    try { bridge?.dispose?.(); } catch {}
  }
  plugin.init = function () {
    if (disposed) return;
    if (initialized) {
      if (knownEditor() !== initializedEditorType) {
        dispose(); root.textContent = 'Редактор изменился. Перезапустите панель штатным способом; старый мост не используется и не пересоздаётся.';
      } // Same-editor init alone is not a new context; preserve Preview.
      return;
    } // NEVER recreate an SDK bridge/lease
    initialized = true;
    try {
      const editorType = knownEditor();
      initializedEditorType = editorType;
      bridge = bridgeFactory(plugin, { editorType, platform });
      controller = controllerFactory({ bridge });
      view = viewFactory(root, controller);
      if (typeof plugin.attachEvent === 'function') {
        plugin.attachEvent('onTargetPositionChanged', function () { if (!disposed) controller?.selectionChanged?.(); });
        plugin.attachEvent('onDocumentContentReady', function () { changed(); });
      }
    } catch {
      dispose();
      root.textContent = 'Панель недоступна. Инициализация Р7 не завершена; повторное создание моста запрещено.';
    }
  };
  return Object.freeze({ dispose });
}

if (typeof globalThis.document !== 'undefined') {
  const root = globalThis.document.getElementById('panel');
  const plugin = globalThis.Asc?.plugin;
  if (root && plugin) {
    // The platform boundary the confirmation parses the export with is handed to the bridge HERE, at the
    // one place that already holds the real page object: the page's own `DOMParser`. The bridge itself
    // never reaches for a global, and the option names exactly the ONE platform capability that path uses
    // — it no longer carries the page's `document`, which the bridge stopped reading when the parse moved
    // to `DOMParser`. This is for the explicit boundary and for testability, NOT because
    // `scripts/static-audit.mjs` requires it: `globalThis.document` is a member read and passes the audit,
    // and only a bare `globalThis` VALUE (aliasing or destructuring) is reported.
    const binding = bindPanel(plugin, root, { platform: Object.freeze({ DOMParser: globalThis.DOMParser }) });
    globalThis.addEventListener('pagehide', function () { binding.dispose(); });
  } else if (root) root.textContent = 'Локальный SDK Р7 недоступен. Проверьте установленный ../v1/plugins.js; удалённой загрузки нет.';
}
