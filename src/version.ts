// Injected at build time from package.json "version" via tsup `define`,
// so the User-Agent can never drift from the published package version.
declare const __CLI_VERSION__: string;

export const CLI_VERSION: string =
  typeof __CLI_VERSION__ !== 'undefined' ? __CLI_VERSION__ : '0.0.0-dev';
