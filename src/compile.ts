import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import {fatal} from './util';

const TS_CONFIG = path.resolve('runtime/tsconfig.json');
const RUNTIME_TS = path.resolve('runtime/runtime.ts');
const RUNTIME_BASECLASS_NAME = 'HotReloadProgram';
const HOTRELOAD = 'hotreload';

const FmtDiagHost: ts.FormatDiagnosticsHost = {
  getCurrentDirectory() {
    return process.cwd();
  },
  getCanonicalFileName(fileName: string) {
    return path.relative(process.cwd(), fileName);
  },
  getNewLine() {
    return '\n';
  }
};

const ParseConfigHost: ts.ParseConfigHost = {
  useCaseSensitiveFileNames: true,
  readDirectory(rootDir: string): readonly string[] {
    return fs.readdirSync(rootDir);
  },
  fileExists(path: string): boolean {
    return fs.existsSync(path);
  },
  readFile(path: string) {
    return fs.readFileSync(path).toString();
  },
};

const ConfigFile = ts.readJsonConfigFile(TS_CONFIG, ParseConfigHost.readFile);
const CompilerOptions = ts.parseJsonSourceFileConfigFileContent(
                              ConfigFile, ParseConfigHost, 'runtime')
                            .options;
const CompilerHost =
    ts.createCompilerHost(CompilerOptions, /* setParentNodes */ true);

function createProgram(inFiles: string[], oldProgram?: ts.Program): ts.Program {
  CompilerHost.fileExists = (fileName: string) => {
    // Avoid superfuous module resolution + type checking
    return inFiles.includes(fileName);
  };
  const totalProgram =
      ts.createProgram(inFiles, CompilerOptions, CompilerHost, oldProgram);

  const diagnostics = totalProgram.getSemanticDiagnostics();
  if (diagnostics.length !== 0) {
    fatal(ts.formatDiagnostics(diagnostics, FmtDiagHost));
  }
  return totalProgram;
}

type NamedClassDeclaration = ts.ClassDeclaration&{name: ts.Identifier};

function isNamedClassDeclaration(n: ts.Node): n is NamedClassDeclaration {
  return ts.isClassDeclaration(n) && n.name !== undefined &&
      ts.isIdentifier(n.name);
}

type ProgramFunction = ts.FunctionDeclaration&{
  name: ts.Identifier;
  body: ts.Block;
}

function isProgramFunction(node: ts.Node): node is ProgramFunction {
  return ts.isFunctionDeclaration(node) && node.name !== undefined &&
      ts.isIdentifier(node.name) && node.body !== undefined;
}

function findUserProgram(
    inFile: string, tsProgram: ts.Program): NamedClassDeclaration {
  const sf = tsProgram.getSourceFile(inFile);
  if (!sf) fatal(`No source file for "${inFile}"`);

  const sfC = sf.getChildren();
  // I guess the TS AST looks like
  // -- ts.SourceFile
  //    -- ts.SyntaxList
  //       -- ts.ClassDeclaration
  //    -- ts.EndOfFileToken
  // But http://ts-ast-viewer.com suggests otherwise (namely, there is no
  // "SyntaxList") level. So let's read the first SF statement, and if it's a
  // SyntaxList, read the first statement of that.
  const stmts =
      sfC[0].kind === ts.SyntaxKind.SyntaxList ? sfC[0].getChildren() : sfC;
  function isProgram(cls: ts.Node): cls is NamedClassDeclaration {
    if (!isNamedClassDeclaration(cls)) return false;
    if (!cls.heritageClauses) return false;
    const extendsBase = cls.heritageClauses.some(
        c => c.types.some(
            t => ts.isIdentifier(t.expression) &&
                t.expression.text === RUNTIME_BASECLASS_NAME));
    return extendsBase;
  }
  const programs = stmts.filter(isProgram);

  if (programs.length !== 1) {
    fatal(`Expected exactly one program extending from "${
        RUNTIME_BASECLASS_NAME}"; found ${programs.length}`);
  }

  return programs[0];
}

function isMarkedHotReload({decorators}: ts.MethodDeclaration): boolean {
  if (!decorators) return false;
  if (decorators.length > 1) fatal(`cannot have more than one decorator`);
  const [decor] = decorators;
  if (!ts.isIdentifier(decor.expression) ||
      decor.expression.text !== HOTRELOAD) {
    fatal(`only @${HOTRELOAD} decorators are permitted`);
  }
  return true;
}

//////////////////////////////
/// Compilation to Browser ///
//////////////////////////////

export const BRT_PROGRAM_NAME = 'πrogram';
export type JsCode = string&{__brand: 'js code'};

export interface JsCodeGenerator {
  readonly tsProgram: ts.Program;
  readonly code: JsCode;
}

export function compileBrowser(
    absFile: string,
    oldProgram?: ts.Program,
    ): JsCodeGenerator {
  const inputFiles = [absFile, RUNTIME_TS];
  const tsProgram = createProgram(inputFiles, oldProgram);
  const userProgram = findUserProgram(absFile, tsProgram);

  const pgName = userProgram.name.text;
  const program = [
    fs.readFileSync(RUNTIME_TS).toString(),
    userProgram.getText(),
    `const ${BRT_PROGRAM_NAME} = new ${pgName}();`,
    `${BRT_PROGRAM_NAME}.main();`,
  ].join('\n');
  const code = ts.transpile(program, CompilerOptions) as JsCode;
  return {tsProgram, code};
}

/**
 * Generates patches to make to apply new "@hotreload"-annotated method
 * definitions to an active program in the runtime.
 */
export function compileBrowserPatches(
    absFile: string, oldProgram: ts.Program): Map<string, JsCode> {
  const inputFiles = [absFile, RUNTIME_TS];
  const tsProgram = createProgram(inputFiles, oldProgram);
  const userProgram = findUserProgram(absFile, tsProgram);

  const patches = new Map<string, JsCode>();
  for (const f of userProgram.members) {
    if (!ts.isMethodDeclaration(f) || !ts.isIdentifier(f.name) ||
        !isMarkedHotReload(f)) {
      continue;
    }
    // First, translate the method definition to a JS function.
    const name = f.name.text;
    const raised = `function ${f.getText()}`.replace(`@${HOTRELOAD}`, '');
    const transpiled = ts.transpile(raised, {
      ...CompilerOptions,
      strict: false,  // avoid attaching "use strict"
    });

    // Apply the new definition by patching it onto the runtime program:
    //   program.doFoo = (function newDoFoo() { ... }).bind(program);
    const patch = `${BRT_PROGRAM_NAME}.${name} = ` +
            `(${transpiled}).bind(${BRT_PROGRAM_NAME});` as JsCode;
    patches.set(name, patch);
  }
  return patches;
}

/////////////////////////////
/// Compilation to Native ///
/////////////////////////////

export type CppCode = string&{__brand: 'c++ code'};

export interface HotReloadFunction {
  /** Name of the hot-reloadable function */
  readonly name: string;
  /**
   * Type signature of the function. Used by the runtime to verify types have
   * not changed between reloads.
   */
  readonly signature: string;
  /**
   * The actual function implementation to reload.
   */
  readonly impl: CppCode;
  /**
   * Given the object file, object file copy, and lockfile associated with this
   * hot reload function, generates the top-level definition of the hot-reload
   * function to attach to the main program.
   *
   * The runtime is responsible for allocating the file parameters, so this is
   * called then.
   */
  readonly genTopLevelDefinition:
      (objFile: string, objCopyFile: string, lockFile: string) => CppCode;
}

export interface CppCodeGenerator {
  readonly tsProgram: ts.Program;
  readonly main: CppCode;
  readonly topLevels: CppCode[];
  readonly hotReload: HotReloadFunction[];
}

export function compileNative(
    absFile: string, oldProgram?: ts.Program): CppCodeGenerator {
  const inputFiles = [absFile, RUNTIME_TS];
  const tsProgram = createProgram(inputFiles, oldProgram);
  const userProgram = findUserProgram(absFile, tsProgram);

  let main: ProgramFunction;
  const hotReloadFunctions: ProgramFunction[] = [];
  const staticFunctions: ProgramFunction[] = [];

  for (const member of userProgram.members) {
    if (!ts.isMethodDeclaration(member)) {
      fatal(`Cannot generate code for non-method ${
          member.name?.getText()}. To use constants, define them in a method.`);
    }

    const isHotReload = isMarkedHotReload(member);
    const fn = transformTo(member, RW_MethodToFunction, isProgramFunction);

    if (fn.name && ts.isIdentifier(fn.name) && fn.name.text === 'main') {
      if (isHotReload) fatal(`"main" cannot be hot-reloaded`);
      main = fn;
    } else if (isHotReload) {
      hotReloadFunctions.push(fn);
    } else {
      staticFunctions.push(fn);
    }
  }

  const hotReloadCallNames =
      new Set(hotReloadFunctions.map(fn => fn.name.text));

  return new CppCodeGeneratorImpl(
      tsProgram,
      hotReloadCallNames,
      main!,
      staticFunctions,
      hotReloadFunctions,
  );
}

/**
 * Eagerly generates C++ code from an input program into a form consumable by
 * the runtime system.
 */
export class CppCodeGeneratorImpl implements CppCodeGenerator {
  main: CppCode = null!;
  topLevels: CppCode[] = [];
  hotReload: HotReloadFunction[] = [];

  private indent = '  ';

  constructor(
      public readonly tsProgram: ts.Program,
      private readonly hotReloadCallNames: Set<string>, main: ProgramFunction,
      topLevels: ProgramFunction[], hotReloadFunctions: ProgramFunction[]) {
    this.main = this.genFunction(main);
    for (const tl of topLevels) {
      this.topLevels.push(this.genFunction(tl));
    }
    for (const fn of hotReloadFunctions) {
      this.hotReload.push(this.genHotReload(fn));
    }
  }

  private genHotReload({name, parameters, type, body}: ProgramFunction):
      HotReloadFunction {
    const EXTERN_IMPL_HEADER = `extern "C"`;
    if (!type) {
      fatal(`@hotreload-able ${name.text} must have an explicit return type`);
    }
    const cRetTy = this.genType(type);
    const paramTyAndNames = parameters.map(p => this.genParam(p));
    const cParamTys = paramTyAndNames.map(([t, _]) => t).join(', ');
    const signature = `${cRetTy}(${cParamTys})`;

    const cName = name.text;
    const cParams = paramTyAndNames.map(tup => tup.join(' ')).join(', ');
    const cBodyUnIndented =
        body.statements.map(s => this.genStmt(s)).join('\n');
    const cBody =
        cBodyUnIndented.split('\n').map(s => this.indent + s).join('\n');
    const impl =
        `${EXTERN_IMPL_HEADER} ${cRetTy} ${cName}(${cParams}) {\n${cBody}\n}` as
        CppCode;

    function genTopLevelDefinition(
        objFile: string, objCopyFile: string, lockFile: string): CppCode {
      return `HotReload<${signature}> ${cName}("${cName}", "${objFile}", "${
                 objCopyFile}", "${lockFile}");` as CppCode;
    }

    return {
      name: cName,
      signature,
      impl,
      genTopLevelDefinition,
    };
  }

  private genFunction({name, parameters, type, body}: ProgramFunction):
      CppCode {
    const cTy = type ? this.genType(type) : 'auto';
    const cName = name.text;
    const cParams = parameters.map(p => this.genParam(p).join(' ')).join(', ');
    const cBodyUnIndented =
        body.statements.map(s => this.genStmt(s)).join('\n');
    const cBody =
        cBodyUnIndented.split('\n').map(s => this.indent + s).join('\n');
    return `${cTy} ${cName}(${cParams}) {\n${cBody}\n}` as CppCode;
  }

  /** Returns [type, name] */
  private genParam(p: ts.ParameterDeclaration): [string, string] {
    if (!ts.isIdentifier(p.name)) {
      fatal(`parameter ${p.getText()} must be an identifier`);
    }
    const cName = p.name.text;
    if (!p.type) {
      fatal(`parameter ${p.getText()} must have a type annotation`);
    }
    const cTy = this.genType(p.type);
    return [cTy, cName];
  }

  private genType(ty: ts.TypeNode): string {
    // It's better to use the TS typechecker here, but oh well.
    switch (ty.kind) {
      case ts.SyntaxKind.NumberKeyword:
        return 'int';
      case ts.SyntaxKind.TypeReference: {
        const t = ty as ts.TypeReferenceNode;
        if (ts.isIdentifier(t.typeName) && t.typeName.text === 'Promise' &&
            t.typeArguments?.length === 1) {
          return this.genType(t.typeArguments![0]);
        }
      }
      default:
        fatal(`cannot translate type "${ty.getText()}"`)
    }
  }

  private genStmt(stmt: ts.Statement): string {
    switch (stmt.kind) {
      case ts.SyntaxKind.Block: {
        const s = stmt as ts.Block;
        return `{\n` +
            s.statements.map(s => this.indent + this.genStmt(s)).join('\n') +
            '\n}';
      }
      case ts.SyntaxKind.WhileStatement: {
        const s = stmt as ts.WhileStatement;
        const cCond = this.genExpr(s.expression);
        const cStmt = this.genStmt(s.statement);
        return `while (${cCond}) ${cStmt}`
      }
      case ts.SyntaxKind.VariableStatement: {
        const s = stmt as ts.VariableStatement;
        return this.genVarDecls(s.declarationList).join('; ') + ';';
      }
      case ts.SyntaxKind.ReturnStatement: {
        const s = stmt as ts.ReturnStatement;
        const cExpr = s.expression ? ' ' + this.genExpr(s.expression) : '';
        return `return${cExpr};`
      }
      case ts.SyntaxKind.ExpressionStatement: {
        const s = stmt as ts.ExpressionStatement;
        const cExpr = this.genExpr(s.expression);
        return `${cExpr};`;
      }
      case ts.SyntaxKind.ForStatement: {
        const s = stmt as ts.ForStatement;
        let cInit: string;
        if (s.initializer === undefined) {
          cInit = ''
        } else if (ts.isVariableDeclarationList(s.initializer)) {
          cInit = this.genVarDecls(s.initializer).join(', ');
        } else {
          cInit = this.genExpr(s.initializer);
        }
        const cCond =
            s.condition === undefined ? '' : this.genExpr(s.condition);
        const cIncr =
            s.incrementor === undefined ? '' : this.genExpr(s.incrementor);
        const cStmt = this.genStmt(s.statement);
        return `for (${cInit}; ${cCond}; ${cIncr}) ${cStmt}`;
      }
      default:
        fatal(`cannot translate statement ${stmt.getText()}`);
    }
  }

  private genOperatorMap:
      Map<ts.BinaryOperator|ts.PrefixUnaryOperator|ts.PostfixUnaryOperator,
          string> =
          new Map([
            [ts.SyntaxKind.PlusToken, '+'],
            [ts.SyntaxKind.PlusPlusToken, '++'],
            [ts.SyntaxKind.MinusToken, '-'],
            [ts.SyntaxKind.AsteriskToken, '*'],
            [ts.SyntaxKind.SlashToken, '/'],
          ]);

  private genOperator(op: ts.BinaryOperator|ts.PrefixUnaryOperator|
                      ts.PostfixUnaryOperator): string {
    const cOp = this.genOperatorMap.get(op);
    if (cOp === undefined) {
      fatal(`cannot translate binary operator ${ts.SyntaxKind[op]}`);
    }
    return cOp;
  }

  private genExpr(expr: ts.Expression): string {
    switch (expr.kind) {
      case ts.SyntaxKind.CallExpression: {
        const e = expr as ts.CallExpression;
        const cArgs = e.arguments.map(e => this.genExpr(e));
        if (!ts.isIdentifier(e.expression)) {
          fatal(`call of ${e.getText()} must call an identifier`);
        }
        const callName = e.expression.text;
        const callNameSuffix =
            this.hotReloadCallNames.has(callName) ? '.get()' : '';
        return `${callName}${callNameSuffix}(${cArgs.join(', ')})`;
      }
      case ts.SyntaxKind.NumericLiteral: {
        const e = expr as ts.NumericLiteral;
        return e.text;
      }
      case ts.SyntaxKind.TrueKeyword: {
        return 'true';
      }
      case ts.SyntaxKind.FalseKeyword: {
        return 'false';
      }
      case ts.SyntaxKind.Identifier: {
        const e = expr as ts.Identifier;
        return e.text;
      }
      case ts.SyntaxKind.BinaryExpression: {
        const e = expr as ts.BinaryExpression;
        const cOp = this.genOperator(e.operatorToken.kind);
        const cLeft = this.genExpr(e.left);
        const cRight = this.genExpr(e.right);
        return `${cLeft} ${cOp} ${cRight}`;
      }
      case ts.SyntaxKind.PrefixUnaryExpression: {
        const e = expr as ts.PrefixUnaryExpression;
        const cOp = this.genOperator(e.operator);
        const cOperand = this.genExpr(e.operand);
        return `${cOp}${cOperand}`;
      }
      case ts.SyntaxKind.PostfixUnaryExpression: {
        const e = expr as ts.PostfixUnaryExpression;
        const cOp = this.genOperator(e.operator);
        const cOperand = this.genExpr(e.operand);
        return `${cOperand}${cOp}`;
      }
      case ts.SyntaxKind.AwaitExpression: {
        // In the C++ runtime we implement await as thread-blocking, so just
        // unwrap the underlying expression immediately.
        const e = expr as ts.AwaitExpression;
        return this.genExpr(e.expression);
      }
      default:
        fatal(`cannot translate expression "${expr.getText()}"`);
    }
  }

  private genVarDecls(varDecls: ts.VariableDeclarationList): string[] {
    return varDecls.declarations.map(d => this.genVarDecl(d));
  }

  private genVarDecl(decl: ts.VariableDeclaration): string {
    if (!ts.isIdentifier(decl.name)) {
      fatal(`${decl.name.getText()} must be an identifier`);
    }
    const cName = decl.name.text;
    const cTy = decl.type ? this.genType(decl.type) : 'auto';
    const cInit =
        decl.initializer ? ` = ${this.genExpr(decl.initializer)}` : '';
    return `${cTy} ${cName}${cInit}`;
  }
}

/// TS code rewriters.

function transformTo<U extends ts.Node>(
    input: ts.Node, transformer: ts.TransformerFactory<ts.Node>,
    validator: (n: ts.Node) => n is U): U {
  const [out] = ts.transform(input, [transformer], CompilerOptions).transformed;
  if (!validator(out)) {
    fatal(`transformed "${out.getText()}" is not as expected`);
  }
  return out;
}

/** Rewrites "this.doFoo()" -> "doFoo" */
function RW_RemoveThis<T extends ts.Node>(context: ts.TransformationContext) {
  return (root: T) => {
    function visit(node: ts.Node): ts.Node {
      node = ts.visitEachChild(node, visit, context);
      if (ts.isPropertyAccessExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ThisKeyword) {
        return node.name;
      }
      return node;
    }
    return ts.visitNode(root, visit);
  }
}

/**
 * Rewrites a method to a function declaration, also collapsing references to
 * "this".
 */
function RW_MethodToFunction<T extends ts.Node>(
    context: ts.TransformationContext) {
  return (root: T) => {
    function visit(node: ts.Node): ts.Node {
      node = ts.visitEachChild(node, visit, context);
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) &&
          node.body !== undefined) {
        const body = transformTo(node.body, RW_RemoveThis, ts.isBlock);
        return context.factory.createFunctionDeclaration(
            node.decorators, node.modifiers, node.asteriskToken, node.name,
            node.typeParameters, node.parameters, node.type, body);
      }
      return node;
    }
    return ts.visitNode(root, visit);
  }
}
