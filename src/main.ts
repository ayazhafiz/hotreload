import * as path from 'path';
import * as yargs from 'yargs';

import * as comp from './compile';
import * as rt_browser from './runtime_browser';
import * as rt_native from './runtime_native';
import {die} from './util';

type Backend = 'native'|'browser';

interface Options {
  backend: Backend;
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

type CodeGenerator<BE extends Backend> = {
  'native': comp.CppCodeGenerator,
  'browser': comp.JsCodeGenerator,
}[BE];

type Handler<T extends Backend> = {
  compile(file: string): CodeGenerator<T>;
  runtime(file: string, codegen: CodeGenerator<T>, showGenerated: boolean):
      Promise<void|never>;
};

const Handlers: {[T in Backend]: Handler<T>} = {
  'native': {
    compile: comp.compileNative,
    runtime: rt_native.start,
  },
  'browser': {
    compile: comp.compileBrowser,
    runtime: rt_browser.start,
  },
};

async function main() {
  const {backend, file, showGenerated} = getOptions();
  const handle: Handler<typeof backend> = Handlers[backend];
  let codegen: CodeGenerator<typeof backend>;
  try {
    codegen = handle.compile(file);
  } catch (e) {
    // We cannot recover if first-pass compilation failed.
    die(e.message);
  }
  return handle.runtime(file, codegen, showGenerated);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(() => process.exit(1));
}
