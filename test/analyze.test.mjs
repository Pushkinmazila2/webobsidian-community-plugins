import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCapabilities, parseModules } from '../scripts/lib/capabilities.mjs';
import { buildIndex, classify, compareVersions, extractUsage, maskNonCode } from '../scripts/lib/analyze.mjs';

// A small capabilities file, built through the real builder from a hand-written status + loader fixture.
const status = {
  apiVersion: '1.14.4',
  classes: [
    { name: 'Plugin', classStatus: 'ok', feasibility: 'easy', members: [{ name: 'addCommand', status: 'ok' }] },
    { name: 'Notice', classStatus: 'ok', feasibility: 'easy', members: [] },
    { name: 'Modal', classStatus: 'ok', feasibility: 'easy', members: [] },
    { name: 'MarkdownView', classStatus: 'ok', feasibility: 'medium', members: [{ name: 'hoverPopover', status: 'missing', feasibility: 'medium' }] },
    { name: 'FileSystemAdapter', classStatus: 'missing', feasibility: 'impossible', members: [{ name: 'getBasePath', status: 'missing', feasibility: 'impossible' }] },
    { name: 'WorkspaceTabs', classStatus: 'missing', feasibility: 'hard', members: [] },
    { name: 'DataAdapter', classStatus: 'ok', feasibility: 'easy', members: [{ name: 'getFullPath', status: 'ok' }, { name: 'getBasePath', status: 'ok' }] },
  ],
  functions: [{ name: 'requestUrl', status: 'stub', stubKind: 'partial', feasibility: 'medium' }],
  consts: [],
};
const pluginsTs = `
const EXTERNALS: Record<string, unknown> = {
  '@codemirror/state': cmState, '@codemirror/view': cmView,
};
const NODE_BUILTINS = new Set(['fs', 'os', 'child_process', 'electron', 'path', 'crypto']);
  if (bare === 'path') return pathShim;
};`;
const caps = buildCapabilities({ status, pluginsTs, utilsTs: "export const API_VERSION = '1.12.7';", generatedAt: '2026-01-01T00:00:00Z' });
const index = buildIndex(caps);
const rate = (src, manifest = {}) => classify(extractUsage(src, index), manifest, caps, index);

test('capabilities: modules and statuses are read from the loader and the API report', () => {
  assert.deepEqual(parseModules(pluginsTs), { obsidian: 'ok', '@codemirror/state': 'ok', '@codemirror/view': 'ok', fs: 'unavailable', os: 'unavailable', child_process: 'unavailable', electron: 'unavailable', path: 'shim', crypto: 'unavailable' });
  assert.equal(caps.functions.requestUrl, 'partial');
  assert.equal(caps.classes.FileSystemAdapter.present, false);
  assert.equal(caps.api.declared, '1.12.7');
  assert.equal(buildCapabilities({ status, pluginsTs, utilsTs: "export const API_VERSION = '1.12.7';" }).hash, caps.hash, 'hash is content-based, not time-based');
});

test('maskNonCode blanks strings, templates, regexes and comments but keeps code and offsets', () => {
  const src = 'a("x//y"); // require("fs")\nb(`t ${c("z")} u`); /* require("os") */ d = /require\\("net"\\)/g; e = 1 / 2;';
  const m = maskNonCode(src);
  assert.equal(m.length, src.length);
  assert.ok(!m.includes('require'), 'nothing inside strings/comments/regex survives');
  assert.match(m, /a\(" {4}"\);/);
  assert.match(m, /c\(" "\)/, 'code inside ${…} is still code');
  assert.match(m, /e = 1 \/ 2;/, 'division is not mistaken for a regex');
});

test('a plugin that only uses supported API is full', () => {
  const r = rate('var obsidian=require("obsidian");class P extends obsidian.Plugin{onload(){new obsidian.Notice("hi");this.addCommand({})}}module.exports=P;');
  assert.equal(r.compat, 'full');
});

test('esbuild / TypeScript output shapes are all recognised', () => {
  for (const src of [
    'var import_obsidian = require("obsidian"); class A extends import_obsidian.Plugin {}',
    'var o=__toESM(require("obsidian"));var A=class extends o.Plugin{};',
    'const {Plugin: P, Notice} = require("obsidian"); class A extends P {}',
    '"use strict";var obsidian=require("obsidian");__extends(A,obsidian.Modal);',
    'var obsidian = require("obsidian"); var A = (function(_super){return _super})(obsidian.Modal);',
  ]) {
    const u = extractUsage(src, index);
    assert.ok(u.api.includes('Plugin') || u.api.includes('Modal'), src);
  }
});

test('extending a class WebObsidian lacks is broken; merely mentioning it is partial', () => {
  assert.equal(rate('var o=require("obsidian");class V extends o.WorkspaceTabs{}').compat, 'broken');
  const r = rate('var o=require("obsidian");if(o.WorkspaceTabs){}');
  assert.equal(r.compat, 'partial');
  assert.match(r.reasons[0], /WorkspaceTabs/);
});

test('Node/Electron: desktop-only + hard module is broken, but a mobile-capable plugin keeps working', () => {
  const src = 'var o=require("obsidian");var fs=require("fs");class P extends o.Plugin{}';
  assert.equal(rate(src, { isDesktopOnly: true }).compat, 'broken');
  assert.equal(rate(src, { isDesktopOnly: false }).compat, 'full', 'fs on a mobile-capable plugin is a dead desktop branch');
  assert.equal(rate('var o=require("obsidian");var os=require("os");class P extends o.Plugin{}', { isDesktopOnly: true }).compat, 'partial');
});

test('require() inside strings, templates and comments is not a dependency (code generators such as ajv)', () => {
  const src = 'var o=require("obsidian");const code=`const x = require("ajv/dist/runtime/equal").default`;/* require("electron") */ var s="require(\\"fs\\")";class P extends o.Plugin{}';
  const u = extractUsage(src, index);
  assert.deepEqual(u.requires, []);
  assert.equal(classify(u, { isDesktopOnly: true }, caps, index).compat, 'full');
});

test('an unknown module: broken when needed at load time, partial when only a feature needs it', () => {
  const atLoad = rate('var o=require("obsidian");var w=require("ws");class P extends o.Plugin{}');
  assert.equal(atLoad.compat, 'broken');
  assert.match(atLoad.reasons[0], /Fails to load/);
  const lazy = rate('var o=require("obsidian");class P extends o.Plugin{async f(){const w=require("ws");return w}}');
  assert.equal(lazy.compat, 'partial');
});

test('FileSystemAdapter / getBasePath: desktop-only → broken, otherwise partial (the feature fails, the plugin runs)', () => {
  const src = 'var o=require("obsidian");class P extends o.Plugin{f(){return this.app.vault.adapter instanceof o.FileSystemAdapter}}';
  assert.equal(rate(src, { isDesktopOnly: true }).compat, 'broken');
  assert.equal(rate(src, {}).compat, 'partial');
});

test('missing methods are found by name, but only distinctive ones', () => {
  const r = rate('var o=require("obsidian");class P extends o.Plugin{f(v){v.hoverPopover=null;v.file.parent;return this.settings.app}}');
  assert.equal(r.compat, 'partial');
  assert.match(r.reasons.join(), /hoverPopover/);
  assert.equal(rate('var o=require("obsidian");class P extends o.Plugin{f(v){return v.parent.settings.app}}').compat, 'full');
});

test('manifest: a minAppVersion newer than the checked API makes it partial; eval is a flag, not a downgrade', () => {
  assert.equal(rate('var o=require("obsidian");class P extends o.Plugin{}', { minAppVersion: '1.12.0' }).compat, 'full');
  assert.equal(rate('var o=require("obsidian");class P extends o.Plugin{}', { minAppVersion: '9.0.0' }).compat, 'partial');
  const r = rate('var o=require("obsidian");class P extends o.Plugin{f(s){return eval(s)}}');
  assert.equal(r.compat, 'full');
  assert.deepEqual(r.flags, ['eval']);
  assert.deepEqual(rate('var o=require("obsidian");var g=Function("return this")();class P extends o.Plugin{}').flags, [], 'global sniffing is not eval');
  assert.deepEqual(rate('var o=require("obsidian");var f=new Function("a","return a");class P extends o.Plugin{}').flags, ['eval']);
});

test('a plugin that does not use the Obsidian API is not misread through unrelated aliases', () => {
  const u = extractUsage('var x=require("foo");x.Plugin;x.Notice;', index);
  assert.deepEqual(u.api, []);
});

test('a multi-megabyte base64 blob does not break or slow the scan', () => {
  const blob = 'A'.repeat(5_000_000);
  const t = Date.now();
  const u = extractUsage(`var o=require("obsidian");var f="data:font/woff2;base64,${blob}";class P extends o.Plugin{}`, index);
  assert.ok(Date.now() - t < 3000);
  assert.deepEqual(u.extends, ['Plugin']);
});

test('compareVersions', () => {
  assert.equal(compareVersions('1.10.3', '1.12.7'), -1);
  assert.equal(compareVersions('1.12.7', '1.12.7'), 0);
  assert.equal(compareVersions('1.13', '1.12.7'), 1);
  assert.equal(compareVersions('0.15.0', '1.0.0'), -1);
});
