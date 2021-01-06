import * as path from 'path';
import * as yargs from 'yargs';

import * as comp from './compile';
import * as rt_browser from './runtime_browser';
import * as rt_native from './runtime_native';
import {die} from './util';

interface Options {
  backend: 'native'|'browser';
  file: string;
  showGenerated: boolean;
}

function getOptions(): Options {
  const argv = yargs.usage('$0 [program]')
                   .options({
                     backend: {
                       demandOption: false,
                       describe: 'Backend to use',
                       requiresArg: true,
                       choices: ['native', 'browser'],
                       default: 'native',
                     },
                     'show-generated': {
                       demandOption: false,
                       describe: 'Show generated code before its execution',
                       type: 'boolean',
                       requiresArg: false,
                       default: false,
                     }
                   })
                   .demandCommand(1)
                   .help('h')
                   .alias('h', 'help')
                   .argv;
  return {
    backend: argv.backend as Options['backend'],
    file: path.resolve(argv._[0] as string),
    showGenerated: argv['show-generated'],
  };
}

async function main() {
  const {backend, file, showGenerated} = getOptions();
  switch (backend) {
    case 'native': {
      let codegen: comp.CppCodeGenerator;
      try {
        codegen = comp.compileNative(file);
      } catch (e) {
        // We cannot recover if first-pass compilation failed.
        die(e.message);
      }
      // The runtime will handle errors gracefully and clean up after itself.
      return rt_native.start(file, codegen, showGenerated);
    }
    case 'browser': {
      let codegen: comp.JsCodeGenerator;
      try {
        codegen = comp.compileBrowser(file);
      } catch (e) {
        // We cannot recover if first-pass compilation failed.
        die(e.message);
      }
      return rt_browser.start(file, codegen, showGenerated);
    }
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(() => process.exit(1));
}
