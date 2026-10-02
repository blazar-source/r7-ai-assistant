import { createR7Bridge } from '../plugin/bridge.js';
import { createController } from './controller.js';
import { mountPanel } from './view.js';

// Standard SDK init and two existing package-evidenced plugin event channels.
// Neither event is an exhaustive, runtime-proved document/selection notification.
export function bindPanel(plugin, root, { bridgeFactory = createR7Bridge, controllerFactory = createController, viewFactory = mountPanel } = {}) {
  let controller = null;
  let view = null;
  let initialized = false;
  let disposed = false;
  let initializedEditorType = 'unknown';
  function changed() { if (!disposed) controller?.contextChanged(); }
  function knownEditor() { const reported = plugin.info?.editorType; return ['word', 'cell', 'slide'].includes(reported) ? reported : 'unknown'; }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (typeof plugin.detachEvent === 'function') {
      plugin.detachEvent('onTargetPositionChanged'); plugin.detachEvent('onDocumentContentReady');
    }
    view?.dispose(); controller?.dispose();
  }
  plugin.init = function () {
    if (disposed) return;
    if (initialized) {
      if (knownEditor() !== initializedEditorType) {
        dispose(); root.textContent = 'Редактор изменился. Перезапустите панель штатным способом; старый мост не используется и не пересоздаётся.';
      } else changed();
      return;
    } // NEVER recreate an SDK bridge/lease
    initialized = true;
    try {
      const editorType = knownEditor();
      initializedEditorType = editorType;
      const bridge = bridgeFactory(plugin, { editorType });
      controller = controllerFactory({ bridge });
      view = viewFactory(root, controller);
      if (typeof plugin.attachEvent === 'function') {
        plugin.attachEvent('onTargetPositionChanged', function () { changed(); });
        plugin.attachEvent('onDocumentContentReady', function () { changed(); });
      }
    } catch { root.textContent = 'Панель недоступна. Инициализация Р7 не завершена; повторное создание моста запрещено.'; }
  };
  return Object.freeze({ dispose });
}

if (typeof globalThis.document !== 'undefined') {
  const root = globalThis.document.getElementById('panel');
  const plugin = globalThis.Asc?.plugin;
  if (root && plugin) {
    const binding = bindPanel(plugin, root);
    globalThis.addEventListener('pagehide', function () { binding.dispose(); });
  } else if (root) root.textContent = 'Локальный SDK Р7 недоступен. Проверьте установленный ../v1/plugins.js; удалённой загрузки нет.';
}
