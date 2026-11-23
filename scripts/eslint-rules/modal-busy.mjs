const MODAL_ROOTS = {
  '@/components/ui/dialog': 'Dialog',
  '@/components/ui/alert-dialog': 'AlertDialog',
  '@/components/ui/sheet': 'Sheet',
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
        const root = MODAL_ROOTS[node.source.value];
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
          if (ancestor.type === 'JSXElement' && jsxRootName(ancestor.openingElement.name, rootNames, namespaces)) {
            context.report({ node: name, messageId: 'nestedModal' });
            return;
          }
        }
      },
    };
  },
};
