// Re-export shim kept for package A3a only: the transport implementation now
// lives in api/transport.ts, but the 136 apiFetch('api/...') call sites across
// views/ and components/ still import from './api.js'. A3b/A3c/A3d sweep them
// domain by domain; this file is deleted in A3d once none remain.
export * from './api/transport.js';
