import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../src/ui/markdown.js';
import { dom } from '../fixtures/dom.js';

test('Markdown renders paragraphs, demoted headings, lists, emphasis, links and literal code', () => {
  const f = dom();
  renderMarkdown(f.root, '# Heading\n\nA **bold** and *emphasis* [link](https://example.invalid/) with `code`.\n\n- one\n- two\n\n3. third\n4. fourth\n\n```js\n<script>literal</script>\n```');
  assert.deepEqual(f.root.children.map(node => node.tagName), ['H3', 'P', 'UL', 'OL', 'PRE']);
  assert.equal(f.all().find(node => node.tagName === 'STRONG').textContent, 'bold');
  assert.equal(f.all().find(node => node.tagName === 'EM').textContent, 'emphasis');
  assert.equal(f.root.children[2].children.length, 2);
  assert.equal(f.root.children[3].getAttribute('start'), '3');
  assert.equal(f.root.children[4].textContent, '<script>literal</script>');
  const link = f.all().find(node => node.tagName === 'A');
  assert.equal(link.getAttribute('href'), 'https://example.invalid/');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
});

test('HTML, images and unsafe destinations cannot create executable or fetching elements', () => {
  const f = dom();
  const attacks = ['javascript:alert%281%29', 'data:text/html,evil', 'file:///etc/passwd', '//example.invalid', 'http://example.invalid', 'https://user:pass@example.invalid', 'https://example.invalid/\u0000x', 'jav&#x61;script:evil'];
  renderMarkdown(f.root, '<script>alert(1)</script><svg onload=evil>\n\n![image](https://example.invalid/track)\n\n' + attacks.map(url => `[bad](${url})`).join('\n'));
  assert.equal(f.all().some(node => ['SCRIPT', 'SVG', 'IMG', 'A', 'IFRAME'].includes(node.tagName)), false);
  assert.match(f.root.textContent, /<script>alert\(1\)<\/script>/);
  for (const url of attacks) assert.ok(f.root.textContent.includes(url));
});

test('soft breaks become spaces and authored hard breaks become br', () => {
  const f = dom(); renderMarkdown(f.root, 'soft\nline  \nhard\\\nend');
  assert.equal(f.root.textContent, 'soft linehardend');
  assert.equal(f.all().filter(node => node.tagName === 'BR').length, 2);
});

test('an unclosed code fence remains literal code through the end', () => {
  const f = dom(); renderMarkdown(f.root, '~~~\n**literal**\n<img src=x>');
  assert.equal(f.root.children[0].tagName, 'PRE');
  assert.equal(f.root.children[0].textContent, '**literal**\n<img src=x>');
});

test('underscores inside identifiers stay literal instead of silently changing displayed text', () => {
  const f = dom(); renderMarkdown(f.root, 'SPRINT9_WORD_NATIVE_C7F1A83 and a__b__c; _emphasis_ and __strong__.');
  assert.equal(f.root.textContent, 'SPRINT9_WORD_NATIVE_C7F1A83 and a__b__c; emphasis and strong.');
  assert.equal(f.all().filter(node => node.tagName === 'EM').length, 1);
  assert.equal(f.all().filter(node => node.tagName === 'STRONG').length, 1);
});
