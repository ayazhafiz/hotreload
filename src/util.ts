import * as chalk from 'chalk';

export function info(...msgs: any[]): void {
  console.info(chalk.cyan(`INFO: `, ...msgs));
}

export function warn(...msgs: any[]): void {
  console.info(chalk.yellow(`WARN: `, ...msgs));
}

export function error(...msgs: any[]): void {
  console.info(chalk.red(`ERROR: `, ...msgs));
}

/** Throws an error with a message. */
export function fatal(msg: string): never {
  throw new Error(msg)
}

/** Like `fatal`, but exits immediately. */
export function die(...msgs: any[]): never {
  console.info(chalk.redBright(`FATAL ERROR: `, ...msgs));
  process.exit(1);
}
