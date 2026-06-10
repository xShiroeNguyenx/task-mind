const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const registeredCommands = new Map();
let createdTreeView = null;

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (listener) => {
      this._listeners.add(listener);
      return { dispose: () => this._listeners.delete(listener) };
    };
  }
  fire(data) {
    for (const l of this._listeners) {
      try { l(data); } catch { /* ignore */ }
    }
  }
  dispose() { this._listeners.clear(); }
}

// Cấu hình test: tắt autoCapture để không khởi động watcher / đọc transcript thật.
const configOverrides = { 'autoCapture.enabled': false };
const configuration = {
  get(key, fallback) {
    return Object.prototype.hasOwnProperty.call(configOverrides, key) ? configOverrides[key] : fallback;
  },
  async update() {},
};

const mockVscode = {
  EventEmitter,
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ThemeIcon: class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } },
  ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
  MarkdownString: class MarkdownString { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; } },
  TreeItem: class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  Uri: { file: (p) => ({ fsPath: p }) },
  ViewColumn: { Active: -1 },
  window: {
    createOutputChannel() { return { appendLine() {}, dispose() {} }; },
    createTreeView(id, opts) {
      createdTreeView = { id, opts, selection: [] };
      return {
        selection: [],
        onDidChangeCheckboxState() { return { dispose() {} }; },
        reveal() {},
        dispose() {},
      };
    },
    showInformationMessage() { return Promise.resolve(undefined); },
    showWarningMessage() { return Promise.resolve(undefined); },
    registerWebviewViewProvider() { return { dispose() {} }; },
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration(section) {
      assert.strictEqual(section, 'taskMind');
      return configuration;
    },
    onDidChangeConfiguration() { return { dispose() {} }; },
  },
  commands: {
    registerCommand(name, cb) { registeredCommands.set(name, cb); return { dispose() {} }; },
    executeCommand() { return Promise.resolve(undefined); },
  },
};

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') {
    return mockVscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  try {
    const ext = require('../out/extension.js');
    const storagePath = path.resolve(__dirname, '..', '.tmp-test-storage');
    try { fs.rmSync(storagePath, { recursive: true, force: true }); } catch { /* ignore */ }
    const context = {
      globalStorageUri: { fsPath: storagePath },
      subscriptions: [],
      secrets: { get: async () => undefined, store: async () => {} },
    };

    await ext.activate(context);

    assert.ok(createdTreeView, 'TreeView phải được tạo');
    assert.strictEqual(createdTreeView.id, 'taskMind.tasksView');
    assert.strictEqual(createdTreeView.opts.manageCheckboxStateManually, true, 'phải quản lý checkbox thủ công');

    const expected = [
      'taskMind.refresh',
      'taskMind.toggleGrouping',
      'taskMind.markDone',
      'taskMind.editTitle',
      'taskMind.deleteTask',
      'taskMind.moveToEpic',
      'taskMind.createEpic',
      'taskMind.addSubtask',
      'taskMind.openReport',
      'taskMind.setApiKey',
      'taskMind.simulateTask',
    ];
    for (const cmd of expected) {
      assert.ok(registeredCommands.has(cmd), `Thiếu lệnh: ${cmd}`);
    }

    // --- Phủ kiểm đường render: tạo dữ liệu mẫu rồi đi hết cây + toggle checkbox ---
    await registeredCommands.get('taskMind.simulateTask')();
    await registeredCommands.get('taskMind.simulateTask')();

    const provider = createdTreeView.opts.treeDataProvider;
    assert.ok(provider, 'phải có treeDataProvider');

    let rendered = 0;
    function walk(node) {
      const item = provider.getTreeItem(node);
      assert.ok(item, 'getTreeItem phải trả TreeItem');
      rendered++;
      for (const child of provider.getChildren(node)) {
        walk(child);
      }
    }
    for (const mode of ['project-day', 'day-project']) {
      configOverrides['tree.groupBy'] = mode;
      const roots = provider.getChildren();
      assert.ok(roots.length > 0, `chế độ ${mode} phải có node gốc`);
      for (const r of roots) {
        walk(r);
      }
    }
    assert.ok(rendered > 0, 'phải render được node');

    // Cấu trúc 2 cấp: simulateTask tạo các việc cùng 1 dự án + cùng 1 ngày.
    // project-day: gốc = project → con = day → cháu = task.
    configOverrides['tree.groupBy'] = 'project-day';
    {
      const roots = provider.getChildren();
      assert.ok(roots.length >= 1 && roots[0].kind === 'project', 'project-day: gốc phải là project');
      const lvl2 = provider.getChildren(roots[0]);
      assert.ok(lvl2.length >= 1 && lvl2[0].kind === 'day', 'project-day: cấp 2 phải là day');
      const lvl3 = provider.getChildren(lvl2[0]);
      assert.ok(lvl3.length >= 1 && lvl3[0].kind === 'task', 'project-day: cấp 3 phải là task');
    }
    // day-project: gốc = day → con = project → cháu = task.
    configOverrides['tree.groupBy'] = 'day-project';
    {
      const roots = provider.getChildren();
      assert.ok(roots.length >= 1 && roots[0].kind === 'day', 'day-project: gốc phải là day');
      const lvl2 = provider.getChildren(roots[0]);
      assert.ok(lvl2.length >= 1 && lvl2[0].kind === 'project', 'day-project: cấp 2 phải là project');
      const lvl3 = provider.getChildren(lvl2[0]);
      assert.ok(lvl3.length >= 1 && lvl3[0].kind === 'task', 'day-project: cấp 3 phải là task');
    }

    // toggle checkbox của một task → trạng thái done phải phản ánh khi render lại.
    // Cây giờ 2 cấp (nhóm → nhóm con → task) nên dò task node theo chiều sâu.
    configOverrides['tree.groupBy'] = 'project-day';
    function findFirstTask(node) {
      for (const child of provider.getChildren(node)) {
        if (child.kind === 'task') return child;
        const found = findFirstTask(child);
        if (found) return found;
      }
      return null;
    }
    const taskNode = findFirstTask(undefined);
    let subtaskNode = null;
    if (taskNode) {
      for (const gc of provider.getChildren(taskNode)) {
        if (gc.kind === 'subtask' && !subtaskNode) subtaskNode = gc;
      }
    }
    assert.ok(taskNode, 'phải tìm được task node');
    await provider.handleCheckboxChange([[taskNode, mockVscode.TreeItemCheckboxState.Checked]]);
    assert.strictEqual(
      provider.getTreeItem(taskNode).checkboxState,
      mockVscode.TreeItemCheckboxState.Checked,
      'task phải ở trạng thái Checked sau toggle',
    );
    if (subtaskNode) {
      await provider.handleCheckboxChange([[subtaskNode, mockVscode.TreeItemCheckboxState.Checked]]);
      assert.strictEqual(
        provider.getTreeItem(subtaskNode).checkboxState,
        mockVscode.TreeItemCheckboxState.Checked,
        'subtask phải Checked sau toggle',
      );
    }

    ext.deactivate();
    console.log(`[smoke-test] OK — ${registeredCommands.size} lệnh, render ${rendered} node, checkbox persist.`);
  } finally {
    Module._load = originalLoad;
  }
}

main().catch((e) => {
  console.error('[smoke-test] FAILED');
  console.error(e);
  process.exit(1);
});
