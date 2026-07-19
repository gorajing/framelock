import "server-only";

import { execFile } from "node:child_process";
import { resolve } from "node:path";

import {
  createFrameLockCliBridge,
  type FrameLockCliProcessPort,
} from "./framelock-cli-core";

const processPort: FrameLockCliProcessPort = {
  run(executable, arguments_, options) {
    return new Promise((resolvePromise, reject) => {
      execFile(
        executable,
        [...arguments_],
        { ...options, env: options.env as NodeJS.ProcessEnv },
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          resolvePromise({ stdout, stderr });
        },
      );
    });
  },
};

const workspaceRoot = process.cwd();

export const frameLockCli = createFrameLockCliBridge({
  executable: resolve(workspaceRoot, ".venv", "bin", "framelock-media"),
  cwd: workspaceRoot,
  environment: process.env,
  process: processPort,
});
