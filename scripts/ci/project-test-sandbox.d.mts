export declare const projectRoot: string;
export declare const projectValidationRoot: string;

export interface ProjectTestSandbox {
  root: string;
  home: string;
  temp: string;
  appData: string;
  localAppData: string;
  config: string;
  cache: string;
  data: string;
  logs: string;
  env: NodeJS.ProcessEnv;
}

export declare function assertProjectPath(path: string): Promise<string>;
export declare function createProjectTestSandbox(
  label: string,
  options?: { env?: NodeJS.ProcessEnv },
): Promise<ProjectTestSandbox>;
export declare function createProjectTestFixture(
  label: string,
  env?: NodeJS.ProcessEnv,
): Promise<string>;
