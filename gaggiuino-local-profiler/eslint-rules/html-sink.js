'use strict';

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

const { ESLintUtils } = require('@typescript-eslint/utils');
const ts = require('typescript');

const SINK_PROPERTIES = new Set(['innerHTML', 'outerHTML']);

// The brand property added by the `Html` intersection type.
const HTML_BRAND = '__html';

// Locate the `Html` type alias in public-src/utils.ts so the value can be
// checked for assignability to it, not just for the brand marker.
function findHtmlType(program, checker) {
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || !/[\\/]utils\.ts$/.test(sourceFile.fileName)) continue;
    let htmlType;
    sourceFile.forEachChild(function visit(node) {
      if (htmlType) return;
      if (ts.isTypeAliasDeclaration(node) && node.name.text === 'Html') {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) htmlType = checker.getDeclaredTypeOfSymbol(symbol);
      }
      if (!htmlType) ts.forEachChild(node, visit);
    });
    if (htmlType) return htmlType;
  }
  return undefined;
}

function memberPropertyName(member) {
  if (member.computed) {
    return member.property.type === 'Literal' && typeof member.property.value === 'string'
      ? member.property.value
      : null;
  }
  return member.property.type === 'Identifier' ? member.property.name : null;
}

const htmlSinkRule = {
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
  create(context) {
    let services;
    try {
      services = ESLintUtils.getParserServices(context);
    } catch {
      // No type information (e.g. a file outside the typed project): stay quiet
      // rather than reporting on a value we cannot inspect.
      return {};
    }
    const checker = services.program.getTypeChecker();
    const htmlType = findHtmlType(services.program, checker);

    const isHtmlValue = (type) => {
      if (htmlType && typeof checker.isTypeAssignableTo === 'function') {
        if (checker.isTypeAssignableTo(type, htmlType)) return true;
      }
      return checker.getPropertyOfType(type, HTML_BRAND) !== undefined;
    };

    const checkValue = (node) => {
      if (!node || node.type === 'SpreadElement') return;
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      if (!tsNode) return;
      if (!isHtmlValue(checker.getTypeAtLocation(tsNode))) {
        context.report({ node, messageId: 'htmlSink' });
      }
    };

    return {
      AssignmentExpression(node) {
        if (node.left.type === 'MemberExpression' && SINK_PROPERTIES.has(memberPropertyName(node.left))) {
          checkValue(node.right);
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

module.exports = { htmlSinkRule };
