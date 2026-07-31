const DEFAULT_TTL_MS = 60 * 1000;

function createLockBotLiveCache(options = {}) {
  const nowMs = options.nowMs || (() => Date.now());
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const entries = new Map();

  function get(key, load, cacheable = () => true) {
    const now = nowMs();
    const entry = entries.get(key) || { value: null, expiresAt: 0, inFlight: null };
    entries.set(key, entry);
    if (entry.value !== null && entry.expiresAt > now) return Promise.resolve(entry.value);
    if (entry.inFlight) return entry.inFlight;
    const promise = Promise.resolve()
      .then(load)
      .then(value => {
        if (cacheable(value)) {
          entry.value = value;
          entry.expiresAt = nowMs() + ttlMs;
        }
        return value;
      })
      .finally(() => {
        if (entry.inFlight === promise) entry.inFlight = null;
        if (entry.value === null) entries.delete(key);
      });
    entry.inFlight = promise;
    return promise;
  }

  function clear() {
    entries.clear();
  }

  return { get, clear };
}

module.exports = { createLockBotLiveCache, DEFAULT_TTL_MS };
