import path from 'node:path';

const MODAL_ROOTS = { dialog: 'Dialog', 'alert-dialog': 'AlertDialog', sheet: 'Sheet' };

const WRAPPER_MODULE = /(?:^|\/)src\/components\/ui\/(dialog|alert-dialog|sheet)(?:\.tsx)?$/;

const wrapperRoot = (source, filename) => {
  let resolved = source;
  if (source.startsWith('@/')) resolved = `src/${source.slice(2)}`;
  else if (source.startsWith('.')) resolved = path.resolve(path.dirname(filename), source);
  const match = WRAPPER_MODULE.exec(resolved.replaceAll('\\', '/'));
  return match ? MODAL_ROOTS[match[1]] : undefined;
};

const jsxRootName = (name, rootNames, namespaces) => {
  if (name.type === 'JSXIdentifier') return rootNames.has(name.name) ? name : null;
  if (
    name.type === 'JSXMemberExpression' &&
    name.object.type === 'JSXIdentifier' &&
    namespaces.get(name.object.name) === name.property.name
  ) {
    return name;
  }
  return null;
};

const isFunction = (node) => node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';

// A function passed as a prop (an event handler) builds JSX for later, not inside the modal. Base UI's render prop does render in place.
const isDeferredAttributeFunction = (node) =>
  isFunction(node) &&
  node.parent.type === 'JSXExpressionContainer' &&
  node.parent.parent.type === 'JSXAttribute' &&
  node.parent.parent.name.name !== 'render';

export const modalBusyRule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Only one Dialog, AlertDialog or Sheet may be open at a time, so none is written inside another one.',
    },
    schema: [],
    messages: {
      nestedModal:
        'A Dialog, AlertDialog or Sheet inside another one opens two modals at once. Render the second one beside the first, and open one modal at a time.',
    },
  },
  create(context) {
    const rootNames = new Set();
    const namespaces = new Map();

    return {
      ImportDeclaration(node) {
        const root = wrapperRoot(node.source.value, context.filename);
        if (!root) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier' && specifier.imported.name === root) rootNames.add(specifier.local.name);
          if (specifier.type === 'ImportNamespaceSpecifier') namespaces.set(specifier.local.name, root);
        }
      },
      JSXElement(node) {
        const name = jsxRootName(node.openingElement.name, rootNames, namespaces);
        if (!name) return;
        for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
          if (isDeferredAttributeFunction(ancestor)) return;
          if (ancestor.type === 'JSXElement' && jsxRootName(ancestor.openingElement.name, rootNames, namespaces)) {
            context.report({ node: name, messageId: 'nestedModal' });
            return;
          }
        }
      },
    };
  },
};
