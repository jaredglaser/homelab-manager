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

interface LocalType {
  members: readonly ts.TypeElement[];
  heritage: string[];
}

export function scrapeFile(file: string, baseDir: string): QuerySite[] {
  const text = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declared = new Map<string, LocalType>();
  const ambiguous = new Set<string>();

  const declare = (name: string, local: LocalType): void => {
    if (declared.has(name)) ambiguous.add(name);
    declared.set(name, local);
  };

  const collectDeclarations = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node)) {
      declare(node.name.getText(sourceFile), {
        members: node.members,
        heritage: (node.heritageClauses ?? []).flatMap((clause) => clause.types.map((t) => t.expression.getText(sourceFile))),
      });
    }
    if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
      declare(node.name.getText(sourceFile), { members: node.type.members, heritage: [] });
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sourceFile);

  const constants = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) constants.set(declaration.name.text, declaration.initializer);
    }
  }

  const resolveSql = (expression: ts.Expression, dynamic: string[], seen = new Set<string>()): string | null => {
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
    if (ts.isParenthesizedExpression(expression)) return resolveSql(expression.expression, dynamic, seen);
    if (ts.isTemplateExpression(expression)) {
      let built = expression.head.text;
      for (const span of expression.templateSpans) {
        const interpolated = span.expression.getText(sourceFile);
        dynamic.push(interpolated);
        built += `<DYN:${interpolated}>${span.literal.text}`;
      }
      return built;
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = resolveSql(expression.left, dynamic, seen);
      const right = resolveSql(expression.right, dynamic, seen);
      return left === null || right === null ? null : left + right;
    }
    if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
      const initializer = constants.get(expression.text);
      return initializer ? resolveSql(initializer, dynamic, new Set(seen).add(expression.text)) : null;
    }
    return null;
  };

  const membersToFields = (members: readonly ts.TypeElement[]): RowField[] | null => {
    const fields: RowField[] = [];
    for (const member of members) {
      // An index signature means this is not a closed row: report nothing rather than every column.
      if (ts.isIndexSignatureDeclaration(member)) return null;
      if (!ts.isPropertySignature(member)) continue;
      fields.push({
        name: member.name.getText(sourceFile).replace(/['"]/g, ''),
        type: member.type ? member.type.getText(sourceFile).replace(/\s+/g, ' ') : 'any',
        optional: Boolean(member.questionToken),
      });
    }
    return fields;
  };

  const fieldsByName = (name: string, seen = new Set<string>()): RowField[] | null => {
    if (seen.has(name) || ambiguous.has(name)) return null;
    seen.add(name);
    const local = declared.get(name);
    if (!local) return null;
    const fields = membersToFields(local.members);
    if (!fields) return null;
    for (const base of local.heritage) {
      const baseFields = fieldsByName(base, seen);
      if (!baseFields) return null;
      for (const field of baseFields) {
        if (!fields.some((existing) => existing.name === field.name)) fields.push(field);
      }
    }
    return fields;
  };

  const sites: QuerySite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.typeArguments?.length === 1) {
      const callee = node.expression.getText(sourceFile);
      if (/\.query$|\.queryOne$/.test(callee)) {
        const typeArgument = node.typeArguments[0];
        const argument = node.arguments.at(0);
        const dynamic: string[] = [];
        const sql = argument === undefined ? null : resolveSql(argument, dynamic);
        sites.push({
          file: path.relative(baseDir, file),
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          rowType: typeArgument.getText(sourceFile).replace(/\s+/g, ' '),
          rowFields: ts.isTypeReferenceNode(typeArgument)
            ? fieldsByName(typeArgument.typeName.getText(sourceFile))
            : ts.isTypeLiteralNode(typeArgument)
              ? membersToFields(typeArgument.members)
              : null,
          sql,
          dynamic: [...new Set(dynamic)],
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
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

export function scrapeUntypedReads(file: string, baseDir: string): UntypedRead[] {
  const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const reads: UntypedRead[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && !node.typeArguments?.length && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'query' && readsRows(node)) {
      reads.push({ file: path.relative(baseDir, file), line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return reads;
}

function walkSources<T>(dirs: string[], visitFile: (file: string) => T[]): T[] {
  const found: T[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        found.push(...visitFile(full));
      }
    }
  };
  for (const dir of dirs) if (fs.existsSync(dir)) walk(dir);
  return found;
}

export function collectSites(dirs: string | string[], baseDir: string): QuerySite[] {
  return walkSources([dirs].flat(), (file) => scrapeFile(file, baseDir));
}

export function collectUntypedReads(dirs: string | string[], baseDir: string): UntypedRead[] {
  return walkSources([dirs].flat(), (file) => scrapeUntypedReads(file, baseDir));
}
