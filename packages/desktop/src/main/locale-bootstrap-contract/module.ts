export const desktopLocaleBootstrapModule = {
  id: "desktop-locale-bootstrap",
  requires: ["shared"],
  provides: ["desktop-locale-bootstrap"],
  publicEntrypoints: ["contract.ts"],
} as const;
