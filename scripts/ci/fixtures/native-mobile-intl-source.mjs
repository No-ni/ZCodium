import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertProjectPath, projectRoot } from "../project-test-sandbox.mjs";

/** 读取当前 TSX，而非 UI dist；只替换大 Root 为 intl probe，不运行产品/业务 owner。 */
export async function loadMobileIntlSource() {
  const directory = await assertProjectPath(join(process.env.TEMP, "native-mobile-intl-source"));
  await mkdir(directory, { recursive: true });
  const surface = await assertProjectPath(
    join(projectRoot, "packages/web/src/mobile/shared-root/ui/RootSurface.tsx"),
  );
  const provider = await assertProjectPath(
    join(projectRoot, "packages/ui/src/i18n/IntlProvider.tsx"),
  );
  const slot = await assertProjectPath(
    join(projectRoot, "packages/web/src/mobile/shared-root/app/root-slot.ts"),
  );
  const shared = await assertProjectPath(join(projectRoot, "packages/shared/src/index.ts"));
  const result = await build({
    stdin: {
      contents: `export {RootSurface} from ${JSON.stringify(surface)};
export {ZCodeIntlProvider,useZCodeIntl} from ${JSON.stringify(provider)};
export {createMobileRootSlot} from ${JSON.stringify(slot)};`,
      resolveDir: projectRoot,
      sourcefile: "native-mobile-intl-source.tsx",
      loader: "tsx",
    },
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "node",
    external: ["react", "react-dom", "react-dom/*"],
    jsx: "automatic",
    alias: { "@": join(projectRoot, "packages/ui/src"), "@zcode/shared": shared },
    logLevel: "silent",
    plugins: [
      {
        name: "public-ui-intl-source-probe",
        setup(builder) {
          builder.onResolve({ filter: /^@zcode\/ui$/ }, () => ({
            path: "ui-intl-probe",
            namespace: "native-mobile-intl",
          }));
          builder.onLoad({ filter: /.*/, namespace: "native-mobile-intl" }, () => ({
            contents: `import React from 'react';
import {ZCodeIntlProvider,useZCodeIntl} from ${JSON.stringify(provider)};
export {ZCodeIntlProvider,useZCodeIntl};
export function AppErrorBoundary({children}) { return children; }
export function Button(props) { return React.createElement('button',props); }
export function Root() {
  const value=useZCodeIntl();
  return React.createElement('div',null,
    React.createElement('output',{'data-locale':value.locale,'data-preference':value.localePreference},value.locale),
    ...['system','zh-CN','en-US'].map(preference=>React.createElement('button',{
      key:preference,'data-action':preference,onClick:()=>value.setLocalePreference(preference)
    },preference)));
}`,
            loader: "jsx",
            resolveDir: projectRoot,
          }));
        },
      },
    ],
  });
  const inputs = Object.keys(result.metafile.inputs);
  if (
    !inputs.some((input) => input.endsWith("packages/ui/src/i18n/IntlProvider.tsx")) ||
    inputs.some((input) => /packages\/(?:ui|shared)\/dist\//.test(input))
  )
    throw new Error("MOBILE_INTL_CURRENT_SOURCE_REQUIRED");
  const target = await assertProjectPath(join(directory, "source.mjs"));
  await writeFile(target, result.outputFiles[0].text);
  return import(pathToFileURL(target).href);
}
