/// <reference types="vite/client" />

/** A unique id for this build ("dev" on the development server). Also written to /version.json. */
declare const __BUILD_ID__: string;
/** When this build was made, ms since the epoch (0 on the development server). */
declare const __BUILD_TIME__: number;
/** The client package's version. */
declare const __APP_VERSION__: string;
