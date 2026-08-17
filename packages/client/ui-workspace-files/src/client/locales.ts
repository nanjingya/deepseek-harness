/** Locale keys for the workspace file tree and `@` file source. */
export const NS = 'workspace-files' as const

/** English copy. */
export const en = {
  'tree.trigger': 'Files',
  'tree.title': 'Project files',
  'tree.empty': 'No entries',
  'tree.error': 'Could not list files',
  'tree.openFailed': 'Could not open file',
  'tree.up': 'Up',
  'source.name': 'file',
} as const

/** Chinese copy. */
export const zh = {
  'tree.trigger': '文件',
  'tree.title': '项目文件',
  'tree.empty': '无条目',
  'tree.error': '无法列出文件',
  'tree.openFailed': '无法打开文件',
  'tree.up': '上级',
  'source.name': 'file',
} as const

export type WorkspaceFilesKey = keyof typeof en
