"use strict";

// 外置只读reload观察器：装载本轮受控TS实现，不改正式helper、产品或退出屏障。
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const repository = path.resolve(__dirname, "../../..");
const desktop = path.join(repository, "packages", "desktop");
const source = path.join(__dirname, "qa-reload-observer.ts");
const desktopRequire = createRequire(path.join(desktop, "package.json"));
const facadeSourceSha256 = createHash("sha256").update(fs.readFileSync(__filename)).digest("hex");
const observerSourceSha256 = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
let observerPromise;

function loadObserver() {
  if (!observerPromise) {
    const { tsImport } = desktopRequire("tsx/esm/api");
    observerPromise = tsImport(pathToFileURL(source).href, { parentURL: pathToFileURL(__filename).href, tsconfig: path.join(desktop, "tsconfig.e2e.json") });
  }
  return observerPromise;
}

exports.beginReloadObservation = async function beginReloadObservation(context, paths) {
  const observer = await loadObserver();
  return observer.beginReloadObservation(context, { ...paths, observerSourceSha256, facadeSourceSha256 });
};
exports.finishReloadObservation = async function finishReloadObservation(context) {
  const observer = await loadObserver();
  return observer.finishReloadObservation(context);
};
// 只解析模块与导出，不调用browser/系统进程；供本轮静态装载核验。
exports.loadObserverForStaticCheck = loadObserver;
