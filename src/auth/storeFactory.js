import { createInMemoryAuthStore } from './storeAdapters/inMemoryAuthStore.js';

// Pluggable store factory. Default is in-memory.
export const authStore = createInMemoryAuthStore();
