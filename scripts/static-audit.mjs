import { parse } from 'acorn';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-control guard, NOT a sandbox or a proof about arbitrary JavaScript.
// Computed DATA reads are allowed; computed execution/global lookups fail closed.
// Local alias analysis is intentionally scope-insensitive and conservative.
const executionNames = new Set(['eval', 'Function', 'constructor', 'execScript']);
const timerNames = new Set(['setTimeout', 'setInterval']);
const globalNames = new Set(['window', 'self', 'globalThis']);
function constantProperty(node) {
  if (node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number')) return String(node.value);
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis.at(0).value.cooked;
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = constantProperty(node.left);
    const right = constantProperty(node.right);
    if (left !== null && right !== null) return left + right;
  }
  return null;
}
function inlineFunction(node) {
  return node && (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') && !node.async && !node.generator;
}
export function auditSource(source, label = 'source.js') {
  const findings = [];
  const seen = new Set();
  function report(code, node) {
    const line = node?.loc?.start.line ?? 1;
    const column = (node?.loc?.start.column ?? 0) + 1;
    const identity = `${code}:${line}:${column}`;
    if (!seen.has(identity)) {
      seen.add(identity);
      findings.push({ code, label, line, column });
    }
  }
  let tree;
  try { tree = parse(source, { ecmaVersion: 2022, sourceType: 'module', locations: true, allowHashBang: true }); }
  catch (error) {
    report('PARSE_ERROR', { loc: { start: error.loc ?? { line: 1, column: 0 } } });
    return findings;
  }
  function walk(node, callback) {
    if (!node?.type) return;
    callback(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) walk(child, callback);
      } else if (value?.type) walk(value, callback);
    }
  }
  const computedAliases = new Set();
  const aggregationAliases = new Set();
  function aggregationFunction(node) {
    if (!node) return false;
    if (node.type === 'Identifier') return aggregationAliases.has(node.name);
    if (node.type !== 'MemberExpression') return false;
    const name = node.computed ? constantProperty(node.property) : node.property.name;
    return name === 'values' || name === 'entries';
  }
  function computedValue(node) {
    if (!node) return false;
    if (node.type === 'Identifier') return computedAliases.has(node.name);
    if (node.type === 'MemberExpression') return (node.computed && constantProperty(node.property) === null) || computedValue(node.object);
    if (node.type === 'ChainExpression' || node.type === 'AwaitExpression') return computedValue(node.expression ?? node.argument);
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const callee = node.callee;
      const name = callee.type === 'MemberExpression' ? (callee.computed ? constantProperty(callee.property) : callee.property.name) : null;
      // Bulk descriptors may expose compilation factories without a named sink.
      // Treat their results as DATA only; aggregation must not erase that taint.
      return name === 'getOwnPropertyDescriptors' || computedValue(callee) ||
        (aggregationFunction(callee) && node.arguments.some(computedValue));
    }
    if (node.type === 'AssignmentExpression') return computedValue(node.right);
    if (node.type === 'ArrayExpression') return node.elements.some(computedValue);
    if (node.type === 'ObjectExpression') return node.properties.some(property => computedValue(property.value ?? property.argument));
    if (node.type === 'SpreadElement') return computedValue(node.argument);
    if (node.type === 'SequenceExpression') return computedValue(node.expressions.at(-1));
    if (node.type === 'ConditionalExpression') return computedValue(node.consequent) || computedValue(node.alternate);
    if (node.type === 'LogicalExpression') return computedValue(node.left) || computedValue(node.right);
    return false;
  }
  function markPattern(pattern, tainted) {
    if (!pattern) return;
    if (pattern.type === 'Identifier' && tainted) computedAliases.add(pattern.name);
    // A property assignment taints its root container, not just one field.
    if (pattern.type === 'MemberExpression') markPattern(pattern.object, tainted);
    if (pattern.type === 'AssignmentPattern') markPattern(pattern.left, tainted || computedValue(pattern.right));
    if (pattern.type === 'RestElement') markPattern(pattern.argument, tainted);
    if (pattern.type === 'ArrayPattern') for (const entry of pattern.elements) markPattern(entry, tainted);
    if (pattern.type === 'ObjectPattern') for (const property of pattern.properties) {
      if (property.type === 'RestElement') markPattern(property.argument, tainted);
      else markPattern(property.value, tainted || (property.computed && constantProperty(property.key) === null));
    }
  }
  // Fixed point catches aliases of aliases and assignments regardless of order.
  let previousSize;
  do {
    previousSize = computedAliases.size + aggregationAliases.size;
    walk(tree, node => {
      const target = node.type === 'VariableDeclarator' ? node.id : node.type === 'AssignmentExpression' ? node.left : null;
      const value = node.type === 'VariableDeclarator' ? node.init : node.type === 'AssignmentExpression' ? node.right : null;
      if (target?.type === 'Identifier' && aggregationFunction(value)) aggregationAliases.add(target.name);
      if (node.type === 'VariableDeclarator') markPattern(node.id, computedValue(node.init));
      if (node.type === 'AssignmentExpression') markPattern(node.left, computedValue(node.right));
      if (node.type === 'AssignmentPattern') markPattern(node.left, computedValue(node.right));
      if (node.type === 'ObjectPattern') markPattern(node, false);
    });
  } while (computedAliases.size + aggregationAliases.size !== previousSize);
  function checkSink(name, node, parent) {
    if (executionNames.has(name)) report('DYNAMIC_EXECUTION', node);
    const call = parent?.type === 'CallExpression' && parent.callee === node ? parent : null;
    if (timerNames.has(name) && (!call || !inlineFunction(call.arguments.at(0)))) report('DYNAMIC_TIMER', node);
    if (name === 'callCommand' && (!call || !inlineFunction(call.arguments.at(0)))) report('NON_STATIC_COMMAND', node);
    // Extracted bulk-reflection aliases are unsupported, even for DATA use.
    if (name === 'getOwnPropertyDescriptors' && !call) report('DYNAMIC_EXECUTION', node);
    if (name === 'getOwnPropertyDescriptor') {
      const property = call ? constantProperty(call.arguments.at(1) ?? {}) : null;
      if (!call) report('DYNAMIC_EXECUTION', node);
      else if (property === null) report('DYNAMIC_PROPERTY', node);
      else if (executionNames.has(property) || timerNames.has(property) || property === 'callCommand') report('DYNAMIC_EXECUTION', node);
    }
  }
  function visit(node, parent = null) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportExpression') report('DYNAMIC_EXECUTION', node);
    if ((node.type === 'CallExpression' || node.type === 'NewExpression' || node.type === 'TaggedTemplateExpression') &&
        computedValue(node.callee ?? node.tag)) report('DYNAMIC_PROPERTY', node);
    if (node.type === 'MemberExpression') {
      const name = node.computed ? constantProperty(node.property) : node.property.name;
      if (name === null) {
        if (node.object.type === 'Identifier' && globalNames.has(node.object.name)) report('DYNAMIC_PROPERTY', node);
      } else checkSink(name, node, parent);
      if (node.object.type === 'Identifier' && node.object.name === 'Reflect' && name !== 'ownKeys') report('DYNAMIC_EXECUTION', node);
    }
    if (node.type === 'Property') {
      const name = node.computed || node.key.type === 'Literal' ? constantProperty(node.key) : node.key.name;
      if (name !== null) checkSink(name, node, parent);
    }
    if (node.type === 'Identifier') {
      const memberProperty = parent?.type === 'MemberExpression' && parent.property === node && !parent.computed;
      const classConstructor = parent?.type === 'MethodDefinition' && parent.kind === 'constructor' && parent.key === node && !parent.computed;
      if (!memberProperty && !classConstructor) checkSink(node.name, node, parent);
      // Do not permit extraction of global/reflective objects for indirect lookup.
      if ((globalNames.has(node.name) || node.name === 'Reflect') && !(parent?.type === 'MemberExpression' && parent.object === node)) report('DYNAMIC_EXECUTION', node);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child, node);
      } else if (value?.type) visit(value, node);
    }
  }
  visit(tree);
  return findings;
}

// No blanket src/plugin/vendor exclusion: official SDK is installed outside this repo.
// Test source strings are inert; production/tooling/artifact JS is the default scope.
const defaultDirectories = ['src', 'scripts', 'dist', 'artifacts', 'packaging'];
const extensions = new Set(['.js', '.mjs', '.cjs']);
export async function auditPaths(root = process.cwd(), paths = null) {
  root = resolve(root);
  const findings = [];
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error();
  } catch { return [{ code: 'READ_ERROR', label: '.', line: 1, column: 1 }]; }
  async function scan(path, optional = false) {
    const absolute = resolve(root, path);
    const label = relative(root, absolute).replaceAll('\\', '/');
    let stat;
    try { stat = await lstat(absolute); }
    catch (error) {
      if (!optional || error.code !== 'ENOENT') findings.push({ code: 'READ_ERROR', label, line: 1, column: 1 });
      return;
    }
    if (stat.isSymbolicLink()) {
      findings.push({ code: 'READ_ERROR', label, line: 1, column: 1 });
    } else if (stat.isDirectory()) {
      let entries;
      try { entries = await readdir(absolute); }
      catch { findings.push({ code: 'READ_ERROR', label, line: 1, column: 1 }); return; }
      for (const entry of entries.sort()) await scan(resolve(absolute, entry));
    } else if (stat.isFile() && extensions.has(extname(absolute))) {
      try { findings.push(...auditSource(await readFile(absolute, 'utf8'), label)); }
      catch { findings.push({ code: 'READ_ERROR', label, line: 1, column: 1 }); }
    }
  }
  for (const path of paths ?? defaultDirectories) await scan(path, paths === null);
  return findings;
}

if (process.argv.at(1) && resolve(process.argv.at(1)) === fileURLToPath(import.meta.url)) {
  const inputs = process.argv.slice(2);
  const findings = await auditPaths(process.cwd(), inputs.length ? inputs : null);
  for (const finding of findings) console.error(`${finding.label}:${finding.line}:${finding.column} ${finding.code}`);
  if (findings.length) process.exitCode = 1;
  else console.log('Authored-code audit PASS');
}
