import pkg from "../../package.json";

/**
 * The running JobManager version (package.json), shown in the page footer and
 * reported by the MCP server, so it's clear which build is deployed. Every
 * change bumps it; see CHANGELOG.md.
 */
export const APP_VERSION: string = pkg.version;
