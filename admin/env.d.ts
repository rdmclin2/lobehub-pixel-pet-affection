declare module '*.css';

// src/core/vrm-ui.js (UMD, shared with the pet window and the tests)
declare module '*/core/vrm-ui.js' {
  const ui: unknown;
  export default ui;
}
