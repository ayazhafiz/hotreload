import * as express from 'express';
import * as express_ws from 'express-ws';
import * as fs from 'fs';
import * as WebSocket from 'ws';

import {compileBrowserPatches, JsCode, JsCodeGenerator} from './compile';
import {error, info, warn} from './util';

const INIT_PROGRAM = 'πINIT_PROGRAM';

const app = express_ws(express()).app;
const port = 8000;

app.set('views', './runtime');
app.engine('html', require('ejs').renderFile);

app.get('/', (req, res) => {
  res.render('runtime.html', {
    host: req.hostname,
    port,
    program: app.get(INIT_PROGRAM),
  });
});

const RegisteredRTClients: WebSocket[] = [];

app.ws('/hotreload', (ws) => {
  RegisteredRTClients.push(ws);
  ws.on('message', () => {
    warn(`Client communication across hotreload connection is not permitted.`);
    warn(`Message will be ignored.`);
  });
  info(`Hot reload client initialized.`);
});

function broadcastPatch(patch: JsCode) {
  for (const rt of RegisteredRTClients) {
    rt.send(patch);
  }
}

function reconcileChangedHotReloadable(
    knownPatches: Map<string, JsCode>, newPatches: Map<string, JsCode>): void {
  for (const hr of knownPatches.keys()) {
    const uPatch = newPatches.get(hr);
    if (uPatch === undefined) {
      warn(`Deletion of "${hr}" during the runtime is unsupported.`);
      warn(`Continuing as if nothing has changed.`);
      return;
    }
    if (uPatch !== knownPatches.get(hr)) {
      broadcastPatch(uPatch);
      knownPatches.set(hr, uPatch);
      info(`"${hr}" has been reloaded.`);
    }
    newPatches.delete(hr);
  }
  if (newPatches.size > 1) {
    const whatsNew = [...newPatches.keys()].map(s => `"${s}"`).join(', ');
    warn(`Addition of new function(s) ${
        whatsNew} during the runtime is unsupported.`);
    warn(`Continuing as if nothing has changed.`);
  }
}

export function start(
    inputProgramFile: string,
    {code, tsProgram: cachedTsProgram}: JsCodeGenerator,
    showGenerated: boolean,
    ): Promise<never> {
  if (showGenerated) {
    info('Generated JS code:');
    for (const line of code.split('\n')) {
      info(line);
    }
  }

  // First, start the program.
  app.set(INIT_PROGRAM, code);
  app.listen(port, () => {
    info(`Starting at http://localhost:${port}`);
  });

  const knownPatches = compileBrowserPatches(inputProgramFile, cachedTsProgram);

  // Next, listen for changes to the program file.
  fs.watch(inputProgramFile, {}, (event) => {
    switch (event) {
      case 'rename': {
        warn(
            'Rename or deletion of program file during the runtime is unsupported.');
        warn('Continuing as if file was not modified at all.');
        break;
      }
      case 'change': {
        let newPatches: Map<string, JsCode>;
        try {
          newPatches = compileBrowserPatches(inputProgramFile, cachedTsProgram);
        } catch (e) {
          error(e.message);
          warn(`Continuing as if the program has not changed.`);
          return;
        }
        reconcileChangedHotReloadable(knownPatches, newPatches);
        break;
      }
      default:
        error(`Unknown file change event "${event}"`);
    }
  })

  // Return a promise that runs until the app itself terminates so that the
  // event loop has something to do and the server can stay alive.
  return new Promise<never>((_resolve, reject) => {
    app.on('close', () => {
      reject(`Server terminated`);
    });
  })
}
