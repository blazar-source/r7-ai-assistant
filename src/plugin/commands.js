// Author-owned synchronous literal body only. SDK serialization/execution is the
// unchanged trusted platform boundary (ADR 0002). No caller/model code or handles.
export function dispatchCapabilityProbe(plugin, callback) {
  plugin.callCommand(function () {
    try {
      var present = typeof Api !== 'undefined' && Api !== null;
      var getDocument = present && typeof Api.GetDocument === 'function';
      var document = getDocument ? Api.GetDocument() : null;
      // Native command return validation strips ordinary objects. Closed wire
      // order: api, getDocument, getDocumentId, replaceTextSmart,
      // getRangeBySelect, isTrackRevisions; normalize names only in the bridge.
      return [
        present,
        getDocument,
        present && typeof Api.GetDocumentId === 'function',
        present && typeof Api.ReplaceTextSmart === 'function',
        document !== null && document !== undefined && typeof document.GetRangeBySelect === 'function',
        document !== null && document !== undefined && typeof document.IsTrackRevisions === 'function'
      ];
    } catch {
      return ['CAPABILITY_UNAVAILABLE'];
    }
  }, false, false, callback);
}

// Measured native public context route, not a universal rich-selection classifier.
// Primitive tuple survives native object-return stripping. Raw ID stays bridge-private.
export function dispatchContextProbe(plugin, callback) {
  plugin.callCommand(function () {
    try {
      var available = typeof Api !== 'undefined' && Api !== null;
      var id = available && typeof Api.GetDocumentId === 'function' ? Api.GetDocumentId() : null;
      var document = available && typeof Api.GetDocument === 'function' ? Api.GetDocument() : null;
      var replace = available && typeof Api.ReplaceTextSmart === 'function';
      var range = document !== null && document !== undefined && typeof document.GetRangeBySelect === 'function';
      var tracking = document !== null && document !== undefined && typeof document.IsTrackRevisions === 'function' ? document.IsTrackRevisions() : null;
      return [id, replace, range, tracking];
    } catch { return [null, false, false, null]; }
  }, false, false, callback);
}
