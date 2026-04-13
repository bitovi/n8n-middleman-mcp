export function createInMemorySessionStore() {
  /** @type {Map<string, any>} */
  const sessions = new Map();

  return {
    getSession(sessionId) {
      if (!sessionId) return null;
      return sessions.get(sessionId) || null;
    },
    setSession(sessionId, value) {
      sessions.set(sessionId, value);
    },
    deleteSession(sessionId) {
      sessions.delete(sessionId);
    }
  };
}
