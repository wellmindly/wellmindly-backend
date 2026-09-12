"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const escapeHtml_1 = require("../utils/escapeHtml");
(0, vitest_1.describe)('escapeHtml', () => {
    (0, vitest_1.it)('neutralises markup that would otherwise land in an email body', () => {
        (0, vitest_1.expect)((0, escapeHtml_1.escapeHtml)('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
        (0, vitest_1.expect)((0, escapeHtml_1.escapeHtml)('<a href="http://phish.example">click</a>')).toBe('&lt;a href=&quot;http://phish.example&quot;&gt;click&lt;/a&gt;');
    });
    (0, vitest_1.it)('escapes the ampersand first, so an entity is not double-decoded', () => {
        (0, vitest_1.expect)((0, escapeHtml_1.escapeHtml)('Tom & Jerry')).toBe('Tom &amp; Jerry');
        (0, vitest_1.expect)((0, escapeHtml_1.escapeHtml)('&lt;b&gt;')).toBe('&amp;lt;b&amp;gt;');
    });
    (0, vitest_1.it)('escapes both quote styles', () => {
        (0, vitest_1.expect)((0, escapeHtml_1.escapeHtml)(`he said "hi" and 'bye'`)).toBe('he said &quot;hi&quot; and &#39;bye&#39;');
    });
    (0, vitest_1.it)('leaves ordinary text untouched', () => {
        (0, vitest_1.expect)((0, escapeHtml_1.escapeHtml)('Anxiety and academic stress')).toBe('Anxiety and academic stress');
        (0, vitest_1.expect)((0, escapeHtml_1.escapeHtml)('multi\nline')).toBe('multi\nline');
    });
    (0, vitest_1.it)('renders null and undefined as an empty string rather than the word', () => {
        (0, vitest_1.expect)((0, escapeHtml_1.escapeHtml)(null)).toBe('');
        (0, vitest_1.expect)((0, escapeHtml_1.escapeHtml)(undefined)).toBe('');
        (0, vitest_1.expect)((0, escapeHtml_1.escapeHtml)(0)).toBe('0');
    });
});
