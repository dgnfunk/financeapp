import { apiRequest } from "./api";

type EncryptedDraft = { id: string; iv: Uint8Array; payload: ArrayBuffer; createdAt: string };

function openDraftDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("finanzas-private-drafts", 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("keys")) database.createObjectStore("keys");
      if (!database.objectStoreNames.contains("drafts")) database.createObjectStore("drafts", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const requestValue = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function saveEncryptedDraft(text: string): Promise<void> {
  const database = await openDraftDatabase();
  const keys = database.transaction("keys", "readonly").objectStore("keys");
  const existing = await requestValue<CryptoKey | undefined>(keys.get("draft-key"));
  const key = existing ?? await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  if (!existing) await requestValue(database.transaction("keys", "readwrite").objectStore("keys").put(key, "draft-key"));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
  await requestValue(database.transaction("drafts", "readwrite").objectStore("drafts").put({ id: crypto.randomUUID(), iv, payload, createdAt: new Date().toISOString() }));
  database.close();
}

export async function syncEncryptedDrafts(): Promise<number> {
  if (!navigator.onLine) return 0;
  const database = await openDraftDatabase();
  const key = await requestValue<CryptoKey | undefined>(database.transaction("keys", "readonly").objectStore("keys").get("draft-key"));
  if (!key) { database.close(); return 0; }
  const drafts = await requestValue<EncryptedDraft[]>(database.transaction("drafts", "readonly").objectStore("drafts").getAll());
  let synced = 0;
  for (const draft of drafts) {
    try {
      const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: draft.iv as BufferSource }, key, draft.payload);
      const text = new TextDecoder().decode(clear);
      await apiRequest("/capture/text", {
        method: "POST",
        headers: { "Idempotency-Key": `offline-${draft.id}` },
        body: JSON.stringify({ text, client: "pwa" }),
      });
      await requestValue(database.transaction("drafts", "readwrite").objectStore("drafts").delete(draft.id));
      synced += 1;
    } catch {
      break;
    }
  }
  database.close();
  return synced;
}
