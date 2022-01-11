#!/bin/sh
":"; //# comment; exec /usr/bin/env node --no-warnings --experimental-vm-modules "$0" "$@"
// #!/usr/bin/env node
import { program } from "commander";
import { fork, spawn } from "child_process";
import globby from "globby";
import path from "path";
import { transform } from "lodash";
import { getDotEnv, escapeQuotes } from "./util";
import fs from "fs-extra";
import { execSync } from "child_process";
import { evalPlugin } from "./evaluator";
import { transformJSToPlugin } from "./transform";
import { compile, watch } from "./ts-compile";
import { ChildProcess } from "node:child_process";
import { transformFile } from "@swc/core";
import chokidar from "chokidar";
import { mkdirSync, writeFileSync } from "fs";
import beautify from "js-beautify";
import { PACKAGE_JSON, PLUGIN_TEMPLATE, TSCONFIG_TEMPLATE } from "./templates";

// --- hack until @lipsurf/common is available here
function padTwo(num) {
  return num.toString().padStart(2, "0");
}
const PLUGIN_SPLIT_SEQ = "\vLS-SPLIT";
// --- end hack

const IS_PROD = process.env.NODE_ENV === "production";
const TMP_DIR = "dist/tmp";
const FOLDER_REGX = /^src\/(.*)\/([^.]*).*$/;
const _timedLog =
  (type) =>
  (...msgs: string[]) => {
    const now = new Date();
    console[type](
      `[${padTwo(now.getHours())}:${padTwo(now.getMinutes())}:${padTwo(
        now.getSeconds()
      )}]`,
      ...msgs
    );
  };
const timedLog = _timedLog("log");
const timedErr = _timedLog("error");

program
  .command("build [PLUGIN_PATHS_OR_IDS...]")
  .description(
    "Build LipSurf plugins. By default builds all plugins under src/ within a directory of the plugin's name."
  )
  .option("-w, --watch")
  .option("-t, --check", "check TypeScript types")
  .option("--no-base-imports")
  .action((plugins, cmdObj) => build(cmdObj, plugins));

program
  .command("init <project_name>")
  .description("Makes a template plugin which is useful as a starting point.")
  .action((cmdObj) => init(cmdObj));

program
  .command("vup")
  .description(
    "Increase (version up) the semver minor version of all the plugins."
  )
  .option(
    "-v, --version <version>",
    "specify a version instead of incrementing the minor version by 1"
  )
  .action((cmdObj) => upVersion({ ...cmdObj, ...cmdObj.parent }));

program
  .command("beautify <plugin_paths...>")
  .description(
    "Beautify a *.ls plugin file in-place so it's easier to read. Note that plugin file will still be readable by LipSurf."
  )
  .action((pluginPaths) => {
    for (const pluginPath of pluginPaths) {
      fs.readFile(pluginPath, "utf8", function (err, data) {
        if (err) {
          throw err;
        }
        const splitted = data.split(PLUGIN_SPLIT_SEQ);
        const parts = splitted.map((x) =>
          beautify(x, { indent_size: 2, space_in_empty_paren: true })
        );
        fs.writeFileSync(pluginPath, parts.join(`\n${PLUGIN_SPLIT_SEQ}\n`));
      });
    }
  });

program.commands.forEach((cmd) => {
  // @ts-ignore
  if (["vup", "build"].includes(cmd._name)) {
    cmd.option("-p, --project", "tsconfig file path", "./tsconfig.json");
    cmd.option("-o, --out-dir <destination>", "destination directory", "dist");
  }
});

function getAllPluginIds(files: string[]) {
  return Array.from(
    new Set(
      files
        .map((filePath) => FOLDER_REGX.exec(filePath))
        .filter((regexRes) => regexRes && regexRes[1] === regexRes[2])
        .map((regexRes) => regexRes![1])
    )
  );
}

// Drops the first element of a tuple. Example:
//
//   type Foo = DropFirstInTuple<[string, number, boolean]>;
//   //=> [number, boolean]
//
type DropFirstInTuple<T extends any[]> = ((...args: T) => any) extends (
  arg: any,
  ...rest: infer U
) => any
  ? U
  : T;

function forkAndTransform(
  pluginIds: string[],
  ...args: DropFirstInTuple<Parameters<typeof transformJSToPlugin>>
): Promise<void> {
  return new Promise((cb) => {
    if (pluginIds.length === 1) {
      transformJSToPlugin(pluginIds[0], ...args).finally(cb);
    } else {
      let finishedForks = 0;
      const forks: ChildProcess[] = [];
      for (let pluginId of pluginIds) {
        // forking done as a workaround for bug in SWC:
        // https://github.com/swc-project/swc/issues/1366
        // (but hey, it probably also improves perf)
        const forked = fork(path.join(__dirname, "./worker.js"), {
          env: {
            NODE_NO_WARNINGS: "1",
            NODE_OPTIONS: "--experimental-vm-modules",
          },
        });
        forks.push(forked);
        forked.once("exit", (code) => {
          finishedForks++;
        });
        forked.send([pluginId, ...args]);
      }
      const checkIfDone = setInterval(() => {
        if (finishedForks >= forks.length) {
          clearInterval(checkIfDone);
          cb();
        }
      }, 20);
    }
  });
}

function init(id: string) {
  return new Promise<void>((cb) => {
    const pkgJson = PACKAGE_JSON;
    const root = `lipsurf-plugin-${id.toLowerCase()}`;
    const path = `${root}/src/${id}/`;
    pkgJson.name = root;
    mkdirSync(root);
    mkdirSync(`${root}/src`);
    mkdirSync(path);
    writeFileSync(`${root}/tsconfig.json`, TSCONFIG_TEMPLATE);
    writeFileSync(`${root}/package.json`, JSON.stringify(pkgJson, null, 2));
    writeFileSync(`${path}${id}.ts`, PLUGIN_TEMPLATE);
    const child = spawn("yarn", ["install"], { cwd: root, stdio: "pipe" });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", function (data) {
      timedLog(data);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", function (data) {
      timedErr(data);
    });

    child.on("close", function (code) {
      if (code === 0)
        console.log(
          `Successfully created project ${id}. Now try \`cd ${root}\`, editing src/${id}/${id}.ts then \`yarn watch\`.`
        );
      else {
        console.error("Could not create project.");
      }
      cb();
    });
  });
}

/**
 * How this works:
 *   1. Compile TS
 *   2. Bundle with esbuild (pull imports into same file)
 *   3. Replace called fns with a special string (using SWC parser)
 *   4. Evaluate the JS (using Node.js VM module)
 *   5. Transform the Plugin object to create 7 different parts:
 *       * backend plugin (no changes currently, but in the future should remove things like tests in the prod build)
 *       * matching content script (for each plan - 0, 10, 20)
 *       * non-matching content script (for each plan)
 *   6. Uneval the js object (make into source code again)
 *   7. Replace the previous Plugin object with the new one in the bundled source
 *   8. Remove extraneous code like Plugin.languages
 *   9. Build each part with esbuild again to treeshake and minify
 *
 * @param options
 * @param plugins
 */
async function build(
  options: {
    baseImports: boolean;
    outDir: string;
    prod?: boolean;
    watch: boolean;
    check: boolean;
  },
  plugins: string[] = []
) {
  const timeStart = new Date();
  let globbedTs: string[];
  let pluginIds;
  if (!plugins.length) {
    globbedTs = globby.sync(["src/**/*.ts", "!src/@types"]);
    pluginIds = getAllPluginIds(globbedTs);
  } else if (plugins[0].endsWith(".ts")) {
    // specific files
    globbedTs = plugins;
    pluginIds = plugins.map((p) =>
      p.substring(p.lastIndexOf("/") + 1, p.length - 3)
    );
  } else {
    // plugin ids
    globbedTs = globby.sync([
      ...plugins.map((id) => `src/${id}/*.ts`),
      "!src/@types",
    ]);
    pluginIds = plugins;
  }
  timedLog("Building plugins:", pluginIds);

  if (globbedTs.length === 0) {
    throw new Error(
      "No plugins found. Pass a [PLUGIN_PATH] or put plugins in src/[plugin name]/[plugin name].ts"
    );
  }

  let envVars: { [k: string]: string } = {};
  const isProd = !!(IS_PROD || options.prod);
  const baseImports =
    typeof options.baseImports !== "undefined" ? options.baseImports : true;
  const envFile = isProd ? ".env" : ".env.development";
  try {
    envVars = getDotEnv(path.join(envFile));
  } catch (e) {
    console.warn(`No "${envFile}" file found.`);
  }
  const define = transform(
    { NODE_ENV: isProd ? "production" : "development", ...envVars },
    (r: {}, val, key) => (r[`process.env.${key}`] = `"${escapeQuotes(val)}"`)
  );

  if (options.watch) {
    if (options.check) {
      watch(globbedTs, async () => {
        timedLog("Starting transform...");
        await forkAndTransform(
          pluginIds,
          globbedTs,
          options.outDir,
          isProd,
          baseImports,
          define
        );
        timedLog("Done transforming.");
      });
    } else {
      let queued = false;
      chokidar.watch(globbedTs).on("all", async (event, path) => {
        if (!queued) {
          queued = true;
          // just do all of them
          await transpileFiles(globbedTs);
          timedLog("Starting transform...");
          await forkAndTransform(
            pluginIds,
            globbedTs,
            options.outDir,
            isProd,
            baseImports,
            define
          );
          timedLog("Done transforming.");
          queued = false;
        }
      });
    }
  } else {
    if (options.check) await compile(globbedTs);
    else {
      await transpileFiles(globbedTs);
    }
    await forkAndTransform(
      pluginIds,
      globbedTs,
      options.outDir,
      isProd,
      baseImports,
      define
    );
    const timeEnd = new Date();
    timedLog(
      `Done building in ${((+timeEnd! - +timeStart) / 1000).toFixed(
        2
      )} seconds.`
    );
  }
}

function transpileFiles(globbedTs: string[]) {
  return Promise.all(
    globbedTs.map((f) =>
      transformFile(f, {
        jsc: {
          parser: {
            syntax: "typescript",
            dynamicImport: true,
          },
          target: "es2020",
          // externalHelpers: true,
        },
      }).then((t) => {
        const splitted = f.split(/\.ts|\//g);
        let dir;
        if (splitted.length > 3)
          dir = `${TMP_DIR}/${splitted[splitted.length - 3]}`;
        else dir = TMP_DIR;
        const outputF = `${dir}/${splitted[splitted.length - 2]}.js`;
        return fs.ensureDir(dir).then(() => fs.writeFile(outputF, t.code));
      })
    )
  );
}

async function upVersion(options) {
  // make sure there are no unexpected changes so that we don't include them in the upversion commit
  try {
    execSync(
      // package.json might have a version increment, that's not commited yet (e.g. when using lerna)
      "git diff-index --ignore-submodules --quiet HEAD -- './:!package.json'"
    ).toString();
  } catch (e) {
    throw new Error(
      `There are uncommitted things. Commit them before running vup.`
    );
  }
  // first find a plugin file
  const globbedTs = globby.sync(["src/*/*.ts", "!src/@types"]);
  const pluginIds = getAllPluginIds(globbedTs);
  const anyPluginName = pluginIds[0];

  const parDir = `${options.outDir}/tmp`;
  try {
    await fs.readdir(parDir);
  } catch (e) {
    console.warn(
      `Expected temporary build plugin files in ${parDir}. Building first. We need these to read the .mjs plugins (can't read ts directly for now) and extract a current version.`
    );
    await build(options);
  }

  const oldVersion = (
    await evalPlugin(
      await fs.readFile(
        `./${TMP_DIR}/${anyPluginName}/${anyPluginName}.js`,
        "utf8"
      ),
      `./${TMP_DIR}/${anyPluginName}/`
    )
  ).version!;
  console.log(`latest version of ${anyPluginName}: ${oldVersion}`);
  const packageJsonVersion = JSON.parse(
    await fs.readFile("./package.json", "utf8")
  ).version;
  const newVersion = options.version || packageJsonVersion;
  console.log(`upping to: ${newVersion}`);
  // HACK: this is crude, and could f'up code that has "version: "..." in it"
  execSync(
    `sed -i 's/version: "${oldVersion}"/version: "${newVersion}"/g' src/*/*.ts`
  );
  await build({ ...options, prod: true });
  // remove the old plugins
  try {
    execSync(`rm dist/*.${oldVersion.replace(/\./g, "-")}.*.ls`);
  } catch (e) {
    console.warn("error removing old version's files");
  }
  // make an vup commit (version tagging is done by the parent repo -- which determines which commit actually gets into the extension's package)
  execSync("git add src dist");
  // no longer doing this in the mono repo
  // execSync(`git commit -m "Version upped from ${oldVersion} to ${newVersion}" -a`);
}

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
