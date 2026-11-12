export const mobileSharedRootModule = {
  id: "mobile-shared-root",
  owner: "web-remote-control",
  requires: ["shared", "client", "ui"],
  provides: ["mobile-shared-root"],
} as const;
