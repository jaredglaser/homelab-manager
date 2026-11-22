import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface RowField {
  name: string;
  type: string;
  optional: boolean;
}

export interface QuerySite {
  file: string;
  line: number;
  rowType: string;
  rowFields: RowField[] | null;
  sql: string | null;
  dynamic: string[];
}

const PG_DECLARATION_FILE = /[\\/]node_modules[\\/](@types[\\/])?pg[\\/]/;

/** Whether a call resolves to node-postgres's `query`, judged by the declaration the checker picks rather than the callee's name. */
function pgQueryCall(call: ts.CallExpression, checker: ts.TypeChecker): 'pg' | 'other' | 'unknown' {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || ts.isJSDocSignature(declaration)) return 'unknown';
  const name = ts.getNameOfDeclaration(declaration);
  if (name && ts.isIdentifier(name) && name.text === 'query' && PG_DECLARATION_FILE.test(declaration.getSourceFile().fileName)) return 'pg';
  return 'other';
}

function isQueryNamedCall(call: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'query';
}

function aliased(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | undefined {
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function lineOf(node: ts.Node): number {
  const sourceFile = node.getSourceFile();
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function membersToFields(members: readonly ts.TypeElement[]): RowField[] | null {
  const fields: RowField[] = [];
  for (const member of members) {
    // An index signature means this is not a closed row: report nothing rather than every column.
    if (ts.isIndexSignatureDeclaration(member)) return null;
    if (!ts.isPropertySignature(member)) continue;
    fields.push({
      name: member.name.getText().replace(/['"]/g, ''),
      type: member.type ? member.type.getText().replace(/\s+/g, ' ') : 'any',
      optional: Boolean(member.questionToken),
    });
  }
  return fields;
}

function rowFieldsOf(typeNode: ts.TypeNode, checker: ts.TypeChecker, seen = new Set<ts.Symbol>()): RowField[] | null {
  if (ts.isTypeLiteralNode(typeNode)) return membersToFields(typeNode.members);
  if (!ts.isTypeReferenceNode(typeNode) || typeNode.typeArguments?.length) return null;
  return fieldsOfSymbol(aliased(checker.getSymbolAtLocation(typeNode.typeName), checker), checker, seen);
}

function fieldsOfSymbol(symbol: ts.Symbol | undefined, checker: ts.TypeChecker, seen: Set<ts.Symbol>): RowField[] | null {
  // A merged or ambient declaration has no single member list to read, so it is refused rather than guessed.
  if (!symbol || seen.has(symbol) || symbol.declarations?.length !== 1) return null;
  seen.add(symbol);
  const [declaration] = symbol.declarations;
  if (ts.isTypeAliasDeclaration(declaration)) {
    return declaration.typeParameters ? null : rowFieldsOf(declaration.type, checker, seen);
  }
  if (!ts.isInterfaceDeclaration(declaration) || declaration.typeParameters) return null;
  const fields = membersToFields(declaration.members);
  if (!fields) return null;
  for (const base of (declaration.heritageClauses ?? []).flatMap((clause) => clause.types)) {
    if (base.typeArguments?.length) return null;
    const baseFields = fieldsOfSymbol(aliased(checker.getSymbolAtLocation(base.expression), checker), checker, seen);
    if (!baseFields) return null;
    for (const field of baseFields) {
      if (!fields.some((existing) => existing.name === field.name)) fields.push(field);
    }
  }
  return fields;
}

function resolveSql(expression: ts.Expression, checker: ts.TypeChecker, dynamic: string[], seen = new Set<ts.Symbol>()): string | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isParenthesizedExpression(expression)) return resolveSql(expression.expression, checker, dynamic, seen);
  if (ts.isTemplateExpression(expression)) {
    let built = expression.head.text;
    for (const span of expression.templateSpans) {
      const interpolated = span.expression.getText();
      dynamic.push(interpolated);
      built += `<DYN:${interpolated}>${span.literal.text}`;
    }
    return built;
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveSql(expression.left, checker, dynamic, seen);
    const right = resolveSql(expression.right, checker, dynamic, seen);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isIdentifier(expression)) {
    const symbol = aliased(checker.getSymbolAtLocation(expression), checker);
    const declaration = symbol?.valueDeclaration;
    if (!symbol || seen.has(symbol) || !declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return null;
    if (!(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)) return null;
    return resolveSql(declaration.initializer, checker, dynamic, new Set(seen).add(symbol));
  }
  return null;
}

function scrapeSourceFile(sourceFile: ts.SourceFile, checker: ts.TypeChecker, baseDir: string, scan: SourceScan): void {
  const file = path.relative(baseDir, sourceFile.fileName);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = pgQueryCall(node, checker);
      if (kind === 'unknown' && isQueryNamedCall(node)) {
        scan.unresolved.push({ file, line: lineOf(node) });
      } else if (kind === 'pg' && node.typeArguments?.length) {
        const [typeArgument] = node.typeArguments;
        const argument = node.arguments.at(0);
        const dynamic: string[] = [];
        scan.sites.push({
          file,
          line: lineOf(node),
          rowType: typeArgument.getText().replace(/\s+/g, ' '),
          rowFields: rowFieldsOf(typeArgument, checker),
          sql: argument === undefined ? null : resolveSql(argument, checker, dynamic),
          dynamic: [...new Set(dynamic)],
        });
      } else if (kind === 'pg' && readsRows(node)) {
        scan.untypedReads.push({ file, line: lineOf(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

export interface UntypedRead {
  file: string;
  line: number;
}

/** Properties of a pg result that carry no rows, so reading only them leaves the rows unchecked and harmless. */
const ROWLESS_RESULT_PROPERTIES = new Set(['rowCount', 'command', 'fields', 'oid']);

function unwrap(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) {
      current = parent;
    } else if (ts.isPropertyAccessExpression(parent) && parent.expression === current && /^(catch|finally)$/.test(parent.name.text) && ts.isCallExpression(parent.parent)) {
      current = parent.parent;
    } else {
      return current;
    }
  }
}

/** Whether a variable named by a declaration is referenced as anything but a rowless property, in the statements that follow it. */
function variableCarriesRows(declaration: ts.VariableDeclaration, name: string): boolean {
  const statement = declaration.parent.parent;
  const container = statement.parent;
  const siblings: readonly ts.Node[] = ts.isBlock(container) || ts.isSourceFile(container) || ts.isModuleBlock(container)
    ? container.statements
    : ts.isCaseClause(container) || ts.isDefaultClause(container)
      ? container.statements
      : [container];
  const after = siblings.length === 1 && siblings[0] === container ? siblings : siblings.filter((sibling) => sibling.pos >= statement.end);
  let used = false;
  const declaresName = (node: ts.Node): boolean => {
    let found = false;
    const find = (inner: ts.Node): void => {
      if (ts.isVariableDeclaration(inner) && ts.isIdentifier(inner.name) && inner.name.text === name) found = true;
      if (ts.isParameter(inner) && ts.isIdentifier(inner.name) && inner.name.text === name) found = true;
      if (!ts.isFunctionLike(inner) || inner === node) ts.forEachChild(inner, find);
    };
    find(node);
    return found;
  };
  const search = (node: ts.Node): void => {
    if (used) return;
    // A nested scope that declares its own variable of this name is a different variable.
    if ((ts.isBlock(node) || ts.isFunctionLike(node) || ts.isCatchClause(node)) && declaresName(node)) return;
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent;
      const isMember = ts.isPropertyAccessExpression(parent) && parent.name === node;
      const isKey = (ts.isPropertyAssignment(parent) && parent.name === node) || (ts.isBindingElement(parent) && parent.propertyName === node);
      if (!isMember && !isKey) {
        const rowless = ts.isPropertyAccessExpression(parent) && parent.expression === node && ROWLESS_RESULT_PROPERTIES.has(parent.name.text);
        if (!rowless) used = true;
      }
    }
    ts.forEachChild(node, search);
  };
  for (const sibling of after) search(sibling);
  return used;
}

function bindingCarriesRows(name: ts.BindingName, declaration: ts.VariableDeclaration, index?: number): boolean {
  if (ts.isObjectBindingPattern(name)) {
    return name.elements.some((element) => (element.propertyName ?? element.name).getText() === 'rows' || ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name));
  }
  if (ts.isArrayBindingPattern(name)) {
    const element = index === undefined ? undefined : name.elements[index];
    if (index === undefined) return true;
    if (!element || ts.isOmittedExpression(element)) return false;
    return bindingCarriesRows(element.name, declaration);
  }
  return variableCarriesRows(declaration, name.text);
}

/** Whether the rows of an untyped query leave the call: returned, destructured, chained, awaited into a used variable, or passed on. */
function readsRows(call: ts.CallExpression): boolean {
  let node: ts.Node = unwrap(call);
  let arrayIndex: number | undefined;
  // Promise.all([a, b]) keeps each result at its position.
  if (ts.isArrayLiteralExpression(node.parent) && ts.isCallExpression(node.parent.parent) && /^Promise\.(all|allSettled)$/.test(node.parent.parent.expression.getText())) {
    arrayIndex = node.parent.elements.indexOf(node as ts.Expression);
    node = unwrap(node.parent.parent);
  } else if (ts.isArrayLiteralExpression(node.parent)) {
    return true;
  }
  const parent = node.parent;
  if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return !ROWLESS_RESULT_PROPERTIES.has(parent.name.text);
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) return bindingCarriesRows(parent.name, parent, arrayIndex);
  // A return, an arrow's implicit return, an assignment, an argument, a spread or anything else keeps the result.
  return true;
}

export interface SourceScan {
  sites: QuerySite[];
  untypedReads: UntypedRead[];
  /** `.query(...)` calls the checker cannot resolve to a declaration (an `any` or unknown receiver), so it cannot tell whether they reach Postgres. */
  unresolved: UntypedRead[];
}

function isScannedFile(file: string, dirs: string[]): boolean {
  if (!/\.tsx?$/.test(file) || /\.d\.ts$/.test(file)) return false;
  return dirs.some((dir) => {
    const relative = path.relative(dir, file);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    const segments = relative.split(/[\\/]/);
    return !segments.includes('__tests__') && !segments.includes('node_modules');
  });
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((entry) => path.join(dir, entry));
}

const librarySourceFiles = new Map<string, ts.SourceFile | undefined>();

/** Library and dependency declarations parse once per process: the fixtures in the tests each build a program over the same pg and lib files. */
function cachingHost(options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (!/[\\/]node_modules[\\/]/.test(fileName)) return getSourceFile(fileName, languageVersion, onError, shouldCreate);
    if (!librarySourceFiles.has(fileName)) librarySourceFiles.set(fileName, getSourceFile(fileName, languageVersion, onError, shouldCreate));
    return librarySourceFiles.get(fileName);
  };
  return host;
}

export function loadCompilerOptions(tsconfigPath: string): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  if (!parsed) throw new Error(`could not read ${tsconfigPath}`);
  return parsed.options;
}

/** `extraRoots` are compiled for their declarations but never reported on. */
export function scanSources(dirs: string | string[], baseDir: string, options: { tsconfig: string; extraRoots?: string[] }): SourceScan {
  const scanDirs = [dirs].flat().map((dir) => path.resolve(dir));
  const files = scanDirs.flatMap(listFiles).filter((file) => isScannedFile(file, scanDirs));
  const compilerOptions = loadCompilerOptions(options.tsconfig);
  const program = ts.createProgram({ rootNames: [...files, ...(options.extraRoots ?? [])], options: compilerOptions, host: cachingHost(compilerOptions) });
  const checker = program.getTypeChecker();
  const scan: SourceScan = { sites: [], untypedReads: [], unresolved: [] };
  const scanned = new Set(files.map((file) => path.resolve(file)));
  for (const sourceFile of program.getSourceFiles()) {
    if (scanned.has(path.resolve(sourceFile.fileName))) scrapeSourceFile(sourceFile, checker, baseDir, scan);
  }
  const byPosition = (a: UntypedRead, b: UntypedRead): number => a.file.localeCompare(b.file) || a.line - b.line;
  scan.sites.sort(byPosition);
  scan.untypedReads.sort(byPosition);
  scan.unresolved.sort(byPosition);
  return scan;
}
