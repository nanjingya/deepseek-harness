export const NS = 'terminal' as const

export const en = {
  'panel.trigger': 'Terminal',
  'panel.title': 'Session terminal',
  'panel.empty': 'No terminal sessions',
  'panel.unavailable': 'Terminal service is unavailable on this host',
  'panel.noAgent': 'Attach this session to use the terminal',
  'panel.open': 'New shell',
  'panel.close': 'Close',
  'panel.input.placeholder': 'Type a command and press Enter',
  'panel.sendFailed': 'Could not send input',
} as const

export const zh = {
  'panel.trigger': '终端',
  'panel.title': '会话终端',
  'panel.empty': '暂无终端会话',
  'panel.unavailable': '此宿主未挂载终端服务',
  'panel.noAgent': '请先附着此会话再使用终端',
  'panel.open': '新建 shell',
  'panel.close': '关闭',
  'panel.input.placeholder': '输入命令后按 Enter',
  'panel.sendFailed': '无法发送输入',
} as const

export type TerminalKey = keyof typeof en
