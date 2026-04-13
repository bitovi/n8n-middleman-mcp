import { createInMemorySessionStore } from './storeAdapters/inMemorySessionStore.js';

// Pluggable session store factory. Default is in-memory.
export const sessionStore = createInMemorySessionStore();
