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
  sql: string;
  dynamic: string[];
}

interface LocalType {
  members: readonly ts.TypeElement[];
  heritage: string[];
}

/** The row types and every `query<Row>` site declared in one file, paths relative to `baseDir`. */
export function scrapeFile(file: string, baseDir: string): QuerySite[] {
  const text = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declared = new Map<string, LocalType>();

  const collectDeclarations = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node)) {
      declared.set(node.name.getText(sourceFile), {
        members: node.members,
        heritage: (node.heritageClauses ?? []).flatMap((clause) => clause.types.map((t) => t.expression.getText(sourceFile))),
      });
    }
    if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
      declared.set(node.name.getText(sourceFile), { members: node.type.members, heritage: [] });
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sourceFile);

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
    if (seen.has(name)) return null;
    seen.add(name);
    const local = declared.get(name);
    if (!local) return null;
    const fields = membersToFields(local.members);
    if (!fields) return null;
    for (const base of local.heritage) {
      const baseFields = fieldsByName(base, seen);
      if (baseFields) {
        for (const field of baseFields) {
          if (!fields.some((existing) => existing.name === field.name)) fields.push(field);
        }
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
        let sql: string | null = null;
        const dynamic: string[] = [];
        if (argument !== undefined && ts.isNoSubstitutionTemplateLiteral(argument)) {
          sql = argument.text;
        } else if (argument !== undefined && ts.isTemplateExpression(argument)) {
          let built = argument.head.text;
          for (const span of argument.templateSpans) {
            const expression = span.expression.getText(sourceFile);
            dynamic.push(expression);
            built += `<DYN:${expression}>${span.literal.text}`;
          }
          sql = built;
        }
        if (sql) {
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
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/** Every site under `dir`, skipping test directories. */
export function collectSites(dir: string, baseDir: string): QuerySite[] {
  const sites: QuerySite[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
      } else if (entry.name.endsWith('.ts')) {
        sites.push(...scrapeFile(full, baseDir));
      }
    }
  };
  walk(dir);
  return sites;
}
