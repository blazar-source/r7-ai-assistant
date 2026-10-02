// Author-owned synchronous literal body only. SDK serialization/execution is the
// unchanged trusted platform boundary (ADR 0002). No caller/model data or handles.
export function dispatchCapabilityProbe(plugin, callback) {
  plugin.callCommand(function () {
    try {
      var present = typeof Api !== 'undefined' && Api !== null;
      var getDocument = present && typeof Api.GetDocument === 'function';
      var document = getDocument ? Api.GetDocument() : null;
      return {
        api: present,
        getDocument: getDocument,
        getDocumentId: present && typeof Api.GetDocumentId === 'function',
        replaceTextSmart: present && typeof Api.ReplaceTextSmart === 'function',
        getRangeBySelect: document !== null && document !== undefined && typeof document.GetRangeBySelect === 'function',
        isTrackRevisions: document !== null && document !== undefined && typeof document.IsTrackRevisions === 'function'
      };
    } catch {
      return { error: 'CAPABILITY_UNAVAILABLE' };
    }
  }, false, false, callback);
}
