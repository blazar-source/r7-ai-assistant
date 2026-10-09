// One IndexedDB transaction commits the encrypted profile and its non-exportable
// CryptoKey together. Compare-and-set prevents an already open settings form from
// replacing a newer profile. Crypto work happens BEFORE the transaction begins.
export function profileRevision(record) {
  return typeof record?.revision === 'string' && record.revision.length > 0 && record.revision.length <= 100 ? record.revision : null;
}

export function createProfileRecords(indexedDB = globalThis.indexedDB, name = 'r7-ai-assistant:connection:v2') {
  function transact(value, expectedRevision) {
    return new Promise(function (resolve, reject) {
      if (!indexedDB) { reject(new Error('storage')); return; }
      let db = null; let transaction = null; let settled = false;
      function end(error, result) {
        if (settled) return;
        settled = true; clearTimeout(timeout); db?.close();
        if (error) reject(new Error('storage')); else resolve(result);
      }
      const timeout = setTimeout(function () { try { transaction?.abort(); } catch {} end(true); }, 5000);
      let request;
      try { request = indexedDB.open(name, 1); } catch { end(true); return; }
      request.onupgradeneeded = function () { request.result.createObjectStore('profile'); };
      request.onerror = function () { end(true); };
      request.onblocked = function () { end(true); };
      request.onsuccess = function () {
        db = request.result;
        if (settled) { db.close(); return; }
        try {
          transaction = db.transaction('profile', value === undefined ? 'readonly' : 'readwrite');
          const store = transaction.objectStore('profile');
          const read = store.get('current');
          let result;
          read.onsuccess = function () {
            if (value === undefined) result = read.result ?? null;
            else {
              // A damaged revision has no usable version, just like an absent
              // record. A concurrent valid save still has a non-null revision.
              result = profileRevision(read.result) === expectedRevision;
              if (result) { try { store.put(value, 'current'); } catch { transaction.abort(); } }
            }
          };
          transaction.oncomplete = function () { end(false, result); };
          transaction.onerror = function () { end(true); };
          transaction.onabort = function () { end(true); };
        } catch { end(true); }
      };
    });
  }
  return Object.freeze({ available: Boolean(indexedDB), read() { return transact(); }, write(value, expectedRevision) { return transact(value, expectedRevision); } });
}
