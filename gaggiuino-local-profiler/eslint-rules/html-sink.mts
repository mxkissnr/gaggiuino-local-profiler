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
//
// #1626 widened it in two ways. More sinks: document.write/writeln,
// DOMParser.parseFromString, Range.createContextualFragment, setHTMLUnsafe
// and an `srcdoc` write. And casts: `x as Html` (or `<Html>x`) mints the brand
// without escaping anything, so outside the two modules that define the Html
// producers (public-src/utils.ts and public-src/i18n.ts) a cast is only
// accepted on a static string — a plain literal or a template without any
// interpolation, which cannot carry user data.

import { AST_NODE_TYPES, ESLintUtils, type TSESLint, type TSESTree } from '@typescript-eslint/utils';
import type ts from 'typescript';

const SINK_PROPERTIES = new Set(['innerHTML', 'outerHTML', 'srcdoc']);

// Methods whose markup argument is parsed as HTML, by argument index. These
// names are unique to the DOM APIs that parse markup, so the method name alone
// identifies the sink — except write/writeln, see DOCUMENT_WRITE_METHODS.
const SINK_METHODS = new Map<string, number>([
  ['insertAdjacentHTML', 1],
  ['parseFromString', 0],
  ['createContextualFragment', 0],
  ['setHTMLUnsafe', 0],
]);

// write/writeln are common names (streams, loggers), so they only count as a
// sink when the receiver is a Document; every argument is markup.
const DOCUMENT_WRITE_METHODS = new Set(['write', 'writeln']);

// The modules that define esc/html/joinHtml and tHtml: the only places allowed
// to cast a computed string to Html.
const CAST_EXEMPT_FILES = [/[\\/]public-src[\\/]utils\.ts$/, /[\\/]public-src[\\/]i18n\.ts$/];

// The brand property that the `Html` intersection type adds.
const HTML_BRAND = '__html';

// Whether a resolved expression type carries the Html brand. Given a plain
// `string` (or `any`) this is false, so the value is reported.
function isHtmlValue(checker: ts.TypeChecker, type: ts.Type): boolean {
  return checker.getPropertyOfType(type, HTML_BRAND) !== undefined;
}

// A literal string, or a template without any interpolation: a cast to Html is
// harmless there because the value is fixed in the source.
function isStaticString(node: TSESTree.Expression): boolean {
  if (node.type === AST_NODE_TYPES.Literal) return typeof node.value === 'string';
  return node.type === AST_NODE_TYPES.TemplateLiteral && node.expressions.length === 0;
}

function isHtmlTypeReference(node: TSESTree.TypeNode): boolean {
  return node.type === AST_NODE_TYPES.TSTypeReference &&
    node.typeName.type === AST_NODE_TYPES.Identifier &&
    node.typeName.name === 'Html';
}

function memberPropertyName(member: TSESTree.MemberExpression): string | null {
  if (member.computed) {
    return member.property.type === AST_NODE_TYPES.Literal && typeof member.property.value === 'string'
      ? member.property.value
      : null;
  }
  return member.property.type === AST_NODE_TYPES.Identifier ? member.property.name : null;
}

export const htmlSinkRule: TSESLint.RuleModule<'htmlSink' | 'htmlCast', []> = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require an Html-branded value at every markup sink, and forbid casting a computed string to Html',
    },
    messages: {
      htmlSink:
        'Markup sinks (innerHTML/outerHTML/srcdoc, insertAdjacentHTML, document.write, parseFromString, createContextualFragment, setHTMLUnsafe) must get an Html value built with the html template tag, joinHtml(), tHtml() or another Html-returning helper (see public-src/utils.ts); a plain string is not escaped (#1104, #1626).',
      htmlCast:
        'Do not cast a computed string to Html: build it with the html template tag, esc() and joinHtml() instead. Only a static string may be cast (#1626).',
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
      if (!node || node.type === AST_NODE_TYPES.SpreadElement) return;
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      if (!tsNode) return;
      if (!isHtmlValue(checker, checker.getTypeAtLocation(tsNode))) {
        context.report({ node, messageId: 'htmlSink' });
      }
    };

    const castExempt = CAST_EXEMPT_FILES.some((re) => re.test(context.filename));
    const checkCast = (node: TSESTree.TSAsExpression | TSESTree.TSTypeAssertion): void => {
      if (castExempt || !isHtmlTypeReference(node.typeAnnotation)) return;
      if (!isStaticString(node.expression)) context.report({ node, messageId: 'htmlCast' });
    };

    const isDocument = (node: TSESTree.Node): boolean => {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      if (!tsNode) return false;
      const symbol = checker.getTypeAtLocation(tsNode).getSymbol();
      return symbol?.getName() === 'Document';
    };

    return {
      TSAsExpression: checkCast,
      TSTypeAssertion: checkCast,
      AssignmentExpression(node) {
        if (node.left.type === AST_NODE_TYPES.MemberExpression) {
          const name = memberPropertyName(node.left);
          if (name !== null && SINK_PROPERTIES.has(name)) {
            checkValue(node.right);
          }
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== AST_NODE_TYPES.MemberExpression) return;
        const name = memberPropertyName(callee);
        if (name === null) return;
        const argIndex = SINK_METHODS.get(name);
        if (argIndex !== undefined) {
          checkValue(node.arguments[argIndex]);
        } else if (DOCUMENT_WRITE_METHODS.has(name) && isDocument(callee.object)) {
          for (const arg of node.arguments) checkValue(arg);
        }
      },
    };
  },
};
