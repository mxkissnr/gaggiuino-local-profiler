// #1104 L1: enforce the Html brand at every markup sink in the migrated
// TypeScript sources (public-src/**/*.ts). `Html` (public-src/utils.ts) is
// `string & { readonly __html: unique symbol }`, so any value that has not been
// produced by `esc`, the `html` tag, `joinHtml`, `tHtml` or another
// Html-returning helper lacks the `__html` brand. This is a typed check, not a
// syntax one: it rejects a plain-string identifier, a member expression, a call
// like `String(x)` / `arr.join('')` / `x.toString()`, a literal, an untagged
// template and a `+` concatenation alike, while accepting every Html producer.
//
// The rule only inspects the *value* half of a sink; `el.innerHTML = html`...``
// therefore stays allowed, which is the point of the branding work.

import { ESLintUtils, type TSESLint, type TSESTree } from '@typescript-eslint/utils';
import type ts from 'typescript';

const SINK_PROPERTIES = new Set(['innerHTML', 'outerHTML']);

// The brand property that the `Html` intersection type adds.
const HTML_BRAND = '__html';

// Whether a resolved expression type carries the Html brand. Given a plain
// `string` (or `any`) this is false, so the value is reported.
function isHtmlValue(checker: ts.TypeChecker, type: ts.Type): boolean {
  return checker.getPropertyOfType(type, HTML_BRAND) !== undefined;
}

function memberPropertyName(member: TSESTree.MemberExpression): string | null {
  if (member.computed) {
    return member.property.type === 'Literal' && typeof member.property.value === 'string'
      ? member.property.value
      : null;
  }
  return member.property.type === 'Identifier' ? member.property.name : null;
}

export const htmlSinkRule: TSESLint.RuleModule<'htmlSink', []> = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require an Html-branded value at every innerHTML/outerHTML write and insertAdjacentHTML call',
    },
    messages: {
      htmlSink:
        'innerHTML/outerHTML must be assigned an Html value built with the html template tag, joinHtml(), tHtml() or another Html-returning helper (see public-src/utils.ts); a plain string is not escaped (#1104).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const services = (() => {
      try {
        return ESLintUtils.getParserServices(context);
      } catch {
        // No type information (e.g. a file outside the typed project): stay quiet
        // rather than reporting on a value we cannot inspect.
        return null;
      }
    })();
    if (!services) return {};

    const checker = services.program.getTypeChecker();

    const checkValue = (node: TSESTree.Node | undefined): void => {
      if (!node || node.type === 'SpreadElement') return;
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      if (!tsNode) return;
      if (!isHtmlValue(checker, checker.getTypeAtLocation(tsNode))) {
        context.report({ node, messageId: 'htmlSink' });
      }
    };

    return {
      AssignmentExpression(node) {
        if (node.left.type === 'MemberExpression') {
          const name = memberPropertyName(node.left);
          if (name !== null && SINK_PROPERTIES.has(name)) {
            checkValue(node.right);
          }
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          memberPropertyName(callee) === 'insertAdjacentHTML'
        ) {
          checkValue(node.arguments[1]);
        }
      },
    };
  },
};
