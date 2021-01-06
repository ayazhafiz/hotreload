import * as path from 'path';
import * as ts from 'typescript';
import {fatal} from './util';

const RUNTIME_DEFS = 'runtime/runtime.d.ts';
const RUNTIME_BASE = 'HotReloadProgram';
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

function getRuntimeProgram(file: string): ts.ClassDeclaration {
  const compilerOptions: ts.CompilerOptions = {
    experimentalDecorators: true,
  };
  const host =
      ts.createCompilerHost(compilerOptions, /* setParentNodes */ true);
  host.getDefaultLibFileName = () => RUNTIME_DEFS;
  const totalProgram = ts.createProgram([file], compilerOptions, host);

  const diagnostics = totalProgram.getSemanticDiagnostics();
  if (diagnostics.length !== 0) {
    fatal(ts.formatDiagnostics(diagnostics, FmtDiagHost));
  }
  const sf = totalProgram.getSourceFile(file);
  if (!sf) fatal(`no source file for ${file}`);

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
  if (stmts[stmts.length - 1].kind === ts.SyntaxKind.EndOfFileToken) {
    stmts.pop();
  }
  if (stmts.length !== 1) {
    fatal(`expected exactly one top level statement, found ${
        stmts.map(s => s.getText())}`);
  }
  const [cls] = stmts;
  if (!ts.isClassDeclaration(cls)) {
    fatal(`${cls.getText()} must be a class`);
  }
  if (cls.heritageClauses?.length !== 1 ||
      cls.heritageClauses[0].types.find(
          sup => ts.isIdentifier(sup.expression) &&
              sup.expression.text === RUNTIME_BASE) === undefined) {
    fatal(`program must extend from, and only from, "${RUNTIME_BASE}"`);
  }
  return cls;
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
        const [body] = ts.transform(node.body, [RW_RemoveThis]).transformed;
        if (!ts.isBlock(body)) {
          fatal(`transformed ${body.getText()} is not a block`);
        }
        return context.factory.createFunctionDeclaration(
            undefined, undefined, undefined, node.name, undefined,
            node.parameters, node.type, body);
      }
      return node;
    }
    return ts.visitNode(root, visit);
  }
}

type ProgramFunction = ts.FunctionDeclaration&{
  name: ts.Identifier;
  body: ts.Block;
}

function isNamedFunction(node: ts.Node): node is ProgramFunction {
  return ts.isFunctionDeclaration(node) && node.name !== undefined &&
      ts.isIdentifier(node.name) && node.body !== undefined;
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

export function compileNative(file: string): CppCodeGenerator {
  const program = getRuntimeProgram(file);

  let main: ProgramFunction;
  const hotReloadFunctions: ProgramFunction[] = [];
  const staticFunctions: ProgramFunction[] = [];

  for (const member of program.members) {
    if (!ts.isMethodDeclaration(member)) {
      fatal(`Cannot generate code for non-method ${
          member.name?.getText()}. To use constants, define them in a method.`);
    }

    const isHotReload = isMarkedHotReload(member);
    const [fn] = ts.transform(member, [RW_MethodToFunction]).transformed;
    if (!isNamedFunction(fn)) {
      fatal(`transformed ${fn.getText()} is not a valid program function`);
    }

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

  return new CppCodeGenerator(
      hotReloadCallNames, main!, staticFunctions, hotReloadFunctions);
}

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

/**
 * Eagerly generates C++ code from an input program into a form consumable by
 * the runtime system.
 */
export class CppCodeGenerator {
  main: CppCode = null!;
  topLevels: CppCode[] = [];
  hotReload: HotReloadFunction[] = [];

  private indent = '  ';

  constructor(
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
    if (ty.kind !== ts.SyntaxKind.NumberKeyword) {
      fatal(`only "number"s are supported as types, found ${ty.getText()}`);
    }
    return 'int';
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
