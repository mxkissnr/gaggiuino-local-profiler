// #1962: the app has its own dialog and toast, and the autocomplete component
// replaced <datalist> because it is unreliable to tap on Android. A native
// alert/confirm cannot be styled or translated and blocks the page. Existing
// uses are tracked in eslint-suppressions.json until they are migrated.
import { AST_NODE_TYPES, type TSESLint, type TSESTree } from '@typescript-eslint/utils';

const DIALOGS = new Set(['alert', 'confirm']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);
const DATALIST_MARKUP = /<datalist\b/i;

function propertyName(member: TSESTree.MemberExpression): string | null {
  if (!member.computed) return member.property.type === AST_NODE_TYPES.Identifier ? member.property.name : null;
  return member.property.type === AST_NODE_TYPES.Literal && typeof member.property.value === 'string'
    ? member.property.value
    : null;
}

export const noNativeDialogRule: TSESLint.RuleModule<'nativeDialog' | 'datalist', []> = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid native alert(), confirm() and <datalist> (docs/DESIGN.md, Interaction rules)' },
    messages: {
      nativeDialog: 'Do not use native {{name}}(): use the app dialog for irreversible actions and a toast for everything else (#1962).',
      datalist: 'Do not use a native <datalist>: use a dropdown, or the autocomplete component where new values are legitimate (#1962).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const checkMarkup = (node: TSESTree.Node, text: string): void => {
      if (DATALIST_MARKUP.test(text)) context.report({ node, messageId: 'datalist' });
    };
    return {
      // Every read of the global counts, so an alias (`const a = alert`) does too.
      // A local function or import of the same name resolves to its own definition.
      Identifier(node) {
        if (!DIALOGS.has(node.name)) return;
        const reference = context.sourceCode.getScope(node).references.find(r => r.identifier === node);
        if (!reference || (reference.resolved && reference.resolved.defs.length > 0)) return;
        context.report({ node, messageId: 'nativeDialog', data: { name: node.name } });
      },
      MemberExpression(node) {
        const name = propertyName(node);
        if (name === null || !DIALOGS.has(name)) return;
        if (node.object.type === AST_NODE_TYPES.Identifier && GLOBAL_OBJECTS.has(node.object.name)) {
          context.report({ node, messageId: 'nativeDialog', data: { name } });
        }
      },
      Literal(node) { if (typeof node.value === 'string') checkMarkup(node, node.value); },
      TemplateElement(node) { checkMarkup(node, node.value.raw); },
      CallExpression(node) {
        const arg = node.arguments[0];
        if (node.callee.type === AST_NODE_TYPES.MemberExpression && propertyName(node.callee) === 'createElement'
          && arg?.type === AST_NODE_TYPES.Literal && typeof arg.value === 'string' && arg.value.toLowerCase() === 'datalist') {
          context.report({ node, messageId: 'datalist' });
        }
      },
    };
  },
};
