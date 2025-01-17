import { HtmlTagDescriptor, Plugin, ResolvedConfig } from 'vite';
import * as path from 'path';
import * as fs from 'fs';

import { EditorLanguageWorks, IWorkerDefinition, languageWorksByLabel } from './lnaguageWork';
import { workerMiddleware, cacheDir, getFilenameByEntry, getWorkPath } from './workerMiddleware';
const esbuild = require('esbuild');

/**
 * Return a resolved path for a given Monaco file.
 */
export function resolveMonacoPath(filePath: string): string {
  try {
    return require.resolve(path.join(process.cwd(), 'node_modules', filePath));
  } catch (err) {
    return require.resolve(filePath);
  }
}

export function getWorks(options: IMonacoEditorOpts) {
  let works: IWorkerDefinition[] = options.languageWorkers.map((work) => languageWorksByLabel[work]);

  works.push(...options.customWorkers);

  return works;

}

export interface IMonacoEditorOpts {
  /**
   * include only a subset of the languageWorkers supported.
   */
  languageWorkers?: EditorLanguageWorks[];

  customWorkers?: IWorkerDefinition[];

  /**
   * 文件生成在哪个目录默认 outdir + 'monacoeditorwork'
   */
  publicPath?: string;

  /**
   * 是否使用cdn路径，默认不使用
   */
  useCdn?: boolean

  /**
   * Specify whether the editor API should be exposed through a global `monaco` object or not. This
   * option is applicable to `0.22.0` and newer version of `monaco-editor`. Since `0.22.0`, the ESM
   * version of the monaco editor does no longer define a global `monaco` object unless
   * `global.MonacoEnvironment = { globalAPI: true }` is set ([change
   * log](https://github.com/microsoft/monaco-editor/blob/main/CHANGELOG.md#0220-29012021)).
   */
  globalAPI?: boolean;
}

export default function monacoEditorPlugin(options: IMonacoEditorOpts = {}): Plugin {
  const languageWorkers =
    options.languageWorkers || (Object.keys(languageWorksByLabel) as EditorLanguageWorks[]);
  const publicPath = options.publicPath || 'monacoeditorwork';
  const globalAPI = options.globalAPI || false;
  const customWorkers = options.customWorkers || [];
  const useCdn = options.useCdn || false

  options = {
    useCdn,
    languageWorkers,
    publicPath,
    globalAPI,
    customWorkers
  };

  let resolvedConfig: ResolvedConfig;

  return {
    name: 'vite-plugin-moncao-editor',
    configResolved(getResolvedConfig) {
      resolvedConfig = getResolvedConfig;
    },
    configureServer(server) {
      workerMiddleware(server.middlewares, resolvedConfig, options);
    },
    transformIndexHtml(html) {
      const works = getWorks(options);
      const workerPaths = getWorkPath(works, options);

      let base = resolvedConfig.base
      // 处理cdn, 如果不使用cdn,但路径是cdn,需修改base
      if (!options.useCdn && /^http/.test(resolvedConfig.base)) {
        base = '/'
      }
      Object.keys(workerPaths).forEach(k => {
        workerPaths[k] = base + workerPaths[k].slice(1)
      })

      const globals = {
        MonacoEnvironment: `(function (paths) {
          return {
            globalAPI: ${globalAPI},
            getWorkerUrl : function (moduleId, label) {
              var result =  paths[label];
              if (/^((http:)|(https:)|(file:)|(\\/\\/))/.test(result)) {
                var currentUrl = String(window.location);
                var currentOrigin = currentUrl.substr(0, currentUrl.length - window.location.hash.length - window.location.search.length - window.location.pathname.length);
                if (result.substring(0, currentOrigin.length) !== currentOrigin) {
                  var js = '/*' + label + '*/importScripts("' + result + '");';
                  var blob = new Blob([js], { type: 'application/javascript' });
                  return URL.createObjectURL(blob);
                }
              }
              return result;
            }
          };
        })(${JSON.stringify(workerPaths, null, 2)})`,
      };

      const descriptor: HtmlTagDescriptor[] = [
        {
          tag: 'script',
          children: Object.keys(globals)
            .map((key) => `self[${JSON.stringify(key)}] = ${globals[key]};`)
            .join('\n'),
          injectTo: 'head-prepend',
        },
      ];
      return descriptor;
    },

    writeBundle() {
      const works = getWorks(options);

      const distPath = path.resolve(resolvedConfig.root, resolvedConfig.build.outDir, options.publicPath);

      // write publicPath
      if (!fs.existsSync(distPath)) {
        fs.mkdirSync(
          path.resolve(resolvedConfig.root, resolvedConfig.build.outDir, options.publicPath),
          {
            recursive: true
          }
        );
      }

      for (const work of works) {
        if (!fs.existsSync(cacheDir + getFilenameByEntry(work.entry))) {
          esbuild.buildSync({
            entryPoints: [resolveMonacoPath(work.entry)],
            bundle: true,
            outfile: cacheDir + getFilenameByEntry(work.entry),
          });
        }
        const contentBuffer = fs.readFileSync(cacheDir + getFilenameByEntry(work.entry));
        const destPath = path.resolve(
          resolvedConfig.root,
          resolvedConfig.build.outDir,
          options.publicPath,
          getFilenameByEntry(work.entry)
        );
        fs.writeFileSync(destPath, contentBuffer);
      }
    },
  };
}
